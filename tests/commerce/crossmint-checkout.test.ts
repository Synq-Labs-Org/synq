import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encodeFunctionData,
  parseAbi,
  serializeTransaction,
  type Hex,
} from 'viem';
import { EconomicGrantAuthority, economicRequestHash } from '@synq/kernel';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type EconomicOffer,
  type Money,
} from '@synq/offer-exchange';
import {
  CROSSMINT_STAGING_CHAINS,
  CommerceExecutionRouter,
  CrossmintCheckoutRoute,
  CrossmintEnvironmentError,
  SearchApiDiscovery,
  commerceCapabilities,
  type CrossmintPayer,
  type HttpFetch,
  type VerifiedPayment,
} from '@synq/plugin-commerce';
import {
  commerceExecution,
  commerceGrantCap,
  executeCommerceCheckout,
  reconcileCommerceCheckout,
} from '../../workers/workflow/src/activities/commerce.js';
import {
  MemorySettlementFabricStore,
  SettlementFabric,
} from '@synq/settlement';
import {
  approval,
  approvalPorts,
  memoryLedger,
  reservationsWith,
} from '../kernel/economic-fixtures.js';

const T = 1_780_000_000;
let clock = T;
const now = () => clock;
const SK = 'sk_staging_TESTONLY0123456789abcdef';
const PAYER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x00000000000000000000000000000000000c0ffe';
const CHAIN = 'ethereum-sepolia' as const;
const USDC = CROSSMINT_STAGING_CHAINS[CHAIN].usdc;
const ASIN = 'B01GGKZ1VA';
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const usd = (c: number): Money => ({
  amount: String(c),
  currency: 'USD',
  decimals: 2,
});

/** Unsigned EIP-1559 USDC transfer shaped like Crossmint's payment preparation. */
function paymentTx(
  amount: bigint,
  opts: {
    chainId?: number;
    to?: string;
    memo?: boolean;
    recipient?: string;
  } = {},
): Hex {
  const data = encodeFunctionData({
    abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
    functionName: 'transfer',
    args: [(opts.recipient ?? DEPOSIT) as Hex, amount],
  });
  return serializeTransaction({
    type: 'eip1559',
    chainId: opts.chainId ?? CROSSMINT_STAGING_CHAINS[CHAIN].chainId,
    to: (opts.to ?? USDC) as Hex,
    data: (opts.memo === false ? data : `${data}deadbeef`) as Hex,
    value: 0n,
    nonce: 7,
    gas: 90_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  });
}

type OrderOpts = {
  unit?: string;
  tax?: string;
  total?: string;
  locator?: string;
  paymentStatus?: string;
  txAmount?: bigint;
  txTo?: string;
  txRecipient?: string;
  payer?: string | null;
  quoteStatus?: string;
};
/** Order object per the documented Crossmint OrderObject schema. */
function order(o: OrderOpts = {}) {
  const total = o.total ?? '6.84';
  return {
    orderId: 'b2959ca5-65e4-466a-bd26-1bd05cb4f837',
    phase: 'payment',
    locale: 'en-US',
    lineItems: [
      {
        chain: CHAIN,
        quantity: 1,
        ...(o.locator ? { productLocator: o.locator } : {}),
        quote: {
          status: 'valid',
          charges: {
            unit: { amount: o.unit ?? '6.29', currency: 'usdc' },
            salesTax: { amount: o.tax ?? '0.55', currency: 'usdc' },
            shipping: { amount: '0', currency: 'usdc' },
          },
          totalPrice: { amount: total, currency: 'usdc' },
        },
        delivery: { status: 'awaiting-payment' },
      },
    ],
    quote: {
      status: o.quoteStatus ?? 'valid',
      quotedAt: '2026-10-12T00:00:00.000Z',
      expiresAt: '2026-10-12T01:00:00.000Z',
      totalPrice: { amount: total, currency: 'usdc' },
    },
    payment: {
      status: o.paymentStatus ?? 'awaiting-payment',
      method: CHAIN,
      currency: 'usdc',
      preparation: {
        chain: CHAIN,
        ...(o.payer === null ? {} : { payerAddress: o.payer ?? PAYER }),
        serializedTransaction: paymentTx(o.txAmount ?? 6_840_000n, {
          ...(o.txTo ? { to: o.txTo } : {}),
          ...(o.txRecipient ? { recipient: o.txRecipient } : {}),
        }),
      },
    },
  };
}

function crossmintServer(
  opts: {
    create?: { status: number; body: string };
    order?: OrderOpts;
    afterPay?: string;
    list?: unknown[];
  } = {},
) {
  const calls: { method: string; url: string; body?: string }[] = [];
  let paid = false;
  const f: HttpFetch = async (url, init) => {
    calls.push({
      method: init.method,
      url,
      ...(init.body ? { body: init.body } : {}),
    });
    const reply = (status: number, body: unknown) => ({
      status,
      text: async () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    });
    expect(
      url.startsWith('https://staging.crossmint.com/api/2022-06-09/'),
    ).toBe(true);
    expect(init.headers['X-API-KEY']).toBe(SK);
    if (init.method === 'POST' && url.endsWith('/orders')) {
      if (opts.create) return reply(opts.create.status, opts.create.body);
      return reply(201, { clientSecret: 'cs', order: order(opts.order) });
    }
    if (init.method === 'POST' && url.endsWith('/payment')) {
      paid = true;
      return reply(200, order(opts.order));
    }
    if (init.method === 'GET' && url.includes('/orders?'))
      return reply(200, { data: opts.list ?? [] });
    if (init.method === 'GET') {
      const o = order(opts.order);
      return reply(200, {
        ...o,
        payment: {
          ...o.payment,
          status: paid ? (opts.afterPay ?? 'completed') : o.payment.status,
        },
      });
    }
    return reply(404, { error: true, message: 'Not found' });
  };
  return { f, calls };
}

function payer(outcome: 'success' | 'reverted' | 'throw' = 'success') {
  const paid: VerifiedPayment[] = [];
  const p: CrossmintPayer = {
    address: PAYER,
    chain: CHAIN,
    pay: async (tx) => {
      paid.push(tx);
      if (outcome === 'throw') throw new Error('rpc timeout');
      return { txHash: `0x${'ab'.repeat(32)}`, status: outcome };
    },
  };
  return { p, paid };
}

const config = {
  apiKey: SK,
  environment: 'staging',
  chain: CHAIN,
  paymentRecipients: [DEPOSIT],
} as const;
const caps = () =>
  commerceCapabilities({
    SEARCHAPI_KEY: 'k',
    CROSSMINT_API_KEY: SK,
    CROSSMINT_ENV: 'staging',
  });
const crossmintCap = () => caps().find((c) => c.providerId === 'crossmint')!;

const intent = EconomicIntentSchema.parse({
  id: 'cable-1',
  groupId: 'group-1',
  domain: 'COMMERCE',
  objective: 'buy this exact cable',
  subject: {
    kind: 'PRODUCT',
    title: 'Amazon Basics USB-C to USB-C cable',
    asin: ASIN,
    brand: 'Amazon Basics',
    condition: 'NEW',
  },
  hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
  preferences: [],
  budget: { max: usd(1_000) },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  maxPriceDriftBps: 100,
  validUntil: T + 3_600,
});

async function revalidated() {
  const search: HttpFetch = async (url) => ({
    status: 200,
    text: async () =>
      fixture(
        url.includes('engine=amazon_product')
          ? 'searchapi-amazon-product.json'
          : 'searchapi-amazon-search.json',
      ),
  });
  const graph = new ProviderCapabilityGraph(caps());
  const amazon = new SearchApiDiscovery('searchapi-amazon', 'k', search, now, {
    evidence: 'MOCKED',
  });
  const sel = selectOffers({
    intent,
    search: await searchOffers({ intent, providers: [amazon], graph, now }),
    now: T,
  });
  const r = await revalidateOffer({
    intent,
    candidate: sel.ranked[0]!,
    provider: amazon,
    graph,
    approvedMax: usd(1_000),
    now,
  });
  if (r.status !== 'EXECUTABLE') throw new Error(r.status);
  return { offer: r.offer, landed: r.landed };
}

const RES_ASSET = 'eip155:11155111/erc20:usdc';
const reservation = {
  reservationId: 'res-cable',
  planHash: '0xplan',
  reservedAssetId: RES_ASSET,
  reservedAmount: '10000000',
};

async function setup(grantTtlSeconds = 300) {
  clock = T;
  const reservations = await reservationsWith(
    'group-1',
    RES_ASSET,
    [
      {
        reservationId: 'res-cable',
        amount: '10000000',
        planHash: '0xplan',
        expiresAt: T + 3_600,
      },
    ],
    T,
  );
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(32).fill(9),
    reservations,
    ledger: memoryLedger(),
    approvals: approvalPorts(['alice', 'bob']),
  });
  await authority.install({
    mandateId: 'gifts',
    groupId: 'group-1',
    version: 1,
    status: 'ACTIVE',
    domains: ['COMMERCE'],
    providers: ['crossmint'],
    hosts: ['staging.crossmint.com'],
    perActionCap: usd(1_000),
    cumulativeBudget: usd(5_000),
    autoApproveMax: usd(0),
    quorum: 1,
    members: ['alice', 'bob'],
    approverKinds: ['LOCAL_FIXTURE'],
    maxQuoteAgeSeconds: 300,
    grantTtlSeconds,
    environment: 'SANDBOX',
    validUntil: T + 86_400,
  });
  const { offer, landed } = await revalidated();
  const cap = commerceGrantCap(landed, 1_500);
  const request = {
    intentId: intent.id,
    groupId: 'group-1',
    mandateId: 'gifts',
    execution: commerceExecution({
      offer,
      host: 'staging.crossmint.com',
      providerId: 'crossmint',
      maxAmount: cap,
      reservation,
      recipientRef: 'pv_recipient',
    }),
    quoteExpiresAt: offer.price.expiresAt,
    revalidatedAt: offer.price.revalidatedAt,
  };
  const d = await authority.authorize(
    request,
    [
      await approval('alice', economicRequestHash(request), {
        mandateId: 'gifts',
      }),
    ],
    T,
  );
  if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
  return { reservations, authority, offer, landed, cap, grant: d.grant };
}

const recipient = {
  name: 'Synq Test',
  email: 'test+synq@example.com',
  line1: '1600 Amphitheatre Pkwy',
  city: 'Mountain View',
  state: 'CA',
  postalCode: '94043',
  country: 'US',
};

async function run(
  s: Awaited<ReturnType<typeof setup>>,
  route: CrossmintCheckoutRoute,
  offer: EconomicOffer = s.offer,
  fabric?: SettlementFabric,
) {
  const decision = new CommerceExecutionRouter([route]).decide(offer, [
    'STABLECOIN_CHECKOUT',
  ]);
  return executeCommerceCheckout(
    {
      authority: s.authority,
      reservations: s.reservations,
      now,
      resolveRecipient: async () => recipient,
      ...(fabric ? { fabric } : {}),
    },
    {
      intentId: intent.id,
      decision,
      offer,
      grant: s.grant,
      reservation,
      recipientRef: 'pv_recipient',
      idempotencyKey: 'cable-1-checkout',
    },
  );
}
const route = (f: HttpFetch, p: CrossmintPayer | null) =>
  new CrossmintCheckoutRoute(crossmintCap(), config, f, p, {
    pollAttempts: 3,
    sleep: async () => {},
  });

describe('Crossmint staging checkout through the Kernel grant', () => {
  it('pays exactly the verified USDC transfer once the quote fits the grant', async () => {
    const s = await setup();
    expect(s.cap.amount).toBe('724');
    const server = crossmintServer();
    const { p, paid } = payer();
    const out = await run(s, route(server.f, p));
    expect(out).toMatchObject({
      kind: 'RECEIPT',
      receipt: {
        state: 'ORDER_PLACED',
        evidence: 'PROVIDER_SANDBOX',
        providerRef: 'b2959ca5-65e4-466a-bd26-1bd05cb4f837',
        charged: { amount: '6840000', currency: 'USDC', decimals: 6 },
        grantId: s.grant.grantId,
      },
      payment: { chain: CHAIN, chainId: 11155111 },
    });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ amount: 6_840_000n, token: USDC });
    const create = JSON.parse(server.calls[0]!.body!);
    expect(create).toEqual({
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
      payment: { method: CHAIN, currency: 'usdc', payerAddress: PAYER },
      lineItems: [{ productLocator: `amazon:${ASIN}` }],
    });
    expect(server.calls[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        type: 'crypto-tx-id',
        txId: `0x${'ab'.repeat(32)}`,
      }),
    });
    expect(JSON.stringify(out)).not.toContain(SK);
  });

  it('a price increase holds before paying', async () => {
    const s = await setup();
    const { p, paid } = payer();
    const out = await run(
      s,
      route(crossmintServer({ order: { unit: '6.30', total: '6.85' } }).f, p),
    );
    expect(out).toMatchObject({
      kind: 'HOLD',
      reason: 'price increased since the grant',
    });
    expect(paid).toHaveLength(0);
    expect((await s.reservations.get('res-cable'))?.state).toBe('HELD');
  });

  it('a quote above the grant cap (tax/shipping) holds before paying', async () => {
    const s = await setup();
    const { p, paid } = payer();
    const out = await run(
      s,
      route(
        crossmintServer({
          order: { tax: '1.00', total: '7.29', txAmount: 7_290_000n },
        }).f,
        p,
      ),
    );
    expect(out).toMatchObject({
      kind: 'HOLD',
      reason: 'quote total exceeds the grant',
      quoted: { amount: '7290000' },
    });
    expect(paid).toHaveLength(0);
  });

  it('a different product in the provider order holds; a different ASIN offer is refused by the Kernel', async () => {
    const s = await setup();
    const { p, paid } = payer();
    expect(
      await run(
        s,
        route(
          crossmintServer({ order: { locator: 'amazon:B000000000' } }).f,
          p,
        ),
      ),
    ).toMatchObject({
      kind: 'HOLD',
      reason: 'order item differs from the granted product',
    });
    const t = await setup();
    const product = t.offer.subject as Extract<
      EconomicOffer['subject'],
      { kind: 'PRODUCT' }
    >;
    const server = crossmintServer();
    const swapped = {
      ...t.offer,
      providerRef: 'amazon:B0DPN758M2',
      subject: { ...product, asin: 'B0DPN758M2' },
    };
    expect(await run(t, route(server.f, p), swapped)).toMatchObject({
      kind: 'REFUSED',
      reason: expect.stringMatching(/GRANT_BINDING: item/),
    });
    expect(server.calls).toHaveLength(0);
    expect(paid).toHaveLength(0);
  });

  it('a payment transaction that does not match the quote is never signed', async () => {
    for (const bad of [
      { txAmount: 6_840_001n },
      { txTo: '0x000000000000000000000000000000000000dead' },
      { payer: '0x000000000000000000000000000000000000beef' },
      { paymentStatus: 'requires-crypto-payer-address' },
      { quoteStatus: 'expired' },
    ]) {
      const s = await setup();
      const { p, paid } = payer();
      const out = await run(s, route(crossmintServer({ order: bad }).f, p));
      expect(out.kind).toBe('HOLD');
      expect(paid).toHaveLength(0);
    }
  });

  it('KYC step-up pauses instead of being bypassed', async () => {
    const s = await setup();
    const { p, paid } = payer();
    expect(
      await run(
        s,
        route(
          crossmintServer({ order: { paymentStatus: 'requires-kyc' } }).f,
          p,
        ),
      ),
    ).toMatchObject({ kind: 'HOLD', stepUp: 'KYC' });
    expect(paid).toHaveLength(0);
  });

  it('an expired grant is refused before any provider call', async () => {
    const s = await setup(60);
    clock = T + 61;
    const server = crossmintServer();
    const { p } = payer();
    expect(await run(s, route(server.f, p))).toMatchObject({
      kind: 'REFUSED',
      reason: expect.stringMatching(/GRANT_EXPIRED/),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('a replayed checkout is refused; the provider sees one order', async () => {
    const s = await setup();
    const server = crossmintServer();
    const { p, paid } = payer();
    const r = route(server.f, p);
    expect((await run(s, r)).kind).toBe('RECEIPT');
    expect(await run(s, r)).toMatchObject({ kind: 'REFUSED' });
    expect(
      server.calls.filter(
        (c) => c.method === 'POST' && c.url.endsWith('/orders'),
      ),
    ).toHaveLength(1);
    expect(paid).toHaveLength(1);
  });

  it('non-staging configuration is refused at construction', () => {
    const { p } = payer();
    const f: HttpFetch = async () => {
      throw new Error('must not call');
    };
    for (const bad of [
      { ...config, environment: 'production' },
      { ...config, environment: undefined },
      { ...config, apiKey: 'sk_production_abc' },
      { ...config, baseUrl: 'https://www.crossmint.com/api/2022-06-09' },
      { ...config, baseUrl: 'http://staging.crossmint.com/api/2022-06-09' },
      { ...config, chain: 'ethereum' as never },
    ])
      expect(
        () => new CrossmintCheckoutRoute(crossmintCap(), bad, f, p),
      ).toThrow(CrossmintEnvironmentError);
    expect(
      commerceCapabilities({
        CROSSMINT_API_KEY: SK,
        CROSSMINT_ENV: 'production',
      }).find((c) => c.providerId === 'crossmint')?.status,
    ).toBe('BLOCKED');
  });

  it('a provider 5xx on create is ambiguous: HOLD, then reconcile releases only when no order exists', async () => {
    const s = await setup();
    const body = fixture('crossmint-staging-create-500.json').replace(
      'Error:',
      `Error (${SK}):`,
    );
    const server = crossmintServer({ create: { status: 500, body } });
    const { p, paid } = payer();
    const r = route(server.f, p);
    const out = await run(s, r);
    expect(out).toMatchObject({
      kind: 'HOLD',
      reason: expect.stringMatching(/CROSSMINT_HTTP_500/),
      receipt: { state: 'UNKNOWN_PROVIDER_OUTCOME', providerRef: null },
    });
    expect(JSON.stringify(out)).not.toContain(SK);
    expect(paid).toHaveLength(0);
    expect((await s.reservations.get('res-cable'))?.state).toBe('HELD');
    expect(
      await reconcileCommerceCheckout(
        { reservations: s.reservations, now },
        {
          route: r,
          reservationId: 'res-cable',
          orderRef: null,
          paymentBroadcast: false,
          since: T,
        },
      ),
    ).toMatchObject({ status: 'RELEASED' });
    expect((await s.reservations.get('res-cable'))?.state).toBe('RELEASED');
  });

  it('a broadcast payment the provider has not confirmed stays HELD after reconciliation', async () => {
    const s = await setup();
    const server = crossmintServer({ afterPay: 'in-progress' });
    const { p } = payer();
    const r = route(server.f, p);
    const out = await run(s, r);
    expect(out).toMatchObject({
      kind: 'HOLD',
      reason: expect.stringMatching(/not confirmed/),
      payment: { txHash: `0x${'ab'.repeat(32)}` },
    });
    const rec = await reconcileCommerceCheckout(
      { reservations: s.reservations, now },
      {
        route: r,
        reservationId: 'res-cable',
        orderRef: out.kind === 'HOLD' ? out.receipt.providerRef : null,
        paymentBroadcast: true,
        since: T,
      },
    );
    expect(rec).toMatchObject({ status: 'STILL_HELD' });
    expect((await s.reservations.get('res-cable'))?.state).toBe('HELD');
  });

  it('an unknown broadcast outcome holds and is never retried', async () => {
    const s = await setup();
    const server = crossmintServer();
    const { p, paid } = payer('throw');
    const out = await run(s, route(server.f, p));
    expect(out).toMatchObject({
      kind: 'HOLD',
      reason: expect.stringMatching(/broadcast outcome unknown/),
    });
    expect(paid).toHaveLength(1);
  });
});

describe('Crossmint payment pinning and fabric orders (security re-check)', () => {
  it('SEC-L3 a USDC transfer to an unpinned recipient, or with no pinned recipients, holds before paying', async () => {
    const s = await setup();
    const { p, paid } = payer();
    const wrong = await run(
      s,
      route(
        crossmintServer({
          order: { txRecipient: '0x000000000000000000000000000000000000beef' },
        }).f,
        p,
      ),
    );
    expect(wrong).toMatchObject({
      kind: 'HOLD',
      reason: expect.stringMatching(/not a pinned Crossmint address/),
    });
    const s2 = await setup();
    const unpinned = new CrossmintCheckoutRoute(
      crossmintCap(),
      { ...config, paymentRecipients: [] },
      crossmintServer().f,
      p,
      { pollAttempts: 1, sleep: async () => {} },
    );
    expect(await run(s2, unpinned)).toMatchObject({
      kind: 'HOLD',
      reason: expect.stringMatching(/not pinned/),
    });
    expect(paid).toHaveLength(0);
  });

  it('SEC-L3 reconcile without an order id never adopts an order that does not name our payer', async () => {
    const { p } = payer();
    const anonymous = order({ payer: null });
    const r = route(crossmintServer({ list: [anonymous] }).f, p);
    expect(await r.reconcile({ orderRef: null, since: T })).toEqual({
      status: 'NOT_FOUND',
    });
    const ours = route(crossmintServer({ list: [order()] }).f, p);
    expect((await ours.reconcile({ orderRef: null, since: T })).status).toBe(
      'FOUND',
    );
  });

  it('SEC-L2 a paid Crossmint order is TESTNET_SETTLED with a testnet debit; a reconciled no-order run is FAILED', async () => {
    const s = await setup();
    const fabric = new SettlementFabric(
      new MemorySettlementFabricStore(),
      s.reservations,
      now,
    );
    const { p } = payer();
    const out = await run(s, route(crossmintServer().f, p), s.offer, fabric);
    expect(out.kind).toBe('RECEIPT');
    const o = await fabric.store.findOrder('crossmint', 'cable-1-checkout');
    expect(o!.state).toBe('TESTNET_SETTLED');
    const rc = await fabric.store.getReceipt(`sr-${o!.providerOrderId}`);
    expect(rc!.treasuryEffect).toBe('TESTNET_DEBIT');
    expect(rc!.providerRefs.txHash).toBe(`0x${'ab'.repeat(32)}`);

    const s2 = await setup();
    const fabric2 = new SettlementFabric(
      new MemorySettlementFabricStore(),
      s2.reservations,
      now,
    );
    const r2 = route(
      crossmintServer({ create: { status: 500, body: '{}' } }).f,
      p,
    );
    const held = await run(s2, r2, s2.offer, fabric2);
    expect(held.kind).toBe('HOLD');
    const o2 = await fabric2.store.findOrder('crossmint', 'cable-1-checkout');
    expect(o2!.state).toBe('UNKNOWN_OUTCOME');
    await reconcileCommerceCheckout(
      { reservations: s2.reservations, now, fabric: fabric2 },
      {
        route: r2,
        reservationId: 'res-cable',
        orderRef: null,
        paymentBroadcast: false,
        since: T,
        idempotencyKey: 'cable-1-checkout',
      },
    );
    expect((await fabric2.store.getOrder(o2!.providerOrderId))!.state).toBe(
      'FAILED',
    );
  });
});
