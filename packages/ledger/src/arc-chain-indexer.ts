import {
  encodeEventTopics,
  erc20Abi,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';

/**
 * Long-running Arc indexer core (the service entry is `apps/api/src/arc-indexer.ts`).
 *
 * - Reads only up to the finality horizon: min(chain `finalized`, latest −
 *   confirmations). Arc reports `finalized` at the head (BFT finality), so
 *   the default depth is 0; it is configurable for other chains or caution.
 * - Durable cursor (block number + hash) per stream. Every batch checks that
 *   its first block's parent hash equals the cursor hash; on mismatch it
 *   walks back the stored block hashes to the fork point, marks events above
 *   it removed (so their effects are reversed or flagged) and resumes there.
 * - Before trusting any log it verifies the emitter's deployed code hash
 *   against the registry pin; a mismatch halts the stream.
 * - Transfer logs count only from the registry token (Arc's 0xffff…fffe
 *   native mirror is never queried), and only when a watched wallet is the
 *   sender or recipient. Memo payments are paired with their Transfer from
 *   the transaction receipt.
 * - Events are unique on (chain, tx, log index, kind) among live rows and
 *   carry provenance (block number and hash, tx, log index, emitter). Effects
 *   (ledger postings, invoice settlement) run from the stored events, after
 *   the batch commits, and are idempotent; a crash between the two re-runs
 *   the pending effects only.
 */

export type ChainBlock = Readonly<{
  number: bigint;
  hash: Hex;
  parentHash: Hex;
}>;

export interface IndexerChain {
  chainId(): Promise<number>;
  /** Highest block the chain reports as final (or latest when unsupported). */
  finalized(): Promise<bigint>;
  latest(): Promise<bigint>;
  block(n: bigint): Promise<ChainBlock>;
  logs(q: {
    address: Address;
    topics: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Log[]>;
  code(address: Address): Promise<Hex | undefined>;
  receiptLogs(
    txHash: Hex,
  ): Promise<{ status: string; from: Address; logs: Log[]; feeWei: bigint }>;
  nativeBalance(address: Address, block: bigint): Promise<bigint>;
  nonce(address: Address, block: bigint): Promise<number>;
}

export const MEMO_EVENT_ABI = parseAbiItem(
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
);

export type IndexedEventKind = 'TRANSFER' | 'MEMO';

export type IndexedEvent = Readonly<{
  /** Store id (set once persisted). */
  id?: number;
  chainId: number;
  kind: IndexedEventKind;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  emitter: Address;
  /** TRANSFER: from, to, value. MEMO: the tx's receipt logs are re-read by the sink. */
  data: Readonly<Record<string, string>>;
  removed: boolean;
}>;

export type StreamCursor = Readonly<{ block: bigint; hash: Hex }>;

export interface ArcIndexStore {
  cursor(stream: string): Promise<StreamCursor | null>;
  /** Stored hash for block `n` of the stream, if that block was recorded. */
  blockHash(stream: string, n: bigint): Promise<Hex | null>;
  /** Highest recorded block at or below `n` (for walking back to a fork point). */
  recordedBlocksDesc(
    stream: string,
    below: bigint,
    limit: number,
  ): Promise<{ number: bigint; hash: Hex }[]>;
  /**
   * Atomically: insert the events (duplicates ignored), record the blocks,
   * and move the cursor from `expected` to `next` (compare-and-set).
   */
  commit(
    stream: string,
    expected: StreamCursor | null,
    next: StreamCursor,
    blocks: readonly ChainBlock[],
    events: readonly IndexedEvent[],
  ): Promise<{ inserted: number; duplicates: number }>;
  /** Marks events above `fork` removed, forgets blocks above it, moves the cursor back. */
  rollback(stream: string, fork: StreamCursor): Promise<number>;
  /** Events whose effect has not run yet (live or removed-after-effect). */
  pendingEffects(stream: string, limit: number): Promise<IndexedEvent[]>;
  markEffected(stream: string, id: number, outcome: string): Promise<void>;
}

export type EffectSink = (e: IndexedEvent) => Promise<string>;

export type WatchedContract = Readonly<{ address: Address; codeHash: Hex }>;

export type ArcIndexerConfig = Readonly<{
  stream: string;
  chainId: number;
  token: WatchedContract;
  memo: WatchedContract | null;
  wallets: readonly Address[];
  startBlock: bigint;
  confirmations: number;
  batchSize: bigint;
  /** Re-verify emitter code hashes every N batches (and always at start). */
  codeCheckEvery?: number;
}>;

export class ArcIndexerError extends Error {
  constructor(
    readonly code:
      | 'WRONG_CHAIN'
      | 'CODE_HASH_MISMATCH'
      | 'DEEP_REORG'
      | 'CONCURRENT_INDEXER',
    message: string = code,
  ) {
    super(message);
    this.name = 'ArcIndexerError';
  }
}

const lower = (a: string) => a.toLowerCase();
const TRANSFER_TOPIC = encodeEventTopics({
  abi: erc20Abi,
  eventName: 'Transfer',
})[0]!;
const MEMO_TOPIC = encodeEventTopics({
  abi: [MEMO_EVENT_ABI],
  eventName: 'Memo',
})[0]!;
const padTopic = (a: Address) =>
  `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;

export type StepResult = Readonly<{
  from: bigint;
  to: bigint;
  inserted: number;
  duplicates: number;
  rolledBackTo: bigint | null;
  removed: number;
  idle: boolean;
}>;

export class ArcChainIndexer {
  private batches = 0;
  constructor(
    readonly chain: IndexerChain,
    readonly store: ArcIndexStore,
    readonly cfg: ArcIndexerConfig,
  ) {}

  /** Chain id and every emitter's code hash, before any log is trusted. */
  async verify(): Promise<void> {
    const id = await this.chain.chainId();
    if (id !== this.cfg.chainId)
      throw new ArcIndexerError(
        'WRONG_CHAIN',
        `expected ${this.cfg.chainId}, got ${id}`,
      );
    for (const c of [
      this.cfg.token,
      ...(this.cfg.memo ? [this.cfg.memo] : []),
    ]) {
      const code = await this.chain.code(c.address);
      const hash = code && code !== '0x' ? keccak256(code) : null;
      if (hash !== c.codeHash)
        throw new ArcIndexerError(
          'CODE_HASH_MISMATCH',
          `${c.address}: ${hash ?? 'no code'} != ${c.codeHash}`,
        );
    }
  }

  async horizon(): Promise<bigint> {
    const [finalized, latest] = await Promise.all([
      this.chain.finalized(),
      this.chain.latest(),
    ]);
    const depth = latest - BigInt(this.cfg.confirmations);
    return finalized < depth ? finalized : depth;
  }

  /** Walks stored hashes back until one still matches the chain: the fork point. */
  private async forkPoint(below: bigint): Promise<StreamCursor> {
    for (;;) {
      const rows = await this.store.recordedBlocksDesc(
        this.cfg.stream,
        below,
        64,
      );
      if (!rows.length)
        throw new ArcIndexerError(
          'DEEP_REORG',
          `no recorded block below ${below} matches the chain`,
        );
      for (const r of rows) {
        const onChain = await this.chain.block(r.number);
        if (onChain.hash === r.hash) return { block: r.number, hash: r.hash };
      }
      below = rows.at(-1)!.number;
    }
  }

  /** One batch: reorg check, logs up to the horizon, commit. */
  async step(limitTo?: bigint): Promise<StepResult> {
    const { stream } = this.cfg;
    if (this.batches++ % (this.cfg.codeCheckEvery ?? 50) === 0)
      await this.verify();
    let cursor = await this.store.cursor(stream);
    let rolledBackTo: bigint | null = null;
    let removed = 0;
    if (cursor) {
      const onChain = await this.chain.block(cursor.block);
      if (onChain.hash !== cursor.hash) {
        const fork = await this.forkPoint(cursor.block);
        removed = await this.store.rollback(stream, fork);
        rolledBackTo = fork.block;
        cursor = fork;
      }
    }
    const from = cursor ? cursor.block + 1n : this.cfg.startBlock;
    let to = await this.horizon();
    if (limitTo !== undefined && limitTo < to) to = limitTo;
    if (from + this.cfg.batchSize - 1n < to)
      to = from + this.cfg.batchSize - 1n;
    if (to < from)
      return {
        from,
        to,
        inserted: 0,
        duplicates: 0,
        rolledBackTo,
        removed,
        idle: true,
      };
    const first = await this.chain.block(from);
    if (cursor && first.parentHash !== cursor.hash) {
      // The chain moved under us between the check and the read: roll back next step.
      const fork = await this.forkPoint(cursor.block + 1n);
      removed += await this.store.rollback(stream, fork);
      return {
        from,
        to: from - 1n,
        inserted: 0,
        duplicates: 0,
        rolledBackTo: fork.block,
        removed,
        idle: false,
      };
    }
    const events = await this.collect(from, to);
    const last = await this.chain.block(to);
    // Record the blocks that carry events and the batch boundaries, so a
    // later reorg can be walked back to a fork point.
    const needed = new Set<bigint>([
      from,
      to,
      ...events.map((e) => e.blockNumber),
    ]);
    const blocks: ChainBlock[] = [];
    for (const n of [...needed].sort((a, b) => (a < b ? -1 : 1)))
      blocks.push(
        n === from ? first : n === to ? last : await this.chain.block(n),
      );
    for (const e of events) {
      const b = blocks.find((x) => x.number === e.blockNumber)!;
      if (b.hash !== e.blockHash)
        // A log from a block that is no longer canonical: retry the batch.
        return {
          from,
          to: from - 1n,
          inserted: 0,
          duplicates: 0,
          rolledBackTo,
          removed,
          idle: false,
        };
    }
    const r = await this.store.commit(
      stream,
      cursor,
      { block: to, hash: last.hash },
      blocks,
      events,
    );
    return { from, to, ...r, rolledBackTo, removed, idle: false };
  }

  private async collect(from: bigint, to: bigint): Promise<IndexedEvent[]> {
    const { token, memo, wallets, chainId } = this.cfg;
    const out = new Map<string, IndexedEvent>();
    const add = (
      l: Log,
      kind: IndexedEventKind,
      data: Record<string, string>,
    ) => {
      const e: IndexedEvent = {
        chainId,
        kind,
        blockNumber: l.blockNumber!,
        blockHash: l.blockHash!,
        txHash: l.transactionHash!,
        logIndex: l.logIndex!,
        emitter: l.address,
        data,
        removed: false,
      };
      out.set(`${kind}:${lower(e.txHash)}:${e.logIndex}`, e);
    };
    if (wallets.length) {
      const topics = wallets.map(padTopic);
      const [sent, received] = await Promise.all([
        this.chain.logs({
          address: token.address,
          topics: [TRANSFER_TOPIC, topics],
          fromBlock: from,
          toBlock: to,
        }),
        this.chain.logs({
          address: token.address,
          topics: [TRANSFER_TOPIC, null, topics],
          fromBlock: from,
          toBlock: to,
        }),
      ]);
      for (const l of parseEventLogs({
        abi: erc20Abi,
        eventName: 'Transfer',
        logs: [...sent, ...received],
      })) {
        // getLogs filtered by address already; this keeps a misbehaving RPC honest.
        if (lower(l.address) !== lower(token.address) || l.removed) continue;
        add(l, 'TRANSFER', {
          from: l.args.from,
          to: l.args.to,
          value: l.args.value.toString(),
        });
      }
    }
    if (memo) {
      const logs = await this.chain.logs({
        address: memo.address,
        topics: [MEMO_TOPIC, null, padTopic(token.address)],
        fromBlock: from,
        toBlock: to,
      });
      for (const l of parseEventLogs({ abi: [MEMO_EVENT_ABI], logs })) {
        if (lower(l.address) !== lower(memo.address) || l.removed) continue;
        add(l, 'MEMO', { memoId: l.args.memoId, sender: l.args.sender });
      }
    }
    return [...out.values()].sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
  }

  /** Runs pending effects in event order; each sink must be idempotent. */
  async applyEffects(
    sinks: Partial<Record<IndexedEventKind, EffectSink>>,
    limit = 500,
  ) {
    const done: { id: number; outcome: string }[] = [];
    for (const e of await this.store.pendingEffects(this.cfg.stream, limit)) {
      const sink = sinks[e.kind];
      const outcome = sink ? await sink(e) : 'NO_SINK';
      await this.store.markEffected(this.cfg.stream, e.id!, outcome);
      done.push({ id: e.id!, outcome });
    }
    return done;
  }
}

/** viem-backed chain access (use a `fallback` transport over the registry RPCs). */
export function viemIndexerChain(client: PublicClient): IndexerChain {
  return {
    chainId: () => client.getChainId(),
    latest: () => client.getBlockNumber({ cacheTime: 0 }),
    finalized: async () => {
      try {
        return (await client.getBlock({ blockTag: 'finalized' })).number!;
      } catch {
        return client.getBlockNumber({ cacheTime: 0 });
      }
    },
    block: async (n) => {
      const b = await client.getBlock({ blockNumber: n });
      return { number: b.number!, hash: b.hash!, parentHash: b.parentHash };
    },
    logs: (q) =>
      client
        .request({
          method: 'eth_getLogs',
          params: [
            {
              address: q.address,
              topics: q.topics,
              fromBlock: `0x${q.fromBlock.toString(16)}`,
              toBlock: `0x${q.toBlock.toString(16)}`,
            },
          ],
        })
        .then((logs) =>
          (logs as unknown as Record<string, unknown>[]).map(
            (l) =>
              ({
                ...l,
                blockNumber: BigInt(l.blockNumber as string),
                logIndex: Number(BigInt(l.logIndex as string)),
                transactionIndex: Number(BigInt(l.transactionIndex as string)),
              }) as unknown as Log,
          ),
        ),
    code: (address) => client.getCode({ address }),
    receiptLogs: async (hash) => {
      const r = await client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        from: r.from,
        logs: r.logs,
        feeWei: r.gasUsed * r.effectiveGasPrice,
      };
    },
    nativeBalance: (address, block) =>
      client.getBalance({ address, blockNumber: block }),
    nonce: (address, block) =>
      client.getTransactionCount({ address, blockNumber: block }),
  };
}

export type WalletReconciliation = Readonly<{
  wallet: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** Native wei (18 decimals; the ERC-20 view is the same balance in 6). */
  balanceDeltaWei: bigint;
  transferDeltaWei: bigint;
  gasPaidWei: bigint;
  txsSent: number;
  txsExplained: number;
  unexplainedWei: bigint;
  status: 'MATCH' | 'MISMATCH';
}>;

/**
 * Balance reconciliation of a watched wallet between two finalized blocks:
 * Δ native balance must equal the indexed registry-token transfers (×10^12)
 * minus the gas of every transaction the wallet sent. Transactions the wallet
 * sent are counted by nonce; any it sent that the index cannot explain, and
 * any wei difference, is a MISMATCH.
 */
export async function reconcileWallet(input: {
  chain: IndexerChain;
  wallet: Address;
  fromBlock: bigint;
  toBlock: bigint;
  /** Live TRANSFER events touching the wallet in (fromBlock, toBlock]. */
  transfers: readonly IndexedEvent[];
}): Promise<WalletReconciliation> {
  const { chain, wallet } = input;
  const w = lower(wallet);
  const [b0, b1, n0, n1, code] = await Promise.all([
    chain.nativeBalance(wallet, input.fromBlock),
    chain.nativeBalance(wallet, input.toBlock),
    chain.nonce(wallet, input.fromBlock),
    chain.nonce(wallet, input.toBlock),
    chain.code(wallet),
  ]);
  // A contract (e.g. the vault Safe) never sends transactions or pays gas;
  // its account nonce counts contract creations, not transactions.
  const isContract = !!code && code !== '0x';
  let transferDeltaWei = 0n;
  const sentTxs = new Set<string>();
  const inRange = input.transfers.filter(
    (e) =>
      !e.removed &&
      e.kind === 'TRANSFER' &&
      e.blockNumber > input.fromBlock &&
      e.blockNumber <= input.toBlock,
  );
  for (const e of inRange) {
    const v = BigInt(e.data.value!) * 1_000_000_000_000n;
    if (lower(e.data.to!) === w) transferDeltaWei += v;
    if (lower(e.data.from!) === w) transferDeltaWei -= v;
  }
  let gasPaidWei = 0n;
  for (const tx of new Set(inRange.map((e) => lower(e.txHash)))) {
    const r = await chain.receiptLogs(tx as Hex);
    if (lower(r.from) === w) {
      sentTxs.add(tx);
      gasPaidWei += r.feeWei;
    }
  }
  const balanceDeltaWei = b1 - b0;
  const unexplainedWei = balanceDeltaWei - (transferDeltaWei - gasPaidWei);
  const txsSent = isContract ? 0 : n1 - n0;
  return {
    wallet,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    balanceDeltaWei,
    transferDeltaWei,
    gasPaidWei,
    txsSent,
    txsExplained: sentTxs.size,
    unexplainedWei,
    status:
      unexplainedWei === 0n && txsSent === sentTxs.size ? 'MATCH' : 'MISMATCH',
  };
}

/** In-memory `ArcIndexStore` (tests, local runs); same contract as Postgres. */
export class MemoryArcIndexStore implements ArcIndexStore {
  private cursors = new Map<string, StreamCursor>();
  private blocks = new Map<string, Map<bigint, Hex>>();
  readonly rows: (IndexedEvent & {
    id: number;
    stream: string;
    effected: string | null;
    reversed: string | null;
  })[] = [];
  async cursor(stream: string) {
    return this.cursors.get(stream) ?? null;
  }
  async blockHash(stream: string, n: bigint) {
    return this.blocks.get(stream)?.get(n) ?? null;
  }
  async recordedBlocksDesc(stream: string, below: bigint, limit: number) {
    return [...(this.blocks.get(stream) ?? new Map<bigint, Hex>())]
      .filter(([n]) => n <= below)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, limit)
      .map(([number, hash]) => ({ number, hash }));
  }
  async commit(
    stream: string,
    expected: StreamCursor | null,
    next: StreamCursor,
    blocks: readonly ChainBlock[],
    events: readonly IndexedEvent[],
  ) {
    const cur = this.cursors.get(stream) ?? null;
    if (cur?.block !== expected?.block || cur?.hash !== expected?.hash)
      throw new ArcIndexerError('CONCURRENT_INDEXER');
    this.cursors.set(stream, next);
    const m = this.blocks.get(stream) ?? new Map<bigint, Hex>();
    for (const b of blocks) if (!m.has(b.number)) m.set(b.number, b.hash);
    this.blocks.set(stream, m);
    let inserted = 0;
    for (const e of events) {
      const dup = this.rows.some(
        (r) =>
          r.stream === stream &&
          !r.removed &&
          r.chainId === e.chainId &&
          lower(r.txHash) === lower(e.txHash) &&
          r.logIndex === e.logIndex &&
          r.kind === e.kind,
      );
      if (dup) continue;
      this.rows.push({
        ...e,
        id: this.rows.length + 1,
        stream,
        effected: null,
        reversed: null,
      });
      inserted++;
    }
    return { inserted, duplicates: events.length - inserted };
  }
  async rollback(stream: string, fork: StreamCursor) {
    let n = 0;
    for (const [i, r] of this.rows.entries())
      if (r.stream === stream && !r.removed && r.blockNumber > fork.block) {
        this.rows[i] = { ...r, removed: true };
        n++;
      }
    const m = this.blocks.get(stream);
    for (const k of [...(m?.keys() ?? [])]) if (k > fork.block) m!.delete(k);
    this.cursors.set(stream, fork);
    return n;
  }
  async pendingEffects(stream: string, limit: number) {
    return this.rows
      .filter(
        (r) =>
          r.stream === stream &&
          ((!r.removed && r.effected === null) ||
            (r.removed && r.effected !== null && r.reversed === null)),
      )
      .slice(0, limit);
  }
  async markEffected(stream: string, id: number, outcome: string) {
    const i = this.rows.findIndex((r) => r.stream === stream && r.id === id);
    const r = this.rows[i]!;
    this.rows[i] = r.removed
      ? { ...r, reversed: outcome }
      : { ...r, effected: outcome };
  }
}
