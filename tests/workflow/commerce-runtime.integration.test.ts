import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  EconomicIntentSchema,
  searchOffers,
  selectOffers,
  type EconomicIntent,
} from '@synq/offer-exchange';
import {
  LITHIC,
  RELOADLY,
  RELOADLY_SANDBOX_HOST,
  giftCardSubject,
  type HttpFetch,
} from '@synq/plugin-commerce';
import { EnvVaultKeyProvider, ProfileDirectory } from '@synq/profile-vault';
import type { VerifiedApproval } from '@synq/schemas';
import {
  openCommerceRuntime,
  type CommerceRuntime,
} from '../../workers/workflow/src/commerce/runtime.js';
import type { BookingWorkflowState } from '../../workers/workflow/src/workflows/booking.js';
import { AUSD, USDC, usd } from '../../scripts/lib/fabric-booking-world.js';
import { approval, approvalPorts } from '../kernel/economic-fixtures.js';
import { FakeReloadly } from '../commerce/fake-reloadly.js';
import { ensureP08Database } from '../treasury/pg.js';
import { startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { testDatabaseUrl } from '../durable/pg.js';

const URL = testDatabaseUrl(
  'SYNQ_COMMERCE_TEST_DATABASE_URL',
  'synq_p08_commerce_runtime',
);
const GROUP = 'group-1';
const MEMBERS = ['alice', 'bob', 'carol'];
const now = () => Math.floor(Date.now() / 1000);
const schemas: string[] = [];
let n = 0;
let pool: pg.Pool;
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  pool = await ensureP08Database(URL);
  env = await startTemporal();
});
afterAll(async () => {
  for (const s of schemas)
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
  await env?.teardown();
});

function freshSchema() {
  const s = `v13_rt_${process.pid}_${++n}`;
  schemas.push(s);
  return s;
}

/** Identity layer stand-in: approvals stored under the request hash, fixture-signed. */
function identity() {
  const stored = new Map<string, VerifiedApproval[]>();
  return {
    ports: {
      ...approvalPorts(MEMBERS, { groupId: GROUP }),
      approvalsFor: async (hash: string) => stored.get(hash) ?? [],
    },
    async approve(hash: string, member: string) {
      const a = await approval(member, hash, {
        groupId: GROUP,
        mandateId: 'gift-mandate',
      });
      stored.set(hash, [...(stored.get(hash) ?? []), a]);
      return a.approvalId;
    },
  };
}

const treasury = {
  core: AUSD,
  edge: USDC,
  account: async (g: string) =>
    g === GROUP
      ? ('0x00000000000000000000000000000000000a11ce' as const)
      : null,
  confirmed: async (_g: string, asset: { canonicalAssetId: string }) =>
    asset.canonicalAssetId === AUSD.canonicalAssetId
      ? 10_000n * 10n ** BigInt(AUSD.decimals)
      : null,
};

function mandatesFile(version = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'synq-mandates-'));
  const path = join(dir, 'mandates.json');
  writeFileSync(
    path,
    JSON.stringify([
      {
        mandateId: 'gift-mandate',
        groupId: GROUP,
        version,
        status: 'ACTIVE',
        domains: ['COMMERCE'],
        providers: [RELOADLY],
        hosts: [RELOADLY_SANDBOX_HOST],
        perActionCap: usd(2_500),
        cumulativeBudget: usd(10_000),
        autoApproveMax: usd(0),
        quorum: 2,
        members: MEMBERS,
        approverKinds: ['LOCAL_FIXTURE'],
        maxQuoteAgeSeconds: 900,
        grantTtlSeconds: 900,
        environment: 'SANDBOX',
        validUntil: now() + 86_400,
      },
    ]),
  );
  return path;
}

async function intentFor(runtime: CommerceRuntime, vaultKey: string) {
  const { ref: recipientRef } = await new ProfileDirectory(
    runtime.profiles,
    new EnvVaultKeyProvider({ SYNQ_PROFILE_VAULT_KEY: vaultKey }),
    now,
  ).put({
    groupId: GROUP,
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
  return EconomicIntentSchema.parse({
    id: `gift-rt-${process.pid}-${++n}`,
    groupId: GROUP,
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
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
}

async function candidates(runtime: CommerceRuntime, intent: EconomicIntent) {
  const provider = runtime.providers.providers[RELOADLY];
  if (!provider) return [];
  const search = await searchOffers({
    intent,
    providers: [provider],
    graph: runtime.providers.graph,
    now,
  });
  return selectOffers({ intent, search, now: now() }).ranked.map((r) => ({
    offer: r.offer,
    landed: r.landed,
  }));
}

async function book(
  runtime: CommerceRuntime,
  intent: EconomicIntent,
  cands: Awaited<ReturnType<typeof candidates>>,
  approve?: (hash: string) => Promise<string[]>,
  approvalTimeoutSeconds = 30,
) {
  const config = testConfig('commerce-rt');
  return withWorkers(env, config, runtime.activities, async () => {
    const handle = await env.client.workflow.start('BookingWorkflow', {
      taskQueue: config.taskQueues.economic,
      workflowId: `commerce-rt-${intent.id}`,
      args: [
        {
          bookingId: intent.id,
          groupId: GROUP,
          mandateId: 'gift-mandate',
          intent,
          candidates: cands,
          approvedMax: usd(2_500),
          travelerRefs: [],
          approvalTimeoutSeconds,
          reconcileIntervalSeconds: 1,
          reconcileAttempts: 3,
        },
      ],
    });
    if (approve) {
      let hash: string | null = null;
      for (let i = 0; i < 300 && !hash; i++) {
        const s = await handle.query<BookingWorkflowState>('bookingState');
        if (s.state === 'FAILED') break;
        hash = s.requestHash;
        if (!hash) await new Promise((r) => setTimeout(r, 100));
      }
      if (hash)
        for (const token of await approve(hash))
          await handle.signal('bookingApproval', { token });
    }
    return (await handle.result()) as BookingWorkflowState;
  });
}

describe(
  'production commerce runtime (Postgres + Temporal)',
  { timeout: 180_000 },
  () => {
    it('RT-001 a gift card books end-to-end through Postgres fabric, reservations, Kernel grant ledger and sealed vault, and survives a restart', async () => {
      const schema = freshSchema();
      const fake = new FakeReloadly();
      const vaultKey = randomBytes(32).toString('base64');
      const runtimeEnv = {
        SYNQ_ECONOMIC_GRANT_KEY: randomBytes(32).toString('hex'),
        SYNQ_ECONOMIC_MANDATES_FILE: mandatesFile(),
        SYNQ_PROFILE_VAULT_KEY: vaultKey,
        RELOADLY_CLIENT_ID: fake.clientId,
        RELOADLY_CLIENT_SECRET: fake.clientSecret,
      };
      const id = identity();
      const open = () =>
        openCommerceRuntime({
          pool,
          schema,
          env: runtimeEnv,
          now,
          fetch: fake.fetch as HttpFetch,
          identity: id.ports,
          treasury,
          workerId: 'rt-test',
        });
      const runtime = await open();
      expect(runtime.status.booking).toBe('READY');
      expect(runtime.status.bitrefillApprovals).toBe('DENY_ALL');
      const status = Object.fromEntries(
        runtime.status.providers.map((p) => [p.providerId, p.status]),
      );
      expect(status).toMatchObject({
        [RELOADLY]: 'READY',
        [LITHIC]: 'BLOCKED_EXTERNAL',
        crossmint: 'BLOCKED_EXTERNAL',
        bitrefill: 'BLOCKED_EXTERNAL',
      });

      const intent = await intentFor(runtime, vaultKey);
      const cands = await candidates(runtime, intent);
      expect(cands).toHaveLength(1);
      const s = await book(runtime, intent, cands, async (hash) => [
        await id.approve(hash, 'alice'),
        await id.approve(hash, 'bob'),
      ]);
      expect(s.state).toBe('RECONCILED');
      expect(fake.orders).toHaveLength(1);

      const order = await runtime.fabric.store.findOrder(
        RELOADLY,
        s.idempotencyKey,
      );
      expect(order!.state).toBe('SANDBOX_FULFILLED');
      expect((await runtime.reservations.get(s.reservationId!))!.state).toBe(
        'RELEASED',
      );
      const receipt = await runtime.records.receipt(`rcpt-${intent.id}`);
      expect(receipt).toMatchObject({
        evidence: 'PROVIDER_SANDBOX',
        environment: 'SANDBOX',
      });
      const vault = await pool.query(
        `SELECT kind, ciphertext FROM "${schema}".synq_profile_vault WHERE kind='GIFT_CODE'`,
      );
      expect(vault.rows).toHaveLength(1);
      expect(JSON.stringify(vault.rows)).not.toContain(fake.code);

      // Restart: migrations and the mandate file re-apply cleanly; state is durable.
      const again = await open();
      expect(
        (await again.fabric.store.findOrder(RELOADLY, s.idempotencyKey))!.state,
      ).toBe('SANDBOX_FULFILLED');
      expect(await again.authority!.isConsumed(s.grantId!)).toBe(true);
      expect(await again.authority!.spentFor('gift-mandate')).toBeGreaterThan(
        0n,
      );
      expect(await again.records.receipt(`rcpt-${intent.id}`)).toEqual(receipt);
    });

    it('RT-002 approvals are only what the identity layer stored for this request hash', async () => {
      const schema = freshSchema();
      const fake = new FakeReloadly();
      const vaultKey = randomBytes(32).toString('base64');
      const id = identity();
      const runtime = await openCommerceRuntime({
        pool,
        schema,
        env: {
          SYNQ_ECONOMIC_GRANT_KEY: randomBytes(32).toString('hex'),
          SYNQ_ECONOMIC_MANDATES_FILE: mandatesFile(),
          SYNQ_PROFILE_VAULT_KEY: vaultKey,
          RELOADLY_CLIENT_ID: fake.clientId,
          RELOADLY_CLIENT_SECRET: fake.clientSecret,
        },
        now,
        fetch: fake.fetch as HttpFetch,
        identity: id.ports,
        treasury,
        workerId: 'rt-test',
      });
      const intent = await intentFor(runtime, vaultKey);
      // One genuine approval, one approval id that was never stored, and a chat-style token.
      const s = await book(
        runtime,
        intent,
        await candidates(runtime, intent),
        async (hash) => [
          await id.approve(hash, 'alice'),
          'apr-forged',
          `fixture-verified:bob:${hash}`,
        ],
        4,
      );
      expect(s.state).toBe('FAILED');
      expect(s.grantId).toBeNull();
      expect(fake.orders).toHaveLength(0);
      expect((await runtime.reservations.get(s.reservationId!))!.state).toBe(
        'RELEASED',
      );
    });

    it('RT-004 a revoked mandate stays revoked when the file bumps its version', async () => {
      const schema = freshSchema();
      const env = (version: number) => ({
        SYNQ_ECONOMIC_GRANT_KEY: 'ab'.repeat(32),
        SYNQ_ECONOMIC_MANDATES_FILE: mandatesFile(version),
      });
      const open = (version: number) =>
        openCommerceRuntime({
          pool,
          schema,
          env: env(version),
          now,
          fetch: (async () => {
            throw new Error('no network');
          }) as HttpFetch,
          identity: identity().ports,
          treasury,
          workerId: 'rt-revoke',
        });
      const first = await open(1);
      await first.authority!.revoke('gift-mandate');
      const bumped = await open(2);
      const m = await bumped.authority!.mandate('gift-mandate');
      expect(m?.status).toBe('REVOKED');
      expect(m?.version).toBe(1);
    });

    it('RT-003 without credentials or a grant key the worker still starts, reports BLOCKED, and books nothing', async () => {
      const schema = freshSchema();
      const calls: string[] = [];
      const fetch: HttpFetch = async (url) => {
        calls.push(url);
        return { status: 500, text: async () => '{}' };
      };
      const bare = await openCommerceRuntime({
        pool,
        schema,
        env: {},
        now,
        fetch,
        identity: identity().ports,
        treasury,
        workerId: 'rt-test',
      });
      expect(bare.status.booking).toBe('BLOCKED');
      expect(bare.status.reason).toMatch(/SYNQ_ECONOMIC_GRANT_KEY/);
      expect(bare.status.providers.map((p) => p.status)).toEqual(
        Array(4).fill('BLOCKED_EXTERNAL'),
      );
      expect(Object.keys(bare.providers.ports)).toEqual([]);
      expect(bare.authority).toBeNull();
      const fake = new FakeReloadly();
      const donor = await openCommerceRuntime({
        pool,
        schema: freshSchema(),
        env: {
          SYNQ_ECONOMIC_GRANT_KEY: randomBytes(32).toString('hex'),
          SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
          RELOADLY_CLIENT_ID: fake.clientId,
          RELOADLY_CLIENT_SECRET: fake.clientSecret,
        },
        now,
        fetch: fake.fetch as HttpFetch,
        identity: identity().ports,
        treasury,
        workerId: 'rt-test',
      });
      const intent = await intentFor(donor, randomBytes(32).toString('base64'));
      const cands = await candidates(donor, intent);
      expect(cands).toHaveLength(1);
      await expect(book(bare, intent, cands)).rejects.toThrow();
      // Grant key present but no provider credentials: the candidate cannot revalidate.
      const keyed = await openCommerceRuntime({
        pool,
        schema,
        env: { SYNQ_ECONOMIC_GRANT_KEY: randomBytes(32).toString('hex') },
        now,
        fetch,
        identity: identity().ports,
        treasury,
        workerId: 'rt-test',
      });
      const s = await book(keyed, { ...intent, id: `${intent.id}-k` }, cands);
      expect(s.state).toBe('FAILED');
      expect(s.notes.join(' ')).toMatch(/provider not installed/);
      expect(s.reservationId).toBeNull();
      expect(calls).toEqual([]);
    });
  },
);
