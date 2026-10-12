/**
 * P12 commerce evidence: live SearchApi.io discovery → live ASIN revalidation
 * → treasury reservation → Kernel EconomicGrant → Crossmint STAGING order →
 * quote re-verification → testnet USDC payment (only if the quote fits the
 * grant) → poll → reconcile. Writes bounty-evidence/commerce/*.json.
 *
 * Guards: CROSSMINT_ENV must be staging (the route refuses otherwise), the
 * payer signs only on a Crossmint staging testnet, and mainnet broadcast stays
 * disabled. Recipient data is obviously fake test data.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseTransaction,
  type Hex,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from 'viem/chains';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
  economicApprovalTypedData,
  economicRequestHash,
  type EconomicGrantLedger,
} from '@synq/kernel';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  revalidateOffer,
  searchOffers,
  selectOffers,
  toDecimal,
  type EconomicOffer,
} from '@synq/offer-exchange';
import {
  CROSSMINT_STAGING_CHAINS,
  CommerceExecutionRouter,
  CrossmintCheckoutRoute,
  SearchApiDiscovery,
  commerceCapabilities,
  type CrossmintPayer,
  type CrossmintStagingChain,
  type HttpFetch,
  type Json,
  type SearchResponseCache,
} from '@synq/plugin-commerce';
import {
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
  type VaultKeyProvider,
} from '@synq/profile-vault';
import {
  MemoryReservationStore,
  PostgresEconomicGrantLedger,
  PostgresReservationStore,
  type TreasuryReservationStore,
} from '@synq/settlement';
import type { VerifiedApproval } from '@synq/schemas';
import {
  commerceExecution,
  commerceGrantCap,
  executeCommerceCheckout,
  reconcileCommerceCheckout,
} from '../workers/workflow/src/activities/commerce.js';

const env = process.env;
const now = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(process.cwd(), 'bounty-evidence', 'commerce');
const QUERY = env.SYNQ_COMMERCE_QUERY ?? 'Amazon Basics USB-C to USB-C cable';
// Crossmint staging caps USDC orders at $10 (docs: payments/advanced/testing-tips).
const PRICE_MAX = Number(env.SYNQ_COMMERCE_PRICE_MAX ?? '9');
const CHAIN = (env.CROSSMINT_PAYMENT_CHAIN ??
  'ethereum-sepolia') as CrossmintStagingChain;
const VIEM_CHAINS = {
  'ethereum-sepolia': sepolia,
  'base-sepolia': baseSepolia,
  'arbitrum-sepolia': arbitrumSepolia,
  'optimism-sepolia': optimismSepolia,
} as const;
const RPC: Record<CrossmintStagingChain, string> = {
  'ethereum-sepolia':
    env.SYNQ_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  'base-sepolia': env.SYNQ_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
  'arbitrum-sepolia':
    env.SYNQ_ARB_SEPOLIA_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc',
  'optimism-sepolia':
    env.SYNQ_OP_SEPOLIA_RPC_URL ?? 'https://sepolia.optimism.io',
};
const EXPLORER: Record<CrossmintStagingChain, string> = {
  'ethereum-sepolia': 'https://sepolia.etherscan.io/tx/',
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
  'arbitrum-sepolia': 'https://sepolia.arbiscan.io/tx/',
  'optimism-sepolia': 'https://sepolia-optimism.etherscan.io/tx/',
};
// Obviously fake test recipient (public landmark address); never personal data.
const TEST_RECIPIENT = {
  name: 'Synq Test',
  email: 'test+synq@example.com',
  line1: '1600 Amphitheatre Pkwy',
  city: 'Mountain View',
  state: 'CA',
  postalCode: '94043',
  country: 'US',
};

type Step = { step: string; label: string; at: string; detail: unknown };
const steps: Step[] = [];
const record = (step: string, label: string, detail: unknown) =>
  steps.push({ step, label, at: new Date().toISOString(), detail });

let searchApiCredits = 0;
const realFetch: HttpFetch = async (url, init) => {
  if (url.startsWith('https://www.searchapi.io/')) searchApiCredits++;
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(45_000),
  });
  return { status: res.status, text: () => res.text() };
};

/** On-disk SearchApi cache (gitignored .synq-cache/) so re-runs spend no credits on search. */
function fileCache(dir: string): SearchResponseCache & { hits: string[] } {
  mkdirSync(dir, { recursive: true });
  const file = (k: string) =>
    join(
      dir,
      `${createHash('sha256').update(k).digest('hex').slice(0, 24)}.json`,
    );
  const hits: string[] = [];
  return {
    hits,
    async get(k) {
      const f = file(k);
      if (!existsSync(f)) return null;
      hits.push(k);
      return JSON.parse(readFileSync(f, 'utf8')) as Json;
    },
    async put(k, v) {
      writeFileSync(file(k), JSON.stringify(v));
    },
  };
}

function loadKey(): Hex {
  const path =
    env.SYNQ_TESTNET_KEY_FILE ?? join(homedir(), '.synq/testnet.key');
  const text = readFileSync(path, 'utf8').trim();
  const key = (text.startsWith('0x') ? text : `0x${text}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('KEY_FILE_INVALID');
  return key;
}

/** Testnet payer: broadcasts exactly the route-verified transaction on a Crossmint staging testnet. */
function testnetPayer(key: Hex): CrossmintPayer & {
  balance(): Promise<bigint>;
} {
  if (env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
    throw new Error('refusing: SYNQ_ALLOW_MAINNET_BROADCAST must stay false');
  const chain = VIEM_CHAINS[CHAIN];
  if (!chain?.testnet) throw new Error('payer chain must be a testnet');
  const account = privateKeyToAccount(key);
  const transport = http(RPC[CHAIN]);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const usdc = CROSSMINT_STAGING_CHAINS[CHAIN].usdc as Hex;
  const balance = () =>
    pub.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
  return {
    address: account.address,
    chain: CHAIN,
    balance,
    async pay(tx) {
      const parsed = parseTransaction(tx.serializedTransaction);
      if (parsed.chainId !== chain.id || tx.chainId !== chain.id)
        throw new Error('payer refuses: chain mismatch');
      if ((await balance()) < tx.amount)
        throw new Error('payer refuses: insufficient testnet USDC');
      // Send the parsed transaction unchanged (Crossmint: never alter it).
      const hash = await wallet.sendTransaction({
        to: parsed.to!,
        data: parsed.data!,
        value: parsed.value ?? 0n,
        ...(parsed.gas ? { gas: parsed.gas } : {}),
        ...(parsed.nonce !== undefined ? { nonce: parsed.nonce } : {}),
        ...(parsed.maxFeePerGas
          ? {
              maxFeePerGas: parsed.maxFeePerGas,
              maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
            }
          : {}),
      });
      record('payment.broadcast', 'REAL_TESTNET (unverified until mined)', {
        chain: CHAIN,
        txHash: hash,
      });
      const receipt = await pub.waitForTransactionReceipt({
        hash,
        timeout: 180_000,
      });
      return { txHash: hash, status: receipt.status };
    },
  };
}

async function stores(): Promise<{
  reservations: TreasuryReservationStore;
  ledger: EconomicGrantLedger;
  backend: string;
  close(): Promise<void>;
}> {
  const url =
    env.SYNQ_P12_DATABASE_URL ??
    'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_p12_commerce';
  try {
    const name = new URL(url).pathname.slice(1);
    const admin = new pg.Client({
      connectionString: url.replace(/\/[^/]+$/, '/postgres'),
    });
    await admin.connect();
    try {
      const exists = await admin.query(
        'SELECT 1 FROM pg_database WHERE datname=$1',
        [name],
      );
      if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    const schema = `p12_cm_${stamp.slice(0, 19).replace(/[^0-9]/g, '')}`;
    const reservations = new PostgresReservationStore(pool, schema);
    await reservations.migrate();
    const ledger = new PostgresEconomicGrantLedger(pool, schema);
    await ledger.migrate();
    return {
      reservations,
      ledger,
      backend: `postgres ${name} schema ${schema}`,
      close: () => pool.end(),
    };
  } catch (e) {
    record('stores', 'SYNQ_INTERNAL', {
      note: 'Postgres unavailable; memory stores used',
      error: (e as Error).message,
    });
    return {
      reservations: new MemoryReservationStore(),
      ledger: new MemoryEconomicGrantLedger(),
      backend: 'memory',
      close: async () => {},
    };
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `crossmint-checkout-${stamp}.json`);
  const secrets = [
    env.SEARCHAPI_KEY,
    env.CROSSMINT_API_KEY,
    env.CROSSMINT_CLIENT_API_KEY,
  ].filter((s): s is string => !!s);
  const finish = (result: Record<string, unknown>) => {
    const text = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        script: 'scripts/crossmint-checkout-evidence.ts',
        ...result,
        searchApi: {
          creditsUsedThisRun: searchApiCredits,
          cacheHits: cache.hits.length,
        },
        steps,
      },
      null,
      2,
    );
    for (const s of [...secrets, keyHex])
      if (s && text.includes(s)) throw new Error('secret leaked into evidence');
    writeFileSync(file, text + '\n');
    console.log(`${String(result.finalStatus)} -> ${file}`);
  };

  const cache = fileCache(
    join(process.cwd(), '.synq-cache', 'searchapi-evidence'),
  );
  let keyHex = '';
  if (!env.SEARCHAPI_KEY || !env.CROSSMINT_API_KEY) {
    finish({
      label: 'BLOCKED_EXTERNAL',
      finalStatus: 'BLOCKED_EXTERNAL',
      reason: 'SEARCHAPI_KEY or CROSSMINT_API_KEY absent',
    });
    return;
  }
  keyHex = loadKey();
  const payer = testnetPayer(keyHex as Hex);
  const caps = commerceCapabilities(env);
  const graph = new ProviderCapabilityGraph(caps);

  // 1. Discovery (MAINNET_READ_ONLY: production read-only search API).
  const amazon = new SearchApiDiscovery(
    'searchapi-amazon',
    env.SEARCHAPI_KEY,
    realFetch,
    now,
    { evidence: 'MAINNET_READ_ONLY', priceMax: PRICE_MAX, cache },
  );
  const gshop = new SearchApiDiscovery(
    'searchapi-google-shopping',
    env.SEARCHAPI_KEY,
    realFetch,
    now,
    { evidence: 'MAINNET_READ_ONLY', cache },
  );
  const discoveryIntent = EconomicIntentSchema.parse({
    id: `p12-discover-${now()}`,
    groupId: 'evidence-group',
    domain: 'COMMERCE',
    objective: QUERY,
    subject: { kind: 'PRODUCT', title: QUERY, condition: 'NEW' },
    hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
    preferences: [],
    budget: {
      max: { amount: String(PRICE_MAX * 100), currency: 'USD', decimals: 2 },
    },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
  const search = await searchOffers({
    intent: discoveryIntent,
    providers: [amazon, gshop],
    graph,
    now,
    timeoutMs: 60_000,
  });
  record('discovery', 'MAINNET_READ_ONLY', {
    request: {
      engines: ['amazon_search', 'google_shopping'],
      q: QUERY,
      amazon_price_max_usd: PRICE_MAX,
      servedFromCache: cache.hits.length > 0,
    },
    outcomes: search.outcomes,
    offers: search.offers.length,
    sample: search.offers.slice(0, 6).map((o) => ({
      offerId: o.offerId,
      title: o.subject.kind === 'PRODUCT' ? o.subject.title.slice(0, 90) : '',
      price: `${toDecimal(o.price.base)} ${o.price.base.currency}`,
      mode: o.execution.mode,
    })),
  });

  // 2. The group picks one exact Amazon listing: the top-relevance new,
  // Crossmint-fulfillable result (or SYNQ_COMMERCE_ASIN).
  const pick = search.offers.find(
    (o) =>
      o.fulfillmentProviderId === 'crossmint' &&
      o.subject.kind === 'PRODUCT' &&
      o.subject.condition === 'NEW' &&
      (env.SYNQ_COMMERCE_ASIN
        ? o.providerRef === `amazon:${env.SYNQ_COMMERCE_ASIN}`
        : true),
  );
  if (!pick || pick.subject.kind !== 'PRODUCT') {
    finish({ label: 'MAINNET_READ_ONLY', finalStatus: 'NO_PRODUCT' });
    return;
  }
  const asin = pick.providerRef.slice('amazon:'.length);
  const intent = EconomicIntentSchema.parse({
    id: `p12-cm-${now()}`,
    groupId: 'evidence-group',
    domain: 'COMMERCE',
    objective: `buy ${pick.subject.title.slice(0, 80)}`,
    subject: {
      kind: 'PRODUCT',
      title: pick.subject.title,
      asin,
      condition: 'NEW',
    },
    hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
    preferences: [],
    budget: {
      max: { amount: String(PRICE_MAX * 100), currency: 'USD', decimals: 2 },
    },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 500,
    validUntil: now() + 3_600,
  });
  const sel = selectOffers({ intent, search, now: now() });
  const candidate = sel.ranked.find(
    (c) => c.offer.providerRef === pick.providerRef,
  );
  if (!candidate) {
    finish({
      label: 'MAINNET_READ_ONLY',
      finalStatus: 'NOT_SELECTABLE',
      sel: sel.rejected,
    });
    return;
  }
  const reval = await revalidateOffer({
    intent,
    candidate,
    provider: amazon,
    graph,
    approvedMax: intent.budget.max,
    now,
    timeoutMs: 60_000,
  });
  record('revalidation', 'MAINNET_READ_ONLY', {
    engine: 'amazon_product (live, uncached)',
    asin,
    status: reval.status,
    ...(reval.status === 'EXECUTABLE'
      ? { landed: `${toDecimal(reval.landed)} USD` }
      : { reason: reval.reason }),
  });
  if (reval.status !== 'EXECUTABLE') {
    finish({
      label: 'MAINNET_READ_ONLY',
      finalStatus: `REVALIDATION_${reval.status}`,
    });
    return;
  }
  const offer: EconomicOffer = reval.offer;

  // 3. Treasury reservation against the payer's real testnet USDC balance.
  const st = await stores();
  const balance = await payer.balance();
  const cap = commerceGrantCap(
    reval.landed,
    Number(env.SYNQ_COMMERCE_TAX_ALLOWANCE_BPS ?? '2000'),
  );
  const reservedUnits = BigInt(cap.amount) * 10n ** 4n; // USD cents → USDC 6dp, par
  const assetId = `eip155:${CROSSMINT_STAGING_CHAINS[CHAIN].chainId}/erc20:usdc`;
  const reservationId = `res-${intent.id}`;
  const planHash = `plan:${CHAIN}:usdc`;
  await st.reservations.setConfirmedBalance({
    groupId: 'evidence-group',
    assetId,
    confirmed: balance,
    asOf: now(),
  });
  await st.reservations.reserve(
    {
      reservationId,
      groupId: 'evidence-group',
      assetId,
      amount: reservedUnits.toString(),
      intentId: intent.id,
      purpose: 'COMMERCE',
      settlementPlanHash: planHash,
      expiresAt: now() + 1_800,
    },
    now(),
  );
  record('reservation', 'SYNQ_INTERNAL', {
    backend: st.backend,
    reservationId,
    assetId,
    amount: `${toDecimal({ amount: reservedUnits.toString(), currency: 'USDC', decimals: 6 })} USDC`,
    confirmedBalanceSource: `balanceOf(payer) on ${CHAIN} (live read)`,
    confirmedBalance: `${Number(balance) / 1e6} USDC`,
  });

  // 4. Kernel grant bound to the exact offer, route, cap, reservation and recipient.
  const vaultKey: VaultKeyProvider = {
    activeKeyId: 'ephemeral:p12-evidence',
    dataKey: (() => {
      const k = new Uint8Array(randomBytes(32));
      return async () => k;
    })(),
  };
  const profileStore = new MemoryProfileStore();
  const directory = new ProfileDirectory(profileStore, vaultKey, now);
  const recipient = await directory.put({
    groupId: 'evidence-group',
    kind: 'RECIPIENT',
    data: TEST_RECIPIENT,
  });
  const decryptor = new ProfileDecryptor(
    profileStore,
    vaultKey,
    now,
    'p12-execution',
  );
  const approverKey = generatePrivateKey();
  const approver = privateKeyToAccount(approverKey);
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(randomBytes(32)),
    reservations: st.reservations,
    ledger: st.ledger,
    approvals: {
      ledger: { isConsumed: async () => true },
      directory: {
        membershipEpoch: async () => 1,
        activeMember: async (groupId, memberId) =>
          memberId === 'alice'
            ? {
                groupId,
                memberId,
                principalId: 'principal-alice',
                principalKind: 'LOCAL_FIXTURE',
                role: 'APPROVER',
                signer: approver.address.toLowerCase() as `0x${string}`,
                membershipEpoch: 1,
                ownerOfAccount: true,
              }
            : null,
      },
    },
  });
  const usdCap = {
    amount: String(PRICE_MAX * 100 * 2),
    currency: 'USD',
    decimals: 2,
  };
  await authority.install({
    mandateId: 'p12-commerce',
    groupId: 'evidence-group',
    version: 1,
    status: 'ACTIVE',
    domains: ['COMMERCE'],
    providers: ['crossmint'],
    hosts: ['staging.crossmint.com'],
    perActionCap: usdCap,
    cumulativeBudget: usdCap,
    autoApproveMax: { amount: '0', currency: 'USD', decimals: 2 },
    quorum: 1,
    members: ['alice'],
    approverKinds: ['LOCAL_FIXTURE'],
    maxQuoteAgeSeconds: 300,
    grantTtlSeconds: 600,
    environment: 'SANDBOX',
    validUntil: now() + 3_600,
  });
  const reservation = {
    reservationId,
    planHash,
    reservedAssetId: assetId,
    reservedAmount: reservedUnits.toString(),
  };
  const request = {
    intentId: intent.id,
    groupId: 'evidence-group',
    mandateId: 'p12-commerce',
    execution: commerceExecution({
      offer,
      host: 'staging.crossmint.com',
      providerId: 'crossmint',
      maxAmount: cap,
      reservation,
      recipientRef: recipient.ref,
    }),
    quoteExpiresAt: offer.price.expiresAt,
    revalidatedAt: offer.price.revalidatedAt,
  };
  const requestHash = economicRequestHash(request);
  const signature = await approver.signTypedData(
    economicApprovalTypedData({
      groupId: 'evidence-group',
      mandateId: 'p12-commerce',
      requestHash,
    }),
  );
  const approval: VerifiedApproval = {
    schemaVersion: 1,
    approvalId: `apr-${intent.id}`,
    challengeId: `chl-${intent.id}`,
    groupId: 'evidence-group' as VerifiedApproval['groupId'],
    memberId: 'alice' as VerifiedApproval['memberId'],
    principalId: 'principal-alice' as VerifiedApproval['principalId'],
    principalKind: 'LOCAL_FIXTURE',
    signer: approver.address.toLowerCase() as `0x${string}`,
    draftDigest: requestHash,
    signature,
    membershipEpoch: 1,
    verifiedAt: now(),
  };
  const decision = await authority.authorize(request, [approval], now());
  if (decision.status !== 'AUTHORIZED') {
    finish({
      label: 'SYNQ_INTERNAL',
      finalStatus: `GRANT_${decision.status}`,
      decision,
    });
    await st.close();
    return;
  }
  const grant = decision.grant;
  record('grant', 'SYNQ_INTERNAL', {
    grantId: grant.grantId,
    approvals:
      'one LOCAL_FIXTURE member EIP-712 signature (ephemeral key; not a passkey)',
    binding: {
      providerId: grant.execution.providerId,
      host: grant.execution.host,
      offerId: grant.execution.offerId,
      productLocator: offer.providerRef,
      quantity: grant.execution.quantity,
      maxAmountInclTaxShipping: `${toDecimal(grant.execution.maxAmount)} USD`,
      revalidatedItemPrice: `${toDecimal(reval.landed)} USD`,
      recipientRef: grant.execution.recipientRef,
    },
    expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
  });

  // 5. Execute through the router and Crossmint staging.
  const route = new CrossmintCheckoutRoute(
    caps.find((c) => c.providerId === 'crossmint')!,
    {
      apiKey: env.CROSSMINT_API_KEY,
      environment: env.CROSSMINT_ENV,
      chain: CHAIN,
      paymentRecipients: (env.CROSSMINT_PAYMENT_RECIPIENTS ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    },
    realFetch,
    payer,
  );
  const routeDecision = new CommerceExecutionRouter([route]).decide(offer, [
    'STABLECOIN_CHECKOUT',
  ]);
  record('route', 'SYNQ_INTERNAL', {
    decision: routeDecision.kind,
    considered: routeDecision.considered,
  });
  const since = now();
  const idempotencyKey = `checkout-${intent.id}`;
  const result = await executeCommerceCheckout(
    {
      authority,
      reservations: st.reservations,
      now,
      resolveRecipient: async (ref, purpose) => {
        const r = await decryptor.resolve({
          groupId: 'evidence-group',
          ref,
          kind: 'RECIPIENT',
          purpose,
          fields: [
            'name',
            'email',
            'line1',
            'city',
            'state',
            'postalCode',
            'country',
          ],
        });
        return { ...r, state: r.state ?? '' };
      },
    },
    {
      intentId: intent.id,
      decision: routeDecision,
      offer,
      grant,
      reservation,
      recipientRef: recipient.ref,
      idempotencyKey,
    },
  );
  const payment = 'payment' in result ? result.payment : undefined;
  const receipt = 'receipt' in result ? result.receipt : null;
  const orderCreated = !!receipt?.providerRef;
  record('checkout', orderCreated ? 'PROVIDER_SANDBOX' : 'BLOCKED_EXTERNAL', {
    kind: result.kind,
    reason: 'reason' in result ? result.reason : null,
    receipt,
    quoted: 'quoted' in result ? result.quoted : undefined,
    profileVaultAudit: decryptor.audit.map((a) => ({
      purpose: a.purpose,
      fields: a.fields,
      outcome: a.outcome,
    })),
  });

  // 6. Reconcile anything held.
  let reconciliation: unknown = null;
  if (result.kind === 'HOLD') {
    reconciliation = await reconcileCommerceCheckout(
      { reservations: st.reservations, now },
      {
        route,
        reservationId,
        orderRef: result.receipt.providerRef,
        paymentBroadcast: !!payment,
        since,
      },
    );
    record('reconcile', 'PROVIDER_SANDBOX', reconciliation);
  }
  // 7. Verify any payment on-chain before labelling it REAL_TESTNET.
  let onchain: Record<string, unknown> | null = null;
  if (payment) {
    const pub = createPublicClient({
      chain: VIEM_CHAINS[CHAIN],
      transport: http(RPC[CHAIN]),
    });
    const r = await pub
      .getTransactionReceipt({ hash: payment.txHash as Hex })
      .catch(() => null);
    onchain = {
      chain: CHAIN,
      chainId: payment.chainId,
      txHash: payment.txHash,
      explorer: `${EXPLORER[CHAIN]}${payment.txHash}`,
      receiptStatus: r?.status ?? 'not found',
      blockNumber: r ? r.blockNumber.toString() : null,
      label: r?.status === 'success' ? 'REAL_TESTNET' : 'UNVERIFIED',
    };
    record('payment.verify', String(onchain.label), onchain);
  }
  const reservationAfter = await st.reservations.get(reservationId);
  await st.close();
  finish({
    label: orderCreated
      ? 'PROVIDER_SANDBOX (Crossmint staging order) with MAINNET_READ_ONLY discovery'
      : 'BLOCKED_EXTERNAL at Crossmint staging order creation; discovery MAINNET_READ_ONLY',
    finalStatus:
      result.kind === 'RECEIPT'
        ? (receipt?.state ?? 'RECEIPT')
        : result.kind === 'HOLD'
          ? `HOLD:${(reconciliation as { status?: string } | null)?.status ?? 'UNRECONCILED'}`
          : result.kind,
    searchRequest: { q: QUERY, priceMaxUsd: PRICE_MAX },
    chosenProduct: {
      asin,
      title: pick.subject.title,
      searchPrice: `${toDecimal(pick.price.base)} USD`,
      revalidatedPrice: `${toDecimal(reval.landed)} USD`,
    },
    grantId: grant.grantId,
    crossmint: {
      environment: env.CROSSMINT_ENV,
      host: 'staging.crossmint.com',
      paymentChain: CHAIN,
      orderId: receipt?.providerRef ?? null,
      receiptState: receipt?.state ?? null,
      outcome: result.kind,
      reason: 'reason' in result ? result.reason : null,
    },
    payment: onchain,
    reservationFinalState: reservationAfter?.state ?? null,
    payer: payer.address,
  });
}

await main();
