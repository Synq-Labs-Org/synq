import { describe, expect, it } from 'vitest';
import {
  TemporalWorkflowStatusSource,
  PostgresPortfolioRiskSource,
  CombinedRiskSource,
  productionRegistryRisk,
} from '../../apps/api/src/world-sources.js';
import { RegistryRiskSource } from '../../plugins/chainlink-cre/src/risk-source.js';
import { LOCAL_CHAIN_ID } from '@synq/schemas';
import { artifactHash, type RiskAttestationObservation } from '@synq/kernel';
import { localProfile, monadTestnetProfile } from '@synq/chain-registry';
import type { PublicClient } from 'viem';
import { TOKEN, hash } from '../kernel/fixtures.js';

const now = 1000;
const observation: RiskAttestationObservation = {
  chainId: LOCAL_CHAIN_ID,
  registry: TOKEN,
  assetId: hash(1),
  status: 'HEALTHY',
  timestamp: now,
  referencePrice: '100000000',
  deviationBps: 0,
  stalenessSec: 0,
  sourceConfigHash: hash(2),
  blockNumber: '10',
  workflowId: hash(3),
  forwarder: TOKEN,
  forwarderKind: 'CRE_MOCK_FORWARDER',
};
const source = (raw: RiskAttestationObservation | null) =>
  new RegistryRiskSource(
    {
      reader: { latest: async () => raw },
      chainId: LOCAL_CHAIN_ID,
      registry: TOKEN,
      assets: [{ address: TOKEN, assetId: hash(1) }],
      maxAttestationAgeSeconds: 60,
      maxReferenceStalenessSeconds: 60,
      maxHealthyDeviationBps: 50,
      trustedSourceConfigHash: hash(2),
      trustedForwarder: TOKEN,
      forwarderKind: 'CRE_MOCK_FORWARDER',
      trustedWorkflowId: hash(3),
    },
    () => now,
    TOKEN,
  );

describe('production World Model sources', () => {
  it('DCA reads validated registry risk and fails closed on missing, stale, future or forged reports', async () => {
    expect((await source(observation).current('group')).state.status).toBe(
      'HEALTHY',
    );
    for (const raw of [
      null,
      { ...observation, timestamp: now - 61 },
      { ...observation, timestamp: now + 1 },
      { ...observation, sourceConfigHash: hash(4) },
      { ...observation, status: 'UNKNOWN' as const },
    ])
      expect((await source(raw).current('group')).state.status).toBe('UNKNOWN');
    expect(
      (await source({ ...observation, status: 'DEGRADED' }).current('group'))
        .state.status,
    ).toBe('DEGRADED');
  });
  it('testnet mock CRE reports cannot certify live economic health', async () => {
    const client = {
      getChainId: async () => monadTestnetProfile.network.chainId,
      getBlockNumber: async () => 10n,
      readContract: async () => {
        throw new Error('missing');
      },
    } as unknown as PublicClient;
    expect(
      (
        await productionRegistryRisk(
          monadTestnetProfile.network,
          client,
          () => now,
        ).current('group')
      ).state.status,
    ).toBe('UNKNOWN');
    expect(
      (
        await productionRegistryRisk(
          localProfile.network,
          client,
          () => now,
        ).current('group')
      ).state.status,
    ).toBe('UNKNOWN');
  });
  it('Temporal reads actual group metadata, converts timer units, and refuses truncated visibility', async () => {
    const entries = [
      {
        workflowId: 'foreign',
        type: 'DCAWorkflow',
        status: { name: 'RUNNING' },
        startTime: new Date(500000),
        memo: { synqGroupId: 'foreign' },
      },
      {
        workflowId: 'our_workflow',
        type: 'DCAWorkflow',
        status: { name: 'RUNNING' },
        startTime: new Date(500000),
        memo: { synqGroupId: 'group', synqIntentId: 'intent' },
      },
    ];
    const queried: string[] = [];
    const temporal = {
      async *list() {
        yield* entries;
      },
      async nextEvent(id: string) {
        queried.push(id);
        return { at: 1100000 };
      },
    };
    expect(
      await new TemporalWorkflowStatusSource(temporal, () => now).list('group'),
    ).toMatchObject({
      observedAt: now,
      workflows: [
        { workflowId: 'our_workflow', intentId: 'intent', nextEventAt: 1100 },
      ],
    });
    expect(queried).toEqual(['our_workflow']);
    await expect(
      new TemporalWorkflowStatusSource(temporal, () => now, 1).list('group'),
    ).rejects.toThrow('TRUNCATED');
  });
  it('portfolio bridge refuses stale data and simulator evidence in production, and combined risk never hides UNKNOWN', async () => {
    const risk = { asOf: now * 1000, blocked: false, blockReasons: [] };
    let row = {
      execution_mode: 'REAL_TESTNET',
      evidence: {
        risk,
        riskPacketHash: artifactHash(risk),
        executionMode: 'REAL_TESTNET',
      },
    };
    const pool = { query: async () => ({ rows: [row] }) };
    const bridge = new PostgresPortfolioRiskSource(
      pool,
      () => now,
      'REAL_TESTNET',
    );
    expect((await bridge.current('group')).state.status).toBe('HEALTHY');
    expect(
      (await new CombinedRiskSource(source(null), bridge).current('group'))
        .state.status,
    ).toBe('UNKNOWN');
    row = { ...row, execution_mode: 'SIMULATION' };
    expect((await bridge.current('group')).state.status).toBe('UNKNOWN');
    row = {
      ...row,
      execution_mode: 'REAL_TESTNET',
      evidence: { ...row.evidence, risk: { ...risk, asOf: (now - 61) * 1000 } },
    };
    expect((await bridge.current('group')).state.status).toBe('UNKNOWN');
  });
});
