import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  searchOffers,
  selectOffers,
} from '@synq/offer-exchange';
import {
  RELOADLY,
  RELOADLY_SANDBOX_HOST,
  giftCardSubject,
  type HttpFetch,
} from '@synq/plugin-commerce';
import { EnvVaultKeyProvider, ProfileDirectory } from '@synq/profile-vault';
import { bootstrapLocalEnvironment } from '../../workers/workflow/src/local/bootstrap.js';
import { openLocalRuntime } from '../../workers/workflow/src/local/runtime.js';
import type { BookingWorkflowState } from '../../workers/workflow/src/workflows/booking.js';
import { usd } from '../../scripts/lib/fabric-booking-world.js';
import { FakeReloadly } from '../commerce/fake-reloadly.js';
import { startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { testDatabaseUrl } from '../durable/pg.js';

const BOOKING = [
  'revalidateBookingCandidate',
  'reserveBookingFunds',
  'authorizeBooking',
  'executeBooking',
  'reconcileBooking',
  'settleBooking',
  'releaseBookingFunds',
  'cancelProviderBooking',
] as const;

it('LOCAL-COM-001 the production worker runtime registers booking with Postgres fabric, migrates every store and books a sandbox gift card through Temporal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synq-local-commerce-'));
  const local = await bootstrapLocalEnvironment({
    dataDir: dir,
    databaseUrl: testDatabaseUrl(
      'SYNQ_UNUSED_TEST_DATABASE_URL',
      'synq_p07_local_commerce',
    ),
    // The local token has 18 decimals; a $10.50 sandbox order reserves ~10.5 tokens.
    funding: 100n * 10n ** 18n,
  });
  const now = () => Math.floor(Date.now() / 1000);
  const groupId = local.manifest.groupId;
  const mandateId = `gift-local-${process.pid}-${now()}`;
  const mandates = join(dir, 'economic-mandates.json');
  writeFileSync(
    mandates,
    JSON.stringify([
      {
        mandateId,
        groupId,
        version: 1,
        status: 'ACTIVE',
        domains: ['COMMERCE'],
        providers: [RELOADLY],
        hosts: [RELOADLY_SANDBOX_HOST],
        perActionCap: usd(2_500),
        cumulativeBudget: usd(5_000),
        autoApproveMax: usd(2_500),
        quorum: 1,
        members: ['m-1'],
        approverKinds: ['LOCAL_FIXTURE'],
        maxQuoteAgeSeconds: 900,
        grantTtlSeconds: 900,
        environment: 'SANDBOX',
        validUntil: now() + 86_400,
      },
    ]),
  );
  const fake = new FakeReloadly();
  const vaultKey = randomBytes(32).toString('base64');
  const runtime = await openLocalRuntime(local.manifest, {
    env: {
      SYNQ_ECONOMIC_GRANT_KEY: randomBytes(32).toString('hex'),
      SYNQ_ECONOMIC_MANDATES_FILE: mandates,
      SYNQ_PROFILE_VAULT_KEY: vaultKey,
      RELOADLY_CLIENT_ID: fake.clientId,
      RELOADLY_CLIENT_SECRET: fake.clientSecret,
    },
    fetch: fake.fetch as HttpFetch,
  });
  const env = await startTemporal();
  try {
    for (const name of BOOKING)
      expect(typeof runtime.activities[name]).toBe('function');
    expect(runtime.commerce.status.booking).toBe('READY');
    const tables = await local.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [
        [
          'synq_settle_orders',
          'synq_settle_ledger',
          'synq_treasury_reservations',
          'synq_econ_grants',
          'synq_econ_consumed',
          'synq_profile_vault',
          'synq_booking_receipts',
          'synq_delegation_attempts',
        ],
      ],
    );
    expect(tables.rows).toHaveLength(8);
    // The attempt ledger is live in this runtime even where the kit has no deployment.
    const key = `0x${randomBytes(32).toString('hex')}:0`;
    expect(await runtime.delegation.ledger.claim(key)).toBe(true);
    expect(await runtime.delegation.ledger.claim(key)).toBe(false);

    const { ref: recipientRef } = await new ProfileDirectory(
      runtime.commerce.profiles,
      new EnvVaultKeyProvider({ SYNQ_PROFILE_VAULT_KEY: vaultKey }),
      now,
    ).put({
      groupId,
      kind: 'RECIPIENT',
      data: {
        name: 'Bea Recipient',
        line1: '1 Main St',
        city: 'Austin',
        postalCode: '73301',
        country: 'US',
        email: 'bea@example.com',
      },
    });
    const intent = EconomicIntentSchema.parse({
      id: `gift-local-${process.pid}-${now()}`,
      groupId,
      domain: 'COMMERCE',
      objective: 'buy a $10 gift card',
      subject: giftCardSubject({
        brand: 'Amazon',
        countryCode: 'US',
        recipientCurrency: 'USD',
        unitPriceCents: 1000,
        recipientRef,
      }),
      hardConstraints: [],
      preferences: [],
      budget: { max: usd(2_500) },
      autonomy: { execution: 'AUTO', substitution: 'NONE' },
      validUntil: now() + 3_600,
    });
    const search = await searchOffers({
      intent,
      providers: [runtime.commerce.providers.providers[RELOADLY]!],
      graph: runtime.commerce.providers.graph,
      now,
    });
    const candidates = selectOffers({
      intent,
      search,
      now: now(),
    }).ranked.map((r) => ({ offer: r.offer, landed: r.landed }));
    expect(candidates).toHaveLength(1);
    const config = testConfig('local-commerce');
    const s = await withWorkers(env, config, runtime.activities, async () => {
      const handle = await env.client.workflow.start('BookingWorkflow', {
        taskQueue: config.taskQueues.economic,
        workflowId: `local-commerce-${intent.id}`,
        args: [
          {
            bookingId: intent.id,
            groupId,
            mandateId,
            intent,
            candidates,
            approvedMax: usd(2_500),
            travelerRefs: [],
            approvalTimeoutSeconds: 30,
            reconcileIntervalSeconds: 1,
            reconcileAttempts: 3,
          },
        ],
      });
      return (await handle.result()) as BookingWorkflowState;
    });
    expect([s.state, ...s.notes]).toEqual(['RECONCILED']);
    expect(fake.orders).toHaveLength(1);
    const order = await runtime.commerce.fabric.store.findOrder(
      RELOADLY,
      s.idempotencyKey,
    );
    expect(order!.state).toBe('SANDBOX_FULFILLED');
    // Confirmed balance came from the chain; the sandbox order moved no treasury value.
    const free = await runtime.commerce.reservations.free(
      groupId,
      local.manifest.asset.canonicalAssetId,
    );
    expect(BigInt(free.confirmed)).toBeGreaterThan(0n);
    expect(free.free).toBe(free.confirmed);
  } finally {
    await env.teardown();
    await runtime.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
