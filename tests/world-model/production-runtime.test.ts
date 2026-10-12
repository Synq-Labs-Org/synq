import { it, expect } from 'vitest';
import type { PublicClient } from 'viem';
import { CapabilityGraph } from '@synq/world-model';
import { monadTestnetProfile } from '@synq/chain-registry';
import { riskAttestationDeployment } from '@synq/plugin-chainlink-cre';
import { productionWorldPlugins } from '../../apps/api/src/world-runtime.js';
import { TemporalWorkflowStatusSource } from '../../apps/api/src/world-sources.js';

it('I-01 production World factory observes installed Send/CRE health and preserves genuine timestamps and failures', async () => {
  let now = 1000;
  let fail = false;
  const client = {
    getChainId: async () => {
      if (fail) throw new Error('RPC unavailable');
      return 10143;
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'forwarder')
        return riskAttestationDeployment('sandbox/monad-testnet').forwarder;
      throw new Error('No liquid book in this recording');
    },
  } as unknown as PublicClient;
  const network = monadTestnetProfile.network;
  const runtime = productionWorldPlugins({
    client,
    network,
    executionModule: '0x0000000000000000000000000000000000000071',
    sendEnabled: true,
    now: () => now,
  });
  const graph = () =>
    CapabilityGraph.build({
      plugins: runtime.registry,
      network,
      now,
      mainnetBroadcastAllowed: false,
    });
  expect(
    graph().canPerform('TRANSFER', network.profile, 'AUSD_TRANSFER')
      .availability,
  ).toBe('UNHEALTHY');
  await Promise.all([runtime.refresh(), runtime.refresh()]);
  expect(runtime.registry.healthStatus('ausd-transfer', network)).toEqual({
    available: true,
    checkedAt: 1000,
  });
  expect(
    graph().canPerform('TRANSFER', network.profile, 'AUSD_TRANSFER')
      .availability,
  ).toBe('REQUIRES_HUMAN');
  expect(
    graph().canPerform('SIMULATE', network.profile, 'CHAINLINK_CRE')
      .availability,
  ).toBe('AVAILABLE');
  expect(
    graph().canPerform('TRADE', network.profile, 'KURU_FLOW').availability,
  ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
  now = 1061;
  expect(
    graph().canPerform('TRANSFER', network.profile, 'AUSD_TRANSFER')
      .availability,
  ).toBe('UNHEALTHY');
  fail = true;
  await runtime.refresh();
  expect(runtime.registry.healthStatus('ausd-transfer', network)).toMatchObject(
    { available: false, checkedAt: 1061 },
  );
  expect(
    graph().canPerform('TRANSFER', network.profile, 'AUSD_TRANSFER')
      .availability,
  ).toBe('UNHEALTHY');
});

it('I-03 legacy running economic children without group metadata make visibility UNKNOWN rather than falsely complete', async () => {
  const source = new TemporalWorkflowStatusSource(
    {
      async *list() {
        yield {
          workflowId: 'legacy-child',
          type: 'ActionExecutionWorkflow',
          status: { name: 'RUNNING' },
          startTime: new Date(),
        };
      },
      nextEvent: async () => ({ at: null }),
    },
    () => 1000,
  );
  await expect(source.list('group')).rejects.toThrow(
    'TEMPORAL_UNSCOPED_ECONOMIC_WORKFLOW',
  );
});
