import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EconomicGrantAuthority, economicRequestHash } from '@synq/kernel';
import {
  approval,
  reservationsWith,
  approvalPorts,
  memoryLedger,
} from '../kernel/economic-fixtures.js';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type EconomicIntent,
  type EconomicOffer,
} from '@synq/offer-exchange';
import {
  CommerceExecutionRouter,
  CrossmintCheckoutRoute,
  EbayBrowseDiscovery,
  EbayOrderRoute,
  ImmersveCardRoute,
  SerpApiDiscovery,
  commerceCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';
import {
  commerceExecution,
  executeCommerceCheckout,
} from '../../workers/workflow/src/activities/commerce.js';

const T = 1_780_000_000;
const now = () => T;
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SERP_KEY = 'serp-secret-key-123';

function fetcher(fail?: { host: string; status: number }) {
  const calls: string[] = [];
  const f: HttpFetch = async (url) => {
    calls.push(url);
    const reply = (status: number, body: string) => ({
      status,
      text: async () => body,
    });
    if (fail && url.includes(fail.host))
      return reply(fail.status, '{"error":"upstream"}');
    if (url.startsWith('https://serpapi.com/search.json'))
      return reply(
        200,
        fixture(
          url.includes('engine=amazon')
            ? 'serpapi-amazon.json'
            : 'serpapi-google-shopping.json',
        ),
      );
    if (url.endsWith('/identity/v1/oauth2/token'))
      return reply(200, fixture('ebay-token.json'));
    if (url.includes('/buy/browse/v1/item_summary/search'))
      return reply(200, fixture('ebay-search.json'));
    if (url.includes('/buy/browse/v1/item/'))
      return reply(200, fixture('ebay-item.json'));
    return reply(404, '{}');
  };
  return { f, calls };
}

const intent: EconomicIntent = EconomicIntentSchema.parse({
  id: 'gift-1',
  groupId: 'group-1',
  domain: 'COMMERCE',
  objective: 'buy the exact phone as a gift',
  subject: {
    kind: 'PRODUCT',
    title: 'Acme Phone 12 128GB Blue',
    gtin: '0012345678905',
    brand: 'Acme',
    model: 'Phone 12',
    variant: { color: 'Blue', storage: '128GB' },
    condition: 'NEW',
  },
  hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
  preferences: [],
  budget: { max: { amount: '80000', currency: 'USD', decimals: 2 } },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  maxPriceDriftBps: 100,
  validUntil: T + 3_600,
});
const env = {
  SERPAPI_KEY: SERP_KEY,
  EBAY_CLIENT_ID: 'id',
  EBAY_CLIENT_SECRET: 'secret',
};

function stack(fail?: { host: string; status: number }) {
  const { f, calls } = fetcher(fail);
  const graph = new ProviderCapabilityGraph(commerceCapabilities(env));
  const amazon = new SerpApiDiscovery('serpapi-amazon', SERP_KEY, f, now, {
    evidence: 'MOCKED',
  });
  const gshop = new SerpApiDiscovery(
    'serpapi-google-shopping',
    SERP_KEY,
    f,
    now,
    { evidence: 'MOCKED' },
  );
  const ebay = new EbayBrowseDiscovery(
    { clientId: 'id', clientSecret: 'secret', environment: 'sandbox' },
    f,
    now,
    { evidence: 'MOCKED' },
  );
  return { graph, amazon, gshop, ebay, calls, f };
}

describe('commerce discovery', () => {
  it('COM-003 two sources in parallel; only GTIN-proven eBay listings are price comparable', async () => {
    const s = stack();
    const r = await searchOffers({
      intent,
      providers: [s.amazon, s.gshop, s.ebay],
      graph: s.graph,
      now,
    });
    expect(r.coverage.label).toBe('3/3 providers healthy');
    const sel = selectOffers({ intent, search: r, now: T });
    expect(sel.ranked.map((x) => x.offer.offerId)).toEqual([
      'ebay-browse:v1|110000000001|0',
      'ebay-browse:v1|110000000003|0',
    ]);
    expect(sel.ranked[0]!.match.basis).toBe('GTIN');
    expect(sel.ranked[0]!.landed.amount).toBe('74900');
    expect(sel.ranked[1]!.landed.amount).toBe('76500');
    const recs = sel.recommendations.map((x) => x.offer.offerId);
    expect(recs).toContain('serpapi-amazon:amazon:B0TESTPH01');
    expect(recs).toContain('ebay-browse:v1|110000000002|0');
    expect(
      sel.recommendations.find((x) => x.offer.offerId.endsWith('B0TESTPH02'))
        ?.match.level,
    ).toBe('SUBSTITUTE');
  });
  it('OFFER-001 an eBay outage keeps SerpAPI results and never leaks the API key', async () => {
    const s = stack({ host: 'ebay.com', status: 503 });
    const r = await searchOffers({
      intent,
      providers: [s.amazon, s.ebay],
      graph: s.graph,
      now,
    });
    expect(r.outcomes.find((o) => o.providerId === 'ebay-browse')?.status).toBe(
      'FAILED',
    );
    expect(r.offers.length).toBeGreaterThan(0);
    const t = stack({ host: 'serpapi.com', status: 401 });
    const r2 = await searchOffers({
      intent,
      providers: [t.amazon],
      graph: t.graph,
      now,
    });
    expect(JSON.stringify(r2)).not.toContain(SERP_KEY);
    expect(JSON.stringify(t.graph.health(T))).not.toContain(SERP_KEY);
  });
  it('OFFER-009 missing commerce credentials are explicit', () => {
    const caps = commerceCapabilities({});
    expect(caps.find((c) => c.providerId === 'serpapi-amazon')?.status).toBe(
      'MISSING_CREDENTIALS',
    );
    expect(caps.find((c) => c.providerId === 'ebay-order')?.status).toBe(
      'PARTNER_GATED',
    );
    expect(caps.find((c) => c.providerId === 'crossmint')?.status).toBe(
      'MISSING_CREDENTIALS',
    );
    expect(
      commerceCapabilities({ CROSSMINT_API_KEY: 'sk_production_x' }).find(
        (c) => c.providerId === 'crossmint',
      )?.status,
    ).toBe('BLOCKED');
  });
});

describe('commerce checkout (simulation through the Kernel)', () => {
  const usd = (c: number) => ({
    amount: String(c),
    currency: 'USD',
    decimals: 2,
  });
  async function revalidated() {
    const s = stack();
    const sel = selectOffers({
      intent,
      search: await searchOffers({
        intent,
        providers: [s.amazon, s.ebay],
        graph: s.graph,
        now,
      }),
      now: T,
    });
    const r = await revalidateOffer({
      intent,
      candidate: sel.ranked[0]!,
      provider: s.ebay,
      graph: s.graph,
      approvedMax: usd(80_000),
      now,
    });
    if (r.status !== 'EXECUTABLE') throw new Error(r.status);
    return { s, offer: r.offer, landed: r.landed, sel };
  }
  function router(caps = commerceCapabilities(env)) {
    const c = (id: string) => caps.find((x) => x.providerId === id)!;
    return new CommerceExecutionRouter([
      new EbayOrderRoute(c('ebay-order')),
      new CrossmintCheckoutRoute(
        c('crossmint'),
        undefined,
        async () => ({ status: 500, text: async () => '' }),
        null,
      ),
      new ImmersveCardRoute(c('immersve'), {
        supportedRegions: [],
        settlementPrincipalId: null,
        credentialsPresent: false,
      }),
    ]);
  }
  const RES_ASSET = 'eip155:10143/erc20:ausd';
  let reservations: Awaited<ReturnType<typeof reservationsWith>>;
  async function authority() {
    reservations = await reservationsWith(
      'group-1',
      RES_ASSET,
      [
        {
          reservationId: 'res-gift',
          amount: '1000',
          planHash: '0xplan',
          expiresAt: T + 3_600,
        },
      ],
      T,
    );
    const a = new EconomicGrantAuthority({
      key: new Uint8Array(32).fill(5),
      reservations,
      ledger: memoryLedger(),
      approvals: approvalPorts(['alice', 'bob']),
    });
    await a.install({
      mandateId: 'gifts',
      groupId: 'group-1',
      version: 1,
      status: 'ACTIVE',
      domains: ['COMMERCE'],
      providers: ['ebay-order', 'crossmint', 'immersve'],
      hosts: ['api.ebay.com', 'staging.crossmint.com', 'api.immersve.com'],
      perActionCap: usd(100_000),
      cumulativeBudget: usd(200_000),
      autoApproveMax: usd(0),
      quorum: 1,
      members: ['alice', 'bob'],
      approverKinds: ['LOCAL_FIXTURE'],
      maxQuoteAgeSeconds: 300,
      grantTtlSeconds: 300,
      environment: 'SANDBOX',
      validUntil: T + 86_400,
    });
    return a;
  }
  const reservation = {
    reservationId: 'res-gift',
    planHash: '0xplan',
    reservedAssetId: RES_ASSET,
    reservedAmount: '1000',
  };
  async function granted(
    a: EconomicGrantAuthority,
    offer: EconomicOffer,
    landed: { amount: string; currency: string; decimals: number },
    host: string,
    providerId: string,
    intentId: string,
  ) {
    const r = {
      intentId,
      groupId: 'group-1',
      mandateId: 'gifts',
      execution: commerceExecution({
        offer,
        host,
        providerId,
        maxAmount: landed,
        reservation,
        recipientRef: 'recipient:ref:1',
      }),
      quoteExpiresAt: offer.price.expiresAt,
      revalidatedAt: offer.price.revalidatedAt,
    };
    const d = await a.authorize(
      r,
      [await approval('alice', economicRequestHash(r), { mandateId: 'gifts' })],
      T,
    );
    if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
    return d.grant;
  }
  it('COM-007 revalidation via eBay getItem makes the offer executable', async () => {
    const { offer } = await revalidated();
    expect(offer.executable).toBe(true);
    expect((offer.subject as { gtin?: string }).gtin).toBe('0012345678905');
  });
  it('eBay listing: native API gated -> simulated checkout, never ORDER_PLACED', async () => {
    const { offer, landed } = await revalidated();
    const decision = router().decide(offer, [
      'NATIVE_API',
      'STABLECOIN_CHECKOUT',
      'SCOPED_CARD',
    ]);
    expect(decision.kind).toBe('SIMULATE');
    if (decision.kind !== 'SIMULATE') return;
    expect(decision.route.providerId).toBe('ebay-order');
    const a = await authority();
    const grant = await granted(
      a,
      offer,
      landed,
      decision.route.host,
      decision.route.providerId,
      intent.id,
    );
    const recipients: string[] = [];
    const deps = {
      authority: a,
      reservations,
      now,
      resolveRecipient: async (ref: string) => (
        recipients.push(ref),
        {
          name: 'x',
          email: 'x@example.com',
          line1: '1',
          city: 'c',
          postalCode: 'p',
          country: 'US',
        }
      ),
    };
    const run = () =>
      executeCommerceCheckout(deps, {
        intentId: intent.id,
        decision,
        offer,
        grant,
        reservation,
        recipientRef: 'recipient:ref:1',
        idempotencyKey: 'gift-1-key',
      });
    expect(await run()).toMatchObject({
      kind: 'RECEIPT',
      receipt: {
        state: 'SIMULATED_CHECKOUT',
        evidence: 'SIMULATED',
        providerRef: null,
      },
    });
    expect(recipients).toEqual([]);
    expect((await reservations.get('res-gift'))?.state).toBe('EXECUTING');
    expect(await run()).toMatchObject({ kind: 'REFUSED' });
  });
  it('commerce checkout moves the reservation to EXECUTING before consuming the grant', async () => {
    const { offer, landed } = await revalidated();
    const decision = router().decide(offer, ['NATIVE_API']);
    if (decision.kind === 'HANDOFF') throw new Error('handoff');
    const a = await authority();
    const grant = await granted(
      a,
      offer,
      landed,
      decision.route.host,
      decision.route.providerId,
      'i-exec',
    );
    await reservations.release('res-gift', 'expired elsewhere', T);
    const deps = {
      authority: a,
      reservations,
      now,
      resolveRecipient: async () => {
        throw new Error('must not decrypt');
      },
    };
    const out = await executeCommerceCheckout(deps, {
      intentId: 'i-exec',
      decision,
      offer,
      grant,
      reservation,
      recipientRef: 'recipient:ref:1',
      idempotencyKey: 'gift-exec-key',
    });
    expect(out).toMatchObject({
      kind: 'REFUSED',
      reason: expect.stringMatching(/INVALID_RESERVATION_TRANSITION/),
    });
    expect(await a.isConsumed(grant.grantId)).toBe(false);
  });
  it('COM-008/COM-009/COM-001 the checked execution is rebuilt from the offer and route actually used', async () => {
    const { offer, landed } = await revalidated();
    const decision = router().decide(offer, ['NATIVE_API']);
    if (decision.kind === 'HANDOFF') throw new Error('handoff');
    const a = await authority();
    const grant = await granted(
      a,
      offer,
      landed,
      decision.route.host,
      decision.route.providerId,
      'i2',
    );
    const deps = {
      authority: a,
      reservations,
      now,
      resolveRecipient: async () => {
        throw new Error('must not decrypt');
      },
    };
    const run = (
      o: EconomicOffer,
      d = decision,
      recipientRef = 'recipient:ref:1',
    ) =>
      executeCommerceCheckout(deps, {
        intentId: 'i2',
        decision: d,
        offer: o,
        grant,
        reservation,
        recipientRef,
        idempotencyKey: 'k',
      });
    const product = offer.subject as Extract<
      EconomicOffer['subject'],
      { kind: 'PRODUCT' }
    >;
    expect(
      await run({ ...offer, subject: { ...product, quantity: 2 } }),
    ).toMatchObject({
      kind: 'REFUSED',
      reason: expect.stringMatching(/quantity|item/),
    });
    const evilRoute = Object.assign(
      Object.create(Object.getPrototypeOf(decision.route)),
      decision.route,
      { host: 'evil.example.com' },
    );
    expect(await run(offer, { ...decision, route: evilRoute })).toMatchObject({
      kind: 'REFUSED',
      reason: expect.stringMatching(/merchant host/),
    });
    expect(
      await run({
        ...offer,
        subject: { ...product, variant: { color: 'Red' } },
      }),
    ).toMatchObject({ reason: expect.stringMatching(/item/) });
    expect(await run(offer, decision, 'other-address')).toMatchObject({
      reason: expect.stringMatching(/recipient/),
    });
    const pricier = {
      ...offer,
      price: {
        ...offer.price,
        shipping: { ...offer.price.shipping, amount: '500' },
      },
    };
    expect(await run(pricier)).toMatchObject({
      kind: 'REFUSED',
      reason: 'landed price exceeds the grant',
    });
  });
  it('CARD-010 a placed order charging more than the grant opens an incident', async () => {
    const { offer, landed } = await revalidated();
    const caps = commerceCapabilities(env);
    const route = {
      mode: 'STABLECOIN_CHECKOUT' as const,
      providerId: 'crossmint',
      host: 'staging.crossmint.com',
      capability: {
        ...caps.find((c) => c.providerId === 'crossmint')!,
        status: 'READY' as const,
      },
      supports: () => true,
      sandboxReady: () => true,
      place: async () => ({
        state: 'ORDER_PLACED' as const,
        orderRef: 'ord-1',
        charged: { ...landed, amount: String(BigInt(landed.amount) + 1n) },
      }),
    };
    const decision = new CommerceExecutionRouter([route]).decide(offer, [
      'STABLECOIN_CHECKOUT',
    ]);
    expect(decision.kind).toBe('EXECUTE');
    const a = await authority();
    const grant = await granted(
      a,
      offer,
      landed,
      route.host,
      route.providerId,
      'i3',
    );
    const out = await executeCommerceCheckout(
      {
        authority: a,
        reservations,
        now,
        resolveRecipient: async () => ({
          name: 'x',
          email: 'x@example.com',
          line1: '1',
          city: 'c',
          postalCode: 'p',
          country: 'US',
        }),
      },
      {
        intentId: 'i3',
        decision,
        offer,
        grant,
        reservation,
        recipientRef: 'recipient:ref:1',
        idempotencyKey: 'gift-k3-key',
      },
    );
    expect(out).toMatchObject({
      kind: 'INCIDENT',
      reason: 'charged amount exceeds the grant',
    });
  });
  it('COM-010 Crossmint unavailable: the ladder follows mandate policy down to handoff', async () => {
    const { sel } = await revalidated();
    const amazonOffer = sel.recommendations.find((x) =>
      x.offer.offerId.endsWith('B0TESTPH01'),
    )!.offer;
    const r = router();
    const sim = r.decide(amazonOffer, ['STABLECOIN_CHECKOUT', 'SCOPED_CARD']);
    expect(sim).toMatchObject({
      kind: 'SIMULATE',
      route: { providerId: 'crossmint' },
    });
    expect(r.decide(amazonOffer, ['SCOPED_CARD'])).toMatchObject({
      kind: 'SIMULATE',
      route: { providerId: 'immersve' },
    });
    const h = r.decide(amazonOffer, []);
    expect(h.kind).toBe('HANDOFF');
    expect(
      h.considered.every((c) => c.verdict === 'not allowed by mandate'),
    ).toBe(true);
  });
  it('CARD-003/004/005 Immersve requires the KYC-approved settlement principal in a supported region', () => {
    const caps = commerceCapabilities({
      IMMERSVE_CLIENT_ID: 'x',
      IMMERSVE_CLIENT_SECRET: 'y',
    });
    const route = new ImmersveCardRoute(
      caps.find((c) => c.providerId === 'immersve')!,
      {
        supportedRegions: ['NZ', 'AU'],
        settlementPrincipalId: 'alice',
        credentialsPresent: true,
      },
    );
    expect(
      route.eligibility({
        principalId: 'bob',
        kycStatus: 'APPROVED',
        residenceCountry: 'NZ',
      }),
    ).toEqual({ eligible: false, code: 'WRONG_SETTLEMENT_PRINCIPAL' });
    expect(
      route.eligibility({
        principalId: 'alice',
        kycStatus: 'PENDING',
        residenceCountry: 'NZ',
      }),
    ).toEqual({ eligible: false, code: 'KYC_INCOMPLETE' });
    expect(
      route.eligibility({
        principalId: 'alice',
        kycStatus: 'APPROVED',
        residenceCountry: 'IN',
      }),
    ).toEqual({ eligible: false, code: 'REGION_UNSUPPORTED' });
    expect(
      route.eligibility({
        principalId: 'alice',
        kycStatus: 'APPROVED',
        residenceCountry: 'NZ',
      }),
    ).toEqual({ eligible: true });
    expect(caps.find((c) => c.providerId === 'immersve')?.kycRequired).toBe(
      true,
    );
  });
});
