/**
 * The chat commerce journey, end to end, with honest labels:
 * "@Synq, find this product on Amazon and buy it under my approved budget".
 *
 *   set -a; . ~/.synq/p11.env; set +a
 *   node --import tsx scripts/commerce-sandbox-proof.ts
 *
 * 1. Chat drafts the request (it authorizes nothing; the mandate sets the budget).
 * 2. Live SearchApi.io Amazon search (MAINNET_READ_ONLY) and exact ASIN/
 *    variant/condition matching; live per-ASIN revalidation.
 * 3. Executable checkout providers are identified: Crossmint staging is
 *    probed live (WorldStore refuses orders), eBay Order is partner gated, so
 *    there is no entitled Amazon order path. The consented path is a scoped
 *    single-use card the human uses at the merchant (handoff).
 * 4. Kernel grant (EIP-712 approvals, quorum 2) bound to that exact item,
 *    amount, card provider and an Arc treasury reservation.
 * 5. Lithic SANDBOX: a single-use virtual card with spend limit = the grant,
 *    a simulated merchant authorization, a refused second use, clearing, a
 *    provider-reported return, card closed. Sandbox cards reach no card
 *    network: no Amazon order exists and no merchant is charged.
 * 6. Settlement fabric: PROVIDER_SANDBOX ledger only; the Arc reservation is
 *    released, never captured; the return is a claim, never treasury credit.
 *
 * Writes bounty-evidence/commerce/commerce-sandbox-<ts>.json (integration
 * worktree when present). Shipping data is a synthetic test profile sealed in
 * ProfileVault; only its ref reaches the agent-facing journey.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
  economicApprovalTypedData,
  economicRequestHash,
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
  CROSSMINT_STAGING_BASE,
  CommerceJourney,
  CrossmintCheckoutRoute,
  EbayOrderRoute,
  LITHIC,
  LITHIC_SANDBOX_HOST,
  LithicSandboxClient,
  SearchApiDiscovery,
  checkoutEligibility,
  commerceCapabilities,
  effectiveBudget,
  lithicCardMemo,
  lithicIdempotencyKey,
  parseCommerceRequest,
  redactCardData,
  settlementFabricCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileDirectory,
} from '@synq/profile-vault';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  SettlementFabric,
  settlementIdempotencyKey,
} from '@synq/settlement';
import { token } from '@synq/chain-registry/arc';
import { balanceOf, connectChain } from '@synq/execution-worker/arc';
import type { VerifiedApproval } from '@synq/schemas';
import { commerceExecution } from '../workers/workflow/src/activities/commerce.js';

const env = process.env;
const now = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const CHAT =
  env.SYNQ_COMMERCE_CHAT ??
  '@Synq, find this product on Amazon https://www.amazon.com/dp/B088NRLMPV and buy it under my approved budget';
const QUERY = env.SYNQ_COMMERCE_QUERY ?? 'USB C to USB C Cable 60W 2-Pack 6 ft';
const GROUP = 'grp_commerce_proof';
const usd = (cents: number | bigint) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const MANDATE_CAP = usd(Number(env.SYNQ_COMMERCE_MANDATE_CAP_CENTS ?? '2000'));

const steps: { step: string; label: string; at: string; detail: unknown }[] =
  [];
const record = (step: string, label: string, detail: unknown) => {
  steps.push({ step, label, at: new Date().toISOString(), detail });
  console.log(`[${step}] ${label}`);
};
let searchCalls = 0;
const realFetch: HttpFetch = async (url, init) => {
  if (url.startsWith('https://www.searchapi.io/')) searchCalls++;
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(45_000),
  });
  return { status: res.status, text: () => res.text() };
};

/** Live Crossmint staging probe: a POST that the provider refuses creates nothing; GET /orders reconciles. */
async function probeCrossmint(asin: string) {
  const key = env.CROSSMINT_API_KEY ?? '';
  if (env.CROSSMINT_ENV !== 'staging' || !key.startsWith('sk_staging_'))
    return { status: 'NOT_PROBED', reason: 'staging key absent' };
  const headers = { 'X-API-KEY': key, 'Content-Type': 'application/json' };
  const res = await fetch(`${CROSSMINT_STAGING_BASE}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      recipient: {
        email: 'test+synq@example.com',
        physicalAddress: {
          name: 'Synq Test',
          line1: '1600 Amphitheatre Pkwy',
          city: 'Mountain View',
          state: 'CA',
          postalCode: '94043',
          country: 'US',
        },
      },
      payment: { method: 'ethereum-sepolia', currency: 'usdc' },
      lineItems: [{ productLocator: `amazon:${asin}` }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = (await res.text()).split(key).join('[REDACTED]').slice(0, 300);
  const list = await fetch(`${CROSSMINT_STAGING_BASE}/orders`, {
    headers,
    signal: AbortSignal.timeout(45_000),
  });
  const orders = ((await list.json()) as { data?: unknown[] }).data ?? [];
  return {
    status: res.status,
    requestId: res.headers.get('x-request-id'),
    body: text,
    ordersAfterProbe: orders.length,
    deprecated: /WorldStore is deprecated/i.test(text),
  };
}

async function main() {
  for (const k of ['SEARCHAPI_KEY', 'LITHIC_API_KEY'])
    if (!env[k]) throw new Error(`${k} required (load ~/.synq/p11.env)`);
  if (env.LITHIC_ENV !== 'sandbox')
    throw new Error('LITHIC_ENV must be sandbox');
  const secrets = [
    env.SEARCHAPI_KEY,
    env.LITHIC_API_KEY,
    env.CROSSMINT_API_KEY,
    env.CROSSMINT_CLIENT_API_KEY,
  ].filter((s): s is string => !!s);
  const journey = new CommerceJourney(`cj-${now()}`, now);

  // 1. Chat → request draft. The budget is the mandate's, lowered by chat at most.
  const request = parseCommerceRequest(CHAT);
  if (!request?.asin) throw new Error('chat request without a product');
  const budget = effectiveBudget(MANDATE_CAP, request);
  record('chat', 'SYNQ_INTERNAL', {
    chat: CHAT,
    request,
    mandateCap: MANDATE_CAP,
    effectiveBudget: budget,
    authorizes: false,
  });

  // 2. Live discovery and exact matching.
  const caps = commerceCapabilities(env);
  const graph = new ProviderCapabilityGraph(caps);
  const amazon = new SearchApiDiscovery(
    'searchapi-amazon',
    env.SEARCHAPI_KEY!,
    realFetch,
    now,
    { evidence: 'MAINNET_READ_ONLY' },
  );
  const intent = EconomicIntentSchema.parse({
    id: `cj-${now()}`,
    groupId: GROUP,
    domain: 'COMMERCE',
    objective: `buy amazon:${request.asin}`,
    subject: {
      kind: 'PRODUCT',
      title: QUERY,
      asin: request.asin,
      condition: 'NEW',
    },
    hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
    preferences: [],
    budget: { max: budget },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 0,
    validUntil: now() + 3_600,
  });
  const search = await searchOffers({
    intent,
    providers: [amazon],
    graph,
    now,
    timeoutMs: 60_000,
  });
  const sel = selectOffers({ intent, search, now: now() });
  journey.advance('DISCOVERED', `${search.offers.length} live Amazon offers`, {
    source: 'searchapi-amazon',
  });
  record('discovery', 'MAINNET_READ_ONLY', {
    engine: 'amazon_search (live)',
    query: QUERY,
    offers: search.offers.length,
    sample: search.offers.slice(0, 8).map((o) => ({
      ref: o.providerRef,
      price: `${toDecimal(o.price.base)} USD`,
      title: o.subject.kind === 'PRODUCT' ? o.subject.title.slice(0, 70) : '',
      executable: o.executable,
    })),
  });
  const candidate = sel.ranked.find(
    (c) => c.offer.providerRef === `amazon:${request.asin}`,
  );
  record('matching', 'SYNQ_INTERNAL', {
    exact: sel.ranked.map((r) => ({
      ref: r.offer.providerRef,
      match: r.match,
    })),
    substitutesNotRanked: sel.recommendations.map((r) => ({
      ref: r.offer.providerRef,
      reasons: r.match.reasons,
    })),
    excluded: sel.rejected.slice(0, 10),
  });
  if (!candidate)
    throw new Error(`exact ASIN ${request.asin} not offered in this search`);
  journey.advance(
    'MATCHED',
    'exact ASIN match; other ASINs/variants excluded',
    { offer: candidate.offer.providerRef },
  );
  const reval = await revalidateOffer({
    intent,
    candidate,
    provider: amazon,
    graph,
    approvedMax: budget,
    now,
    timeoutMs: 60_000,
  });
  record('revalidation', 'MAINNET_READ_ONLY', {
    engine: 'amazon_product (live)',
    status: reval.status,
    ...(reval.status === 'EXECUTABLE'
      ? { landed: `${toDecimal(reval.landed)} USD` }
      : { reason: reval.reason }),
  });
  if (reval.status !== 'EXECUTABLE')
    throw new Error(`revalidation ${reval.status}`);
  const offer: EconomicOffer = reval.offer;
  journey.advance('REVALIDATED', `live price ${toDecimal(reval.landed)} USD`, {
    quote: offer.price.quoteId.slice(0, 120),
  });

  // 3. Who can actually execute this purchase?
  const crossmintProbe = await probeCrossmint(request.asin);
  record('crossmint-probe', 'BLOCKED_EXTERNAL', crossmintProbe);
  const crossmintReason =
    'deprecated' in crossmintProbe && crossmintProbe.deprecated
      ? 'BLOCKED_EXTERNAL: Crossmint WorldStore is deprecated and accepts no orders (HTTP 400)'
      : `BLOCKED_EXTERNAL: Crossmint staging order probe returned ${crossmintProbe.status}`;
  const capOf = (id: string) => caps.find((c) => c.providerId === id)!;
  const routes = [
    new EbayOrderRoute(capOf('ebay-order')),
    new CrossmintCheckoutRoute(
      {
        ...capOf('crossmint'),
        status: 'BLOCKED',
        statusReason: crossmintReason,
      },
      undefined,
      realFetch,
      null,
    ),
  ];
  const fabricCaps = settlementFabricCapabilities(env, {
    crossmint: { health: 'DOWN', reason: crossmintReason },
    [LITHIC]: { health: 'HEALTHY', reason: null },
  });
  const eligibility = checkoutEligibility({
    offer,
    routes,
    allowed: ['NATIVE_API', 'STABLECOIN_CHECKOUT', 'SCOPED_CARD'],
    fabric: fabricCaps,
  });
  record('eligibility', 'SYNQ_INTERNAL', {
    listing: eligibility.listing,
    path: eligibility.path,
    considered: eligibility.considered,
    statement: eligibility.statement,
  });
  journey.advance('PROVIDERS_IDENTIFIED', eligibility.statement, {
    path: eligibility.path,
  });
  if (eligibility.path !== 'SCOPED_CARD_HANDOFF')
    throw new Error(`unexpected path ${eligibility.path}`);

  // 4. Approval: Arc treasury reservation (live balance read) + Kernel grant from EIP-712 approvals.
  const arc = await connectChain('arc-testnet');
  const usdc = token('arc-testnet', 'USDC');
  const ownerKey = readFileSync(
    join(process.env.HOME!, '.synq', 'testnet.key'),
    'utf8',
  ).trim();
  const treasury = privateKeyToAccount(
    (ownerKey.startsWith('0x') ? ownerKey : `0x${ownerKey}`) as Hex,
  ).address;
  const confirmed = (await balanceOf(arc, usdc, treasury)).baseUnits;
  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: GROUP,
    assetId: usdc.assetId,
    confirmed,
    asOf: now(),
  });
  const capCents = BigInt(reval.landed.amount);
  const reservedUnits = capCents * 10n ** 4n; // USD cents at USDC par (6 decimals)
  const reservationId = `res-${intent.id}`;
  await reservations.reserve(
    {
      reservationId,
      groupId: GROUP,
      assetId: usdc.assetId,
      amount: String(reservedUnits),
      intentId: intent.id,
      purpose: 'COMMERCE',
      settlementPlanHash: 'plan:scoped-card:lithic-sandbox',
      expiresAt: now() + 1_800,
    },
    now(),
  );
  const freeBefore = await reservations.free(GROUP, usdc.assetId);
  record('arc-reservation', 'SYNQ_INTERNAL (balance: LIVE_ARC_TESTNET read)', {
    treasury,
    confirmedUsdc: toDecimal({
      amount: String(confirmed),
      currency: 'USDC',
      decimals: 6,
    }),
    reserved: toDecimal({
      amount: String(reservedUnits),
      currency: 'USDC',
      decimals: 6,
    }),
    note: 'a reservation holds Arc funds during checkout; it is not a payment and moves nothing on chain',
  });
  const keys = new EnvVaultKeyProvider({
    SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
  });
  const profiles = new MemoryProfileStore();
  const shipping = await new ProfileDirectory(profiles, keys, now).put({
    groupId: GROUP,
    kind: 'SHIPPING',
    data: {
      name: 'Synq Test',
      line1: '1600 Amphitheatre Pkwy',
      city: 'Mountain View',
      state: 'CA',
      postalCode: '94043',
      country: 'US',
      email: 'test+synq@example.com',
    },
  });
  const members = new Map(
    ['alice', 'bob', 'carol'].map((m) => [
      m,
      privateKeyToAccount(generatePrivateKey()),
    ]),
  );
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(randomBytes(32)),
    reservations,
    ledger: new MemoryEconomicGrantLedger(),
    approvals: {
      ledger: { isConsumed: async () => true },
      directory: {
        membershipEpoch: async (g) => (g === GROUP ? 1 : null),
        activeMember: async (g, memberId) => {
          const a = members.get(memberId);
          return g === GROUP && a
            ? {
                groupId: g,
                memberId,
                principalId: `fixture-${memberId}`,
                principalKind: 'LOCAL_FIXTURE',
                role: 'APPROVER',
                signer: a.address.toLowerCase() as `0x${string}`,
                membershipEpoch: 1,
                ownerOfAccount: true,
              }
            : null;
        },
      },
    },
  });
  await authority.install({
    mandateId: 'shopping',
    groupId: GROUP,
    version: 1,
    status: 'ACTIVE',
    domains: ['COMMERCE'],
    providers: [LITHIC],
    hosts: [LITHIC_SANDBOX_HOST],
    perActionCap: MANDATE_CAP,
    cumulativeBudget: MANDATE_CAP,
    autoApproveMax: usd(0),
    quorum: 2,
    members: [...members.keys()],
    approverKinds: ['LOCAL_FIXTURE'],
    maxQuoteAgeSeconds: 600,
    grantTtlSeconds: 600,
    environment: 'SANDBOX',
    validUntil: now() + 3_600,
  });
  const binding = {
    reservationId,
    planHash: 'plan:scoped-card:lithic-sandbox',
    reservedAssetId: usdc.assetId,
    reservedAmount: String(reservedUnits),
  };
  const execution = commerceExecution({
    offer,
    host: LITHIC_SANDBOX_HOST,
    providerId: LITHIC,
    maxAmount: reval.landed,
    reservation: binding,
    recipientRef: shipping.ref,
  });
  const authRequest = {
    intentId: intent.id,
    groupId: GROUP,
    mandateId: 'shopping',
    execution,
    quoteExpiresAt: offer.price.expiresAt,
    revalidatedAt: offer.price.revalidatedAt,
  };
  const requestHash = economicRequestHash(authRequest);
  journey.advance(
    'APPROVAL_PENDING',
    'quorum 2 of 3 EIP-712 approvals required',
    { requestHash },
  );
  const sign = async (
    memberId: string,
    i: number,
  ): Promise<VerifiedApproval> => {
    const a = members.get(memberId)!;
    return {
      schemaVersion: 1,
      approvalId: `apr-${i}-${intent.id}`,
      challengeId: `chl-${i}-${intent.id}`,
      groupId: GROUP as VerifiedApproval['groupId'],
      memberId: memberId as VerifiedApproval['memberId'],
      principalId: `fixture-${memberId}` as VerifiedApproval['principalId'],
      principalKind: 'LOCAL_FIXTURE',
      signer: a.address.toLowerCase() as `0x${string}`,
      draftDigest: requestHash,
      signature: await a.signTypedData(
        economicApprovalTypedData({
          groupId: GROUP,
          mandateId: 'shopping',
          requestHash,
        }),
      ),
      membershipEpoch: 1,
      verifiedAt: now(),
    };
  };
  const pending = await authority.authorize(
    authRequest,
    [await sign('alice', 1)],
    now(),
  );
  const decision = await authority.authorize(
    authRequest,
    [await sign('alice', 1), await sign('bob', 2)],
    now(),
  );
  if (decision.status !== 'AUTHORIZED')
    throw new Error(`grant ${decision.status}`);
  const grant = decision.grant;
  journey.advance('APPROVED', 'Kernel grant issued', {
    grantId: grant.grantId,
  });
  record('grant', 'SYNQ_INTERNAL', {
    oneApproval: pending.status,
    grantId: grant.grantId,
    approvals:
      'two LOCAL_FIXTURE members (ephemeral keys), EIP-712; not passkeys',
    binding: {
      providerId: grant.execution.providerId,
      host: grant.execution.host,
      offerId: grant.execution.offerId,
      maxAmount: `${toDecimal(grant.execution.maxAmount)} USD`,
      recipientRef: grant.execution.recipientRef,
    },
  });

  // 5. Rail and the sandbox card checkout (once).
  const fabricStore = new MemorySettlementFabricStore();
  const fabric = new SettlementFabric(fabricStore, reservations, now);
  const idempotencyKey = settlementIdempotencyKey({
    groupId: GROUP,
    intentId: intent.id,
    providerId: LITHIC,
    subject: offer.providerRef,
  });
  const order = await fabric.openOrder({
    intentId: intent.id,
    groupId: GROUP,
    providerId: LITHIC,
    mode: 'PROVIDER_SANDBOX',
    economicEffect: 'NONE_SANDBOX',
    idempotencyKey,
    amount: reval.landed,
  });
  const gate = await fabric.submitGate(order.providerOrderId);
  journey.advance(
    'RAIL_SELECTED',
    'CARD_NETWORK_SANDBOX via Lithic (PROVIDER_SANDBOX)',
    { order: order.providerOrderId.slice(0, 160) },
  );
  if (gate.action !== 'SUBMIT') throw new Error(`submit gate ${gate.action}`);
  await reservations.beginExecution(
    reservationId,
    { groupId: GROUP, settlementPlanHash: binding.planHash },
    now(),
  );
  await authority.consume(grant, execution, now());
  const lithic = new LithicSandboxClient(
    { apiKey: env.LITHIC_API_KEY!, environment: env.LITHIC_ENV },
    realFetch,
  );
  const memo = lithicCardMemo(idempotencyKey);
  const cents = Number(capCents);
  let cardType: 'SINGLE_USE' | 'VIRTUAL' = 'SINGLE_USE';
  let issued;
  try {
    issued = await lithic.createCard({
      spendLimitCents: cents,
      duration: 'TRANSACTION',
      memo,
      idempotencyKey: lithicIdempotencyKey(idempotencyKey),
      type: 'SINGLE_USE',
    });
  } catch (e) {
    record('card-type', 'PROVIDER_SANDBOX', {
      singleUse: 'refused',
      error: redactCardData((e as Error).message, env.LITHIC_API_KEY),
    });
    cardType = 'VIRTUAL';
    issued = await lithic.createCard({
      spendLimitCents: cents,
      duration: 'FOREVER',
      memo,
      idempotencyKey: lithicIdempotencyKey(`${idempotencyKey}:v`),
    });
  }
  const secret =
    issued.secret ?? (await lithic.getCard(issued.card.token)).secret;
  if (!secret) throw new Error('card issued without PAN access');
  const descriptor = 'AMAZON MKTPL SANDBOX-SIM';
  const auth = await lithic.simulateAuthorization(secret, {
    amountCents: cents,
    descriptor,
  });
  const second = await lithic.simulateAuthorization(secret, {
    amountCents: 100,
    descriptor: 'OTHER MERCHANT SIM',
  });
  record('card-checkout', 'PROVIDER_SANDBOX', {
    cardToken: issued.card.token,
    cardType,
    spendLimitCents: issued.card.spendLimit,
    authorization: {
      token: auth.transactionToken,
      approved: auth.approved,
      amountCents: cents,
      descriptor,
    },
    secondUse: {
      token: second.transactionToken,
      approved: second.approved,
      result: second.message,
    },
    note: 'Lithic sandbox simulates card network events; no card network, no Amazon order, no merchant charge',
  });
  if (!auth.approved || !auth.transactionToken)
    throw new Error(`authorization declined: ${auth.message}`);
  journey.advance(
    'HANDOFF',
    'human completes Amazon checkout with the scoped card; Synq places no Amazon order',
    { card: issued.card.token, authorization: auth.transactionToken },
  );

  // Reconcile at the provider by memo before trusting the local record.
  const found = await lithic.findCardByMemo(memo);
  const txs = found ? await lithic.listTransactions(found.token) : [];
  const approved = txs.find(
    (t) => t.token === auth.transactionToken && t.result === 'APPROVED',
  );
  if (!approved)
    throw new Error('reconcile: approved authorization not found at provider');
  await lithic.simulateClearing(auth.transactionToken);
  const receipt = await fabric.settleSandboxOrder({
    providerOrderId: order.providerOrderId,
    providerRefs: {
      authorization: auth.transactionToken,
      card: issued.card.token,
    },
    category: 'CARD_NETWORK_SANDBOX',
    providerName: 'Lithic',
    reservationIds: [reservationId],
    charged: reval.landed,
  });
  journey.advance(
    'RECONCILED',
    'provider reconciled by card memo; sandbox order settled to the simulated ledger',
    { receipt: receipt.receiptId.slice(0, 160) },
  );
  const cleared = await lithic.getTransaction(auth.transactionToken);
  record('reconcile', 'PROVIDER_SANDBOX', {
    foundByMemo: !!found,
    providerStatus: cleared.status,
    receipt,
    reservation: await reservations.get(reservationId),
    freeBefore,
    freeAfter: await reservations.free(GROUP, usdc.assetId),
    ledgers: await fabricStore.ledgerTotals(GROUP),
    delivery: 'NOT_TRACKED: no merchant order id exists (human handoff)',
  });

  // 6. Return: a provider-reported refund is a claim; it never credits the Arc treasury.
  const returnToken = await lithic.simulateReturn(secret, {
    amountCents: cents,
    descriptor,
  });
  const reported = await fabric.recordProviderRefund({
    providerOrderId: order.providerOrderId,
    refundId: `ret-${intent.id}`,
    amount: reval.landed,
    providerRef: returnToken,
  });
  let confirmAttempt = 'not attempted';
  try {
    await fabric.confirmRefund({
      providerOrderId: order.providerOrderId,
      refundId: `cfr-${intent.id}`,
      amount: reval.landed,
      onchain: null,
      reservationId,
      coreAmount: reservedUnits,
      observedCoreAmount: reservedUnits,
    });
    confirmAttempt = 'UNEXPECTEDLY_CONFIRMED';
  } catch (e) {
    confirmAttempt = (e as Error).message;
  }
  journey.advance(
    'REFUND_ACCEPTED',
    'sandbox return reported by the provider; not money received',
    { return: returnToken ?? 'none' },
  );
  await lithic.setCardState(issued.card.token, 'CLOSED').catch(() => undefined);
  record('refund', 'PROVIDER_SANDBOX', {
    returnToken,
    ledger: reported.ledger,
    treasuryCredit: reported.treasuryCredit,
    confirmIntoTreasury: confirmAttempt,
    ledgers: await fabricStore.ledgerTotals(GROUP),
    cardStateAfter: (await lithic.getCard(issued.card.token)).card.state,
  });
  if (confirmAttempt === 'UNEXPECTEDLY_CONFIRMED')
    throw new Error('sandbox refund credited the treasury');

  const agentView = journey.agentView();
  const report = {
    generatedAt: new Date().toISOString(),
    script: 'scripts/commerce-sandbox-proof.ts',
    label: 'PROVIDER_SANDBOX',
    labels: {
      discovery:
        'MAINNET_READ_ONLY (SearchApi.io live Amazon search and product)',
      crossmint: 'BLOCKED_EXTERNAL (live probe; no order created)',
      approvals: 'LOCAL_FIXTURE EIP-712 signatures (ephemeral keys)',
      arcReservation:
        'Synq internal reservation against a LIVE_ARC_TESTNET balance read; nothing moved on chain',
      card: 'PROVIDER_SANDBOX (Lithic sandbox: real sandbox API objects, simulated network events)',
      merchantOrder: 'NONE: Amazon has no order; checkout is a human handoff',
    },
    sandboxIds: {
      lithicCard: issued.card.token,
      lithicAuthorization: auth.transactionToken,
      lithicSecondUse: second.transactionToken,
      lithicReturn: returnToken,
    },
    distinctions: {
      arcTreasuryReservation: `${reservationId} (released; never captured)`,
      providerSandboxOrder: order.providerOrderId,
      realMerchantPayment: 'none',
      merchantOrderConfirmation: 'none (handoff)',
      refundReceivable: `${reported.refundId} PROVIDER_REPORTED_REFUND (claim)`,
      refundSettled: 'no: sandbox refunds never credit the treasury',
    },
    statement: receipt.statement,
    eligibility: { path: eligibility.path, statement: eligibility.statement },
    agentView,
    searchApiCalls: searchCalls,
    steps,
  };
  const text = JSON.stringify(
    report,
    (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  );
  for (const s of secrets)
    if (text.includes(s)) throw new Error('secret leaked into evidence');
  if (/\b\d{13,19}\b/.test(text))
    throw new Error('PAN-shaped number in evidence');
  const agentText = JSON.stringify(agentView);
  for (const pii of [
    '1600 Amphitheatre',
    'Mountain View',
    '94043',
    'test+synq@example.com',
  ])
    if (agentText.includes(pii))
      throw new Error('shipping PII reached the agent view');
  const integration = join(
    process.cwd(),
    '..',
    'synq-v13',
    'bounty-evidence',
    'commerce',
  );
  const dir = existsSync(
    join(process.cwd(), '..', 'synq-v13', 'bounty-evidence'),
  )
    ? integration
    : join(process.cwd(), 'bounty-evidence', 'commerce');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `commerce-sandbox-${stamp}.json`);
  writeFileSync(file, text + '\n');
  console.log(
    `card=${issued.card.token} auth=${auth.transactionToken} -> ${file}`,
  );
}

await main();
