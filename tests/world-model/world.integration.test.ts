import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient } from 'redis';
import { PluginRegistry } from '@synq/plugin-sdk';
import { officialAssets } from '@synq/chain-registry';
import {
  MembershipViewSchema,
  networkProfileForChain,
  type GrantDraft,
  type PluginManifestInput,
} from '@synq/schemas';
import {
  ProjectionReader,
  Projector,
  RedisSnapshotCache,
  type RedisConnection,
} from '../../packages/read-model/src/index.js';
import { PostgresIdentityStore } from '../../packages/identity/src/server.js';
import { Kernel } from '../../packages/kernel/src/index.js';
import {
  InMemoryMarketDataSource,
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
  capabilityFacts,
} from '@synq/world-model';
import {
  DeclaredSimulation,
  KernelProposalGateway,
  StoreIdentityDirectoryReader,
} from '../../apps/api/src/brain-runtime.js';
import {
  account,
  ausdLower,
  config,
  executor,
  groupId as chainGroupId,
  lifecycle,
  owners,
  recipient,
} from '../read-model/fixtures.js';
import { dropSchemas, freshStore } from '../read-model/pg.js';
import {
  AUDIT_KEY,
  FixtureLedger,
  FixtureProbe,
  mandate,
} from '../kernel/fixtures.js';
import { FixtureDirectory } from '../kernel/fixtures.js';
import { SUPPORT, action, brainFor, chatFixture } from '../brain/harness.js';

const url =
  process.env.SYNQ_P06_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p06_world';
const redisUrl =
  process.env.SYNQ_P06_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/11';
const GROUP = 'p06_group';
const T = 1_791_700_000;
const network = networkProfileForChain(10143);
const AUSD = officialAssets.testnetAUSD;
const created: string[] = [];
let pool: pg.Pool;
let redis: ReturnType<typeof createClient>;

async function ensureDatabase() {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_p06_[a-z0-9_]+$/.test(name))
    throw new Error('unsafe test database');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  await ensureDatabase();
  pool = new pg.Pool({ connectionString: url, max: 6 });
  redis = createClient({ url: redisUrl });
  await redis.connect();
  await redis.flushDb();
});
afterAll(async () => {
  await dropSchemas(pool, created);
  await redis.quit();
  await pool.end();
});

describe('WorldSnapshot from real Postgres read model, Redis cache, Postgres identity and the Kernel', () => {
  it('assembles provenance-tagged fields and shows a Brain proposal as a pending Postgres draft', async () => {
    const store = await freshStore(pool, 10143, 'rm_ws4_p06', created);
    const cfg = config();
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    const reader = new ProjectionReader(store, cfg);
    const cache = new RedisSnapshotCache(
      redis as unknown as RedisConnection,
      reader,
      {
        namespace: 'synq:rm:p06-it',
      },
    );

    const identity = new PostgresIdentityStore(pool);
    await identity.migrate();
    await pool.query(
      'TRUNCATE identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal RESTART IDENTITY CASCADE',
    );
    await identity.transaction(async (tx) => {
      for (const [i, signer] of owners.entries())
        await tx.insertPrincipal({
          principalId: `principal_${i}`,
          kind: 'LOCAL_FIXTURE',
          signer,
          rpId: null,
          credential: null,
          providerRef: null,
          status: 'ACTIVE',
          enrolledAt: T - 100,
          lastRecoveredAt: null,
        });
      await tx.insertGroup({
        groupId: GROUP,
        chainGroupId,
        chainId: 10143,
        account,
        owners,
        threshold: 2,
        executors: [executor],
        membershipEpoch: 1,
        createdAt: T - 100,
      });
      for (const [i, signer] of owners.entries())
        await tx.insertMembership(
          MembershipViewSchema.parse({
            groupId: GROUP,
            memberId: `member_${i}`,
            principalId: `principal_${i}`,
            principalKind: 'LOCAL_FIXTURE',
            role: 'APPROVER',
            signer,
            status: 'ACTIVE',
            joinedEpoch: 1,
            joinedAt: T - 100,
            revokedAt: null,
          }),
        );
    });

    const terms = mandate({
      groupId: GROUP,
      network,
      account,
      chainGroupId,
      operators: [executor],
      bindings: [
        {
          pluginId: 'ausd-transfer',
          action: 'TRANSFER',
          target: ausdLower,
          selector: '0xa9059cbb',
        },
      ],
      recipients: [{ address: recipient, purpose: 'COUNTERPARTY' }],
      inputAsset: AUSD,
      perActionCap: '1000000',
      cumulativeBudget: '2000000',
      validAfter: 0,
      validUntil: 4_000_000_000,
      quoteTtlSeconds: 300,
      evidenceTtlSeconds: 300,
      simulationTtlSeconds: 300,
      maxGrantTtlSeconds: 120,
    });
    const manifest: PluginManifestInput = {
      id: 'ausd-transfer',
      version: '0.1.0',
      capabilities: ['TRANSFER'],
      chains: [10143],
      riskClass: 'FINANCIAL_EXECUTION',
      requiresSimulation: true,
      maxGrantTtlSeconds: 120,
    };
    const clock = {
      t: T,
      now() {
        return this.t;
      },
    };
    const probe = new FixtureProbe();
    probe.observation = { ...probe.observation, chainId: 10143 };
    const kernel = new Kernel({
      auditKey: AUDIT_KEY,
      membershipDirectory: new FixtureDirectory(),
      network,
      executionModule: `0x${'0'.repeat(38)}f3`,
      clock,
      approvalLedger: new FixtureLedger(),
      freshness: { probe, maxLagBlocks: 0 },
      plugins: [manifest],
      mandates: [terms],
      balances: [{ account, asset: AUSD, balance: '750000' }],
    });
    const plugins = new PluginRegistry();
    const unused = async (): Promise<never> => {
      throw new Error('execution is outside the Brain');
    };
    plugins.register({
      manifest,
      health: async () => ({ available: true, checkedAt: T }),
      prepare: unused,
      simulate: unused,
      execute: unused,
      reconcile: unused,
    });
    await plugins.refreshHealth('ausd-transfer', { network, now: T });
    const market = new InMemoryMarketDataSource([
      {
        pair: 'AUSD/USD',
        price: '99983000',
        priceDecimals: 8,
        source: 'chainlink-ausd-usd',
        chainId: 10143,
        observedAt: T,
        maxAgeSeconds: 3600,
      },
    ]);
    const builder = new WorldSnapshotBuilder({
      network,
      now: () => clock.t,
      readModel: {
        snapshots: cache,
        head: { head: async () => ({ block: 111 }) },
        maxLagBlocks: 5,
      },
      kernel,
      identity: new StoreIdentityDirectoryReader(identity, pool),
      plugins,
      modelProviders: {
        QWEN: { installed: true, credentialsPresent: false },
        KIMI: { installed: true, credentialsPresent: false },
      },
      mainnetBroadcastAllowed: false,
      workflows: new InMemoryWorkflowStatusReader([], T),
      market,
      capabilityFacts: {
        ...capabilityFacts,
        providers: [
          ...capabilityFacts.providers,
          {
            providerId: 'AUSD_TRANSFER',
            pluginId: 'ausd-transfer',
            kind: 'PLUGIN',
            credentialEnv: [],
            sourceRefs: ['tests/world-model/world.integration.test.ts'],
            facts: [
              {
                action: 'TRANSFER',
                networks: ['sandbox/monad-testnet'],
                mutating: true,
                requiresHuman: true,
                disabledBy: null,
                note: 'integration test binding',
              },
            ],
          },
        ],
      },
    });

    const first = await builder.build({ groupId: GROUP });
    expect(first.group.meta).toMatchObject({
      provenance: 'ENVIO',
      freshness: 'FRESH',
    });
    expect(first.group.value).toMatchObject({
      account,
      chainGroupId,
      threshold: 2,
    });
    expect(first.readModel.value).toMatchObject({
      indexedThroughBlock: 110,
      lagBlocks: 1,
      status: 'FRESH',
    });
    expect(first.treasury.value).toEqual([
      { asset: AUSD, balance: '750000', reserved: '0', free: '750000' },
    ]);
    expect(first.members.meta.provenance).toBe('POSTGRES');
    expect(
      first.members.value.map((m) => [m.memberId, m.ownerOfAccount]),
    ).toEqual([
      ['member_0', true],
      ['member_1', true],
      ['member_2', true],
    ]);
    expect(first.recentExecutions.value.length).toBeGreaterThan(0);
    expect(first.proposals.value).toEqual([]);
    expect(cache.stats.groupMisses).toBe(1);
    await builder.build({ groupId: GROUP });
    expect(cache.stats.groupHits).toBe(1);

    const gateway = new KernelProposalGateway({
      kernel,
      market,
      simulations: new DeclaredSimulation(
        clock,
        'integration-declared-simulation',
      ),
      clock,
      executionMode: 'SIMULATION',
      onPendingDraft: (draft: GrantDraft) =>
        identity.transaction((tx) =>
          tx.insertDraft({
            draft,
            asset: AUSD,
            status: 'PENDING',
            createdAt: clock.t,
          }),
        ),
    });
    const brain = brainFor(
      { kernel: { clock }, gateway },
      {
        qwen: chatFixture('qwen', [
          {
            key: 'it:intent',
            content: {
              items: [
                action({
                  network: 'sandbox/monad-testnet',
                  providerId: 'AUSD_TRANSFER',
                  token: ausdLower,
                  recipient,
                  amount: { display: '0.5', baseUnits: '500000', decimals: 6 },
                }),
              ],
            },
          },
        ]),
        kimi: chatFixture('kimi', [{ key: 'it:critic', content: SUPPORT }]),
      },
    );
    const run = await brain.run({
      runId: 'run_it',
      groupId: GROUP,
      world: first,
      messages: [
        { memberId: 'member_0', text: 'Pay the counterparty 0.5 AUSD.' },
      ],
      fixtureKey: 'it',
    });
    expect(run.items[0]?.decision).toMatchObject({
      status: 'PENDING_APPROVAL',
      executionMode: 'SIMULATION',
    });
    expect(kernel.stateView().grants).toEqual([]);

    const second = await builder.build({ groupId: GROUP });
    expect(second.proposals.meta.provenance).toBe('POSTGRES');
    expect(second.proposals.value).toEqual([
      expect.objectContaining({
        draftDigest: run.items[0]?.decision?.draftDigest,
        status: 'PENDING',
        countedApprovals: 0,
      }),
    ]);
    expect(second.kernelIntents.value.map((i) => i.state)).toEqual([
      'PENDING_APPROVAL',
    ]);
    expect(second.treasury.value[0]?.reserved).toBe('0');
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });
});
