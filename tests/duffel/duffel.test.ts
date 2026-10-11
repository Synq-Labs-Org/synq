import { describe, expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type EconomicIntent,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  DuffelStaysProvider,
  LiveKeyRefusedError,
  travelCapabilities,
} from '@synq/plugin-duffel';
import { FakeDuffel } from './fake-duffel.js';

const T = 1_780_000_000;
const now = () => T;
const TOKEN = 'duffel_test_fixture';
const gbp = (pence: number) => ({
  amount: String(pence),
  currency: 'GBP',
  decimals: 2,
});
const traveler = {
  givenName: 'Test',
  familyName: 'Traveler',
  bornOn: '1990-01-01',
  email: 'traveler@example.com',
  phone: '+442080160509',
};

function stayIntent(over: Record<string, unknown> = {}): EconomicIntent {
  return EconomicIntentSchema.parse({
    id: 'stay-1',
    groupId: 'group-1',
    domain: 'STAY',
    objective: 'two nights at the test hotel',
    subject: {
      kind: 'STAY',
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      rooms: 1,
      adults: 2,
      mealPlan: 'BREAKFAST',
      refundable: true,
      location: { latitude: -24.38, longitude: -128.32, radiusKm: 2 },
    },
    hardConstraints: [{ kind: 'REQUIRE_REFUNDABLE' }],
    preferences: [],
    budget: { max: gbp(30_000) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 200,
    validUntil: T + 3_600,
    ...over,
  });
}
function flightIntent(): EconomicIntent {
  return EconomicIntentSchema.parse({
    id: 'flight-1',
    groupId: 'group-1',
    domain: 'FLIGHT',
    objective: 'LHR to JFK with a bag',
    subject: {
      kind: 'FLIGHT',
      segments: [
        { origin: 'LHR', destination: 'JFK', departureDate: '2026-12-01' },
      ],
      adults: 1,
      cabin: 'economy',
      checkedBags: 1,
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: gbp(50_000) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 0,
    validUntil: T + 3_600,
  });
}
const env = { DUFFEL_TEST_TOKEN: TOKEN };
const setup = () => {
  const fake = new FakeDuffel(now);
  const client = new DuffelClient(TOKEN, fake.fetch);
  const graph = new ProviderCapabilityGraph(travelCapabilities(env));
  return {
    fake,
    graph,
    stays: new DuffelStaysProvider(client, now),
    flights: new DuffelFlightsProvider(client, now),
    exec: new DuffelBookingExecutor(client),
  };
};

describe('Duffel client and capabilities', () => {
  it('refuses live keys outright', () => {
    expect(
      () => new DuffelClient('duffel_live_abc', new FakeDuffel().fetch),
    ).toThrow(LiveKeyRefusedError);
    const caps = travelCapabilities({ DUFFEL_TEST_TOKEN: 'duffel_live_abc' });
    expect(caps.find((c) => c.providerId === 'duffel-stays')?.status).toBe(
      'BLOCKED',
    );
  });
  it('lists partner-gated travel providers truthfully and Duffel as missing creds without a token', () => {
    const caps = travelCapabilities({});
    expect(caps.find((c) => c.providerId === 'duffel-flights')?.status).toBe(
      'MISSING_CREDENTIALS',
    );
    for (const id of [
      'hbx',
      'booking-com-demand',
      'expedia-rapid',
      'travelport',
    ])
      expect(caps.find((c) => c.providerId === id)?.status).toBe(
        'PARTNER_GATED',
      );
  });
});

describe('Duffel Stays', () => {
  it('search -> normalize -> select a refundable breakfast rate', async () => {
    const { graph, stays } = setup();
    const intent = stayIntent();
    const r = await searchOffers({ intent, providers: [stays], graph, now });
    expect(r.offers).toHaveLength(3);
    const first = r.offers[0]!;
    expect(first.price).toMatchObject({ base: gbp(20_000), tax: gbp(4_000) });
    expect(first.evidence).toBe('PROVIDER_SANDBOX');
    const sel = selectOffers({ intent, search: r, now: T });
    expect(sel.selected?.offer.providerRef).toBe('rat_0000UNAVAILABLE');
    expect(sel.rejected.map((x) => x.offerId)).toContain(
      'duffel-stays:rat_0000AWr2VsUNIF1Vl91xg2',
    );
  });
  it('STAY-007 revalidation creates a quote; rate unavailable fails closed and re-ranks', async () => {
    const { graph, stays } = setup();
    const intent = stayIntent();
    const sel = selectOffers({
      intent,
      search: await searchOffers({ intent, providers: [stays], graph, now }),
      now: T,
    });
    const gone = await revalidateOffer({
      intent,
      candidate: sel.ranked[0]!,
      provider: stays,
      graph,
      approvedMax: gbp(30_000),
      now,
    });
    expect(gone.status).toBe('UNAVAILABLE');
    const next = await revalidateOffer({
      intent,
      candidate: sel.ranked[1]!,
      provider: stays,
      graph,
      approvedMax: gbp(30_000),
      now,
    });
    expect(next.status).toBe('EXECUTABLE');
    if (next.status === 'EXECUTABLE') {
      expect(next.offer.providerRef).toMatch(/^quo_/);
      expect(next.offer.price.revalidatedAt).toBe(T);
    }
  });
  it('STAY-006 a final price above the mandate blocks booking', async () => {
    const { fake, graph, stays } = setup();
    const intent = stayIntent();
    const sel = selectOffers({
      intent,
      search: await searchOffers({ intent, providers: [stays], graph, now }),
      now: T,
    });
    fake.faults.set('quote', { kind: 'PRICE_UP', amount: '260.00' });
    const r = await revalidateOffer({
      intent,
      candidate: sel.ranked[1]!,
      provider: stays,
      graph,
      approvedMax: gbp(30_000),
      now,
    });
    expect(r.status).toBe('PRICE_DRIFT');
  });
  it('books with an idempotency key and never duplicates', async () => {
    const { fake, exec } = setup();
    const a = await exec.bookStay({
      quoteId: 'quo_1',
      guests: [traveler],
      idempotencyKey: 'synq:stay-1:a',
    });
    expect(a).toMatchObject({ status: 'CONFIRMED', charged: gbp(24_000) });
    const b = await exec.bookStay({
      quoteId: 'quo_1',
      guests: [traveler],
      idempotencyKey: 'synq:stay-1:a',
    });
    expect(b).toEqual(a);
    expect(
      fake.calls.filter(
        (c) => c.method === 'POST' && c.path === '/stays/bookings',
      ),
    ).toHaveLength(1);
  });
  it('STAY-008 a timeout after commit reconciles to the existing booking, no second POST', async () => {
    const { fake, exec } = setup();
    fake.faults.set('book', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const first = await exec.bookStay({
      quoteId: 'quo_1',
      guests: [traveler],
      idempotencyKey: 'k-timeout',
    });
    expect(first.status).toBe('UNKNOWN');
    const found = await exec.findStayBooking('k-timeout');
    expect(found?.status).toBe('CONFIRMED');
    expect(fake.bookings.size).toBe(1);
    fake.faults.set('book', { kind: 'HTTP_500_AFTER_COMMIT' });
    expect(
      (
        await exec.bookStay({
          quoteId: 'quo_2',
          guests: [traveler],
          idempotencyKey: 'k-500',
        })
      ).status,
    ).toBe('UNKNOWN');
    expect((await exec.findStayBooking('k-500'))?.status).toBe('CONFIRMED');
  });
  it('a definitive 422 is FAILED; a 500 before commit stays UNKNOWN and reconciles to absent', async () => {
    const { fake, exec } = setup();
    fake.faults.set('book', { kind: 'RATE_UNAVAILABLE' });
    expect(
      await exec.bookStay({
        quoteId: 'q',
        guests: [traveler],
        idempotencyKey: 'k1',
      }),
    ).toMatchObject({ status: 'FAILED', code: '422:rate_unavailable' });
    fake.faults.set('book', { kind: 'HTTP_500_BEFORE_COMMIT' });
    expect(
      (
        await exec.bookStay({
          quoteId: 'q',
          guests: [traveler],
          idempotencyKey: 'k2',
        })
      ).status,
    ).toBe('UNKNOWN');
    expect(await exec.findStayBooking('k2')).toBeNull();
  });
  it('cancels a stay booking', async () => {
    const { exec } = setup();
    const b = await exec.bookStay({
      quoteId: 'q',
      guests: [traveler],
      idempotencyKey: 'k3',
    });
    if (b.status !== 'CONFIRMED') throw new Error('expected confirmation');
    expect((await exec.cancelStay(b.providerRef)).confirmed).toBe(true);
    expect((await exec.getStayBooking(b.providerRef)).status).toBe('CANCELED');
  });
});

describe('Duffel Flights / Duffel Airways', () => {
  it('FLT-002 search filters the fare without the required bag', async () => {
    const { graph, flights } = setup();
    const intent = flightIntent();
    const r = await searchOffers({ intent, providers: [flights], graph, now });
    expect(r.offers).toHaveLength(2);
    const sel = selectOffers({ intent, search: r, now: T });
    expect(sel.selected?.offer.providerRef).toBe('off_0000ZZtest');
    expect(sel.rejected[0]?.reasons).toContain('insufficient bags');
    expect(sel.selected?.offer.cancellation).toMatchObject({
      refundable: true,
      penalty: gbp(2_500),
    });
  });
  it('FLT-010 a price change on commit requires a new approval', async () => {
    const { fake, graph, flights } = setup();
    const intent = flightIntent();
    const sel = selectOffers({
      intent,
      search: await searchOffers({ intent, providers: [flights], graph, now }),
      now: T,
    });
    fake.faults.set('offer', { kind: 'PRICE_UP', amount: '320.00' });
    expect(
      (
        await revalidateOffer({
          intent,
          candidate: sel.selected!,
          provider: flights,
          graph,
          approvedMax: gbp(50_000),
          now,
        })
      ).status,
    ).toBe('PRICE_DRIFT');
  });
  it('FLT-007/FLT-008 order, get, quote cancellation then confirm (MOCKED)', async () => {
    const { flights, exec } = setup();
    const ids = await flights.passengerIds('off_0000ZZtest');
    const order = await exec.bookFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ids,
      passengers: [traveler],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'f1',
    });
    expect(order).toMatchObject({ status: 'CONFIRMED', charged: gbp(31_240) });
    if (order.status !== 'CONFIRMED') return;
    expect((await exec.getOrder(order.providerRef)).status).toBe('CONFIRMED');
    const quote = await exec.quoteFlightCancellation(order.providerRef);
    expect(quote).toMatchObject({
      confirmed: false,
      refund: gbp(28_740),
      refundTo: 'balance',
    });
    const done = await exec.confirmFlightCancellation(quote.cancellationId!);
    expect(done.confirmed).toBe(true);
    expect((await exec.getOrder(order.providerRef)).status).toBe('CANCELED');
  });
  it('FLT-005 a traveler count mismatch is blocked before any provider call', async () => {
    const { fake, exec } = setup();
    const r = await exec.bookFlight({
      offerId: 'off',
      passengerIds: ['pas_1', 'pas_2'],
      passengers: [traveler],
      amount: gbp(1),
      amountDecimal: '0.01',
      idempotencyKey: 'f2',
    });
    expect(r).toMatchObject({ status: 'FAILED', code: 'PASSENGER_MISMATCH' });
    expect(fake.calls).toHaveLength(0);
  });
  it('an order timeout after commit reconciles by metadata', async () => {
    const { fake, exec } = setup();
    fake.faults.set('order', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const r = await exec.bookFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'f3',
    });
    expect(r.status).toBe('UNKNOWN');
    expect((await exec.findFlightOrder('f3'))?.status).toBe('CONFIRMED');
    expect(fake.orders.size).toBe(1);
  });
});
