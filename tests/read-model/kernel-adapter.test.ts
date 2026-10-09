import { expect, it } from 'vitest';
import { FreshnessGate } from '../../packages/kernel/src/index.js';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
} from '../../packages/read-model/src/index.js';
import {
  ReadModelFreshnessProbe,
  grantExecutionObservation,
} from '../../packages/read-model/src/kernel-adapter.js';
import {
  account,
  chainId,
  config,
  creation,
  execution,
  funding,
  governance,
  ev,
  groupId,
  mandateId,
  owners,
} from './fixtures.js';

const head = (block: number) =>
  new ChainHeadObserver(
    {
      getBlockNumber: async () => BigInt(block),
      getChainId: async () => chainId,
    },
    chainId,
    { ttlMs: 0 },
  );
const query = {
  chainId,
  account,
  mandateId,
  mandateVersion: 1,
  accountThreshold: 2,
  assets: [],
};

it('implements the Kernel FreshnessProbe port from the projection and an independent head', async () => {
  const store = new MemoryProjectionStore(chainId);
  const cfg = config();
  const projector = new Projector(store, cfg);
  await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: [...creation(), funding(102), ...governance(), ...execution()],
  });
  const reader = new ProjectionReader(store, cfg);
  const probe = new ReadModelFreshnessProbe(reader, head(112));
  expect(await probe.observe(query)).toEqual({
    chainId,
    indexedThroughBlock: 110,
    headBlock: 112,
    accountPaused: false,
    mandate: { active: true, version: 1, minValidVersion: 1 },
    owners: [...owners].sort(),
    threshold: 2,
  });
  const fresh = new FreshnessGate({ probe, maxLagBlocks: 5 });
  expect((await fresh.check(query)).mode).toBe('INDEXED');
  const stale = new FreshnessGate({
    probe: new ReadModelFreshnessProbe(reader, head(500)),
    maxLagBlocks: 5,
  });
  await expect(stale.check(query)).rejects.toThrow('STALE_READ_MODEL');
  await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: [...creation(), funding(102), ...governance()],
  });
  await expect(probe.observe(query)).rejects.toThrow('ACCOUNTING_FROZEN');
  await expect(fresh.check(query)).rejects.toThrow('STALE_READ_MODEL');
});

it('supplies projected mandate status, owners and threshold so the indexed gate refuses like direct mode', async () => {
  const store = new MemoryProjectionStore(chainId);
  const cfg = config();
  const projector = new Projector(store, cfg);
  await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 103,
    events: [...creation(), funding(102), ...governance()],
  });
  const reader = new ProjectionReader(store, cfg);
  const gate = new FreshnessGate({
    probe: new ReadModelFreshnessProbe(reader, head(106)),
    maxLagBlocks: 5,
  });
  expect(await gate.check(query)).toMatchObject({
    mode: 'INDEXED',
    owners: [...owners].sort(),
  });
  await expect(gate.check({ ...query, accountThreshold: 3 })).rejects.toThrow(
    'ONCHAIN_QUORUM_REQUIRED',
  );
  await expect(gate.check({ ...query, mandateVersion: 2 })).rejects.toThrow(
    'MANDATE_VERSION',
  );
  await projector.applyWindow({
    fromBlockExclusive: 103,
    toBlockInclusive: 104,
    events: [
      ev('RemovedOwner', 104, { owner: owners[0]! }, { logIndex: 0 }),
      ev('ChangedThreshold', 104, { threshold: '1' }, { logIndex: 1 }),
    ],
  });
  const changed = await gate.check({ ...query, accountThreshold: 1 });
  expect(changed.owners).toEqual([...owners.slice(1)].sort());
  await expect(gate.check(query)).rejects.toThrow('ONCHAIN_QUORUM_REQUIRED');
  await projector.applyWindow({
    fromBlockExclusive: 104,
    toBlockInclusive: 105,
    events: [
      ev('MandateRevoked', 105, { groupId, account, mandateId, version: '1' }),
    ],
  });
  await expect(gate.check({ ...query, accountThreshold: 1 })).rejects.toThrow(
    'MANDATE_REVOKED',
  );
  await expect(
    gate.check({ ...query, mandateId: `0x${'7'.repeat(64)}` }),
  ).rejects.toThrow('STALE_READ_MODEL');
});

it('builds the schema GrantExecutionObservation from an indexed GrantExecuted event', () => {
  const grant = execution()[2]!;
  if (grant.eventName !== 'GrantExecuted') throw new Error('fixture');
  expect(grantExecutionObservation(grant)).toMatchObject({
    receiptStatus: 'success',
    transactionHash: grant.transactionHash,
    event: { nonce: '1', tokenAmount: '250000' },
  });
});
