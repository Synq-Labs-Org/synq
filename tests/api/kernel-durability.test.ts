import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { monadTestnetProfile } from '@synq/chain-registry';
import { MandateSchema } from '@synq/schemas';
import {
  DurableKernel,
  kernelStateFromReadModel,
  openDurableKernel,
} from '../../apps/api/src/kernel-runtime.js';
import {
  MemoryKernelStateStore,
  anchoredSink,
  verifyPersistedKernel,
} from '../../apps/api/src/kernel-store.js';
import {
  Kernel,
  artifactHash,
  onchainMandateId,
  stateHash,
} from '../../packages/kernel/src/index.js';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  registerMandateArtifacts,
} from '../../packages/read-model/src/index.js';
import {
  account,
  address,
  ausdLower,
  chainId,
  config,
  creation,
  ev,
  executor,
  funding,
  groupId,
  mandateTerms,
  owners,
  recipient,
  tx,
  word,
} from '../read-model/fixtures.js';
import {
  sandboxManifest,
  sandboxMandate,
  sandboxProposal,
  type SandboxGroup,
} from './kernel-fixture.js';
import {
  AUDIT_KEY,
  allPlugins,
  authorizeWith,
  evidence,
  harness,
  intent,
} from '../kernel/fixtures.js';

const NOW = 1_000_000;
const KEY = new Uint8Array(32).fill(7);
const group: SandboxGroup = {
  groupId,
  chainGroupId: groupId,
  account,
  executor,
  recipient: address(0xbb),
  members: owners.map((signer, i) => ({ memberId: `member_${i}`, signer })),
};

async function chainWithSpend(spent: string, cumulativeBudget = '1000000000') {
  const mandate = MandateSchema.parse({
    ...sandboxMandate(group, NOW),
    cumulativeBudget,
    maxExecutions: 2,
    minIntervalSeconds: 600,
  });
  const cfg = config();
  const store = new MemoryProjectionStore(chainId);
  const id = onchainMandateId(mandate);
  const t = tx('exec-5');
  await new Projector(store, cfg).applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 104,
    events: [
      ...creation(101),
      funding(102),
      ev(
        'ExecutorSet',
        103,
        { groupId, account, executor, allowed: true },
        { logIndex: 0 },
      ),
      ev(
        'MandateConfigured',
        103,
        {
          groupId,
          account,
          mandateId: id,
          version: '1',
          ...mandateTerms,
          mandateHash: artifactHash(mandate),
        },
        { logIndex: 1 },
      ),
      ev(
        'SpendRecorded',
        104,
        {
          groupId,
          account,
          mandateId: id,
          version: '1',
          module: cfg.module,
          tokenAmount: spent,
          nativeAmount: '0',
          spentToken: spent,
          spentNative: '0',
        },
        { tx: t, logIndex: 0 },
      ),
      ev(
        'GrantExecuted',
        104,
        {
          groupId,
          account,
          intentHash: word('intent-5'),
          mandateId: id,
          mandateVersion: '1',
          executor,
          pluginId: word('plugin'),
          chainId: String(chainId),
          nonce: '5',
          grantHash: word('grant-5'),
          target: ausdLower,
          selector: '0xa9059cbb',
          calldataHash: word('calldata-5'),
          token: ausdLower,
          recipient,
          tokenAmount: spent,
          nativeValue: '0',
          outputAmount: spent,
        },
        { tx: t, logIndex: 1 },
      ),
    ],
  });
  await registerMandateArtifacts(store, [
    { mandateHash: artifactHash(mandate), artifact: mandate },
  ]);
  return { mandate, cfg, reader: new ProjectionReader(store, cfg) };
}

async function open(
  reader: ProjectionReader,
  cfg: ReturnType<typeof config>,
  store: MemoryKernelStateStore,
  clock = { t: NOW },
) {
  return openDurableKernel(
    {
      network: monadTestnetProfile.network,
      executionModule: cfg.module,
      clock: { now: () => clock.t },
      identity: {
        approvalLedger: { isConsumed: async () => false },
        membershipDirectory: {
          activeMember: async () => null,
          membershipEpoch: async () => null,
        },
      },
      client: {} as PublicClient,
      projection: cfg,
      snapshots: async () => reader,
      head: new ChainHeadObserver(
        {
          getBlockNumber: async () => 104n,
          getChainId: async () => chainId,
        },
        chainId,
        { ttlMs: 0 },
      ),
      maxLagBlocks: 5,
      auditKey: KEY,
      plugins: [sandboxManifest],
      state: await kernelStateFromReadModel(reader),
    },
    store,
  );
}

describe('production Kernel survives restart against chain truth', () => {
  it('a restarted Kernel takes cumulative spend, executions and used nonces from the indexed chain', async () => {
    const { mandate, cfg, reader } = await chainWithSpend('1900000');
    const durable = await open(reader, cfg, new MemoryKernelStateStore());
    expect(
      durable.kernel.accounting(mandate.groupId, mandate.mandateId),
    ).toMatchObject({ spentToken: '1900000', issued: 1, lastIssued: NOW });
    const propose = (nonce: string) =>
      durable.authorize({
        ...sandboxProposal(durable.kernel, group, {
          amount: 400_000n,
          nonce,
          now: NOW,
        }),
        approvals: [],
      });
    expect(await propose('5')).toMatchObject({ code: 'NONCE_REPLAY' });
    expect(await propose('6')).toMatchObject({ code: 'FREQUENCY_CAP' });
  });

  it('chain spend near the cumulative cap exhausts the budget after restart', async () => {
    const { cfg, reader } = await chainWithSpend('999800000');
    const durable = await open(reader, cfg, new MemoryKernelStateStore());
    expect(
      await durable.authorize({
        ...sandboxProposal(durable.kernel, group, {
          amount: 400_000n,
          nonce: '9',
          now: NOW,
        }),
        approvals: [],
      }),
    ).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('persisted Kernel state and audit chain are restored on restart, and chain floors never go down', async () => {
    const { mandate, cfg, reader } = await chainWithSpend('1900000');
    const store = new MemoryKernelStateStore();
    const clock = { t: NOW };
    const first = await open(reader, cfg, store, clock);
    clock.t = NOW + 700;
    await first.authorize({
      ...sandboxProposal(first.kernel, group, {
        amount: 400_000n,
        nonce: '6',
        now: clock.t,
      }),
      approvals: [],
    });
    const auditLength = first.kernel.auditLog().length;
    const empty = new MemoryProjectionStore(chainId);
    await new Projector(empty, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 101,
      events: creation(101),
    });
    const restarted = await open(
      new ProjectionReader(empty, cfg),
      cfg,
      store,
      clock,
    );
    expect(restarted.kernel.auditLog().length).toBeGreaterThan(auditLength);
    expect(restarted.kernel.auditLog().slice(0, auditLength)).toEqual(
      first.kernel.auditLog().slice(0, auditLength),
    );
    expect(
      restarted.kernel.accounting(mandate.groupId, mandate.mandateId),
    ).toMatchObject({ spentToken: '1900000', issued: 1 });
  });

  it('a full Kernel state with reservations, nonces, lifecycles and delegation usage round-trips; tampered or rolled-back state is refused', async () => {
    const data = evidence(intent());
    const h = harness(data);
    expect((await authorizeWith(h, data)).status).toBe('AUTHORIZED');
    const store = new MemoryKernelStateStore();
    const durable = new DurableKernel(h.kernel, store, AUDIT_KEY, 0);
    await durable.mutate(() => undefined);
    const early = structuredClone(store.persisted!);
    await durable.mutate(() => undefined);
    const persisted = (await store.load())!;
    const dependencies = {
      clock: h.clock,
      approvalLedger: h.ledger,
      membershipDirectory: h.directory,
      freshness: { probe: h.probe, maxLagBlocks: 0 },
      plugins: allPlugins(),
      auditKey: AUDIT_KEY,
      auditSink: anchoredSink(() => persisted.head),
    };
    const restored = Kernel.restore(
      verifyPersistedKernel(persisted, AUDIT_KEY),
      dependencies,
    );
    const original = h.kernel.snapshot();
    const copy = restored.snapshot();
    expect(stateHash({ ...copy, audit: [] })).toBe(
      stateHash({ ...original, audit: [] }),
    );
    expect((await restored.authorize({ ...data, approvals: [] })).code).toMatch(
      /NONCE_REPLAY|INTENT_TERMINAL/,
    );

    const tampered = structuredClone(persisted);
    (tampered.state.budgets[0]![1] as { reservedToken: string }).reservedToken =
      '0';
    expect(() => verifyPersistedKernel(tampered, AUDIT_KEY)).toThrow(
      'SNAPSHOT_INVALID',
    );
    const rolledBack = { ...early, records: persisted.records };
    expect(() => verifyPersistedKernel(rolledBack, AUDIT_KEY)).toThrow(
      'SNAPSHOT_INVALID',
    );
    const forged = structuredClone(persisted);
    forged.records[0]!.recordedAt += 1;
    expect(() =>
      Kernel.restore(verifyPersistedKernel(forged, AUDIT_KEY), dependencies),
    ).toThrow();
  });

  it('a failed persistence write fails closed and blocks further decisions', async () => {
    const { cfg, reader } = await chainWithSpend('1900000');
    const store = new MemoryKernelStateStore();
    const durable = await open(reader, cfg, store);
    store.save = async () => {
      throw new Error('db down');
    };
    const request = () => ({
      ...sandboxProposal(durable.kernel, group, {
        amount: 400_000n,
        nonce: '7',
        now: NOW,
      }),
      approvals: [],
    });
    await expect(durable.authorize(request())).rejects.toThrow(
      'AUDIT_UNAVAILABLE',
    );
    await expect(durable.authorize(request())).rejects.toThrow(
      'AUDIT_UNAVAILABLE',
    );
  });
});
