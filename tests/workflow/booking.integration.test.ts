import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { officialAssets } from '@synq/chain-registry';
import { EconomicGrantAuthority } from '@synq/kernel';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
  type EconomicIntent,
  type FulfillmentReceipt,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  DuffelStaysProvider,
  duffelBookingPorts,
  travelCapabilities,
} from '@synq/plugin-duffel';
import {
  MemoryReservationStore,
  type SettlementPolicy,
} from '@synq/settlement';
import type { Asset } from '@synq/schemas';
import { createBookingActivities } from '../../workers/workflow/src/activities/booking.js';
import type { BookingWorkflowState } from '../../workers/workflow/src/workflows/booking.js';
import { FakeDuffel } from '../duffel/fake-duffel.js';
import {
  HmacHumanProofVerifier,
  MerchantAuthBroker,
} from '@synq/profile-vault';

const proofs = new HmacHumanProofVerifier(new Uint8Array(32).fill(4));
import { startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';

const AUSD = officialAssets.testnetAUSD as Asset;
const USDC = officialAssets.testnetUSDC as Asset;
const T = Math.floor(Date.now() / 1000);
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const fx = [
  {
    from: 'GBP',
    to: 'USD',
    numerator: '127',
    denominator: '100',
    source: 'fixture-fx',
    observedAt: T,
  },
];
const policy: SettlementPolicy = {
  allowedRails: ['PROVIDER_BALANCE', 'AUSD_ONCHAIN', 'USDC_ONCHAIN'],
  allowedSourceAssets: [AUSD.canonicalAssetId],
  fxBufferBps: 100,
  conversion: {
    maxSlippageBps: 50,
    maxDepegBps: 100,
    maxReferenceAgeSeconds: 600,
    perConversionCap: 1_000_000_000n,
    autoApproveMax: 0n,
    verifiedVenues: [],
  },
  quoteTtlSeconds: 600,
};

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await startTemporal();
});
afterAll(async () => {
  await env?.teardown();
});

function world(opts: { coreFree?: bigint; stepUp?: boolean } = {}) {
  const broker = new MerchantAuthBroker(
    proofs,
    () => Math.floor(Date.now() / 1000),
    { isEligibleHuman: (p) => p.startsWith('human:') },
  );
  const fake = new FakeDuffel(() => Math.floor(Date.now() / 1000));
  const now = () => Math.floor(Date.now() / 1000);
  const client = new DuffelClient('duffel_test_fixture', fake.fetch, {
    evidence: 'MOCKED',
  });
  const stays = new DuffelStaysProvider(client, now, { fxRates: fx });
  const flights = new DuffelFlightsProvider(client, now, { fxRates: fx });
  const graph = new ProviderCapabilityGraph(
    travelCapabilities({ DUFFEL_TEST_TOKEN: 'duffel_test_fixture' }),
  );
  const reservations = new MemoryReservationStore();
  const authority = new EconomicGrantAuthority(new Uint8Array(32).fill(3));
  authority.install({
    mandateId: 'travel',
    groupId: 'group-1',
    version: 1,
    status: 'ACTIVE',
    domains: ['STAY', 'FLIGHT'],
    providers: ['duffel-stays', 'duffel-flights'],
    hosts: ['api.duffel.com'],
    perActionCap: usd(100_000),
    cumulativeBudget: usd(500_000),
    autoApproveMax: usd(100),
    quorum: 2,
    members: ['alice', 'bob', 'carol'],
    maxQuoteAgeSeconds: 600,
    grantTtlSeconds: 600,
    environment: 'SANDBOX',
    validUntil: T + 86_400,
  });
  const receipts: FulfillmentReceipt[] = [];
  const decrypts: string[] = [];
  const activities = createBookingActivities({
    now,
    graph,
    providers: { 'duffel-stays': stays, 'duffel-flights': flights },
    ports: duffelBookingPorts(new DuffelBookingExecutor(client), flights),
    reservations,
    settlement: {
      treasury: async (groupId) => ({
        account: '0x00000000000000000000000000000000000a11ce',
        core: {
          asset: AUSD,
          free: BigInt(
            (await reservations.free(groupId, AUSD.canonicalAssetId)).free,
          ),
        },
        edge: { asset: USDC, free: 0n },
      }),
      rails: [
        {
          railId: 'duffel-balance',
          rail: 'PROVIDER_BALANCE',
          chainId: null,
          assetId: null,
          currency: 'GBP',
          auth: 'PROVIDER_API_KEY',
          kycRequired: false,
          kycSatisfied: false,
          environment: 'SANDBOX',
          status: 'READY',
        },
      ],
      policy,
      reference: async () => ({
        source: 'fixture',
        priceE8: 100_000_000n,
        observedAt: now(),
      }),
      reservationTtlSeconds: 3_600,
    },
    authority,
    approvals: {
      verify: async ({ tokens }) =>
        tokens.filter((t) => t.startsWith('verified:')).map((t) => t.slice(9)),
    },
    travelers: {
      resolve: async ({ refs, purpose }) => {
        decrypts.push(purpose);
        return refs.map(() => ({
          givenName: 'Test',
          familyName: 'Traveler',
          bornOn: '1990-01-01',
          email: 'traveler@example.com',
          phone: '+442080160509',
        }));
      },
    },
    receipts: { write: async (r) => void receipts.push(r) },
    ...(opts.stepUp
      ? {
          stepUp: {
            requirement: async () =>
              broker.open({
                kind: 'THREE_DS',
                principalId: 'human:alice',
                ttlSeconds: 600,
              }),
            verify: ({ challenge, completion }) =>
              broker.complete(challenge, completion),
          },
        }
      : {}),
  });
  return {
    fake,
    stays,
    flights,
    graph,
    reservations,
    authority,
    receipts,
    decrypts,
    activities,
    opts,
    broker,
  };
}

async function stayCandidates(
  w: ReturnType<typeof world>,
  intent: EconomicIntent,
) {
  const sel = selectOffers({
    intent,
    search: await searchOffers({
      intent,
      providers: [w.stays],
      graph: w.graph,
      now: () => Math.floor(Date.now() / 1000),
    }),
    now: Math.floor(Date.now() / 1000),
  });
  return sel.ranked.map((r) => ({ offer: r.offer, landed: r.landed }));
}

const stayIntent = (id: string) =>
  EconomicIntentSchema.parse({
    id,
    groupId: 'group-1',
    domain: 'STAY',
    objective: 'test hotel',
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
    budget: { max: usd(40_000) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 200,
    validUntil: T + 3_600,
  });

async function run(
  w: ReturnType<typeof world>,
  input: Record<string, unknown>,
  drive: (h: {
    signal: (name: string, arg?: unknown) => Promise<void>;
    state: () => Promise<BookingWorkflowState>;
  }) => Promise<void> = async () => undefined,
) {
  const config = testConfig('booking');
  await w.reservations.setConfirmedBalance({
    groupId: 'group-1',
    assetId: AUSD.canonicalAssetId,
    confirmed: w.opts.coreFree ?? 1_000_000_000n,
    asOf: T,
  });
  return withWorkers(env, config, w.activities, async () => {
    const handle = await env.client.workflow.start('BookingWorkflow', {
      taskQueue: config.taskQueues.economic,
      workflowId: `booking-${input.bookingId}-${process.pid}`,
      args: [
        {
          groupId: 'group-1',
          mandateId: 'travel',
          travelerRefs: ['traveler:ref:1', 'traveler:ref:2'],
          approvalTimeoutSeconds: 30,
          reconcileIntervalSeconds: 1,
          reconcileAttempts: 3,
          ...input,
        },
      ],
    });
    await drive({
      signal: (name, arg) =>
        arg === undefined ? handle.signal(name) : handle.signal(name, arg),
      state: () => handle.query<BookingWorkflowState>('bookingState'),
    });
    return (await handle.result()) as BookingWorkflowState;
  });
}

const waitFor = async (
  state: () => Promise<BookingWorkflowState>,
  s: string,
) => {
  for (let i = 0; i < 200; i++) {
    if ((await state()).state === s) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`state ${s} not reached`);
};

describe('BookingWorkflow (Temporal, Duffel test-mode double)', () => {
  it('re-ranks past an unavailable rate, waits for quorum, books once and reconciles', async () => {
    const w = world();
    const intent = stayIntent('stay-happy');
    const candidates = await stayCandidates(w, intent);
    const out = await run(
      w,
      { bookingId: 'happy', intent, candidates, approvedMax: usd(40_000) },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'forged:carol' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.state).toBe('RECONCILED');
    expect(out.history.map((e) => e.to)).toEqual([
      'QUOTED',
      'REVALIDATED',
      'RESERVED',
      'APPROVED',
      'BOOKING_PENDING',
      'CONFIRMED',
      'RECONCILED',
    ]);
    expect(out.notes[0]).toMatch(/UNAVAILABLE/);
    expect(w.fake.bookings.size).toBe(1);
    expect(w.receipts[0]).toMatchObject({
      state: 'CONFIRMED',
      evidence: 'MOCKED',
      providerId: 'duffel-stays',
    });
    const r = await w.reservations.get('bk-happy');
    expect(r?.state).toBe('CAPTURED');
    expect(BigInt(r!.captured)).toBeLessThanOrEqual(BigInt(r!.amount));
    expect(w.decrypts).toEqual(['booking:happy']);
  });

  it('STAY-008/RECOURSE-001 a timeout after commit reconciles instead of re-booking', async () => {
    const w = world();
    w.fake.faults.set('book', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const intent = stayIntent('stay-timeout');
    const out = await run(
      w,
      {
        bookingId: 'timeout',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.history.map((e) => e.to)).toContain('UNKNOWN_PROVIDER_OUTCOME');
    expect(out.state).toBe('RECONCILED');
    expect(w.fake.bookings.size).toBe(1);
    expect(
      w.fake.calls.filter(
        (c) => c.method === 'POST' && c.path === '/stays/bookings',
      ),
    ).toHaveLength(1);
  });

  it('an unresolved outcome holds the reservation and never retries', async () => {
    const w = world();
    w.fake.faults.set('book', { kind: 'HTTP_500_BEFORE_COMMIT' });
    const intent = stayIntent('stay-lost');
    const out = await run(
      w,
      {
        bookingId: 'lost',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
        reconcileAttempts: 2,
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.state).toBe('UNKNOWN_PROVIDER_OUTCOME');
    expect((await w.reservations.get('bk-lost'))?.state).toBe('ACTIVE');
    expect(
      w.fake.calls.filter(
        (c) => c.method === 'POST' && c.path === '/stays/bookings',
      ),
    ).toHaveLength(1);
  });

  it('a definitive provider refusal fails and releases the reservation', async () => {
    const w = world();
    w.fake.faults.set('book', { kind: 'RATE_UNAVAILABLE' });
    const intent = stayIntent('stay-422');
    const out = await run(
      w,
      {
        bookingId: 'r422',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.state).toBe('FAILED');
    expect((await w.reservations.get('bk-r422'))?.state).toBe('RELEASED');
  });

  it('approval timeout fails closed and releases; unverified approvals never count', async () => {
    const w = world();
    const intent = stayIntent('stay-noquorum');
    const out = await run(
      w,
      {
        bookingId: 'noquorum',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
        approvalTimeoutSeconds: 2,
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'forged:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.state).toBe('FAILED');
    expect(out.notes.at(-1)).toBe('approval timed out');
    expect(w.fake.bookings.size).toBe(0);
    expect((await w.reservations.get('bk-noquorum'))?.state).toBe('RELEASED');
  });

  it('SET-005 insufficient free treasury blocks before any approval', async () => {
    const w = world({ coreFree: 1_000n });
    const intent = stayIntent('stay-poor');
    const out = await run(w, {
      bookingId: 'poor',
      intent,
      candidates: await stayCandidates(w, intent),
      approvedMax: usd(40_000),
    });
    expect(out.state).toBe('FAILED');
    expect(out.notes.at(-1)).toMatch(/INSUFFICIENT_FREE_BALANCE/);
  });

  it('CARD-008/AUTH-001 a 3DS step-up pauses the workflow until the cardholder completes it', async () => {
    const w = world({ stepUp: true });
    const intent = stayIntent('stay-3ds');
    const out = await run(
      w,
      {
        bookingId: 'tds',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
        await waitFor(h.state, 'APPROVED');
        let st = await h.state();
        for (let i = 0; i < 50 && !st.stepUp; i++) {
          await new Promise((r) => setTimeout(r, 100));
          st = await h.state();
        }
        const challenge = st.stepUp!;
        expect(challenge.principalId).toBe('human:alice');
        await h.signal('bookingStepUp', {
          challengeId: challenge.challengeId,
          principalId: 'agent:brain',
          proof: proofs.issue(challenge, 'agent:brain'),
        });
        await h.signal('bookingStepUp', {
          challengeId: challenge.challengeId,
          principalId: 'human:alice',
          proof: '0'.repeat(64),
        });
        await new Promise((r) => setTimeout(r, 500));
        expect((await h.state()).state).toBe('APPROVED');
        expect(w.fake.bookings.size).toBe(0);
        await h.signal('bookingStepUp', {
          challengeId: challenge.challengeId,
          principalId: 'human:alice',
          proof: proofs.issue(challenge, 'human:alice'),
        });
      },
    );
    expect(out.state).toBe('RECONCILED');
    expect(w.broker.events.map((e) => e.event)).toEqual([
      'OPENED',
      'REJECTED:WRONG_PRINCIPAL',
      'REJECTED:BAD_PROOF',
      'COMPLETED',
    ]);
  });

  it('a step-up that never completes fails closed without booking', async () => {
    const w = world({ stepUp: true });
    const intent = stayIntent('stay-3ds-timeout');
    const out = await run(
      w,
      {
        bookingId: 'tdsx',
        intent,
        candidates: await stayCandidates(w, intent),
        approvedMax: usd(40_000),
        stepUpTimeoutSeconds: 2,
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:bob' });
      },
    );
    expect(out.state).toBe('FAILED');
    expect(w.fake.bookings.size).toBe(0);
    expect((await w.reservations.get('bk-tdsx'))?.state).toBe('RELEASED');
  });

  it('FLT-007/FLT-008 Duffel Airways order then cancel to REFUND_PENDING', async () => {
    const w = world();
    const intent = EconomicIntentSchema.parse({
      id: 'flight-1',
      groupId: 'group-1',
      domain: 'FLIGHT',
      objective: 'LHR-JFK',
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
      budget: { max: usd(60_000) },
      autonomy: { execution: 'QUORUM', substitution: 'NONE' },
      maxPriceDriftBps: 0,
      validUntil: T + 3_600,
    });
    const sel = selectOffers({
      intent,
      search: await searchOffers({
        intent,
        providers: [w.flights],
        graph: w.graph,
        now: () => Math.floor(Date.now() / 1000),
      }),
      now: Math.floor(Date.now() / 1000),
    });
    const out = await run(
      w,
      {
        bookingId: 'flt',
        intent,
        candidates: sel.ranked.map((r) => ({
          offer: r.offer,
          landed: r.landed,
        })),
        approvedMax: usd(60_000),
        travelerRefs: ['traveler:ref:1'],
        cancelWindowSeconds: 30,
      },
      async (h) => {
        await waitFor(h.state, 'RESERVED');
        await h.signal('bookingApproval', { token: 'verified:alice' });
        await h.signal('bookingApproval', { token: 'verified:carol' });
        await waitFor(h.state, 'RECONCILED');
        await h.signal('bookingCancel');
      },
    );
    expect(out.state).toBe('REFUND_PENDING');
    expect(out.refund).toEqual({
      amount: '28740',
      currency: 'GBP',
      decimals: 2,
    });
    expect(w.fake.orders.size).toBe(1);
    const free = await w.reservations.free('group-1', AUSD.canonicalAssetId);
    expect(BigInt(free.pendingRefunds)).toBeGreaterThan(0n);
  });
});
