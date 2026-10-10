import { PluginRegistry } from '@synq/plugin-sdk';
import type { PluginHealth, PluginManifestInput } from '@synq/schemas';
import {
  GroupSnapshotSchema,
  type GroupSnapshot,
  type SnapshotSource,
} from '@synq/read-model';
import {
  FixtureFileSchema,
  SynqBrain,
  type BrainDependencies,
  type FixtureFile,
} from '@synq/agent-runtime';
import {
  InMemoryMarketDataSource,
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
  type IdentityDirectoryReader,
} from '@synq/world-model';
import { QwenStructuredReasoner } from '@synq/plugin-qwen';
import { KimiReasoner } from '@synq/plugin-kimi';
import {
  DeclaredSimulation,
  KernelProposalGateway,
} from '../../apps/api/src/brain-runtime.js';
import {
  ACCOUNT,
  CHAIN_GROUP,
  MODULE,
  RECIPIENT,
  TOKEN,
  hash,
  harness,
  mandate,
  manifest,
  network,
  now,
  owners,
  type Harness,
} from '../kernel/fixtures.js';

export const GROUP = 'group_1';
export const MEMBERS = owners.map((o, i) => ({
  memberId: `member_${i}`,
  signer: o.address.toLowerCase() as `0x${string}`,
}));

export function groupSnapshot(
  overrides: { indexedThroughBlock?: number; balance?: string } = {},
): GroupSnapshot {
  return GroupSnapshotSchema.parse({
    schemaVersion: 1,
    sourceChainId: 31337,
    profile: 'local/anvil',
    build: {
      id: `0x${'1'.repeat(32)}`,
      store: 'memory',
      configHash: hash(5),
    },
    indexedThroughBlock: overrides.indexedThroughBlock ?? 100,
    generation: 1,
    groupRevision: 1,
    revisionLineage: null,
    stateHash: hash(6),
    group: {
      groupId: CHAIN_GROUP,
      account: ACCOUNT,
      registry: `0x${'0'.repeat(38)}f2`,
      module: MODULE,
      creator: null,
      salt: null,
      owners: MEMBERS.map((m) => m.signer).sort(),
      threshold: '2',
      guard: null,
      safeModules: [],
      paused: false,
      accountingStatus: 'OPEN',
      executors: [],
      mandates: [],
      treasury: [
        { asset: TOKEN, balance: overrides.balance ?? '10000', lastBlock: 100 },
      ],
      grantsExecuted: [],
      cancelledNonces: [],
      createdBlock: 1,
      createdTransaction: hash(7),
    },
  });
}

export class FixtureSnapshotSource implements SnapshotSource {
  readonly chainId = 31337;
  readonly scope = 'fixture';
  constructor(public snapshot: GroupSnapshot | null) {}
  async progress() {
    return {
      schemaVersion: 1 as const,
      sourceChainId: 31337,
      profile: 'local/anvil',
      build: this.snapshot!.build,
      indexedThroughBlock: this.snapshot?.indexedThroughBlock ?? 0,
      generation: 1,
      lineage: hash(8),
      frozenGroups: [],
      groups: [],
    };
  }
  async groupSnapshot(): Promise<GroupSnapshot | null> {
    return this.snapshot;
  }
  async stamp(): Promise<never> {
    throw new Error('not used by the world model');
  }
  async checkpointStamp(): Promise<never> {
    throw new Error('not used by the world model');
  }
}

export class FixtureIdentityReader implements IdentityDirectoryReader {
  async group(groupId: string) {
    if (groupId !== GROUP) return null;
    return {
      groupId: GROUP,
      chainGroupId: CHAIN_GROUP,
      chainId: 31337,
      account: ACCOUNT,
      owners: MEMBERS.map((m) => m.signer),
      threshold: 2,
      membershipEpoch: 1,
      memberships: MEMBERS.map((m, i) => ({
        memberId: m.memberId,
        principalId: `principal_${i}`,
        principalKind: 'LOCAL_FIXTURE' as const,
        role: 'APPROVER' as const,
        signer: m.signer,
        status: 'ACTIVE' as const,
      })),
    };
  }
  async drafts() {
    return [];
  }
  async approvals() {
    return [];
  }
}

export function localTransferPlugin() {
  const unused = async (): Promise<never> => {
    throw new Error('execution is outside the Brain');
  };
  const copy: PluginManifestInput = JSON.parse(JSON.stringify(manifest));
  return {
    manifest: copy,
    health: async (): Promise<PluginHealth> => ({
      available: true,
      checkedAt: now,
    }),
    prepare: unused,
    simulate: unused,
    execute: unused,
    reconcile: unused,
  };
}

export function chatCompletion(
  content: string | null,
  options: {
    model?: string;
    toolCalls?: { name: string; arguments: string }[];
    promptTokens?: number;
    completionTokens?: number;
  } = {},
) {
  return {
    id: 'fixture',
    object: 'chat.completion',
    created: 1_791_600_000,
    model: options.model ?? 'fixture-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(options.toolCalls
            ? {
                tool_calls: options.toolCalls.map((t, i) => ({
                  id: `call_${i}`,
                  type: 'function',
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        },
        finish_reason: options.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: options.promptTokens ?? 1_200,
      completion_tokens: options.completionTokens ?? 300,
      total_tokens:
        (options.promptTokens ?? 1_200) + (options.completionTokens ?? 300),
    },
  };
}

export type ChatEntry = {
  key: string;
  content?: unknown;
  raw?: string;
  toolCalls?: { name: string; arguments: string }[];
  status?: number;
};
export function chatFixture(
  provider: 'qwen' | 'kimi',
  entries: readonly ChatEntry[],
  extra: FixtureFile['interactions'] = [],
): FixtureFile {
  const path =
    provider === 'qwen'
      ? '/compatible-mode/v1/chat/completions'
      : '/v1/chat/completions';
  return FixtureFileSchema.parse({
    schemaVersion: 1,
    label: 'HAND_AUTHORED_FIXTURE',
    provider,
    description: `Hand-authored ${provider} responses for Brain evals; not recorded from a live provider.`,
    recordedAt: null,
    interactions: [
      ...entries.map((e) => ({
        fixtureKey: e.key,
        method: 'POST',
        path,
        requestBodyHash: null,
        response: {
          status: e.status ?? 200,
          body:
            (e.status ?? 200) === 200
              ? chatCompletion(
                  e.raw ??
                    (e.content === undefined
                      ? null
                      : JSON.stringify(e.content)),
                  {
                    model: provider === 'qwen' ? 'qwen3.8-max' : 'kimi-k3',
                    ...(e.toolCalls ? { toolCalls: e.toolCalls } : {}),
                  },
                )
              : {
                  error: { message: 'fixture error', type: 'invalid_request' },
                },
        },
      })),
      ...extra,
    ],
  });
}

export const action = (overrides: Record<string, unknown> = {}) => ({
  kind: 'ACTION',
  requestedBy: 'member_0',
  action: 'TRANSFER',
  network: 'local/anvil',
  providerId: 'LOCAL_TRANSFER',
  mandateId: 'mandate_1',
  mandateVersion: 1,
  token: TOKEN,
  amount: { display: '0.00006', baseUnits: '60', decimals: 6 },
  recipient: RECIPIENT,
  deadlineSeconds: 120,
  rationale: 'Pay the agreed counterparty from the group treasury.',
  ambiguities: [],
  uncertainty: 0.1,
  ...overrides,
});
export const SUPPORT = {
  verdict: 'SUPPORT',
  issues: [],
  disagreements: [],
  uncertainty: 0.1,
};

export type EvalWorld = {
  kernel: Harness;
  plugins: PluginRegistry;
  market: InMemoryMarketDataSource;
  readModel: FixtureSnapshotSource;
  head: { block: number };
  builder: WorldSnapshotBuilder;
  gateway: KernelProposalGateway;
};

export async function evalWorld(
  options: {
    pluginHealthy?: boolean;
    pluginInstalled?: boolean;
    marketObservedAt?: number;
    headBlock?: number;
    mandates?: unknown[];
  } = {},
): Promise<EvalWorld> {
  const kernel = harness([], options.mandates ?? [mandate()]);
  const plugins = new PluginRegistry();
  if (options.pluginInstalled !== false) {
    const plugin = localTransferPlugin();
    if (options.pluginHealthy === false)
      plugin.health = async () => ({
        available: false,
        checkedAt: now,
        reason: 'RPC down',
      });
    plugins.register(plugin);
    await plugins.refreshHealth(manifest.id, { network, now });
  }
  const market = new InMemoryMarketDataSource([
    {
      pair: 'OTHER/USD',
      price: '100000000',
      priceDecimals: 8,
      source: 'fixture-reference',
      chainId: 31337,
      observedAt: options.marketObservedAt ?? now,
      maxAgeSeconds: 30,
    },
  ]);
  const readModel = new FixtureSnapshotSource(groupSnapshot());
  const head = { block: options.headBlock ?? 100 };
  const builder = new WorldSnapshotBuilder({
    network,
    now: () => kernel.clock.t,
    readModel: {
      snapshots: readModel,
      head: { head: async () => head },
      maxLagBlocks: 5,
    },
    kernel: kernel.kernel,
    identity: new FixtureIdentityReader(),
    plugins,
    modelProviders: {
      QWEN: { installed: true, credentialsPresent: false },
      KIMI: { installed: true, credentialsPresent: false },
    },
    mainnetBroadcastAllowed: false,
    workflows: new InMemoryWorkflowStatusReader([], now),
    market,
  });
  const gateway = new KernelProposalGateway({
    kernel: kernel.kernel,
    market,
    simulations: new DeclaredSimulation(
      kernel.clock,
      'eval-declared-simulation',
    ),
    clock: kernel.clock,
    executionMode: 'SIMULATION',
  });
  return { kernel, plugins, market, readModel, head, builder, gateway };
}

export function brainFor(
  world: { gateway: KernelProposalGateway; kernel: { clock: { t: number } } },
  fixtures: { qwen: FixtureFile; kimi?: FixtureFile },
  extra: Partial<BrainDependencies> = {},
): SynqBrain {
  const kimi = new KimiReasoner({
    mode: 'REPLAY',
    fixtures: fixtures.kimi ?? chatFixture('kimi', []),
    now: () => world.kernel.clock.t,
  });
  return new SynqBrain({
    structured: new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: fixtures.qwen,
    }),
    research: kimi,
    critic: kimi,
    proposals: world.gateway,
    executionMode: 'SIMULATION',
    nowSeconds: () => world.kernel.clock.t,
    ...extra,
  });
}

export function economicState(h: Harness) {
  const s = h.kernel.snapshot();
  return JSON.stringify({
    budgets: s.budgets,
    balances: s.balances,
    grants: s.grants,
    nonces: s.nonces,
    mandates: s.mandates,
    delegations: s.delegations,
    chain: s.chain,
  });
}
