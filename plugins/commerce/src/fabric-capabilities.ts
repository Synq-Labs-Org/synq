import {
  credentialStatus,
  type ProviderCapability,
} from '@synq/offer-exchange';
import type {
  CredentialStatus,
  ProviderExecutionCapability,
  ProviderHealth,
} from '@synq/settlement';
import {
  BITREFILL,
  BITREFILL_PAYMENT_METHODS,
  BITREFILL_SOURCES,
} from './bitrefill.js';
import { CROSSMINT, CROSSMINT_STAGING_CHAINS } from './crossmint.js';
import { LITHIC, LITHIC_SOURCES } from './lithic.js';
import { RELOADLY, RELOADLY_SOURCES } from './reloadly.js';

type Env = Readonly<Record<string, string | undefined>>;
const has = (env: Env, k: string) => !!(env[k] ?? '').trim();

/** Observed provider health (e.g. from the last probe); UNKNOWN when never probed. */
export type ObservedHealth = Partial<
  Record<string, { health: ProviderHealth; reason: string | null }>
>;

/**
 * Truthful v1.3 settlement capabilities. Status is derived from credentials
 * present, the environment each provider is pinned to, and observed health.
 * Production credentials are never treated as executable.
 */
export function settlementFabricCapabilities(
  env: Env,
  observed: ObservedHealth = {},
): ProviderExecutionCapability[] {
  const health = (id: string) =>
    observed[id] ?? { health: 'UNKNOWN' as const, reason: null };
  const creds = (keys: string[], sandboxOk: boolean): CredentialStatus =>
    !sandboxOk
      ? 'REFUSED_NON_SANDBOX'
      : keys.every((k) => has(env, k))
        ? 'PRESENT'
        : 'MISSING';

  const reloadlyEnvOk = (env.RELOADLY_ENV ?? 'sandbox') === 'sandbox';
  const lithicEnvOk = (env.LITHIC_ENV ?? 'sandbox') === 'sandbox';
  const crossmintStaging =
    (env.CROSSMINT_ENV ?? 'staging') === 'staging' &&
    (!has(env, 'CROSSMINT_API_KEY') ||
      (env.CROSSMINT_API_KEY ?? '').startsWith('sk_staging_'));
  const bitrefillKind =
    has(env, 'BITREFILL_API_ID') && has(env, 'BITREFILL_API_SECRET')
      ? 'BUSINESS'
      : has(env, 'BITREFILL_API_KEY')
        ? 'PERSONAL'
        : null;

  return [
    {
      providerId: RELOADLY,
      displayName: 'Reloadly gift cards (sandbox)',
      category: 'DIGITAL_GOODS_SANDBOX',
      mode: 'PROVIDER_SANDBOX',
      products: ['GIFT_CARD'],
      currencies: ['USD'],
      chains: [],
      sandbox: { available: reloadlyEnvOk },
      live: {
        available: false,
        reason: 'production gift cards are real money; not enabled',
      },
      credentials: creds(
        ['RELOADLY_CLIENT_ID', 'RELOADLY_CLIENT_SECRET'],
        reloadlyEnvOk,
      ),
      credentialEnv: ['RELOADLY_CLIENT_ID', 'RELOADLY_CLIENT_SECRET'],
      identityChecks: ['NONE'],
      identitySatisfied: true,
      funding: 'PREFUNDED_PROVIDER_BALANCE',
      economicEffect: 'NONE_SANDBOX',
      cancel: { supported: false },
      refund: { supported: false },
      health: health(RELOADLY).health,
      partnerGated: false,
      statusReason: health(RELOADLY).reason,
      sourceRefs: RELOADLY_SOURCES,
    },
    {
      providerId: LITHIC,
      displayName: 'Lithic card issuing (sandbox)',
      category: 'CARD_NETWORK_SANDBOX',
      mode: 'PROVIDER_SANDBOX',
      products: ['VIRTUAL_CARD_AUTHORIZATION'],
      currencies: ['USD'],
      chains: [],
      sandbox: { available: lithicEnvOk },
      live: {
        available: false,
        reason: 'production issuing needs a Lithic program agreement',
      },
      credentials: creds(['LITHIC_API_KEY'], lithicEnvOk),
      credentialEnv: ['LITHIC_API_KEY'],
      identityChecks: ['NONE'],
      identitySatisfied: true,
      funding: 'CARD_PROGRAM_FUNDING',
      economicEffect: 'NONE_SANDBOX',
      cancel: { supported: true },
      refund: { supported: true },
      health: health(LITHIC).health,
      partnerGated: false,
      statusReason: health(LITHIC).reason,
      sourceRefs: LITHIC_SOURCES,
    },
    {
      providerId: BITREFILL,
      displayName: 'Bitrefill (mainnet, read-only)',
      category: 'CRYPTO_COMMERCE_REAL',
      mode: 'MAINNET_READ_ONLY',
      products: ['GIFT_CARD'],
      currencies: ['USD', 'EUR'],
      chains: Object.values(BITREFILL_PAYMENT_METHODS).filter(
        (c) => c.chain !== 'bitrefill-account',
      ),
      sandbox: { available: false },
      live: {
        available: false,
        reason:
          'real money: payment requires REAL_MONEY_APPROVAL_REQUIRED and is not implemented',
      },
      credentials: bitrefillKind ? 'PRESENT' : 'MISSING',
      credentialEnv: ['BITREFILL_API_KEY'],
      identityChecks: ['NONE'],
      identitySatisfied: true,
      funding: 'MERCHANT_INVOICE',
      economicEffect: 'NONE_READ_ONLY',
      cancel: { supported: false },
      refund: { supported: true },
      health: health(BITREFILL).health,
      // Personal API keys are for an individual's own purchases; multi-user production needs the Business/partner programme.
      partnerGated: bitrefillKind !== 'BUSINESS',
      statusReason:
        bitrefillKind === 'BUSINESS'
          ? health(BITREFILL).reason
          : 'PARTNER_GATED: production multi-user operation needs the Bitrefill Business API',
      sourceRefs: BITREFILL_SOURCES,
    },
    {
      providerId: CROSSMINT,
      displayName: 'Crossmint headless checkout (staging)',
      category: 'MERCHANT_CHECKOUT',
      // Staging merchant, but payment is real testnet USDC: TESTNET mode, TESTNET_DEBIT receipts.
      mode: 'TESTNET',
      products: ['MERCHANT_GOODS'],
      currencies: ['USD', 'USDC'],
      chains: Object.keys(CROSSMINT_STAGING_CHAINS).map((chain) => ({
        chain,
        asset: 'USDC',
      })),
      sandbox: { available: crossmintStaging },
      live: {
        available: false,
        reason:
          'production Crossmint keys exist but must not be used (no production orders)',
      },
      credentials: crossmintStaging
        ? has(env, 'CROSSMINT_API_KEY')
          ? 'PRESENT'
          : 'MISSING'
        : 'REFUSED_NON_SANDBOX',
      credentialEnv: ['CROSSMINT_API_KEY'],
      identityChecks: ['NONE'],
      identitySatisfied: true,
      funding: 'ONCHAIN_TRANSFER',
      economicEffect: 'TESTNET_TOKENS',
      cancel: { supported: false },
      refund: { supported: false },
      // Staging Amazon orders fail upstream (Crossmint staging cannot reach the Amazon Business API).
      health: observed[CROSSMINT]?.health ?? 'DOWN',
      partnerGated: false,
      statusReason:
        observed[CROSSMINT]?.reason ??
        'BLOCKED_EXTERNAL: Crossmint staging Amazon lookup returns upstream 403',
      sourceRefs: [
        'https://docs.crossmint.com/api-reference/headless/create-order',
      ],
    },
    {
      providerId: 'human-handoff',
      displayName: 'Human completes the purchase',
      category: 'HUMAN_HANDOFF',
      mode: 'MAINNET_READ_ONLY',
      products: ['GIFT_CARD', 'MERCHANT_GOODS', 'VIRTUAL_CARD_AUTHORIZATION'],
      currencies: ['USD'],
      chains: [],
      sandbox: { available: false },
      live: { available: true, reason: null },
      credentials: 'NOT_REQUIRED',
      credentialEnv: [],
      identityChecks: ['HUMAN_STEP_UP'],
      identitySatisfied: false,
      funding: 'NONE',
      economicEffect: 'HUMAN_OFFLINE',
      cancel: { supported: false },
      refund: { supported: false },
      health: 'HEALTHY',
      partnerGated: false,
      statusReason: null,
      sourceRefs: [],
    },
  ];
}

/** Offer-exchange capability rows for the sandbox execution providers. */
export function reloadlyProviderCapability(env: Env): ProviderCapability {
  return credentialStatus(
    {
      providerId: RELOADLY,
      displayName: 'Reloadly gift cards (sandbox)',
      domains: ['COMMERCE'],
      verbs: ['DISCOVER', 'QUOTE', 'PURCHASE', 'TRACK'],
      environment: 'SANDBOX',
      status:
        (env.RELOADLY_ENV ?? 'sandbox') === 'sandbox' ? 'READY' : 'BLOCKED',
      statusReason: null,
      kycRequired: false,
      credentialEnv: ['RELOADLY_CLIENT_ID', 'RELOADLY_CLIENT_SECRET'],
      settlementRails: ['PROVIDER_BALANCE'],
      discoveryOnly: false,
      sourceRefs: RELOADLY_SOURCES,
    },
    env,
  );
}
export function lithicProviderCapability(env: Env): ProviderCapability {
  return credentialStatus(
    {
      providerId: LITHIC,
      displayName: 'Lithic card issuing (sandbox)',
      domains: ['COMMERCE'],
      verbs: ['DISCOVER', 'QUOTE', 'PURCHASE', 'PAY', 'CANCEL', 'TRACK'],
      environment: 'SANDBOX',
      status: (env.LITHIC_ENV ?? 'sandbox') === 'sandbox' ? 'READY' : 'BLOCKED',
      statusReason: null,
      kycRequired: false,
      credentialEnv: ['LITHIC_API_KEY'],
      settlementRails: ['SCOPED_CARD'],
      discoveryOnly: false,
      sourceRefs: LITHIC_SOURCES,
    },
    env,
  );
}
