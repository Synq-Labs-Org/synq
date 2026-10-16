import { describe, expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
  NotExecutableError,
  ProviderCapabilityGraph,
  assertExecutable,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type EconomicIntent,
  type EconomicOffer,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  DuffelHoldExecutor,
  holdPaymentDecision,
  travelCapabilities,
} from '@synq/plugin-duffel';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
  redact,
} from '@synq/profile-vault';
import { MemoryReservationStore } from '@synq/settlement';
import { BOOKING_TRAVELER_FIELDS } from '../../workers/workflow/src/commerce/runtime.js';
import { FakeDuffel } from './fake-duffel.js';

const T = 1_780_000_000;
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
const flightIntent = (over: Record<string, unknown> = {}): EconomicIntent =>
  EconomicIntentSchema.parse({
    id: 'trip-1',
    groupId: 'group-1',
    domain: 'FLIGHT',
    objective: 'LHR to JFK with a bag for the group',
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
    ...over,
  });

function setup(clock = { t: T }) {
  const now = () => clock.t;
  const fake = new FakeDuffel(now);
  const client = new DuffelClient(TOKEN, fake.fetch, { evidence: 'MOCKED' });
  const exec = new DuffelBookingExecutor(client);
  return {
    clock,
    now,
    fake,
    graph: new ProviderCapabilityGraph(
      travelCapabilities({ DUFFEL_TEST_TOKEN: TOKEN }),
    ),
    flights: new DuffelFlightsProvider(client, now),
    exec,
    holds: new DuffelHoldExecutor(client, exec),
  };
}

function flightOffer(
  id: string,
  pence: number,
  subject: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
): EconomicOffer {
  return EconomicOfferSchema.parse({
    offerId: id,
    intentId: 'trip-1',
    domain: 'FLIGHT',
    discoveryProviderId: 'duffel-flights',
    fulfillmentProviderId: 'duffel-flights',
    providerRef: id,
    subject: {
      kind: 'FLIGHT',
      segments: [
        {
          origin: 'LHR',
          destination: 'JFK',
          departureDate: '2026-12-01',
          carrier: 'ZZ',
        },
      ],
      adults: 1,
      cabin: 'economy',
      checkedBags: 1,
      refundable: true,
      changeable: true,
      ...subject,
    },
    price: {
      quoteId: `q-${id}`,
      base: gbp(pence),
      shipping: gbp(0),
      tax: gbp(0),
      fees: gbp(0),
      fx: [],
      quotedAt: T,
      expiresAt: T + 1_200,
      revalidatedAt: null,
    },
    cancellation: {
      kind: 'PARTIAL',
      refundable: true,
      freeUntil: null,
      penalty: gbp(2_500),
      changeable: true,
    },
    settlement: {
      accepts: [{ rail: 'PROVIDER_BALANCE', currency: 'GBP' }],
      payee: null,
    },
    execution: {
      mode: 'NATIVE_API',
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: ['TRAVELER_NAME', 'DOB', 'EMAIL', 'PHONE'],
    },
    environment: 'SANDBOX',
    evidence: 'MOCKED',
    stops: 0,
    retrievedAt: T,
    executable: false,
    ...over,
  });
}
const search = (offers: EconomicOffer[]) =>
  ({ offers, coverage: [] }) as unknown as Parameters<
    typeof selectOffers
  >[0]['search'];

describe('P18 flights, stays and group bookings', () => {
  it('P18-01 flights are ranked only against the same itinerary, passengers, cabin, baggage and fare rules', async () => {
    const { graph, flights, now } = setup();
    const live = await searchOffers({
      intent: flightIntent(),
      providers: [flights],
      graph,
      now,
    });
    const sel = selectOffers({ intent: flightIntent(), search: live, now: T });
    expect(sel.selected?.offer.providerRef).toBe('off_0000ZZtest');
    expect(
      sel.rejected.find((r) => r.offerId.includes('nobag'))?.reasons,
    ).toContain('insufficient bags');

    const intent = flightIntent({
      budget: { max: gbp(200_000) },
      subject: {
        kind: 'FLIGHT',
        segments: [
          { origin: 'LHR', destination: 'JFK', departureDate: '2026-12-01' },
        ],
        adults: 2,
        cabin: 'economy',
        checkedBags: 1,
        refundable: true,
      },
    });
    const offers = [
      flightOffer('same', 61_000, { adults: 2 }),
      flightOffer('next-day', 30_000, {
        adults: 2,
        segments: [
          { origin: 'LHR', destination: 'JFK', departureDate: '2026-12-02' },
        ],
      }),
      flightOffer('to-ewr', 31_000, {
        adults: 2,
        segments: [
          { origin: 'LHR', destination: 'EWR', departureDate: '2026-12-01' },
        ],
      }),
      flightOffer('one-seat', 20_000, { adults: 1 }),
      flightOffer('no-bag', 40_000, { adults: 2, checkedBags: 0 }),
      flightOffer('premium', 90_000, { adults: 2, cabin: 'premium_economy' }),
      flightOffer('non-ref', 45_000, { adults: 2, refundable: false }),
      flightOffer('also-same', 62_000, { adults: 2 }),
    ];
    const s = selectOffers({ intent, search: search(offers), now: T });
    // Cheaper but incomparable fares never outrank the requested itinerary.
    expect(s.ranked.map((r) => r.offer.offerId)).toEqual(['same', 'also-same']);
    const why = Object.fromEntries(
      s.rejected.map((r) => [r.offerId, r.reasons.join('; ')]),
    );
    expect(why['next-day']).toContain('date differs');
    expect(why['to-ewr']).toContain('route differs');
    expect(why['one-seat']).toContain('fewer passengers');
    expect(why['no-bag']).toContain('insufficient bags');
    expect(why['premium']).toContain('cabin differs');
    expect(why['non-ref']).toContain('not refundable');
  });

  it('P18-02 an expired offer blocks booking', async () => {
    const stale = flightOffer(
      'stale',
      30_000,
      {},
      {
        price: {
          quoteId: 'q',
          base: gbp(30_000),
          shipping: gbp(0),
          tax: gbp(0),
          fees: gbp(0),
          fx: [],
          quotedAt: T - 2_000,
          expiresAt: T - 1,
          revalidatedAt: T - 1_000,
        },
        executable: true,
      },
    );
    expect(
      selectOffers({ intent: flightIntent(), search: search([stale]), now: T })
        .rejected[0]?.reasons,
    ).toContain('quote expired');
    expect(() => assertExecutable(stale, T)).toThrow(NotExecutableError);
    const fresh = flightOffer(
      'fresh',
      30_000,
      {},
      {
        executable: true,
        price: { ...stale.price, expiresAt: T + 600, revalidatedAt: T - 1_000 },
      },
    );
    expect(() => assertExecutable(fresh, T)).toThrow(/revalidation stale/);
    // A provider that returns an already-expired quote on revalidation blocks too.
    const { graph } = setup();
    const r = await revalidateOffer({
      intent: flightIntent(),
      candidate: {
        offer: flightOffer('x', 30_000),
        landed: gbp(30_000),
        match: { level: 'EXACT_MATCH', basis: 'ITINERARY', reasons: [] },
      },
      provider: {
        providerId: 'duffel-flights',
        search: async () => [],
        revalidate: async (o) => ({
          price: { ...o.price, expiresAt: T },
          subject: o.subject,
          available: true,
          providerRef: o.providerRef,
        }),
      },
      graph,
      approvedMax: gbp(50_000),
      now: () => T,
    });
    expect(r).toMatchObject({ status: 'EXPIRED' });
  });

  it('P18-03 a changed fare requires fresh approval before any payment', async () => {
    const { fake, graph, flights, holds, now } = setup();
    const intent = flightIntent();
    const sel = selectOffers({
      intent,
      search: await searchOffers({ intent, providers: [flights], graph, now }),
      now: T,
    });
    fake.faults.set('offer', { kind: 'PRICE_UP', amount: '320.00' });
    const r = await revalidateOffer({
      intent,
      candidate: sel.selected!,
      provider: flights,
      graph,
      approvedMax: sel.selected!.landed,
      now,
    });
    expect(r).toMatchObject({ status: 'PRICE_DRIFT' });
    // A held fare that moved after approval is not paid with the old approval.
    fake.faults.delete('offer');
    const held = await holds.holdFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      idempotencyKey: 'hold-fare',
    });
    if (held.status !== 'HELD') throw new Error(held.status);
    fake.orders.get(held.orderId)!.total_amount = '330.00';
    const paid = await holds.payHeld({
      orderId: held.orderId,
      approved: gbp(31_240),
      now: T,
    });
    expect(paid).toMatchObject({
      decision: { action: 'REAPPROVE', current: gbp(33_000) },
      paymentId: null,
    });
    expect(fake.payments).toEqual([]);
    // With the new fare approved, the same hold can be paid.
    expect(
      (
        await holds.payHeld({
          orderId: held.orderId,
          approved: gbp(33_000),
          now: T,
        })
      ).decision.action,
    ).toBe('PAY');
    expect(fake.payments).toEqual([held.orderId]);
  });

  it('P18-04 a provider hold that lapses is never paid and its reservation is released', async () => {
    const clock = { t: T };
    const { fake, holds } = setup(clock);
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: 'arc:usdc',
      confirmed: 1_000_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'res-hold',
        groupId: 'group-1',
        assetId: 'arc:usdc',
        amount: '400000000',
        intentId: 'trip-1',
        purpose: 'FLIGHT',
        settlementPlanHash: 'plan',
        expiresAt: T + 7 * 86_400,
      },
      T,
    );
    const held = await holds.holdFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      idempotencyKey: 'hold-1',
    });
    if (held.status !== 'HELD') throw new Error(held.status);
    expect(held).toMatchObject({
      awaitingPayment: true,
      paymentRequiredBy: T + 3 * 86_400,
    });
    // Inside the safety margin the hold is already treated as expired.
    clock.t = T + 3 * 86_400 - 60;
    let r = await holds.payHeld({
      orderId: held.orderId,
      approved: gbp(31_240),
      now: clock.t,
    });
    expect(r.decision.action).toBe('EXPIRED');
    clock.t = T + 3 * 86_400 + 1;
    r = await holds.payHeld({
      orderId: held.orderId,
      approved: gbp(31_240),
      now: clock.t,
    });
    expect(r).toMatchObject({
      decision: { action: 'EXPIRED' },
      paymentId: null,
    });
    expect(fake.payments).toEqual([]);
    expect(
      fake.calls.filter((c) => c.path.startsWith('/air/payments')),
    ).toHaveLength(0);
    await reservations.release(
      'res-hold',
      'HOLD_EXPIRED: provider hold lapsed unpaid',
      clock.t,
    );
    expect((await reservations.free('group-1', 'arc:usdc')).free).toBe(
      '1000000000',
    );
    expect(
      holdPaymentDecision({
        hold: {
          paymentRequiredBy: null,
          cancelled: false,
          awaitingPayment: true,
        },
        current: gbp(1),
        approved: gbp(1),
        now: T,
      }).action,
    ).toBe('EXPIRED');
  });

  it('P18-05 a provider timeout never duplicates a booking: lookup by idempotency key before any retry', async () => {
    const { fake, exec, holds } = setup();
    fake.faults.set('order', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const input = {
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'trip-1:book',
    };
    expect((await exec.bookFlight(input)).status).toBe('UNKNOWN');
    fake.faults.delete('order');
    const retry = await exec.bookFlight(input);
    expect(retry.status).toBe('CONFIRMED');
    expect(fake.orders.size).toBe(1);
    expect(
      fake.calls.filter((c) => c.method === 'POST' && c.path === '/air/orders'),
    ).toHaveLength(1);
    // Holds reconcile the same way.
    const h1 = await holds.holdFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      idempotencyKey: 'trip-1:hold',
    });
    const h2 = await holds.holdFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      idempotencyKey: 'trip-1:hold',
    });
    expect(
      h1.status === 'HELD' && h2.status === 'HELD' && h1.orderId === h2.orderId,
    ).toBe(true);
    expect(fake.orders.size).toBe(2);
  });

  it('P18-06 a cancellation creates a refund receivable that is not credited until the refund is observed', async () => {
    const { exec } = setup();
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: 'arc:usdc',
      confirmed: 1_000_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'res-trip',
        groupId: 'group-1',
        assetId: 'arc:usdc',
        amount: '400000000',
        intentId: 'trip-1',
        purpose: 'FLIGHT',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    await reservations.capture('res-trip', 312_400_000n, T + 1);
    const order = await exec.bookFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'trip-1:c',
    });
    if (order.status !== 'CONFIRMED') throw new Error(order.status);
    const quote = await exec.quoteFlightCancellation(order.providerRef);
    const done = await exec.confirmFlightCancellation(quote.cancellationId!);
    expect(done).toMatchObject({
      confirmed: true,
      refund: gbp(28_740),
      refundTo: 'balance',
    });
    const before = await reservations.free('group-1', 'arc:usdc');
    await reservations.recordRefund({
      refundId: `refund-${order.providerRef}`,
      reservationId: 'res-trip',
      amount: 287_400_000n,
      now: T + 10,
    });
    const promised = await reservations.free('group-1', 'arc:usdc');
    // A receivable: visible as pending, never as free money.
    expect(promised.free).toBe(before.free);
    expect(promised.pendingRefunds).toBe('287400000');
    // Less arrived than promised: a mismatch, not settled.
    const short = await reservations.settleRefund(
      `refund-${order.providerRef}`,
      200_000_000n,
      T + 20,
    );
    expect(short.state).toBe('MISMATCH');
    await reservations.recordRefund({
      refundId: `refund-${order.providerRef}-2`,
      reservationId: 'res-trip',
      amount: 25_000_000n,
      now: T + 30,
    });
    expect(
      (
        await reservations.settleRefund(
          `refund-${order.providerRef}-2`,
          25_000_000n,
          T + 40,
        )
      ).state,
    ).toBe('SETTLED');
    expect((await reservations.free('group-1', 'arc:usdc')).free).toBe(
      before.free,
    );
  });

  it('P18-07 traveler passport data never enters workflow state, provider calls, logs or model context', async () => {
    const keys = new EnvVaultKeyProvider({
      SYNQ_PROFILE_VAULT_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    const store = new MemoryProfileStore();
    const passport = {
      passportNumber: 'X7Q91827',
      passportCountry: 'GB',
      passportExpiry: '2031-05-01',
    };
    const { ref, summary } = await new ProfileDirectory(
      store,
      keys,
      () => T,
    ).put({
      groupId: 'group-1',
      kind: 'TRAVELER',
      data: { ...traveler, title: 'ms', gender: 'f', ...passport },
    });
    expect(summary).toBe('traveler T. T.');
    expect(BOOKING_TRAVELER_FIELDS).not.toContain('passportNumber');
    const worker = new ProfileDecryptor(
      store,
      keys,
      () => T,
      'execution-worker',
    );
    const resolved = await worker.resolve({
      groupId: 'group-1',
      ref,
      kind: 'TRAVELER',
      purpose: 'booking:trip-1',
      fields: BOOKING_TRAVELER_FIELDS,
    });
    expect(Object.keys(resolved)).not.toContain('passportNumber');
    const { fake, exec } = setup();
    const outcome = await exec.bookFlight({
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [resolved],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'trip-1:pii',
    });
    const providerBodies = JSON.stringify(fake.calls);
    expect(providerBodies).not.toContain(passport.passportNumber);
    // What the workflow keeps (and an agent may read) is ids and money, not identity.
    const workflowVisible = JSON.stringify({ travelerRefs: [ref], outcome });
    for (const s of [
      passport.passportNumber,
      traveler.givenName,
      traveler.email,
      traveler.bornOn,
    ])
      expect(workflowVisible).not.toContain(s);
    expect(
      redact(
        `passport number ${passport.passportNumber} for ${traveler.email}`,
      ),
    ).toBe('[PASSPORT] for [EMAIL]');
    expect(worker.audit[0]).toMatchObject({
      outcome: 'GRANTED',
      fields: [...BOOKING_TRAVELER_FIELDS],
    });
  });
});
