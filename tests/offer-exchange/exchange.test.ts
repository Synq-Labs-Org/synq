import { describe, expect, it } from 'vitest';
import {
  EconomicOfferSchema,
  NotExecutableError,
  ProviderCapabilityGraph,
  assertExecutable,
  convert,
  credentialStatus,
  fromDecimal,
  landedTotal,
  matchFlight,
  matchProduct,
  matchStay,
  rankCandidates,
  resolveProperty,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type FlightSubject,
  type ProductSubject,
  type StaySubject,
} from '@synq/offer-exchange';
import {
  FakeProvider,
  NOW,
  capability,
  graphOf,
  hang,
  intent,
  offer,
  phone,
  usd,
} from './fixtures.js';

const product = phone as ProductSubject;
const now = () => NOW;

describe('money', () => {
  it('converts conservatively with exact integers', () => {
    const eur = fromDecimal('10.01', 'EUR', 2);
    const out = convert(eur, { currency: 'USD', decimals: 6 }, [
      {
        from: 'EUR',
        to: 'USD',
        numerator: '108',
        denominator: '100',
        source: 'fixture',
        observedAt: NOW,
      },
    ]);
    expect(out).toEqual({ amount: '10810800', currency: 'USD', decimals: 6 });
    expect(() => convert(eur, { currency: 'GBP', decimals: 2 }, [])).toThrow(
      /FX_RATE_MISSING/,
    );
  });
  it('lands price + shipping + tax + fees + fx', () => {
    const o = EconomicOfferSchema.parse(
      offer('a', 'p1', 1000, {
        price: {
          quoteId: 'q',
          base: { amount: '1000', currency: 'EUR', decimals: 2 },
          shipping: { amount: '500', currency: 'EUR', decimals: 2 },
          tax: { amount: '201', currency: 'EUR', decimals: 2 },
          fees: { amount: '0', currency: 'EUR', decimals: 2 },
          fx: [
            {
              from: 'EUR',
              to: 'USD',
              numerator: '11',
              denominator: '10',
              source: 'f',
              observedAt: NOW,
            },
          ],
          quotedAt: NOW,
          expiresAt: NOW + 60,
          revalidatedAt: null,
        },
      }),
    );
    expect(landedTotal(o, { currency: 'USD', decimals: 2 }).amount).toBe(
      String(1100 + 550 + 222),
    );
  });
});

describe('OFFER fan-out and capability graph', () => {
  it('OFFER-001 a provider timeout keeps other results and marks coverage', async () => {
    const graph = graphOf(capability('fast'), capability('slow'));
    const r = await searchOffers({
      intent: intent(),
      providers: [
        new FakeProvider('fast', [offer('a', 'fast', 900)]),
        new FakeProvider('slow', hang),
      ],
      graph,
      now,
      timeoutMs: 50,
    });
    expect(r.offers.map((o) => o.offerId)).toEqual(['a']);
    expect(r.coverage.label).toBe('1/2 providers healthy');
    expect(r.outcomes.find((o) => o.providerId === 'slow')?.status).toBe(
      'TIMEOUT',
    );
    expect(graph.health(NOW).find((h) => h.providerId === 'slow')?.status).toBe(
      'DEGRADED',
    );
  });
  it('OFFER-002 an error payload is isolated and invalid offers are dropped', async () => {
    const graph = graphOf(
      capability('ok'),
      capability('bad'),
      capability('junk'),
    );
    const r = await searchOffers({
      intent: intent(),
      providers: [
        new FakeProvider('ok', [offer('a', 'ok', 900)]),
        new FakeProvider('bad', () =>
          Promise.reject(new Error('500 upstream')),
        ),
        new FakeProvider('junk', [
          { ...offer('b', 'junk', 1), price: { nope: true } } as never,
          offer('c', 'someone-else', 5),
        ]),
      ],
      graph,
      now,
    });
    expect(r.offers.map((o) => o.offerId)).toEqual(['a']);
    expect(r.invalid).toHaveLength(2);
    expect(r.outcomes.find((o) => o.providerId === 'bad')?.status).toBe(
      'FAILED',
    );
  });
  it('OFFER-003 duplicates merge without losing provenance', () => {
    const a = offer('same', 'merchant', 900, { discoveryProviderId: 'serp' });
    const b = offer('same', 'merchant', 950, { discoveryProviderId: 'ebay' });
    const sel = selectOffers({
      intent: intent(),
      search: {
        offers: [a, b].map((o) => EconomicOfferSchema.parse(o)),
        invalid: [],
        outcomes: [],
        coverage: { healthy: 2, total: 2, label: '2/2' },
      },
      now: NOW,
    });
    expect(sel.ranked).toHaveLength(1);
    expect(sel.selected?.offer.discoveryProviderId).toBe('serp');
    expect(sel.selected?.offer.alsoDiscoveredBy).toEqual(['ebay']);
  });
  it('OFFER-008/009 credential-gated providers are explicit and never searched', async () => {
    const gated = credentialStatus(
      capability('duffel', { credentialEnv: ['DUFFEL_TEST_TOKEN'] }),
      {},
    );
    expect(gated.status).toBe('MISSING_CREDENTIALS');
    const hbx = capability('hbx', { status: 'PARTNER_GATED' });
    const graph = graphOf(gated, hbx, capability('ok'));
    const gatedProvider = new FakeProvider('duffel', [offer('x', 'duffel', 1)]);
    const r = await searchOffers({
      intent: intent(),
      providers: [
        gatedProvider,
        new FakeProvider('hbx', []),
        new FakeProvider('ok', []),
      ],
      graph,
      now,
    });
    expect(gatedProvider.calls).toBe(0);
    expect(
      r.outcomes.filter((o) => o.status === 'SKIPPED').map((o) => o.providerId),
    ).toEqual(['duffel', 'hbx']);
    expect(graph.usable('ok', 'PURCHASE', NOW)).toBe(false);
    const health = graph.health(NOW);
    expect(health.find((h) => h.providerId === 'hbx')?.authState).toBe(
      'BLOCKED',
    );
    expect(health.find((h) => h.providerId === 'duffel')?.authState).toBe(
      'MISSING_CREDENTIALS',
    );
  });
  it('OFFER-010 repeated failures open the circuit; others continue', async () => {
    const graph = new ProviderCapabilityGraph(
      [capability('flaky'), capability('ok')],
      { failureThreshold: 2, cooldownSeconds: 30 },
    );
    const flaky = new FakeProvider('flaky', () =>
      Promise.reject(new Error('429')),
    );
    const ok = new FakeProvider('ok', [offer('a', 'ok', 1)]);
    for (let i = 0; i < 3; i++)
      await searchOffers({
        intent: intent(),
        providers: [flaky, ok],
        graph,
        now,
      });
    expect(flaky.calls).toBe(2);
    expect(ok.calls).toBe(3);
    expect(
      graph.health(NOW).find((h) => h.providerId === 'flaky'),
    ).toMatchObject({
      circuit: 'OPEN',
      status: 'DOWN',
    });
    expect(graph.usable('flaky', 'DISCOVER', NOW + 31)).toBe(true);
  });
});

describe('ranking and selection', () => {
  const search = (offers: ReturnType<typeof offer>[]) => ({
    offers: offers.map((o) => EconomicOfferSchema.parse(o)),
    invalid: [],
    outcomes: [],
    coverage: { healthy: 1, total: 1, label: '1/1' },
  });
  it('OFFER-007 ranking is deterministic regardless of input order', () => {
    const offers = [
      offer('c', 'p3', 900),
      offer('a', 'p1', 900),
      offer('b', 'p2', 800, {
        price: { ...offer('b', 'p2', 800).price!, shipping: usd(150) } as never,
      }),
    ];
    const one = selectOffers({
      intent: intent(),
      search: search(offers),
      now: NOW,
    });
    const two = selectOffers({
      intent: intent(),
      search: search([...offers].reverse()),
      now: NOW,
    });
    expect(one.ranked.map((r) => r.offer.offerId)).toEqual(['a', 'c', 'b']);
    expect(two.ranked.map((r) => r.offer.offerId)).toEqual(['a', 'c', 'b']);
    expect(one.selected?.explanation).toMatch(
      /landed 900 USD\/2 EXACT_MATCH via GTIN/,
    );
  });
  it('OFFER-005 substitution NONE never auto-selects a variant change', () => {
    const red = offer('red', 'p1', 500, {
      subject: { ...product, variant: { ...product.variant, color: 'Red' } },
    });
    const sel = selectOffers({
      intent: intent(),
      search: search([red, offer('blue', 'p2', 900)]),
      now: NOW,
    });
    expect(sel.selected?.offer.offerId).toBe('blue');
    expect(sel.recommendations.map((r) => r.offer.offerId)).toEqual(['red']);
  });
  it('OFFER-006 EQUIVALENT switches only within hard constraints', () => {
    const red = offer('red', 'p1', 500, {
      subject: { ...product, variant: { ...product.variant, color: 'Red' } },
    });
    const pricey = offer('red2', 'p3', 200_000, {
      subject: { ...product, variant: { ...product.variant, color: 'Red' } },
    });
    const sel = selectOffers({
      intent: intent({
        autonomy: { execution: 'QUORUM', substitution: 'EQUIVALENT' },
      }),
      search: search([red, pricey, offer('blue', 'p2', 900)]),
      now: NOW,
    });
    expect(sel.selected?.offer.offerId).toBe('red');
    expect(sel.selected?.match.level).toBe('NEAR_EQUIVALENT');
    expect(sel.rejected.find((r) => r.offerId === 'red2')?.reasons).toContain(
      'over budget',
    );
  });
  it('COM-005 delivery deadline misses are filtered', () => {
    const late = offer('late', 'p1', 100, {
      subject: { ...product, deliverBy: NOW + 10 * 86_400 },
    });
    const ontime = offer('ok', 'p2', 900, {
      subject: { ...product, deliverBy: NOW + 86_400 },
    });
    const sel = selectOffers({
      intent: intent({
        hardConstraints: [{ kind: 'DELIVER_BY', at: NOW + 2 * 86_400 }],
      }),
      search: search([late, ontime]),
      now: NOW,
    });
    expect(sel.selected?.offer.offerId).toBe('ok');
    expect(sel.rejected[0]?.reasons).toContain('delivery after deadline');
  });
  it('COM-006 a strong return-policy preference reorders the ranking', () => {
    const cheapFinal = offer('final', 'p1', 800, {
      cancellation: {
        kind: 'NON_REFUNDABLE',
        refundable: false,
        freeUntil: null,
        penalty: null,
        changeable: false,
      },
    });
    const refundable = offer('ret', 'p2', 900);
    const base = selectOffers({
      intent: intent(),
      search: search([cheapFinal, refundable]),
      now: NOW,
    });
    expect(base.selected?.offer.offerId).toBe('final');
    const pref = selectOffers({
      intent: intent({ preferences: [{ key: 'REFUNDABLE', weight: 80 }] }),
      search: search([cheapFinal, refundable]),
      now: NOW,
    });
    expect(pref.selected?.offer.offerId).toBe('ret');
  });
  it('OFFER-004 expired quotes are rejected at selection', () => {
    const expired = offer('old', 'p1', 1, {
      price: { ...offer('old', 'p1', 1).price!, expiresAt: NOW - 1 } as never,
    });
    const sel = selectOffers({
      intent: intent(),
      search: search([expired]),
      now: NOW,
    });
    expect(sel.selected).toBeNull();
    expect(sel.rejected[0]?.reasons).toContain('quote expired');
  });
  it('FLT-004 layover constraint filters routes', () => {
    const direct = offer('d', 'p1', 900, { stops: 0 });
    const twoStop = offer('s', 'p2', 500, { stops: 2 });
    const sel = selectOffers({
      intent: intent({ hardConstraints: [{ kind: 'MAX_STOPS', max: 1 }] }),
      search: search([direct, twoStop]),
      now: NOW,
    });
    expect(sel.selected?.offer.offerId).toBe('d');
  });
  it('rank candidates is a pure function of input', () => {
    expect(rankCandidates(intent(), [])).toEqual([]);
  });
});

describe('COM product matching', () => {
  it('COM-003 GTIN exact match, including UPC/EAN padding', () => {
    const r = matchProduct(
      product,
      { ...product, gtin: '12345678905', title: 'different title' },
      'NONE',
    );
    expect(r).toMatchObject({ level: 'EXACT_MATCH', basis: 'GTIN' });
    expect(
      matchProduct(
        product,
        { ...product, gtin: '0012345678912' },
        'ANY_COMPLIANT',
      ).level,
    ).toBe('NOT_COMPARABLE');
  });
  it('COM-002 refurbished never replaces new, even with substitution allowed', () => {
    const r = matchProduct(
      product,
      { ...product, condition: 'REFURBISHED' },
      'ANY_COMPLIANT',
    );
    expect(r.level).toBe('SUBSTITUTE');
  });
  it('COM-001 wrong variant (color/region/revision/warranty) is not exact', () => {
    for (const v of [
      { color: 'Red' },
      { region: 'EU' },
      { revision: 'B' },
      { warranty: 'none' },
    ]) {
      const got = { ...product, variant: { ...product.variant, ...v } };
      expect(
        matchProduct(
          {
            ...product,
            variant: { ...product.variant, revision: 'A', warranty: '1y' },
          },
          got,
          'NONE',
        ).level,
      ).toBe('SUBSTITUTE');
    }
  });
  it('COM-004 fuzzy title is supporting only', () => {
    const want: ProductSubject = {
      kind: 'PRODUCT',
      title: 'Acme Phone 12 Blue 128GB',
      variant: {},
      condition: 'NEW',
      attributes: {},
      quantity: 1,
    };
    const got: ProductSubject = {
      ...want,
      title: 'Acme Phone 12 128GB Blue (renewed)',
    };
    expect(matchProduct(want, got, 'ANY_COMPLIANT').level).toBe('SUBSTITUTE');
  });
  it('MPN mismatch and brand mismatch are not comparable', () => {
    const noGtin = { ...product, gtin: undefined };
    expect(
      matchProduct(noGtin, { ...noGtin, mpn: 'X' }, 'ANY_COMPLIANT').level,
    ).toBe('NOT_COMPARABLE');
    expect(
      matchProduct(noGtin, { ...noGtin, brand: 'Other' }, 'ANY_COMPLIANT')
        .level,
    ).toBe('NOT_COMPARABLE');
  });
});

describe('STAY matching', () => {
  const stay: StaySubject = {
    kind: 'STAY',
    propertyName: 'Harbour View Hotel',
    providerPropertyIds: { duffel: 'acc_1' },
    coordinates: { latitude: -24.38, longitude: -128.32 },
    checkIn: '2026-11-01',
    checkOut: '2026-11-03',
    rooms: 1,
    adults: 2,
    children: 0,
    roomCategory: 'Double',
    mealPlan: 'BREAKFAST',
    refundable: true,
  };
  it('STAY-001 same hotel under different provider ids resolves by geo+name', () => {
    const other: StaySubject = {
      ...stay,
      providerPropertyIds: { hbx: '998' },
      coordinates: { latitude: -24.3801, longitude: -128.3201 },
    };
    expect(resolveProperty(stay, other)).toMatchObject({
      same: true,
      basis: 'GEO_NAME',
    });
  });
  it('STAY-002 similar names far apart or below threshold stay separate', () => {
    const far: StaySubject = {
      ...stay,
      providerPropertyIds: {},
      coordinates: { latitude: -24.4, longitude: -128.32 },
    };
    expect(resolveProperty(stay, far).same).toBe(false);
    const nearDifferent: StaySubject = {
      ...stay,
      providerPropertyIds: {},
      propertyName: 'Harbour Inn Budget Rooms',
    };
    expect(resolveProperty(stay, nearDifferent).same).toBe(false);
  });
  it('STAY-003 non-refundable is never equivalent to a refundable request', () => {
    expect(
      matchStay(stay, { ...stay, refundable: false }, 'ANY_COMPLIANT').level,
    ).toBe('NOT_COMPARABLE');
  });
  it('STAY-004 breakfast mismatch is surfaced', () => {
    const r = matchStay(stay, { ...stay, mealPlan: 'ROOM_ONLY' }, 'EQUIVALENT');
    expect(r).toMatchObject({
      level: 'NEAR_EQUIVALENT',
      reasons: ['meal plan differs'],
    });
    expect(
      matchStay(stay, { ...stay, mealPlan: 'ROOM_ONLY' }, 'NONE').level,
    ).toBe('SUBSTITUTE');
  });
  it('STAY-005 occupancy mismatch excludes the rate', () => {
    expect(matchStay(stay, { ...stay, adults: 1 }, 'ANY_COMPLIANT').level).toBe(
      'NOT_COMPARABLE',
    );
  });
});

describe('FLT matching', () => {
  const flight: FlightSubject = {
    kind: 'FLIGHT',
    segments: [
      { origin: 'LHR', destination: 'JFK', departureDate: '2026-12-01' },
    ],
    adults: 1,
    cabin: 'economy',
    fareFamily: 'Standard',
    checkedBags: 1,
  };
  it('FLT-002 baggage requirement rejects noncompliant fares', () => {
    expect(
      matchFlight(flight, { ...flight, checkedBags: 0 }, 'ANY_COMPLIANT').level,
    ).toBe('NOT_COMPARABLE');
  });
  it('FLT-003 fare family mismatch is explained', () => {
    expect(
      matchFlight(flight, { ...flight, fareFamily: 'Basic' }, 'EQUIVALENT'),
    ).toMatchObject({
      level: 'NEAR_EQUIVALENT',
      reasons: ['fare family differs'],
    });
  });
  it('route, date and cabin are hard', () => {
    expect(
      matchFlight(flight, { ...flight, cabin: 'business' }, 'ANY_COMPLIANT')
        .level,
    ).toBe('NOT_COMPARABLE');
    expect(
      matchFlight(
        flight,
        {
          ...flight,
          segments: [{ ...flight.segments[0]!, departureDate: '2026-12-02' }],
        },
        'ANY_COMPLIANT',
      ).level,
    ).toBe('NOT_COMPARABLE');
  });
});

describe('revalidation gate', () => {
  const setup = (fresh: ConstructorParameters<typeof FakeProvider>[2]) => {
    const graph = graphOf(capability('p1'));
    const provider = new FakeProvider('p1', [], fresh);
    const sel = selectOffers({
      intent: intent(),
      search: {
        offers: [EconomicOfferSchema.parse(offer('a', 'p1', 1000))],
        invalid: [],
        outcomes: [],
        coverage: { healthy: 1, total: 1, label: '1/1' },
      },
      now: NOW,
    });
    return { graph, provider, candidate: sel.ranked[0]! };
  };
  const quote = (base: number, expiresAt = NOW + 600) => ({
    ...EconomicOfferSchema.parse(offer('a', 'p1', base)).price,
    base: usd(base),
    expiresAt,
  });
  it('COM-007 a search quote is not executable before revalidation', () => {
    const { candidate } = setup(undefined);
    expect(() => assertExecutable(candidate.offer, NOW)).toThrow(
      NotExecutableError,
    );
  });
  it('revalidated within drift becomes executable', async () => {
    const { graph, provider, candidate } = setup((o) => ({
      price: quote(1010),
      subject: o.subject,
      available: true,
      providerRef: o.providerRef,
    }));
    const r = await revalidateOffer({
      intent: intent(),
      candidate,
      provider,
      graph,
      approvedMax: usd(1100),
      now,
    });
    expect(r.status).toBe('EXECUTABLE');
    if (r.status === 'EXECUTABLE') {
      expect(() => assertExecutable(r.offer, NOW)).not.toThrow();
      expect(() => assertExecutable(r.offer, NOW + 301)).toThrow(/stale/);
    }
  });
  it('STAY-006/FLT-010 price drift above mandate blocks execution', async () => {
    const { graph, provider, candidate } = setup((o) => ({
      price: quote(1050),
      subject: o.subject,
      available: true,
      providerRef: o.providerRef,
    }));
    const r = await revalidateOffer({
      intent: intent(),
      candidate,
      provider,
      graph,
      approvedMax: usd(1100),
      now,
    });
    expect(r).toMatchObject({ status: 'PRICE_DRIFT' });
    const capped = await revalidateOffer({
      intent: intent({ maxPriceDriftBps: 1000 }),
      candidate,
      provider,
      graph,
      approvedMax: usd(1020),
      now,
    });
    expect(capped).toMatchObject({ status: 'PRICE_DRIFT' });
  });
  it('STAY-007/FLT-001 an expired final quote requires a fresh quote', async () => {
    const { graph, provider, candidate } = setup((o) => ({
      price: quote(1000, NOW - 1),
      subject: o.subject,
      available: true,
      providerRef: o.providerRef,
    }));
    const r = await revalidateOffer({
      intent: intent(),
      candidate,
      provider,
      graph,
      approvedMax: usd(1100),
      now,
    });
    expect(r.status).toBe('EXPIRED');
  });
  it('identity change at revalidation is a mismatch', async () => {
    const { graph, provider, candidate } = setup((o) => ({
      price: quote(1000),
      subject: { ...product, variant: { ...product.variant, color: 'Red' } },
      available: true,
      providerRef: o.providerRef,
    }));
    const r = await revalidateOffer({
      intent: intent(),
      candidate,
      provider,
      graph,
      approvedMax: usd(1100),
      now,
    });
    expect(r.status).toBe('MISMATCH');
  });
  it('unavailable and failing providers fail closed', async () => {
    const gone = setup((o) => ({
      price: quote(1000),
      subject: o.subject,
      available: false,
      providerRef: o.providerRef,
    }));
    expect(
      (
        await revalidateOffer({
          intent: intent(),
          ...gone,
          approvedMax: usd(1100),
          now,
        })
      ).status,
    ).toBe('UNAVAILABLE');
    const broken = setup(() => {
      throw new Error('503');
    });
    expect(
      (
        await revalidateOffer({
          intent: intent(),
          ...broken,
          approvedMax: usd(1100),
          now,
        })
      ).status,
    ).toBe('PROVIDER_UNAVAILABLE');
  });
});
