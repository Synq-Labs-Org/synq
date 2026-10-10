import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';
import { LOCAL_CHAIN_ID } from '@synq/schemas';
import {
  ChainHeadObserver,
  ProjectionReader,
  Projector,
  RedisSnapshotCache,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import {
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
  capabilityFacts,
  credentialPresence,
  mainnetBroadcastAllowed,
} from '@synq/world-model';
import { FixtureFileSchema, SynqBrain } from '@synq/agent-runtime';
import { QwenStructuredReasoner, qwenOptionsFromEnv } from '@synq/plugin-qwen';
import { KimiReasoner, kimiOptionsFromEnv } from '@synq/plugin-kimi';
import {
  DeclaredSimulation,
  KernelProposalGateway,
  StoreIdentityDirectoryReader,
} from '../apps/api/src/brain-runtime.js';
import { indexedEvents } from '../apps/demo/src/events.js';

process.env.SYNQ_DEMO_DATABASE_URL ??=
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p06_demo';
process.env.SYNQ_ALLOW_MAINNET_BROADCAST ??= 'false';
const REDIS_URL =
  process.env.SYNQ_P06_DEMO_REDIS_URL ?? 'redis://127.0.0.1:56379/12';

const GROUP_TEXT = [
  {
    memberId: 'member_0',
    name: 'Alice',
    text: "We're going to Tokyo next month. Keep 150 aside for Sarah's birthday gift.",
  },
  {
    memberId: 'member_1',
    name: 'Ben',
    text: "I'll buy Sarah's gift, so let me withdraw that 150 when it's time. Also put 200 into MON gradually over two months, but don't chase spikes.",
  },
  {
    memberId: 'member_2',
    name: 'Sarah',
    text: 'Fine by me, but anything that moves money still needs our votes.',
  },
];

const { startLocalVertical } = await import('../apps/demo/src/local.js');
const local = await startLocalVertical();
const pool = new pg.Pool({
  connectionString: process.env.SYNQ_DEMO_DATABASE_URL,
  max: 4,
});
const redis = createClient({ url: REDIS_URL });
try {
  await redis.connect();
  const schema = `rm_p06_demo_${Date.now().toString(36)}`;
  const store = new PostgresProjectionStore({ pool }, LOCAL_CHAIN_ID, schema);
  await store.migrate();
  const { events, checkpoint } = await indexedEvents(local.chain);
  await new Projector(store, local.readModelConfig).applyWindow({
    fromBlockExclusive: local.readModelConfig.startBlock - 1,
    toBlockInclusive: checkpoint,
    events,
  });
  const reader = new ProjectionReader(store, local.readModelConfig);
  const cache = new RedisSnapshotCache(redis, reader, {
    namespace: 'synq:rm:p06-demo',
  });
  await local.sync();
  await local.plugins.refreshHealth('local-transfer', {
    network: local.mandate.network,
    now: local.clock.now(),
  });

  const presence = credentialPresence(capabilityFacts, process.env);
  const builder = new WorldSnapshotBuilder({
    network: local.mandate.network,
    now: () => local.clock.now(),
    readModel: {
      snapshots: cache,
      head: new ChainHeadObserver(local.chain.client, LOCAL_CHAIN_ID, {
        ttlMs: 0,
      }),
      maxLagBlocks: 5,
    },
    kernel: local.kernel,
    identity: new StoreIdentityDirectoryReader(local.identity.store, pool),
    plugins: local.plugins,
    modelProviders: {
      QWEN: { installed: true, credentialsPresent: presence.QWEN ?? false },
      KIMI: { installed: true, credentialsPresent: presence.KIMI ?? false },
    },
    mainnetBroadcastAllowed: mainnetBroadcastAllowed(process.env),
    workflows: new InMemoryWorkflowStatusReader([], local.clock.now()),
    localAssets: [local.asset],
  });
  const world = await builder.build({ groupId: local.mandate.groupId });

  const decimals = local.decimals;
  const units = (n: number) => (BigInt(n) * 10n ** BigInt(decimals)).toString();
  const member1 = world.members.value.find((m) => m.memberId === 'member_1');
  if (!member1 || !world.group.value) throw new Error('WORLD_INCOMPLETE');
  const bind = (path: string) =>
    FixtureFileSchema.parse(
      JSON.parse(
        readFileSync(path, 'utf8')
          .replaceAll('{{TOKEN}}', local.asset.address)
          .replaceAll('{{ACCOUNT}}', world.group.value!.account)
          .replaceAll('{{MEMBER_1}}', member1.signer)
          .replaceAll('{{DECIMALS}}', String(decimals))
          .replaceAll('{{UNITS_150}}', units(150))
          .replaceAll('{{UNITS_200}}', units(200))
          .replaceAll('{{UNITS_25}}', units(25)),
      ),
    );
  const qwen = new QwenStructuredReasoner(
    qwenOptionsFromEnv(process.env, {
      fixtures: bind('tests/brain/fixtures/demo.qwen.json'),
    }),
  );
  const kimi = new KimiReasoner({
    ...kimiOptionsFromEnv(process.env, {
      fixtures: bind('tests/brain/fixtures/demo.kimi.json'),
    }),
    now: () => local.clock.now(),
  });
  const gateway = new KernelProposalGateway({
    kernel: local.kernel,
    market: { quotes: async () => [] },
    simulations: new DeclaredSimulation(local.clock, 'brain-demo-declared'),
    clock: local.clock,
    executionMode: 'SIMULATION',
    onPendingDraft: async (draft) => {
      await local.identity.gateway.registerDraft({ draft, asset: local.asset });
    },
  });
  const brain = new SynqBrain({
    structured: qwen,
    research: kimi,
    critic: kimi,
    proposals: gateway,
    executionMode: 'SIMULATION',
    nowSeconds: () => local.clock.now(),
  });
  const runId = `brain_demo_${local.clock.now()}`;
  const result = await brain.run({
    runId,
    groupId: local.mandate.groupId,
    world,
    messages: GROUP_TEXT.map(({ memberId, name, text }) => ({
      memberId,
      text: `${name}: ${text}`,
    })),
    fixtureKey: 'brain-demo',
  });
  const output = {
    executionMode: 'SIMULATION',
    modes: {
      chain: 'local/anvil (real Anvil node, real Safe and Synq contracts)',
      readModel: 'Postgres projection of Anvil logs behind the Redis cache',
      identity: 'Postgres identity store with local software-key fixtures',
      kernel:
        'real Kernel (createIntentKernel) with read-model freshness probe',
      qwen: `${qwen.availability().mode}${qwen.transport.label ? ` (${qwen.transport.label})` : ''}`,
      kimi: `${kimi.availability().mode}${kimi.transport.label ? ` (${kimi.transport.label})` : ''}`,
      market: 'none configured in the local profile (P09 adapters)',
      groupText:
        'authored from Bible §21/§69; the run brief §71 text was not on disk',
    },
    world: {
      snapshotId: world.snapshotId,
      sources: world.sourceFreshness,
      treasury: world.treasury,
      capabilities: world.capabilities.value.nodes.map((n) => ({
        providerId: n.providerId,
        status: n.status,
      })),
    },
    items: result.items.map((i) => ({
      proposalId: i.proposalId,
      kind: i.kind,
      status: i.status,
      issues: i.issues,
      mandateProposal:
        i.normalized?.kind === 'MANDATE' ? i.normalized.mandate : null,
      kernelDecision: i.decision,
      evidenceArtifactHash: i.evidenceArtifactHash,
    })),
    evidenceArtifact: result.items[0]?.evidenceArtifact ?? null,
    findings: result.findings,
    costs: result.costs,
    kernelGrants: local.kernel.stateView().grants.length,
  };
  const dir = resolve('artifacts/brain-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${runId}.json`),
    JSON.stringify({ ...output, result }, null, 2) + '\n',
  );
  console.log(JSON.stringify(output, null, 2));
  console.log(`\nfull run written to artifacts/brain-demo/${runId}.json`);
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
} finally {
  await redis.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);
  await local.close();
}
