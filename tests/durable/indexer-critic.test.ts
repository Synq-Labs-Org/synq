import { describe, expect, it } from 'vitest';
import { keccak256, type Address } from 'viem';
import {
  ArcChainIndexer,
  MemoryArcIndexStore,
  type ArcIndexerConfig,
} from '@synq/ledger';
import {
  TOKEN,
  TOKEN_CODE,
  boundedReads,
  forkableChain,
  truncatingProvider,
} from './fake-indexer-chain.js';

const me = '0x00000000000000000000000000000000000000a1' as Address;
const them = '0x00000000000000000000000000000000000000b2' as Address;
const cfg = (over: Partial<ArcIndexerConfig> = {}): ArcIndexerConfig => ({
  stream: 'arc:critic',
  chainId: 5042002,
  token: { address: TOKEN, codeHash: keccak256(TOKEN_CODE) },
  memo: null,
  wallets: [me],
  startBlock: 1n,
  confirmations: 0,
  batchSize: 100n,
  ...over,
});

/** Runs steps like the service does: errors are retried, never skipped. */
async function drain(ix: ArcChainIndexer, max = 20) {
  const errors: string[] = [];
  for (let i = 0; i < max; i++) {
    try {
      if ((await ix.step()).idle) break;
    } catch (e) {
      errors.push((e as { code?: string }).code ?? (e as Error).message);
    }
  }
  return errors;
}

describe('critic C-01: a truncating or lagging RPC never makes the cursor skip logs', () => {
  it('a provider whose logs backend lags is refused for the step; the cursor never passes data it did not see', async () => {
    const { chain, api } = forkableChain();
    for (let i = 1; i <= 20; i++)
      api.mine([{ from: them, to: me, value: BigInt(i), sender: them }]);
    const lagging = truncatingProvider(chain, () => 15n);
    const store = new MemoryArcIndexStore();
    const errors = await drain(new ArcChainIndexer(lagging, store, cfg()), 3);
    expect(errors.length).toBeGreaterThan(0);
    const cursor = await store.cursor('arc:critic');
    // Nothing was committed past what the provider demonstrably holds.
    expect(cursor === null || cursor.block <= 15n).toBe(true);
    const seen = new Set(store.rows.map((r) => r.blockNumber));
    for (let n = 1n; n <= (cursor?.block ?? 0n); n++)
      expect(seen.has(n)).toBe(true);
  });

  it('with a fallback list, a failing provider is swapped for the next step, and every log is ingested exactly once', async () => {
    const { chain, api } = forkableChain();
    for (let i = 1; i <= 20; i++)
      api.mine([{ from: them, to: me, value: BigInt(i), sender: them }]);
    const lagging = truncatingProvider(chain, () => 15n);
    const store = new MemoryArcIndexStore();
    const ix = new ArcChainIndexer([lagging, chain], store, cfg());
    const errors = await drain(ix);
    expect(errors).toContain('PROVIDER_INCOMPLETE');
    expect((await store.cursor('arc:critic'))!.block).toBe(20n);
    expect(store.rows.map((r) => r.blockNumber)).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(i + 1)),
    );
  });

  it('a fallback provider is verified before its first batch even between periodic code checks', async () => {
    const { chain, api } = forkableChain();
    api.mineEmpty(3);
    const failed = {
      ...chain,
      logs: async () => {
        throw new Error('offline');
      },
    };
    const wrong = { ...chain, chainId: async () => 1 };
    const ix = new ArcChainIndexer(
      [failed, wrong],
      new MemoryArcIndexStore(),
      cfg(),
    );
    await expect(ix.step()).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    await expect(ix.step()).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
  });

  it('logs outside [from, to] are dropped and counted, never stored', async () => {
    const { chain, api } = forkableChain();
    for (let i = 1; i <= 6; i++)
      api.mine([{ from: them, to: me, value: BigInt(i), sender: them }]);
    // A provider that always sends one stray log from block 1 with every answer.
    const stray = truncatingProvider(chain, () => 6n);
    const store = new MemoryArcIndexStore();
    const ix = new ArcChainIndexer(stray, store, cfg({ batchSize: 3n }));
    await drain(ix);
    const blocks = store.rows.map((r) => r.blockNumber);
    expect(blocks).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(ix.droppedOutOfRange).toBeGreaterThan(0);
  });
});

describe('critic C-02: a reorg below every recorded block halts deterministically', () => {
  it('raises DEEP_REORG after a bounded number of reads', async () => {
    const { chain, api } = forkableChain();
    api.mineEmpty(6);
    const counted = boundedReads(chain);
    const store = new MemoryArcIndexStore();
    const ix = new ArcChainIndexer(
      counted.chain,
      store,
      cfg({ startBlock: 3n }),
    );
    await ix.step();
    api.reorg(2, [[], [], [], [], [], []], 'fork'); // below the start anchor
    await expect(ix.step()).rejects.toMatchObject({ code: 'DEEP_REORG' });
    expect(counted.reads).toBeLessThan(50);
    // And it keeps refusing rather than spinning or silently moving on.
    await expect(ix.step()).rejects.toMatchObject({ code: 'DEEP_REORG' });
  });

  it('a reorg at the start block rolls back to the recorded anchor (start − 1), not into a loop', async () => {
    const { chain, api } = forkableChain();
    api.mine([{ from: them, to: me, value: 1n, sender: them }]);
    api.mineEmpty(3);
    const counted = boundedReads(chain);
    const store = new MemoryArcIndexStore();
    const ix = new ArcChainIndexer(counted.chain, store, cfg());
    await ix.step();
    api.reorg(1, [[], [], [], [], []], 'fork');
    const r = await ix.step();
    expect(r.rolledBackTo).toBe(0n);
    expect(counted.reads).toBeLessThan(50);
    expect(store.rows.filter((x) => !x.removed)).toHaveLength(0);
  });
});
