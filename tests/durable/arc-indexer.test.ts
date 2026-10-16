import { describe, expect, it } from 'vitest';
import { keccak256, type Address } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  ArcCashIndexer,
  ArcChainIndexer,
  Ledger,
  MemoryArcIndexStore,
  MemoryLedgerStore,
  type ArcIndexerConfig,
  type IndexedEvent,
} from '@synq/ledger';
import {
  MIRROR,
  TOKEN,
  TOKEN_CODE,
  forkableChain,
} from './fake-indexer-chain.js';

const USDC = token('arc-testnet', 'USDC');
const me = '0x00000000000000000000000000000000000000a1' as Address;
const them = '0x00000000000000000000000000000000000000b2' as Address;
const other = '0x00000000000000000000000000000000000000c3' as Address;

const cfg = (over: Partial<ArcIndexerConfig> = {}): ArcIndexerConfig => ({
  stream: 'arc:test',
  chainId: 5042002,
  token: { address: TOKEN, codeHash: keccak256(TOKEN_CODE) },
  memo: null,
  wallets: [me],
  startBlock: 1n,
  confirmations: 0,
  batchSize: 5n,
  ...over,
});

async function drain(ix: ArcChainIndexer) {
  const steps = [];
  for (let i = 0; i < 100; i++) {
    const r = await ix.step();
    steps.push(r);
    if (r.idle) break;
  }
  return steps;
}

function cashSink(ledger: Ledger) {
  const cash = new ArcCashIndexer(ledger, {
    workspaceId: 'wsp_ix',
    wallet: me,
    assetId: USDC.assetId,
    token: TOKEN,
    chainId: 5042002,
    classify: () => ({
      counterAccount: 'ACCOUNTS_RECEIVABLE',
      memo: 'indexed',
    }),
  });
  return (e: IndexedEvent) =>
    cash.ingest({
      chainId: e.chainId,
      blockNumber: e.blockNumber,
      blockHash: e.blockHash,
      txHash: e.txHash,
      logIndex: e.logIndex,
      removed: e.removed,
      token: e.emitter,
      from: e.data.from as Address,
      to: e.data.to as Address,
      value: BigInt(e.data.value!),
    });
}
const cashOf = async (ledger: Ledger) =>
  (await ledger.store.entries('wsp_ix'))
    .flatMap((e) => e.postings)
    .filter((p) => p.account === 'CASH_ARC_USDC')
    .reduce((n, p) => n + p.amount, 0n);

describe('Arc indexer service core', () => {
  it('ingests registry-token transfers of watched wallets exactly once, ignoring the native mirror, across restart', async () => {
    const { chain, api } = forkableChain();
    api.sloppy = true; // an RPC that returns the 0xffff…fffe mirror too
    api.mineEmpty(2);
    api.mine([{ from: them, to: me, value: 500_000n, sender: them }]);
    api.mine([{ from: them, to: other, value: 7n, sender: them }]); // not ours
    api.mine([{ from: me, to: them, value: 100_000n, sender: me }]);
    api.mineEmpty(6);
    const store = new MemoryArcIndexStore();
    await drain(new ArcChainIndexer(chain, store, cfg()));
    expect(store.rows.map((r) => [r.blockNumber, r.emitter])).toEqual([
      [3n, TOKEN],
      [5n, TOKEN],
    ]);
    expect(
      store.rows.some((r) => r.emitter.toLowerCase() === MIRROR.toLowerCase()),
    ).toBe(false);
    // Restart: a new indexer on the same store re-reads nothing and duplicates nothing.
    const again = await drain(new ArcChainIndexer(chain, store, cfg()));
    expect(again.at(-1)!.idle).toBe(true);
    expect(store.rows).toHaveLength(2);
    // Even if the cursor were lost, a re-scan inserts nothing new (unique per tx/log).
    const replay = new MemoryArcIndexStore();
    for (const r of store.rows)
      await replay.commit(
        'arc:test',
        await replay.cursor('arc:test'),
        { block: r.blockNumber, hash: r.blockHash },
        [],
        [r],
      );
    const n = replay.rows.length;
    await drain(new ArcChainIndexer(chain, replay, cfg({ startBlock: 1n })));
    expect(replay.rows.length).toBe(n);
  });

  it('respects the finality horizon (confirmations and the finalized tag)', async () => {
    const { chain, api } = forkableChain();
    api.mineEmpty(3);
    api.mine([{ from: them, to: me, value: 1n, sender: them }]); // block 4
    api.mineEmpty(1); // head 5
    const store = new MemoryArcIndexStore();
    await drain(new ArcChainIndexer(chain, store, cfg({ confirmations: 2 })));
    expect((await store.cursor('arc:test'))!.block).toBe(3n);
    expect(store.rows).toHaveLength(0);
    api.setFinalizedLag(0);
    api.mineEmpty(2);
    await drain(new ArcChainIndexer(chain, store, cfg({ confirmations: 2 })));
    expect(store.rows).toHaveLength(1);
  });

  it('detects a reorg by parent hash, rolls back to the fork point, re-ingests, and reverses the cash effect of dropped logs', async () => {
    const { chain, api } = forkableChain();
    api.mineEmpty(3);
    api.mine([{ from: them, to: me, value: 500_000n, sender: them }]); // 4: survives (re-included)
    api.mine([{ from: them, to: me, value: 300_000n, sender: them }]); // 5: dropped by the reorg
    api.mineEmpty(3); // head 8
    const store = new MemoryArcIndexStore();
    const ledger = new Ledger(new MemoryLedgerStore());
    const ix = new ArcChainIndexer(chain, store, cfg());
    await drain(ix);
    await ix.applyEffects({ TRANSFER: cashSink(ledger) });
    expect(await cashOf(ledger)).toBe(800_000n);
    // Fork from block 4: the first transfer is re-included in block 5 of the fork; the second never happens.
    const survivor = api.txsAt(4)[0]!;
    api.reorg(4, [[]], 'fork');
    api.mineWith([survivor], 'fork'); // 5'
    api.mineEmpty(4, 'fork'); // head 9'
    const steps = await drain(ix);
    // Rolls back to the newest recorded block still on the canonical chain
    // (at or before the fork point; re-scanning a few blocks is harmless).
    expect(steps[0]!.removed).toBe(2);
    expect(steps[0]!.rolledBackTo! <= 3n).toBe(true);
    const live = store.rows.filter((r) => !r.removed);
    expect(live.map((r) => r.blockNumber)).toEqual([5n]);
    expect(live[0]!.txHash).toBe(survivor.hash);
    expect(store.rows.filter((r) => r.removed)).toHaveLength(2);
    await ix.applyEffects({ TRANSFER: cashSink(ledger) });
    expect(await cashOf(ledger)).toBe(500_000n);
    // Effects ran once each: a second pass has nothing to do.
    expect(await ix.applyEffects({ TRANSFER: cashSink(ledger) })).toEqual([]);
  });

  it('refuses to trust logs when an emitter code hash changes, and fences a second indexer on the same stream', async () => {
    const { chain, api } = forkableChain();
    api.mineEmpty(5);
    const store = new MemoryArcIndexStore();
    api.code = '0x6080604052cafebabe';
    await expect(
      new ArcChainIndexer(chain, store, cfg()).step(),
    ).rejects.toMatchObject({
      code: 'CODE_HASH_MISMATCH',
    });
    expect(await store.cursor('arc:test')).toBeNull();
    api.code = TOKEN_CODE;
    const a = new ArcChainIndexer(chain, store, cfg());
    const b = new ArcChainIndexer(chain, store, cfg());
    const results = await Promise.allSettled([a.step(), b.step()]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toMatchObject({ code: 'CONCURRENT_INDEXER' });
  });
});
