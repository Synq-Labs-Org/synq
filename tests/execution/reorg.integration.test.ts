import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  ProjectionReconciliationSignals,
  ProjectionReader,
  Projector,
  type ChainEvent,
} from '../../packages/read-model/src/index.js';
import {
  EXECUTION_WORKER_PRINCIPAL,
  ExecutionJournal,
  JournaledBroadcaster,
  ReorgReconciler,
  loadJournalKey,
  type BroadcastPort,
} from '@synq/execution-worker';
import {
  chainId,
  config,
  creation,
  execution,
  funding,
  governance,
  groupId,
} from '../read-model/fixtures.js';
import { dropSchemas, freshStore, testPool } from '../read-model/pg.js';

const pool = testPool();
const created: string[] = [];
const roots: string[] = [];
afterAll(async () => {
  await dropSchemas(pool, created);
  await pool.end();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const raw = '0xc0ffee' as const;
const txHash = keccak256(raw);
const grantId = `0x${'4'.repeat(64)}` as const;
const executed = (block: number, branch: string): ChainEvent[] =>
  execution(block, '1', '250000', branch).map((e) => ({
    ...e,
    transactionHash: txHash,
  }));
const base = () => [...creation(101), funding(102), ...governance(103)];

it('an OPEN read-model reorg signal reopens a SETTLED journal entry and re-observation re-confirms it', async () => {
  const store = await freshStore(pool, chainId, 'rm_ws4_reorg', created);
  const cfg = config();
  const projector = new Projector(store, cfg);
  await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 105,
    events: [...base(), ...executed(104, 'a')],
  });

  const dir = mkdtempSync(join(tmpdir(), 'synq-reorg-'));
  roots.push(dir);
  const keyPath = join(dir, 'journal.key');
  writeFileSync(keyPath, 'ef'.repeat(32), { mode: 0o600 });
  const journalDir = join(dir, 'journal');
  const journal = new ExecutionJournal(
    journalDir,
    EXECUTION_WORKER_PRINCIPAL,
    undefined,
    loadJournalKey(journalDir, {
      SYNQ_NETWORK: 'sandbox/monad-testnet',
      SYNQ_JOURNAL_KEY_FILE: keyPath,
    }),
  );
  let included = 104n;
  let head = 105n;
  const port: BroadcastPort = {
    sendRawTransaction: async (r) => keccak256(r),
    receipt: async () => ({ status: 'success', blockNumber: included }),
    blockNumber: async () => head,
  };
  const broadcaster = new JournaledBroadcaster(journal, port, 2);
  await broadcaster.submit({
    schemaVersion: 1,
    grantId,
    transactionHash: txHash,
    rawTransaction: raw,
    state: 'SIGNED',
    chainId,
    blockNumber: null,
  });
  expect((await broadcaster.reconcile(grantId)).state).toBe('CONFIRMED');
  for (const state of ['INDEXED', 'RECONCILED', 'SETTLED'] as const)
    journal.update(grantId, { state, blockNumber: '104', outcome: 'SUCCESS' });

  const signals = new ProjectionReconciliationSignals(projector);
  const reconciler = new ReorgReconciler(broadcaster, signals, chainId);
  expect(await reconciler.sync()).toEqual({
    reopened: [],
    held: [],
    reconfirmed: [],
    unresolved: [],
  });

  const reorg = await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 105,
    events: [...base(), ...executed(105, 'b')],
  });
  expect(reorg.reopened.map((s) => s.transactionHash)).toContain(txHash);
  expect(
    (await new ProjectionReader(store, cfg).groupSnapshot(groupId))!.group
      .accountingStatus,
  ).toBe('FROZEN');

  expect((await reconciler.sync()).reopened).toEqual([grantId]);
  expect(journal.get(grantId)).toMatchObject({
    state: 'RECONCILIATION_REQUIRED',
    blockNumber: null,
  });
  expect(journal.history(grantId).at(-1)).toMatchObject({
    from: 'SETTLED',
    to: 'RECONCILIATION_REQUIRED',
  });
  expect(journal.actionHistory(grantId).at(-1)).toMatchObject({
    from: 'RECONCILED',
    to: 'RECONCILIATION_REQUIRED',
  });

  included = 105n;
  expect(await reconciler.sync()).toMatchObject({
    reopened: [],
    held: [grantId],
    reconfirmed: [],
  });
  expect(journal.get(grantId)?.state).toBe('RECONCILIATION_REQUIRED');

  head = 107n;
  const later = await projector.applyWindow({
    fromBlockExclusive: 105,
    toBlockInclusive: 107,
    events: [],
  });
  expect(later.resolved.length).toBeGreaterThan(0);
  expect(await signals.openSignals()).toHaveLength(0);
  expect((await reconciler.sync()).reconfirmed).toEqual([grantId]);
  expect(journal.get(grantId)).toMatchObject({
    state: 'CONFIRMED',
    blockNumber: '105',
    outcome: 'SUCCESS',
  });
  expect(
    journal
      .history(grantId)
      .slice(-2)
      .map((t) => t.to),
  ).toEqual(['INCLUDED', 'CONFIRMED']);
  expect(await reconciler.sync()).toEqual({
    reopened: [],
    held: [],
    reconfirmed: [],
    unresolved: [],
  });
});
