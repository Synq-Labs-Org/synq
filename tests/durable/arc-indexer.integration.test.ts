import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { keccak256, type Address } from 'viem';
import {
  ArcChainIndexer,
  PostgresArcIndexStore,
  migrateArcIndexer,
  reconcileWallet,
  type ArcIndexerConfig,
} from '@synq/ledger';
import { TOKEN, TOKEN_CODE, forkableChain } from './fake-indexer-chain.js';
import { durablePool, runId } from './pg.js';

let pool: pg.Pool;
const me = '0x00000000000000000000000000000000000000a1' as Address;
const them = '0x00000000000000000000000000000000000000b2' as Address;
const cfg = (stream: string): ArcIndexerConfig => ({
  stream,
  chainId: 5042002,
  token: { address: TOKEN, codeHash: keccak256(TOKEN_CODE) },
  memo: null,
  wallets: [me],
  startBlock: 1n,
  confirmations: 0,
  batchSize: 4n,
});

beforeAll(async () => {
  pool = await durablePool();
  await migrateArcIndexer(pool);
});
afterAll(async () => {
  await pool.end();
});

async function drain(ix: ArcChainIndexer, max = 100) {
  for (let i = 0; i < max; i++) if ((await ix.step()).idle) return;
}

describe('Arc indexer state on Postgres', { timeout: 60_000 }, () => {
  it('a crash after commit but before effects resumes effects only; a restart ingests nothing twice', async () => {
    const stream = `arc:${runId()}`;
    const { chain, api } = forkableChain();
    api.mineEmpty(2);
    api.mine([{ from: them, to: me, value: 5n, sender: them }]);
    api.mine([{ from: me, to: them, value: 2n, sender: me }]);
    api.mineEmpty(5);
    const first = new ArcChainIndexer(
      chain,
      new PostgresArcIndexStore(pool),
      cfg(stream),
    );
    await drain(first); // committed; the process dies before applyEffects
    const store = new PostgresArcIndexStore(pool);
    expect(await store.pendingEffects(stream, 10)).toHaveLength(2);
    const restarted = new ArcChainIndexer(chain, store, cfg(stream));
    const seen: string[] = [];
    const sinks = {
      TRANSFER: async (e: { txHash: string }) => (seen.push(e.txHash), 'OK'),
    };
    await restarted.applyEffects(sinks);
    await drain(restarted);
    await restarted.applyEffects(sinks);
    expect(seen).toHaveLength(2);
    expect(await store.events(stream)).toHaveLength(2);
    // A second indexer holding a stale cursor cannot commit (compare-and-set).
    const cur = (await store.cursor(stream))!;
    const stale = { block: cur.block - 1n, hash: cur.hash };
    await expect(
      new PostgresArcIndexStore(pool).commit(
        stream,
        stale,
        { block: cur.block + 1n, hash: cur.hash },
        [],
        [],
      ),
    ).rejects.toMatchObject({ code: 'CONCURRENT_INDEXER' });
    const racers = await Promise.allSettled(
      [1, 2, 3].map(() =>
        new PostgresArcIndexStore(pool).commit(
          stream,
          cur,
          { block: cur.block + 1n, hash: cur.hash },
          [],
          [],
        ),
      ),
    );
    expect(racers.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });

  it('reviews removed events even when a crash happened after the sink committed but before markEffected', async () => {
    const stream = `arc:${runId()}`,
      { chain, api } = forkableChain();
    api.mineEmpty(3);
    api.mine([{ from: them, to: me, value: 9n, sender: them }]);
    api.mineEmpty(4);
    const store = new PostgresArcIndexStore(pool),
      ix = new ArcChainIndexer(chain, store, cfg(stream));
    await drain(ix);
    const pending = await store.pendingEffects(stream, 10);
    expect(pending).toHaveLength(1);
    // Sink committed externally; process dies before indexer's markEffected.
    api.reorg(3, [[], [], [], [], [], []], 'crash-fork');
    await drain(ix);
    const reviews = await ix.applyEffects({
      TRANSFER: async (e) => (e.removed ? 'REVIEW_PARTIAL_EFFECT' : 'LIVE'),
    });
    expect(reviews.map((r) => r.outcome)).toEqual(['REVIEW_PARTIAL_EFFECT']);
    expect(await store.pendingEffects(stream, 10)).toHaveLength(0);
  });

  it('a reorg below the cursor marks the orphaned events removed (kept for audit) and their effects reversible', async () => {
    const stream = `arc:${runId()}`;
    const { chain, api } = forkableChain();
    api.mineEmpty(3);
    api.mine([{ from: them, to: me, value: 9n, sender: them }]); // 4
    api.mineEmpty(4);
    const store = new PostgresArcIndexStore(pool);
    const ix = new ArcChainIndexer(chain, store, cfg(stream));
    await drain(ix);
    await ix.applyEffects({ TRANSFER: async () => 'POSTED' });
    api.reorg(3, [[], [], [], [], [], []], 'fork');
    await drain(ix);
    expect(await store.events(stream)).toHaveLength(0);
    const removed = await pool.query(
      'SELECT block_hash, removed, effect_outcome FROM synq_arc_index_events WHERE stream=$1',
      [stream],
    );
    expect(removed.rows).toEqual([
      expect.objectContaining({ removed: true, effect_outcome: 'POSTED' }),
    ]);
    const reversed = await ix.applyEffects({
      TRANSFER: async (e) => (e.removed ? 'REVERSED' : 'POSTED'),
    });
    expect(reversed.map((x) => x.outcome)).toEqual(['REVERSED']);
    expect(await ix.applyEffects({ TRANSFER: async () => 'AGAIN' })).toEqual(
      [],
    );
  });

  it('wallet reconciliation matches balance deltas to indexed transfers minus gas, and flags unexplained transactions', async () => {
    const stream = `arc:${runId()}`;
    const { chain, api } = forkableChain();
    api.mineEmpty(2);
    api.mine([{ from: them, to: me, value: 5_000n, sender: them }]); // +5000 units
    api.mine([{ from: me, to: them, value: 2_000n, sender: me }]); // -2000 units, gas 1000 wei
    api.mineEmpty(3);
    const store = new PostgresArcIndexStore(pool);
    await drain(new ArcChainIndexer(chain, store, cfg(stream)));
    const transfers = await store.events(stream, 'TRANSFER');
    api.setBalance(me, 3_000n * 1_000_000_000_000n - 1_000n);
    api.setNonce(me, 1);
    const ok = await reconcileWallet({
      chain,
      wallet: me,
      fromBlock: 0n,
      toBlock: 7n,
      transfers,
    });
    expect(ok).toMatchObject({
      status: 'MATCH',
      unexplainedWei: 0n,
      gasPaidWei: 1_000n,
    });
    api.setNonce(me, 2); // the wallet also sent a transaction the index cannot explain
    const bad = await reconcileWallet({
      chain,
      wallet: me,
      fromBlock: 0n,
      toBlock: 7n,
      transfers,
    });
    expect(bad).toMatchObject({
      status: 'MISMATCH',
      txsSent: 2,
      txsExplained: 1,
    });
  });
});
