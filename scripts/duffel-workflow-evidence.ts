import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { officialAssets } from '@synq/chain-registry';
import { EconomicGrantAuthority } from '@synq/kernel';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
  type FulfillmentReceipt,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  duffelBookingPorts,
  travelCapabilities,
  type HttpFetch,
} from '@synq/plugin-duffel';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
} from '@synq/profile-vault';
import { MemoryReservationStore } from '@synq/settlement';
import type { Asset } from '@synq/schemas';
import { createBookingActivities } from '../workers/workflow/src/activities/booking.js';
import { bundleSynqWorkflows } from '../workers/workflow/src/worker.js';
import type { BookingWorkflowState } from '../workers/workflow/src/workflows/booking.js';

const token = process.env.DUFFEL_TEST_TOKEN ?? '';
const now = () => Math.floor(Date.now() / 1000);
const AUSD = officialAssets.testnetAUSD as Asset;
const USDC = officialAssets.testnetUSDC as Asset;
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const day = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

async function main() {
  if (!token.startsWith('duffel_test_'))
    throw new Error('DUFFEL_TEST_TOKEN (duffel_test_) required');
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  const client = new DuffelClient(token, realFetch, {
    evidence: 'PROVIDER_SANDBOX',
  });
  const flights = new DuffelFlightsProvider(client, now, { maxOffers: 500 });
  const graph = new ProviderCapabilityGraph(
    travelCapabilities({ DUFFEL_TEST_TOKEN: token }),
  );
  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: 'evidence-group',
    assetId: AUSD.canonicalAssetId,
    confirmed: 2_000_000_000n,
    asOf: now(),
  });
  const authority = new EconomicGrantAuthority(new Uint8Array(randomBytes(32)));
  authority.install({
    mandateId: 'travel-evidence',
    groupId: 'evidence-group',
    version: 1,
    status: 'ACTIVE',
    domains: ['FLIGHT'],
    providers: ['duffel-flights'],
    hosts: ['api.duffel.com'],
    perActionCap: usd(150_000),
    cumulativeBudget: usd(150_000),
    autoApproveMax: usd(100),
    quorum: 2,
    members: ['alice', 'bob', 'carol'],
    maxQuoteAgeSeconds: 600,
    grantTtlSeconds: 600,
    environment: 'SANDBOX',
    validUntil: now() + 86_400,
  });
  const vaultKey = {
    SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
  };
  const keys = new EnvVaultKeyProvider(vaultKey);
  const profiles = new MemoryProfileStore();
  const { ref } = await new ProfileDirectory(profiles, keys, now).put({
    groupId: 'evidence-group',
    kind: 'TRAVELER',
    data: {
      givenName: 'Ada',
      familyName: 'Synqtest',
      bornOn: '1990-01-01',
      email: 'ada.synqtest@example.com',
      phone: '+442080160509',
      title: 'ms',
      gender: 'f',
    },
  });
  const decryptor = new ProfileDecryptor(
    profiles,
    keys,
    now,
    'evidence-execution-worker',
  );
  const receipts: FulfillmentReceipt[] = [];
  const activities = createBookingActivities({
    now,
    graph,
    providers: { 'duffel-flights': flights },
    ports: duffelBookingPorts(new DuffelBookingExecutor(client), flights),
    reservations,
    settlement: {
      treasury: async (g) => ({
        account: '0x00000000000000000000000000000000000a11ce',
        core: {
          asset: AUSD,
          free: BigInt(
            (await reservations.free(g, AUSD.canonicalAssetId)).free,
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
          currency: 'USD',
          auth: 'PROVIDER_API_KEY',
          kycRequired: false,
          kycSatisfied: false,
          environment: 'SANDBOX',
          status: 'READY',
        },
      ],
      policy: {
        allowedRails: ['PROVIDER_BALANCE'],
        allowedSourceAssets: [AUSD.canonicalAssetId],
        fxBufferBps: 100,
        conversion: {
          maxSlippageBps: 50,
          maxDepegBps: 100,
          maxReferenceAgeSeconds: 600,
          perConversionCap: 0n,
          autoApproveMax: 0n,
          verifiedVenues: [],
        },
        quoteTtlSeconds: 600,
      },
      reference: async () => null,
      reservationTtlSeconds: 3_600,
    },
    authority,
    approvals: {
      verify: async ({ tokens }) =>
        tokens
          .filter((t) => t.startsWith('fixture-verified:'))
          .map((t) => t.slice(17)),
    },
    travelers: {
      resolve: async ({ groupId, refs, purpose }) =>
        Promise.all(
          refs.map((r) =>
            decryptor.resolve({
              groupId,
              ref: r,
              kind: 'TRAVELER',
              purpose,
              fields: [
                'givenName',
                'familyName',
                'bornOn',
                'email',
                'phone',
                'title',
                'gender',
              ],
            }),
          ),
        ),
    },
    receipts: { write: async (r) => void receipts.push(r) },
  });

  const intent = EconomicIntentSchema.parse({
    id: `flight-wf-${now()}`,
    groupId: 'evidence-group',
    domain: 'FLIGHT',
    objective: 'Duffel Airways order through the booking workflow',
    subject: {
      kind: 'FLIGHT',
      segments: [{ origin: 'LHR', destination: 'JFK', departureDate: day(75) }],
      adults: 1,
      cabin: 'economy',
      checkedBags: 0,
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: usd(150_000) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 200,
    validUntil: now() + 3_600,
  });
  const search = await searchOffers({
    intent,
    providers: [flights],
    graph,
    now,
    timeoutMs: 90_000,
  });
  const zz = search.offers.filter(
    (o) =>
      o.subject.kind === 'FLIGHT' &&
      o.subject.segments.every((s) => s.carrier === 'ZZ'),
  );
  const sel = selectOffers({
    intent,
    search: { ...search, offers: zz },
    now: now(),
  });
  if (!sel.ranked.length)
    throw new Error(
      `no Duffel Airways offer: ${JSON.stringify(sel.rejected).slice(0, 300)}`,
    );

  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: { type: 'existing-path', path: '/opt/homebrew/bin/temporal' },
      extraArgs: ['--log-level', 'error'],
    },
  });
  const taskQueue = `duffel-evidence-${process.pid}`;
  let state: BookingWorkflowState;
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await bundleSynqWorkflows(),
      activities,
      shutdownGraceTime: '1s',
    });
    const running = worker.run();
    const handle = await env.client.workflow.start('BookingWorkflow', {
      taskQueue,
      workflowId: `duffel-evidence-${now()}`,
      args: [
        {
          bookingId: `ev-${now()}`,
          groupId: 'evidence-group',
          mandateId: 'travel-evidence',
          intent,
          candidates: sel.ranked
            .slice(0, 3)
            .map((r) => ({ offer: r.offer, landed: r.landed })),
          approvedMax: usd(150_000),
          travelerRefs: [ref],
          approvalTimeoutSeconds: 120,
          reconcileIntervalSeconds: 5,
          cancelWindowSeconds: 120,
          activityTimeoutSeconds: 120,
        },
      ],
    });
    const query = () => handle.query<BookingWorkflowState>('bookingState');
    const until = async (s: string) => {
      for (let i = 0; i < 600; i++) {
        if ((await query()).state === s) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `timeout waiting for ${s}: ${JSON.stringify(await query()).slice(0, 400)}`,
      );
    };
    await until('RESERVED');
    await handle.signal('bookingApproval', { token: 'fixture-verified:alice' });
    await handle.signal('bookingApproval', { token: 'fixture-verified:bob' });
    await until('RECONCILED');
    await handle.signal('bookingCancel');
    state = (await handle.result()) as BookingWorkflowState;
    worker.shutdown();
    await running;
  } finally {
    await env.teardown();
  }
  const report = {
    generatedAt: new Date().toISOString(),
    label: 'PROVIDER_SANDBOX',
    environment:
      'Duffel test mode (api.duffel.com); Temporal local test server; Kernel EconomicGrantAuthority',
    approvals:
      'FIXTURE (identity verifier stubbed: token prefix); not passkey-verified',
    workflow: {
      finalState: state.state,
      transitions: state.history.map((h) => `${h.from}->${h.to}`),
      offerId: state.offer?.providerRef,
      grantId: state.grantId,
      reservationId: state.reservationId,
      orderId: state.providerRef,
      bookingReference: state.reference,
      refund: state.refund,
      notes: state.notes,
    },
    receipt: receipts[0] ?? null,
    reservation: state.reservationId
      ? await reservations.get(state.reservationId)
      : null,
    pendingRefunds: (
      await reservations.free('evidence-group', AUSD.canonicalAssetId)
    ).pendingRefunds,
    grantConsumed: state.grantId ? authority.isConsumed(state.grantId) : false,
    profileDecrypts: decryptor.audit.map((a) => ({
      outcome: a.outcome,
      purpose: a.purpose,
      fields: a.fields,
      worker: a.worker,
    })),
  };
  const text = JSON.stringify(
    report,
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  );
  if (
    text.includes(token) ||
    text.includes('Synqtest') ||
    text.includes('example.com')
  )
    throw new Error('secret or PII leaked into evidence');
  const dir = join(process.cwd(), 'bounty-evidence', 'duffel');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `duffel-workflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, text + '\n');
  console.log(
    `${state.state} order=${state.providerRef} ref=${state.reference} -> ${file}`,
  );
  console.log(report.workflow.transitions.join(' '));
}

await main();
