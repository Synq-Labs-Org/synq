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
  mandateId,
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

it('builds the schema GrantExecutionObservation from an indexed GrantExecuted event', () => {
  const grant = execution()[2]!;
  if (grant.eventName !== 'GrantExecuted') throw new Error('fixture');
  expect(grantExecutionObservation(grant)).toMatchObject({
    receiptStatus: 'success',
    transactionHash: grant.transactionHash,
    event: { nonce: '1', tokenAmount: '250000' },
  });
});
