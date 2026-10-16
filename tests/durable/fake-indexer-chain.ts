import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { token } from '@synq/chain-registry/arc';
import type { ChainBlock, IndexerChain } from '@synq/ledger';

export const TOKEN = token('arc-testnet', 'USDC').address;
/** Arc's native-mirror Transfer emitter, 0xffff…fffe. */
export const MIRROR = `0x${'f'.repeat(39)}e` as Address;
export const TOKEN_CODE = '0x6080604052deadbeef' as Hex;

type Tx = {
  hash: Hex;
  from: Address;
  to: Address;
  value: bigint;
  sender: Address;
};

/**
 * A forkable chain: blocks 0..head, each with a hash derived from its fork
 * label, so a reorg changes hashes from the fork point onward. Transfers are
 * emitted by the token and (like Arc) mirrored by 0xffff…fffe in 18 decimals.
 */
export function forkableChain(chainId = 5042002) {
  let blocks: { b: ChainBlock; txs: Tx[] }[] = [];
  const hashOf = (label: string, n: number) =>
    keccak256(toHex(`${label}:${n}`));
  const mk = (n: number, label: string, parent: Hex, txs: Tx[] = []) => ({
    b: { number: BigInt(n), hash: hashOf(label, n), parentHash: parent },
    txs,
  });
  blocks.push(mk(0, 'genesis', `0x${'00'.repeat(32)}`));
  let finalizedLag = 0;
  const balances = new Map<string, bigint>();
  const nonces = new Map<string, number>();
  const logsOf = (i: number): Log[] => {
    const { b, txs } = blocks[i]!;
    const out: Log[] = [];
    txs.forEach((t, k) => {
      const topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: t.from, to: t.to },
      }) as [Hex, ...Hex[]];
      const base = {
        blockNumber: b.number,
        blockHash: b.hash,
        transactionHash: t.hash,
        transactionIndex: k,
        removed: false,
      };
      out.push({
        ...base,
        address: TOKEN,
        topics,
        data: encodeAbiParameters([{ type: 'uint256' }], [t.value]),
        logIndex: 2 * k,
      } as unknown as Log);
      out.push({
        ...base,
        address: MIRROR,
        topics,
        data: encodeAbiParameters(
          [{ type: 'uint256' }],
          [t.value * 1_000_000_000_000n],
        ),
        logIndex: 2 * k + 1,
      } as unknown as Log);
    });
    return out;
  };
  const api = {
    /** RPC that ignores the address filter (returns the mirror too). */
    sloppy: false,
    code: TOKEN_CODE as Hex | undefined,
    mine(txs: Omit<Tx, 'hash'>[] = [], label = 'main') {
      const parent = blocks.at(-1)!.b;
      const n = blocks.length;
      blocks.push(
        mk(
          n,
          label,
          parent.hash,
          txs.map((t, k) => ({
            ...t,
            hash: keccak256(toHex(`tx:${label}:${n}:${k}:${t.value}`)),
          })),
        ),
      );
      return blocks.at(-1)!.b;
    },
    mineEmpty(count: number, label = 'main') {
      for (let i = 0; i < count; i++) api.mine([], label);
    },
    /** Replace everything from block `at` with a new fork carrying `txs` per block. */
    reorg(at: number, fork: Omit<Tx, 'hash'>[][], label: string) {
      blocks = blocks.slice(0, at);
      for (const txs of fork) api.mine(txs, label);
    },
    /** Re-include a specific tx (same hash) in a new block of the current fork. */
    mineWith(txs: Tx[], label: string) {
      const parent = blocks.at(-1)!.b;
      const n = blocks.length;
      blocks.push(mk(n, label, parent.hash, txs));
      return blocks.at(-1)!.b;
    },
    txsAt: (n: number) => blocks[n]!.txs,
    setFinalizedLag: (n: number) => (finalizedLag = n),
    setBalance: (a: Address, wei: bigint) => balances.set(a.toLowerCase(), wei),
    setNonce: (a: Address, n: number) => nonces.set(a.toLowerCase(), n),
    head: () => blocks.length - 1,
  };
  const chain: IndexerChain = {
    chainId: async () => chainId,
    latest: async () => BigInt(blocks.length - 1),
    finalized: async () => BigInt(blocks.length - 1 - finalizedLag),
    block: async (n) => {
      const x = blocks[Number(n)];
      if (!x) throw new Error(`no block ${n}`);
      return x.b;
    },
    logs: async (q) => {
      const out: Log[] = [];
      for (
        let i = Number(q.fromBlock);
        i <= Number(q.toBlock) && i < blocks.length;
        i++
      )
        for (const l of logsOf(i)) {
          if (
            !api.sloppy &&
            l.address.toLowerCase() !== q.address.toLowerCase()
          )
            continue;
          const ok = q.topics.every((t, k) =>
            t === null || t === undefined
              ? true
              : (Array.isArray(t) ? t : [t]).some(
                  (x) => x.toLowerCase() === (l.topics[k] ?? '').toLowerCase(),
                ),
          );
          if (ok) out.push(l);
        }
      return out;
    },
    hasBlock: async (hash) => blocks.some((x) => x.b.hash === hash),
    code: async (a) =>
      a.toLowerCase() === TOKEN.toLowerCase() ? api.code : undefined,
    receiptLogs: async (hash) => {
      for (const x of blocks)
        for (const t of x.txs)
          if (t.hash === hash)
            return {
              status: 'success',
              from: t.sender,
              logs: [],
              feeWei: 1_000n,
            };
      throw new Error('receipt not found');
    },
    // Balances and nonces apply from block 1 (block 0 is the empty genesis).
    nativeBalance: async (a, block) =>
      block === 0n ? 0n : (balances.get(a.toLowerCase()) ?? 0n),
    nonce: async (a, block) =>
      block === 0n ? 0 : (nonces.get(a.toLowerCase()) ?? 0),
  };
  return { chain, api };
}

/**
 * A load-balanced RPC whose logs backend lags at `lagTo`: it reports the real
 * head, but `eth_getLogs` silently returns only logs up to `lagTo` (and, like
 * drpc did live, one stray log from before the requested range), and it does
 * not know blocks above `lagTo` by hash.
 */
export function truncatingProvider(
  inner: IndexerChain,
  lagTo: () => bigint,
): IndexerChain & { calls: number } {
  const p = {
    ...inner,
    calls: 0,
    logs: async (q: Parameters<IndexerChain['logs']>[0]) => {
      p.calls++;
      const all = await inner.logs({ ...q, fromBlock: 0n });
      const cut = all.filter((l) => l.blockNumber! <= lagTo());
      // In range and below the lag, plus one stray log from before the range.
      return cut.filter(
        (l) => l.blockNumber! >= q.fromBlock || l === cut.at(0),
      );
    },
    hasBlock: async (hash: Hex) => {
      for (let n = 0n; n <= lagTo(); n++)
        if ((await inner.block(n)).hash === hash) return true;
      return false;
    },
  };
  return p;
}

/** Counts block reads and gives up loudly instead of spinning forever. */
export function boundedReads(inner: IndexerChain, max = 2_000) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    chain: {
      ...inner,
      block: async (n: bigint) => {
        if (++reads > max) throw new Error(`GAVE_UP_AFTER_${max}_BLOCK_READS`);
        return inner.block(n);
      },
    } as IndexerChain,
  };
}
