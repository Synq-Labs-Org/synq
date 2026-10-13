import {
  ProviderCapabilityGraph,
  type OfferProvider,
  type ProviderBookingPort,
  type ProviderCapability,
} from '@synq/offer-exchange';
import {
  BITREFILL,
  BitrefillClient,
  CROSSMINT,
  CrossmintCheckoutRoute,
  LITHIC,
  LithicSandboxCardPort,
  LithicSandboxClient,
  RELOADLY,
  ReloadlyClient,
  ReloadlyGiftCardPort,
  ReloadlyGiftCardProvider,
  SimulatedCardMerchant,
  bitrefillConfigFromEnv,
  commerceCapabilities,
  lithicProviderCapability,
  reloadlyProviderCapability,
  type CrossmintStagingChain,
  type GiftCodeSealer,
  type GiftRecipientDirectory,
  type HttpFetch,
} from '@synq/plugin-commerce';
import type { RailDescriptor } from '@synq/settlement';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What the worker can actually do with a provider right now. BLOCKED_EXTERNAL:
 * credentials or an external dependency are missing; UNAVAILABLE: the
 * configuration is refused (e.g. a non-sandbox key) or incomplete.
 */
export type ProviderRuntimeStatus = {
  providerId: string;
  label: 'PROVIDER_SANDBOX' | 'REAL_TESTNET' | 'MAINNET_READ_ONLY';
  status: 'READY' | 'READ_ONLY' | 'BLOCKED_EXTERNAL' | 'UNAVAILABLE';
  reason: string | null;
};

export type CommerceProviders = {
  graph: ProviderCapabilityGraph;
  providers: Record<string, OfferProvider>;
  ports: Record<string, ProviderBookingPort>;
  rails: RailDescriptor[];
  /** Read-only catalog client; there is no Bitrefill payer anywhere. */
  bitrefill: BitrefillClient | null;
  /** Staging checkout route; no testnet payer is held by this worker. */
  crossmint: CrossmintCheckoutRoute | null;
  status: ProviderRuntimeStatus[];
};

const has = (env: Env, k: string) => !!(env[k] ?? '').trim();
/** Construction errors name the refused setting; they never carry the secret. */
const why = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

const sandboxRail = (
  railId: string,
  rail: RailDescriptor['rail'],
  ready: boolean,
): RailDescriptor => ({
  railId,
  rail,
  chainId: null,
  assetId: null,
  currency: 'USD',
  auth: 'PROVIDER_API_KEY',
  kycRequired: false,
  kycSatisfied: false,
  environment: 'SANDBOX',
  status: ready ? 'READY' : 'MISSING_CREDENTIALS',
});

function lithicMerchant(env: Env) {
  const raw = env.SYNQ_LITHIC_SIM_MERCHANT;
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof m.descriptor === 'string' &&
      /^[A-Za-z0-9 .*'&-]{3,40}$/.test(m.descriptor) &&
      typeof m.title === 'string' &&
      Number.isSafeInteger(m.priceCents) &&
      (m.priceCents as number) > 0
    )
      return {
        descriptor: m.descriptor,
        title: m.title.slice(0, 120),
        priceCents: m.priceCents as number,
      };
  } catch {
    return null;
  }
  return null;
}

/**
 * Builds the commerce provider adapters from environment configuration.
 * Never throws: an absent credential is BLOCKED_EXTERNAL and a refused
 * configuration is UNAVAILABLE, and neither installs a port.
 */
export function commerceProvidersFromEnv(
  env: Env,
  deps: {
    fetch: HttpFetch;
    now: () => number;
    /** Sealed gift-code storage; without it Reloadly orders are not installed. */
    giftCodes: GiftCodeSealer | null;
    /** Group profile lookup; a gift card is only ordered for a RECIPIENT/SHIPPING profile. */
    recipients: GiftRecipientDirectory | null;
  },
): CommerceProviders {
  const providers: Record<string, OfferProvider> = {};
  const ports: Record<string, ProviderBookingPort> = {};
  const capabilities: ProviderCapability[] = [];
  const status: ProviderRuntimeStatus[] = [];

  // Reloadly gift cards (sandbox).
  let reloadlyReady = false;
  if (!has(env, 'RELOADLY_CLIENT_ID') || !has(env, 'RELOADLY_CLIENT_SECRET'))
    status.push({
      providerId: RELOADLY,
      label: 'PROVIDER_SANDBOX',
      status: 'BLOCKED_EXTERNAL',
      reason: 'RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET not set',
    });
  else if (!deps.giftCodes || !deps.recipients)
    status.push({
      providerId: RELOADLY,
      label: 'PROVIDER_SANDBOX',
      status: 'UNAVAILABLE',
      reason:
        'SYNQ_PROFILE_VAULT_KEY not set: gift codes could not be sealed or recipients checked',
    });
  else
    try {
      const client = new ReloadlyClient(
        {
          clientId: env.RELOADLY_CLIENT_ID!,
          clientSecret: env.RELOADLY_CLIENT_SECRET!,
          environment: env.RELOADLY_ENV ?? 'sandbox',
        },
        deps.fetch,
        deps.now,
      );
      providers[RELOADLY] = new ReloadlyGiftCardProvider(
        client,
        deps.now,
        deps.recipients,
      );
      ports[RELOADLY] = new ReloadlyGiftCardPort(
        client,
        deps.giftCodes,
        deps.recipients,
      );
      capabilities.push(reloadlyProviderCapability(env));
      reloadlyReady = true;
      status.push({
        providerId: RELOADLY,
        label: 'PROVIDER_SANDBOX',
        status: 'READY',
        reason: null,
      });
    } catch (e) {
      status.push({
        providerId: RELOADLY,
        label: 'PROVIDER_SANDBOX',
        status: 'UNAVAILABLE',
        reason: why(e),
      });
    }

  // Lithic card issuing (sandbox) against a simulated merchant.
  let lithicReady = false;
  const merchant = lithicMerchant(env);
  if (!has(env, 'LITHIC_API_KEY'))
    status.push({
      providerId: LITHIC,
      label: 'PROVIDER_SANDBOX',
      status: 'BLOCKED_EXTERNAL',
      reason: 'LITHIC_API_KEY not set',
    });
  else
    try {
      const client = new LithicSandboxClient(
        {
          apiKey: env.LITHIC_API_KEY!.trim(),
          environment: env.LITHIC_ENV ?? 'sandbox',
        },
        deps.fetch,
      );
      if (!merchant)
        status.push({
          providerId: LITHIC,
          label: 'PROVIDER_SANDBOX',
          status: 'UNAVAILABLE',
          reason:
            'SYNQ_LITHIC_SIM_MERCHANT not set: no simulated merchant to authorize against',
        });
      else {
        providers[LITHIC] = new SimulatedCardMerchant(merchant, deps.now);
        ports[LITHIC] = new LithicSandboxCardPort(client);
        capabilities.push(lithicProviderCapability(env));
        lithicReady = true;
        status.push({
          providerId: LITHIC,
          label: 'PROVIDER_SANDBOX',
          status: 'READY',
          reason: null,
        });
      }
    } catch (e) {
      status.push({
        providerId: LITHIC,
        label: 'PROVIDER_SANDBOX',
        status: 'UNAVAILABLE',
        reason: why(e),
      });
    }

  // Crossmint staging checkout: testnet USDC, but no payer lives in this worker.
  let crossmint: CrossmintCheckoutRoute | null = null;
  if (!has(env, 'CROSSMINT_API_KEY'))
    status.push({
      providerId: CROSSMINT,
      label: 'REAL_TESTNET',
      status: 'BLOCKED_EXTERNAL',
      reason: 'CROSSMINT_API_KEY not set',
    });
  else
    try {
      const chain = (env.CROSSMINT_PAYMENT_CHAIN ??
        'base-sepolia') as CrossmintStagingChain;
      const capability = commerceCapabilities(env).find(
        (c) => c.providerId === CROSSMINT,
      )!;
      crossmint = new CrossmintCheckoutRoute(
        capability,
        {
          apiKey: env.CROSSMINT_API_KEY!.trim(),
          environment: env.CROSSMINT_ENV ?? 'staging',
          // assertCrossmintStaging refuses any chain that is not a staging testnet.
          chain,
          paymentRecipients: (env.CROSSMINT_PAYMENT_RECIPIENTS ?? '')
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        },
        deps.fetch,
        null,
      );
      status.push({
        providerId: CROSSMINT,
        label: 'REAL_TESTNET',
        status: 'BLOCKED_EXTERNAL',
        reason:
          'no testnet USDC payer in the workflow worker; staging Amazon lookups fail upstream',
      });
    } catch (e) {
      status.push({
        providerId: CROSSMINT,
        label: 'REAL_TESTNET',
        status: 'UNAVAILABLE',
        reason: why(e),
      });
    }

  // Bitrefill: mainnet catalog, read-only. Never a booking port.
  let bitrefill: BitrefillClient | null = null;
  const bitrefillConfig = bitrefillConfigFromEnv(env);
  if (!bitrefillConfig)
    status.push({
      providerId: BITREFILL,
      label: 'MAINNET_READ_ONLY',
      status: 'BLOCKED_EXTERNAL',
      reason: 'BITREFILL_API_KEY (or BITREFILL_API_ID / _SECRET) not set',
    });
  else
    try {
      bitrefill = new BitrefillClient(bitrefillConfig, deps.fetch);
      status.push({
        providerId: BITREFILL,
        label: 'MAINNET_READ_ONLY',
        status: 'READ_ONLY',
        reason: 'catalog only; real-money payment has no implementation',
      });
    } catch (e) {
      status.push({
        providerId: BITREFILL,
        label: 'MAINNET_READ_ONLY',
        status: 'UNAVAILABLE',
        reason: why(e),
      });
    }

  return {
    graph: new ProviderCapabilityGraph(capabilities),
    providers,
    ports,
    rails: [
      sandboxRail(
        'reloadly-sandbox-balance',
        'PROVIDER_BALANCE',
        reloadlyReady,
      ),
      sandboxRail('lithic-sandbox-card', 'SCOPED_CARD', lithicReady),
    ],
    bitrefill,
    crossmint,
    status,
  };
}
