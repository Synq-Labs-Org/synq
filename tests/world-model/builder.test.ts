import { describe, expect, it } from 'vitest';
import {
  PROVENANCES,
  WorldModelSnapshotSchema,
  type WorldModelSnapshot,
} from '@synq/schemas';
import {
  InMemoryRiskStateSource,
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
} from '@synq/world-model';
import {
  TOKEN,
  evidence,
  intent,
  mandate,
  network,
  now,
  trust,
} from '../kernel/fixtures.js';
import {
  FixtureIdentityReader,
  GROUP,
  evalWorld,
  groupSnapshot,
} from '../brain/harness.js';

const FIELDS = [
  'network',
  'readModel',
  'group',
  'members',
  'principalTypes',
  'quorum',
  'treasury',
  'mandates',
  'proposals',
  'approvals',
  'kernelIntents',
  'pendingExecutions',
  'recentExecutions',
  'pluginHealth',
  'capabilities',
  'workflows',
  'marketSnapshots',
  'riskState',
] as const satisfies readonly (keyof WorldModelSnapshot)[];

describe('WorldSnapshot builder', () => {
  it('every field carries provenance, freshness and confidence from its real source', async () => {
    const world = await evalWorld();
    const s = await world.builder.build({ groupId: GROUP });
    expect(WorldModelSnapshotSchema.parse(s)).toEqual(s);
    for (const field of FIELDS) {
      expect(PROVENANCES, field).toContain(s[field].meta.provenance);
      expect(s[field].meta.confidence).toBeGreaterThanOrEqual(0);
    }
    expect(
      Object.fromEntries(FIELDS.map((f) => [f, s[f].meta.provenance])),
    ).toEqual({
      network: 'CHAIN',
      readModel: 'ENVIO',
      group: 'ENVIO',
      members: 'POSTGRES',
      principalTypes: 'POSTGRES',
      quorum: 'KERNEL',
      treasury: 'ENVIO',
      mandates: 'KERNEL',
      proposals: 'POSTGRES',
      approvals: 'POSTGRES',
      kernelIntents: 'KERNEL',
      pendingExecutions: 'KERNEL',
      recentExecutions: 'ENVIO',
      pluginHealth: 'PLUGIN',
      capabilities: 'PLUGIN',
      workflows: 'TEMPORAL',
      marketSnapshots: 'MARKET',
      riskState: 'MARKET',
    });
    expect(s.group.value).toMatchObject({ groupId: GROUP, threshold: 2 });
    expect(s.members.value).toHaveLength(3);
    expect(s.principalTypes.value).toEqual(['LOCAL_FIXTURE']);
    expect(s.quorum.value.mandates[0]).toMatchObject({ quorum: 2 });
    expect(s.treasury.value[0]).toMatchObject({
      balance: '10000',
      reserved: '0',
      free: '10000',
    });
    expect(s.mandates.value[0]?.terms).toEqual(mandate());
    expect(s.riskState.meta.freshness).toBe('UNKNOWN');
    expect(s.sourceFreshness.map((x) => x.source)).toEqual([
      'identity-directory',
      'envio-read-model',
      'kernel-state',
      'capability-graph',
      'temporal-workflows',
      'market-data',
      'risk-state',
    ]);
    const again = await world.builder.build({ groupId: GROUP });
    expect(again.snapshotId).toBe(s.snapshotId);
  });

  it('reserved and free balances follow a real Kernel reservation', async () => {
    const world = await evalWorld();
    const prepared = evidence(intent());
    trust(world.kernel, prepared);
    const { authorizeWith } = await import('../kernel/fixtures.js');
    const decision = await authorizeWith(world.kernel, prepared);
    expect(decision.status).toBe('AUTHORIZED');
    const s = await world.builder.build({ groupId: GROUP });
    expect(s.treasury.value[0]).toMatchObject({
      asset: expect.objectContaining({ address: TOKEN }),
      balance: '10000',
      reserved: '60',
      free: '9940',
    });
    expect(s.pendingExecutions.value).toHaveLength(1);
    expect(s.kernelIntents.value[0]?.state).toBe('AUTHORIZED');
    expect(s.mandates.value[0]?.reservedToken).toBe('60');
  });

  it('stale and failing sources degrade to STALE/UNKNOWN instead of throwing', async () => {
    const world = await evalWorld({
      headBlock: 300,
      marketObservedAt: now - 120,
    });
    const s = await world.builder.build({ groupId: GROUP });
    expect(s.readModel.value?.status).toBe('STALE');
    expect(s.group.meta).toMatchObject({ freshness: 'STALE', confidence: 0.5 });
    expect(s.mandates.meta.freshness).toBe('STALE');
    expect(s.marketSnapshots.meta.freshness).toBe('STALE');
    const broken = new WorldSnapshotBuilder({
      network,
      now: () => now,
      mainnetBroadcastAllowed: false,
      identity: new FixtureIdentityReader(),
      readModel: {
        snapshots: world.readModel,
        head: {
          head: async () => {
            throw Object.assign(new Error('rpc'), {
              code: 'SOURCE_UNAVAILABLE',
            });
          },
        },
        maxLagBlocks: 5,
      },
      kernel: {
        stateView: () => {
          throw new Error('kernel offline');
        },
      },
      workflows: new InMemoryWorkflowStatusReader(
        [
          {
            workflowId: 'wf_1',
            type: 'MandateApproval',
            status: 'WAITING_APPROVAL',
            intentId: null,
            startedAt: 0,
            nextEventAt: null,
          },
        ],
        now - 300,
      ),
      risk: new InMemoryRiskStateSource({
        state: {
          status: 'HEALTHY',
          reasons: [],
          attestationRef: 'cre:1',
          referenceDeviationBps: 5,
        },
        observedAt: 0,
        maxAgeSeconds: 600,
      }),
    });
    const b = await broken.build({ groupId: GROUP });
    expect(b.group.meta).toMatchObject({
      freshness: 'UNKNOWN',
      confidence: 0,
      reason: 'SOURCE_UNAVAILABLE',
    });
    expect(b.mandates.meta.freshness).toBe('UNKNOWN');
    expect(b.workflows.meta.freshness).toBe('STALE');
    expect(b.workflows.value[0]?.status).toBe('WAITING_APPROVAL');
    expect(b.riskState.value.status).toBe('STALE');
    expect(b.pluginHealth.meta.freshness).toBe('UNKNOWN');
    expect(
      b.capabilities.value.nodes.find((n) => n.providerId === 'QWEN')?.status,
    ).toBe('NOT_INSTALLED');
  });

  it('flags a Kernel mandate version that differs from the chain', async () => {
    const world = await evalWorld();
    const { onchainMandateId } =
      await import('../../packages/kernel/src/index.js');
    const snapshot = groupSnapshot();
    snapshot.group.mandates.push({
      mandateId: onchainMandateId(mandate()),
      status: 'ACTIVE',
      currentVersion: '2',
      minValidVersion: '2',
      spentToken: '0',
      spentNative: '0',
      versions: [],
    });
    world.readModel.snapshot = snapshot;
    const s = await world.builder.build({ groupId: GROUP });
    expect(s.mandates.value[0]?.onchainVersion).toBe(2);
    expect(s.mandates.meta).toMatchObject({
      freshness: 'STALE',
      reason: 'Kernel mandate version differs from chain',
    });
  });
});
