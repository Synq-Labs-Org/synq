import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
  NotExecutableError,
  ProviderCapabilityGraph,
  assertExecutable,
  matchProduct,
  revalidateOffer,
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  LiveKeyRefusedError,
  duffelBookingPorts,
  travelCapabilities,
} from '@synq/plugin-duffel';
import {
  LithicSandboxCardPort,
  LithicSandboxClient,
  MemoryWebhookDeduper,
  SimulatedCardMerchant,
} from '@synq/plugin-commerce';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  SettlementFabric,
  SettlementFabricError,
} from '@synq/settlement';
import { LedgerError, validateEntry } from '@synq/ledger';
import {
  createBookingActivities,
  type BookingActivityDeps,
} from '../../workers/workflow/src/activities/booking.js';
import { LITHIC_WEBHOOK_PATH } from '../../apps/api/src/lithic-webhook.js';
import { FakeDuffel } from '../duffel/fake-duffel.js';
import { FakeLithic } from '../commerce/fake-lithic.js';
import { SECRET, signed, webhookApp } from '../api/lithic-webhook-fixtures.js';

/**
 * Cross-cutting OFFCHAIN rows (X-OFF-01..07). Every test drives the real
 * provider adapters, Settlement Fabric and booking activities against the
 * in-repo provider doubles (LOCAL_FIXTURE evidence; no network).
 */

const T = 1_780_000_000;
const TOKEN = 'duffel_test_fixture';
const gbp = (pence: number): Money => ({
  amount: String(pence),
  currency: 'GBP',
  decimals: 2,
});
const usd = (cents: number): Money => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const traveler = {
  givenName: 'Test',
  familyName: 'Traveler',
  bornOn: '1990-01-01',
  email: 'traveler@example.com',
  phone: '+442080160509',
};
const flightIntent = EconomicIntentSchema.parse({
  id: 'xoff-trip',
  groupId: 'xoff-group',
  domain: 'FLIGHT',
  objective: 'LHR to JFK',
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

function duffel(now = () => T) {
  const fake = new FakeDuffel(now);
  const client = new DuffelClient(TOKEN, fake.fetch, { evidence: 'MOCKED' });
  return {
    fake,
    client,
    exec: new DuffelBookingExecutor(client),
    flights: new DuffelFlightsProvider(client, now),
    graph: new ProviderCapabilityGraph(
      travelCapabilities({ DUFFEL_TEST_TOKEN: TOKEN }),
    ),
  };
}

function fabric(now = () => T) {
  const reservations = new MemoryReservationStore();
  const store = new MemorySettlementFabricStore();
  return {
    reservations,
    store,
    fabric: new SettlementFabric(store, reservations, now),
  };
}

const productIntent = EconomicIntentSchema.parse({
  id: 'xoff-phone',
  groupId: 'xoff-group',
  domain: 'COMMERCE',
  objective: 'a blue 256GB phone',
  subject: {
    kind: 'PRODUCT',
    title: 'Pixel 9 256GB Obsidian',
    brand: 'Google',
    model: 'Pixel 9',
    variant: { color: 'Obsidian', storage: '256GB' },
    quantity: 1,
  },
  hardConstraints: [],
  preferences: [],
  budget: { max: usd(100_000) },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  validUntil: T + 3_600,
});

function productOffer(over: Partial<EconomicOffer> = {}): EconomicOffer {
  return EconomicOfferSchema.parse({
    offerId: 'xoff-offer-1',
    intentId: productIntent.id,
    domain: 'COMMERCE',
    discoveryProviderId: 'lithic-sandbox',
    fulfillmentProviderId: 'lithic-sandbox',
    providerRef: 'lithic-merchant:SYNQ TEST SHOP',
    subject: productIntent.subject,
    price: {
      quoteId: 'q-1',
      base: usd(79_900),
      shipping: usd(0),
      tax: usd(0),
      fees: usd(0),
      fx: [],
      quotedAt: T,
      expiresAt: T + 900,
      revalidatedAt: T,
    },
    cancellation: {
      kind: 'FREE_UNTIL',
      refundable: true,
      freeUntil: T + 900,
      penalty: null,
      changeable: false,
    },
    settlement: {
      accepts: [{ rail: 'SCOPED_CARD', currency: 'USD' }],
      payee: 'SYNQ TEST SHOP',
    },
    execution: {
      mode: 'SCOPED_CARD',
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: [],
    },
    environment: 'SANDBOX',
    evidence: 'SIMULATED',
    retrievedAt: T,
    executable: true,
    ...over,
  });
}

function lithic(mutateAuth?: (tx: Record<string, unknown>) => void): {
  fake: FakeLithic;
  port: LithicSandboxCardPort;
} {
  const fake = new FakeLithic();
  const base = fake.fetch;
  fake.fetch = async (url, init) => {
    const r = await base(url, init);
    if (mutateAuth && new URL(url).pathname.endsWith('/simulate/authorize')) {
      const body = JSON.parse(await r.text()) as { token: string };
      const tx = fake.txs.get(body.token);
      if (tx) mutateAuth(tx);
      return { ...r, text: async () => JSON.stringify(body) };
    }
    return r;
  };
  const client = new LithicSandboxClient(
    { apiKey: fake.key, environment: 'sandbox' },
    fake.fetch,
    { sleep: async () => undefined },
  );
  return { fake, port: new LithicSandboxCardPort(client) };
}

const cardOffer = (cents: number) =>
  EconomicOfferSchema.parse(
    new SimulatedCardMerchant(
      { descriptor: 'SYNQ TEST CAFE', title: 'Team lunch', priceCents: cents },
      () => T,
    ).offer(
      EconomicIntentSchema.parse({
        ...productIntent,
        id: 'xoff-card',
        subject: { kind: 'PRODUCT', title: 'Team lunch', quantity: 1 },
      }),
    ),
  );

describe('cross-cutting OFFCHAIN (X-OFF)', () => {
  it('X-OFF-01 a Duffel sandbox order is never presented as a real airline ticket', async () => {
    // Live keys are a construction error: only test-mode tokens are accepted.
    expect(
      () =>
        new DuffelClient('duffel_live_abc123', duffel().fake.fetch, {
          evidence: 'PROVIDER_SANDBOX',
        }),
    ).toThrow(LiveKeyRefusedError);
    const { client, flights, graph, exec } = duffel();
    expect(client.environment).toBe('SANDBOX');
    // Every capability row and every offer is labelled sandbox/fixture, never live.
    for (const cap of travelCapabilities({ DUFFEL_TEST_TOKEN: TOKEN }))
      expect(cap.environment).toBe('SANDBOX');
    const offers = (
      await flights.search(flightIntent, new AbortController().signal)
    ).map((o) => EconomicOfferSchema.parse(o));
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(['SANDBOX', 'FIXTURE']).toContain(o.environment);
      expect(['PROVIDER_SANDBOX', 'MOCKED']).toContain(o.evidence);
      expect(o.evidence).not.toBe('REAL_TESTNET');
    }
    expect(graph.usable('duffel-flights', 'QUOTE', T)).toBe(true);
    // Book through the real Duffel booking port, then settle through the real
    // booking activity: the receipt the user sees keeps the sandbox labels.
    const ports = duffelBookingPorts(exec, {
      passengerIds: async () => ['pas_0000test1'],
    });
    const offer = offers.find((o) => o.providerRef === 'off_0000ZZtest')!;
    const booked = await ports['duffel-flights']!.book({
      offer,
      travelers: [traveler],
      idempotencyKey: 'xoff-01-booking',
    });
    expect(booked.status).toBe('CONFIRMED');
    if (booked.status !== 'CONFIRMED') return;
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'xoff-group',
      assetId: 'arc:usdc',
      confirmed: 1_000_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'bk-xoff-01',
        groupId: 'xoff-group',
        assetId: 'arc:usdc',
        amount: '400000000',
        intentId: flightIntent.id,
        purpose: 'FLIGHT',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    const receipts: FulfillmentReceipt[] = [];
    const acts = createBookingActivities({
      now: () => T,
      ports,
      reservations,
      receipts: {
        write: async (r: FulfillmentReceipt) => void receipts.push(r),
      },
    } as unknown as BookingActivityDeps);
    const settled = await acts.settleBooking({
      bookingId: 'xoff-01',
      intent: flightIntent,
      offer,
      reservationId: 'bk-xoff-01',
      coreAmount: '400000000',
      providerRef: booked.providerRef,
      reference: booked.reference,
      charged: null,
      grantId: 'grant-xoff-01',
      idempotencyKey: 'xoff-01-booking',
    });
    expect(settled.status).toBe('SETTLED');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.environment).not.toBe('PRODUCTION');
    expect(['SANDBOX', 'FIXTURE']).toContain(receipts[0]!.environment);
    expect(['PROVIDER_SANDBOX', 'MOCKED']).toContain(receipts[0]!.evidence);
    // Known residual (finding P23-20261016-duffel-sandbox-captures-reservation):
    // the Duffel ports declare no NONE_SANDBOX settlement profile, so the
    // sandbox booking is captured against the reservation. That is
    // conservative (free funds go down, never up) and is pinned here so a
    // change in either direction is noticed.
    expect((await reservations.get('bk-xoff-01'))?.state).toBe('CAPTURED');
    expect(
      BigInt((await reservations.free('xoff-group', 'arc:usdc')).free),
    ).toBeLessThanOrEqual(1_000_000_000n);
    // A sandbox order can never become a settled merchant (real-money) order.
    const { fabric: f } = fabric();
    const o = await f.openOrder({
      intentId: flightIntent.id,
      groupId: 'xoff-group',
      providerId: 'duffel-flights',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'xoff-01-order',
      amount: gbp(31_240),
    });
    await f.transition(o.providerOrderId, 'SUBMITTED');
    await expect(
      f.transition(o.providerOrderId, 'MERCHANT_SETTLED'),
    ).rejects.toThrow(SettlementFabricError);
  });

  it('X-OFF-02 booking after the provider offer expired is refused before any provider call', async () => {
    const { fake, flights, graph } = duffel();
    const offer = EconomicOfferSchema.parse(
      (await flights.search(flightIntent, new AbortController().signal))[0],
    );
    // Property: for every instant at or after expiry the offer is not executable.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (late) => {
        const o = {
          ...offer,
          executable: true,
          price: {
            ...offer.price,
            revalidatedAt: offer.price.expiresAt - 1,
          },
        };
        expect(() => assertExecutable(o, o.price.expiresAt + late)).toThrow(
          NotExecutableError,
        );
      }),
    );
    // A provider that answers revalidation with an expired quote is EXPIRED.
    const callsBefore = fake.calls.length;
    const r = await revalidateOffer({
      intent: flightIntent,
      candidate: {
        offer,
        landed: offer.price.base,
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
    expect(r.status).toBe('EXPIRED');
    expect(
      fake.calls
        .slice(callsBefore)
        .filter((c) => c.method === 'POST' && c.path === '/air/orders'),
    ).toHaveLength(0);
  });

  it('X-OFF-03 a provider timeout after booking creation reconciles to the one order and gates any resubmit', async () => {
    const { fake, exec } = duffel();
    const { fabric: f } = fabric();
    const o = await f.openOrder({
      intentId: 'xoff-trip',
      groupId: 'xoff-group',
      providerId: 'duffel-flights',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'xoff-03-key',
      amount: gbp(31_240),
    });
    expect((await f.submitGate(o.providerOrderId)).action).toBe('SUBMIT');
    fake.faults.set('order', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const input = {
      offerId: 'off_0000ZZtest',
      passengerIds: ['pas_0000test1'],
      passengers: [traveler],
      amount: gbp(31_240),
      amountDecimal: '312.40',
      idempotencyKey: 'xoff-03-key',
    };
    expect((await exec.bookFlight(input)).status).toBe('UNKNOWN');
    await f.transition(o.providerOrderId, 'UNKNOWN_OUTCOME', {
      reason: 'timeout',
    });
    // The fabric never lets the worker resubmit an order whose outcome is unknown.
    expect((await f.submitGate(o.providerOrderId)).action).toBe(
      'RECONCILE_FIRST',
    );
    fake.faults.delete('order');
    // Concurrent retries (e.g. a restarted worker racing the original) all
    // reconcile to the single committed order.
    const outs = await Promise.all(
      Array.from({ length: 5 }, () => exec.bookFlight(input)),
    );
    for (const out of outs) expect(out.status).toBe('CONFIRMED');
    expect(new Set(outs.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(fake.orders.size).toBe(1);
    expect(
      fake.calls.filter((c) => c.method === 'POST' && c.path === '/air/orders'),
    ).toHaveLength(1);
  });

  it('X-OFF-04 a merchant item variant mismatch is never executed as the requested item', async () => {
    const want = productIntent.subject;
    if (want.kind !== 'PRODUCT') throw new Error('product intent');
    const got = { ...want, variant: { color: 'Porcelain', storage: '256GB' } };
    expect(matchProduct(want, got, 'NONE')).toMatchObject({
      level: 'SUBSTITUTE',
      reasons: ['color Porcelain != Obsidian'],
    });
    // Revalidation that returns a different variant is a MISMATCH even at the same price.
    const graph = new ProviderCapabilityGraph([
      {
        providerId: 'lithic-sandbox',
        displayName: 'card sandbox',
        domains: ['COMMERCE'],
        verbs: ['DISCOVER', 'QUOTE', 'PURCHASE'],
        environment: 'SANDBOX',
        status: 'READY',
        statusReason: null,
        kycRequired: false,
        credentialEnv: [],
        settlementRails: ['SCOPED_CARD'],
        discoveryOnly: false,
        sourceRefs: [],
      },
    ]);
    const offer = productOffer();
    const r = await revalidateOffer({
      intent: productIntent,
      candidate: {
        offer,
        landed: usd(79_900),
        match: { level: 'EXACT_MATCH', basis: 'BRAND_MODEL', reasons: [] },
      },
      provider: {
        providerId: 'lithic-sandbox',
        search: async () => [],
        revalidate: async (o) => ({
          price: o.price,
          subject: { ...o.subject, variant: got.variant } as typeof o.subject,
          available: true,
          providerRef: o.providerRef,
        }),
      },
      graph,
      approvedMax: usd(100_000),
      now: () => T,
    });
    expect(r).toMatchObject({ status: 'MISMATCH' });
    if (r.status === 'MISMATCH') expect(r.reason).toMatch(/color/);
  });

  it('X-OFF-05 a card-simulator authorization is never counted as an Arc transaction or treasury spend', async () => {
    const { port } = lithic();
    expect(port.settlement).toMatchObject({
      category: 'CARD_NETWORK_SANDBOX',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
    });
    const offer = cardOffer(1_250);
    const out = await port.book({ offer, idempotencyKey: 'xoff-05-card' });
    expect(out.status).toBe('CONFIRMED');
    const { fabric: f, reservations, store } = fabric();
    await reservations.setConfirmedBalance({
      groupId: 'xoff-group',
      assetId: 'arc:usdc',
      confirmed: 100_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'xoff-05-res',
        groupId: 'xoff-group',
        assetId: 'arc:usdc',
        amount: '12500000',
        intentId: 'xoff-card',
        purpose: 'COMMERCE',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    const before = await reservations.free('xoff-group', 'arc:usdc');
    expect(before.free).toBe('87500000');
    const o = await f.openOrder({
      intentId: 'xoff-card',
      groupId: 'xoff-group',
      providerId: port.providerId,
      mode: 'PROVIDER_SANDBOX',
      economicEffect: port.settlement.economicEffect,
      idempotencyKey: 'xoff-05-card',
      amount: usd(1_250),
    });
    await f.recordAuthorization({
      authorizationId: 'xoff-05-auth',
      providerOrderId: o.providerOrderId,
      intentId: 'xoff-card',
      providerId: port.providerId,
      mode: 'PROVIDER_SANDBOX',
      kind: 'CARD_AUTHORIZATION',
      providerRef: out.status === 'CONFIRMED' ? out.providerRef : null,
      amount: usd(1_250),
      status: 'APPROVED',
      declineReason: null,
      simulated: true,
      at: T,
    });
    // A testnet-token settlement (what an Arc payment produces) is refused.
    await expect(
      f.settleTestnetOrder({
        providerOrderId: o.providerOrderId,
        providerRefs: { tx: 'tx-1' },
        category: 'CARD_NETWORK_SANDBOX',
        providerName: 'Lithic',
        charged: usd(1_250),
      }),
    ).rejects.toThrow(/not a testnet-token order/);
    const receipt = await f.settleSandboxOrder({
      providerOrderId: o.providerOrderId,
      providerRefs: { tx: 'tx-1' },
      category: 'CARD_NETWORK_SANDBOX',
      providerName: 'Lithic',
      reservationIds: ['xoff-05-res'],
      charged: usd(1_250),
    });
    expect(receipt).toMatchObject({
      treasuryEffect: 'NONE',
      label: 'PROVIDER_SANDBOX',
    });
    expect(receipt.statement).toMatch(/simulated card payment/);
    expect(receipt.statement).not.toMatch(/USDC|Arc/);
    // The reservation is released: no treasury value counted as spent.
    expect((await reservations.free('xoff-group', 'arc:usdc')).free).toBe(
      '100000000',
    );
    expect(
      (await store.listAuthorizations(o.providerOrderId))[0],
    ).toMatchObject({ simulated: true });
    // The ledger refuses to book a "chain" cash movement with no chain evidence.
    expect(() =>
      validateEntry({
        entryId: 'je-card',
        workspaceId: 'w',
        occurredAt: T,
        memo: 'card auth booked as Arc payment',
        source: { kind: 'CHAIN_TX', ref: 'tx-1' },
        evidence: null,
        idempotencyKey: 'card:tx-1',
        postings: [
          { account: 'CONTRACTOR_EXPENSE', assetId: 'arc:usdc', amount: 1n },
          { account: 'CASH_ARC_USDC', assetId: 'arc:usdc', amount: -1n },
        ],
        reversalOf: null,
      }),
    ).toThrow(LedgerError);
  });

  it('X-OFF-06 refund webhooks out of order (and redelivered) never credit funds before on-chain evidence', async () => {
    const seen: string[] = [];
    const app = await webhookApp({
      secret: SECRET,
      deduper: new MemoryWebhookDeduper(),
      now: () => 1_790_000_000,
      onEvent: async (e) => void seen.push(`${e.webhookId}:${e.eventType}`),
    });
    const { fabric: f, reservations } = fabric();
    await reservations.setConfirmedBalance({
      groupId: 'xoff-group',
      assetId: 'arc:usdc',
      confirmed: 100_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'xoff-06-res',
        groupId: 'xoff-group',
        assetId: 'arc:usdc',
        amount: '30000000',
        intentId: 'xoff-06',
        purpose: 'COMMERCE',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    await reservations.capture('xoff-06-res', 30_000_000n, T + 1);
    const order = await f.openOrder({
      intentId: 'xoff-06',
      groupId: 'xoff-group',
      providerId: 'crossmint',
      mode: 'TESTNET',
      economicEffect: 'TESTNET_TOKENS',
      idempotencyKey: 'xoff-06-order',
      amount: usd(3_000),
    });
    await f.settleTestnetOrder({
      providerOrderId: order.providerOrderId,
      providerRefs: { tx: 'tx-6' },
      category: 'MERCHANT_CHECKOUT',
      providerName: 'Crossmint',
      charged: usd(3_000),
    });
    const freeBefore = (await reservations.free('xoff-group', 'arc:usdc')).free;
    // The "refund settled" event arrives first, then "refund pending".
    const settledBody = JSON.stringify({
      event_type: 'refund.settled',
      token: 'rf-1',
      payload: { amount: 3000 },
    });
    const pendingBody = JSON.stringify({
      event_type: 'refund.pending',
      token: 'rf-1',
      payload: { amount: 3000 },
    });
    for (const [id, body] of [
      ['msg_rf_settled', settledBody],
      ['msg_rf_pending', pendingBody],
      ['msg_rf_settled', settledBody],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: LITHIC_WEBHOOK_PATH,
        payload: body,
        headers: signed(id, body),
      });
      expect(r.statusCode).toBe(200);
    }
    // Inbox only: each event is handled once and none moves money.
    expect(seen).toEqual([
      'msg_rf_settled:refund.settled',
      'msg_rf_pending:refund.pending',
    ]);
    expect((await reservations.free('xoff-group', 'arc:usdc')).free).toBe(
      freeBefore,
    );
    // Settling a refund that was never recorded (the out-of-order "settled") fails closed.
    await expect(
      reservations.settleRefund('fabric-cfr-rf-1', 30_000_000n, T + 5),
    ).rejects.toThrow(/RESERVATION_NOT_FOUND/);
    // A provider claim is a claim: recorded, never treasury credit.
    const claim = await f.recordProviderRefund({
      providerOrderId: order.providerOrderId,
      refundId: 'rf-1-claim',
      amount: usd(3_000),
      providerRef: 'rf-1',
    });
    expect(claim.treasuryCredit).toBe(false);
    expect((await reservations.free('xoff-group', 'arc:usdc')).free).toBe(
      freeBefore,
    );
    await expect(
      f.confirmRefund({
        providerOrderId: order.providerOrderId,
        refundId: 'rf-1-confirmed',
        amount: usd(3_000),
        onchain: null,
        reservationId: 'xoff-06-res',
        coreAmount: 30_000_000n,
        observedCoreAmount: 30_000_000n,
      }),
    ).rejects.toThrow(/REFUND_EVIDENCE_REQUIRED/);
    const confirmed = await f.confirmRefund({
      providerOrderId: order.providerOrderId,
      refundId: 'rf-1-confirmed',
      amount: usd(3_000),
      onchain: { chainId: 5042002, txHash: `0x${'ab'.repeat(32)}` },
      reservationId: 'xoff-06-res',
      coreAmount: 30_000_000n,
      observedCoreAmount: 30_000_000n,
    });
    expect(confirmed).toMatchObject({
      ledger: 'CONFIRMED_REFUND',
      treasuryCredit: true,
    });
    // A late duplicate "settled" refund for the same order cannot double-credit.
    await expect(
      f.confirmRefund({
        providerOrderId: order.providerOrderId,
        refundId: 'rf-1-confirmed-again',
        amount: usd(3_000),
        onchain: { chainId: 5042002, txHash: `0x${'cd'.repeat(32)}` },
        reservationId: 'xoff-06-res',
        coreAmount: 30_000_000n,
        observedCoreAmount: 30_000_000n,
      }),
    ).rejects.toThrow(SettlementFabricError);
    await app.close();
  });

  it('X-OFF-07 an unfinished card challenge or step-up is never treated as paid', async () => {
    // The issuer leaves the authorization pending a challenge (not APPROVED).
    const { fake, port } = lithic((tx) => {
      tx.result = 'AUTHENTICATION_REQUIRED';
      tx.status = 'PENDING';
    });
    const offer = cardOffer(990);
    const out = await port.book({ offer, idempotencyKey: 'xoff-07-card' });
    expect(out.status).toBe('FAILED');
    // The card is closed after an unapproved authorization.
    expect([...fake.cards.values()].every((c) => c.state === 'CLOSED')).toBe(
      true,
    );
    // Reconciliation by idempotency key never upgrades it to CONFIRMED.
    const found = await port.find({ offer, idempotencyKey: 'xoff-07-card' });
    expect(found?.status).not.toBe('CONFIRMED');
    // A booking whose offer requires step-up fails closed with no broker,
    // and an unverifiable completion is never accepted.
    const acts = createBookingActivities({
      now: () => T,
    } as unknown as BookingActivityDeps);
    const stepUpOffer = productOffer({
      execution: {
        mode: 'SCOPED_CARD',
        requiresQuote: true,
        requiresKyc: false,
        requiresStepUp: true,
        piiFields: [],
      },
    });
    await expect(
      acts.bookingStepUpRequirement({
        bookingId: 'xoff-07',
        offer: stepUpOffer,
      }),
    ).rejects.toThrow(/step-up broker not configured/);
    expect(
      await acts.verifyBookingStepUp({
        bookingId: 'xoff-07',
        challenge: {
          challengeId: 'c1',
        } as unknown as Parameters<
          typeof acts.verifyBookingStepUp
        >[0]['challenge'],
        completion: {
          challengeId: 'c1',
        } as unknown as Parameters<
          typeof acts.verifyBookingStepUp
        >[0]['completion'],
      }),
    ).toBe(false);
  });
});
