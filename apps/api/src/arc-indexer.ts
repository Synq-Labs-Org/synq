/**
 * Synq Arc indexer service (long-running).
 *
 *   corepack pnpm indexer:arc                       # follow the chain
 *   corepack pnpm indexer:arc -- --from N --to M    # bounded run, then exit
 *
 * Environment:
 *   SYNQ_INDEXER_DATABASE_URL         Postgres (falls back to DATABASE_URL)
 *   SYNQ_ARC_TESTNET_RPC_URL          preferred RPC; the registry list is the fallback
 *   SYNQ_ARC_INDEXER_WALLETS          comma-separated watched wallets
 *   SYNQ_ARC_INDEXER_START_BLOCK      first block when the stream has no cursor
 *   SYNQ_ARC_INDEXER_CONFIRMATIONS    extra depth below `finalized` (default 0)
 *   SYNQ_ARC_INDEXER_BATCH            blocks per batch (default 2000)
 *   SYNQ_ARC_INDEXER_POLL_MS          idle poll interval (default 2000)
 *   SYNQ_ARC_INDEXER_STREAM           stream id (default arc-testnet:main)
 *   SYNQ_ARC_INDEXER_RECONCILE_EVERY  batches between wallet reconciliations (default 30)
 *
 * Ingests registry-USDC transfers of watched wallets and Memo invoice
 * payments into Postgres (cursor, events with provenance, reorg rollback),
 * then settles Memo payments through `InvoiceService.settle` (idempotent per
 * chain/tx/log). It never signs anything.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { CHAINS, contract, token, tokenEntry } from '@synq/chain-registry/arc';
import {
  ArcChainIndexer,
  FATAL_INDEXER_ERRORS,
  Ledger,
  PostgresArcIndexStore,
  PostgresLedgerStore,
  migrateArcIndexer,
  migrateFinance,
  reconcileWallet,
  viemIndexerChain,
  type IndexedEvent,
  type IndexerChain,
} from '@synq/ledger';
import {
  InvoiceError,
  InvoiceService,
  PostgresInvoiceStore,
  extractMemoPayments,
} from '@synq/invoices';

export type ArcIndexerOptions = {
  databaseUrl: string;
  stream: string;
  wallets: readonly Address[];
  startBlock: bigint;
  confirmations: number;
  batchSize: bigint;
  pollMs: number;
  reconcileEvery: number;
  /** Bounded run: stop after this block. */
  toBlock?: bigint;
  /** Stop after this many batches (crash/restart rehearsal). */
  maxBatches?: number;
  /** Reads for receipts and reconciliation (fallback across RPCs is fine for by-hash reads). */
  client?: PublicClient;
  /** One client per RPC; each indexer step is pinned to one of them. */
  providers?: readonly PublicClient[];
  /** Give up a bounded run after this many failed steps (default: never). */
  maxRetries?: number;
  log?: (line: Record<string, unknown>) => void;
  signal?: AbortSignal;
  now?: () => number;
};

/** The env RPC, then every registry RPC, in order, without duplicates. */
export function arcRpcUrls(): string[] {
  const profile = CHAINS['arc-testnet'];
  return [
    ...new Set([
      ...(process.env[profile.rpcEnvironment]
        ? [process.env[profile.rpcEnvironment]!]
        : []),
      ...profile.rpcUrls,
    ]),
  ];
}

const httpFor = (u: string) =>
  http(u, { retryCount: 2, retryDelay: 300, timeout: 20_000 });

/**
 * One client per RPC, for the indexer's pinned steps. A step never mixes
 * providers (a per-request fallback once let a lagging RPC silently truncate
 * a getLogs answer); the indexer moves to the next provider per step.
 */
export function arcProviderClients(): PublicClient[] {
  return arcRpcUrls().map(
    (u) => createPublicClient({ transport: httpFor(u) }) as PublicClient,
  );
}

/** viem client over the env RPC then every registry RPC, for by-hash reads. */
export function arcFallbackClient(): PublicClient {
  const urls = arcRpcUrls();
  return createPublicClient({
    transport: fallback(
      urls.map(httpFor),
    ),
  }) as PublicClient;
}

export function optionsFromEnv(argv = process.argv): ArcIndexerOptions {
  const arg = (n: string) =>
    argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : null;
  const e = process.env;
  const databaseUrl = e.SYNQ_INDEXER_DATABASE_URL ?? e.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('SYNQ_INDEXER_DATABASE_URL (or DATABASE_URL) is required');
  const from = arg('from') ?? e.SYNQ_ARC_INDEXER_START_BLOCK;
  if (!from)
    throw new Error('SYNQ_ARC_INDEXER_START_BLOCK or --from is required');
  const to = arg('to');
  return {
    databaseUrl,
    stream: arg('stream') ?? e.SYNQ_ARC_INDEXER_STREAM ?? 'arc-testnet:main',
    wallets: (arg('wallets') ?? e.SYNQ_ARC_INDEXER_WALLETS ?? '')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => getAddress(w)),
    startBlock: BigInt(from),
    confirmations: Number(e.SYNQ_ARC_INDEXER_CONFIRMATIONS ?? 0),
    batchSize: BigInt(e.SYNQ_ARC_INDEXER_BATCH ?? 2000),
    pollMs: Number(e.SYNQ_ARC_INDEXER_POLL_MS ?? 2000),
    reconcileEvery: Number(e.SYNQ_ARC_INDEXER_RECONCILE_EVERY ?? 30),
    ...(to ? { toBlock: BigInt(to) } : {}),
    ...(arg('max-batches') ? { maxBatches: Number(arg('max-batches')) } : {}),
  };
}

/** Settles each Memo payment in the tx; outcome per payment, never throws on a bad match. */
export function memoSink(input: {
  chain: IndexerChain;
  service: InvoiceService;
  chainId: number;
  token: Address;
  memoContract: Address;
}) {
  return async (e: IndexedEvent): Promise<string> => {
    // A Memo whose block was reorged out: a settled payment cannot be
    // silently un-applied; flag it for review instead.
    if (e.removed) return 'REVIEW_REORGED_MEMO';
    const r = await input.chain.receiptLogs(e.txHash);
    if (r.status !== 'success') return 'TX_REVERTED';
    const { payments } = extractMemoPayments({
      chainId: input.chainId,
      txHash: e.txHash,
      logs: r.logs,
      token: input.token,
      memoContract: input.memoContract,
    });
    const outcomes: string[] = [];
    // Only the payment(s) this Memo log names; other memos in the same tx
    // are their own events.
    for (const p of payments.filter(
      (x) =>
        x.paymentRef.toLowerCase() === e.data.memoId?.toLowerCase() &&
        x.payer.toLowerCase() === e.data.sender?.toLowerCase(),
    )) {
      try {
        const s = await input.service.settle(p);
        outcomes.push(
          s.outcome === 'UNMATCHED'
            ? `UNMATCHED:${p.paymentRef}`
            : `${s.outcome}:${s.invoice.invoiceId}`,
        );
      } catch (err) {
        if (!(err instanceof InvoiceError)) throw err;
        outcomes.push(`REVIEW:${err.code}:${p.paymentRef}`);
      }
    }
    return outcomes.join(',') || 'NO_PAYMENT';
  };
}

export async function runArcIndexer(o: ArcIndexerOptions) {
  const log = o.log ?? ((l) => console.log(JSON.stringify(l)));
  const pool = new pg.Pool({ connectionString: o.databaseUrl, max: 4 });
  try {
    await migrateArcIndexer(pool);
    await migrateFinance(pool);
    const client = o.client ?? arcFallbackClient();
    const chain = viemIndexerChain(client);
    const providers = (
      o.providers ?? (o.client ? [o.client] : arcProviderClients())
    ).map(viemIndexerChain);
    const usdc = token('arc-testnet', 'USDC');
    const memo = contract('arc-testnet', 'MEMO');
    const store = new PostgresArcIndexStore(pool);
    const indexer = new ArcChainIndexer(providers, store, {
      stream: o.stream,
      chainId: usdc.chainId,
      token: { address: usdc.address, codeHash: tokenEntry(usdc).codeHash! },
      memo: { address: memo.address, codeHash: memo.codeHash! },
      wallets: o.wallets,
      startBlock: o.startBlock,
      confirmations: o.confirmations,
      batchSize: o.batchSize,
    });
    await indexer.verify();
    const ledger = new Ledger(new PostgresLedgerStore(pool));
    const invoices = new InvoiceService(
      new PostgresInvoiceStore(pool),
      ledger,
      o.now ?? (() => Math.floor(Date.now() / 1000)),
    );
    const sinks = {
      MEMO: memoSink({
        chain,
        service: invoices,
        chainId: usdc.chainId,
        token: usdc.address,
        memoContract: memo.address,
      }),
      TRANSFER: async (e: IndexedEvent) => (e.removed ? 'REMOVED' : 'RECORDED'),
    };
    const effects = async (recovered: boolean) => {
      try {
        for (const d of await indexer.applyEffects(sinks))
          log({ kind: 'effect', ...d, ...(recovered ? { recovered } : {}) });
      } catch (e) {
        // The event stays pending and is retried on the next pass.
        log({ kind: 'effect-retry', message: String((e as Error).message).slice(0, 200) });
      }
    };
    // Effects left pending by a crash run first.
    await effects(true);
    let batches = 0;
    let failures = 0;
    for (;;) {
      if (o.signal?.aborted) break;
      let r: Awaited<ReturnType<typeof indexer.step>>;
      try {
        r = await indexer.step(o.toBlock);
      } catch (e) {
        const code = (e as { code?: string }).code;
        // Wrong chain, a changed contract or a reorg past the anchor halt the stream.
        if (FATAL_INDEXER_ERRORS.includes(code as never)) throw e;
        failures++;
        log({
          kind: 'retry',
          code: code ?? 'ERROR',
          message: String((e as Error).message).slice(0, 200),
          nextProvider: indexer.providers.indexOf(indexer.chain),
        });
        if (o.maxRetries !== undefined && failures > o.maxRetries) throw e;
        await new Promise((res) => setTimeout(res, o.pollMs));
        continue;
      }
      if (!r.idle) {
        batches++;
        log({
          kind: 'batch',
          stream: o.stream,
          from: String(r.from),
          to: String(r.to),
          inserted: r.inserted,
          duplicates: r.duplicates,
          rolledBackTo: r.rolledBackTo === null ? null : String(r.rolledBackTo),
          removed: r.removed,
        });
        await effects(false);
        if (o.reconcileEvery > 0 && batches % o.reconcileEvery === 0)
          await reconcileAll();
      }
      const cursor = await store.cursor(o.stream);
      if (o.toBlock !== undefined && cursor && cursor.block >= o.toBlock) break;
      if (o.maxBatches !== undefined && batches >= o.maxBatches) break;
      if (r.idle) await new Promise((res) => setTimeout(res, o.pollMs));
    }
    // A bounded run ends with a reconciliation of every watched wallet.
    const reconciliation = o.toBlock !== undefined ? await reconcileAll() : [];
    return { batches, cursor: await store.cursor(o.stream), reconciliation };

    async function reconcileAll() {
      const cursor = await store.cursor(o.stream);
      if (!cursor) return [];
      const transfers = await store.events(o.stream, 'TRANSFER');
      const out = [];
      for (const wallet of o.wallets) {
        const r = await reconcileWallet({
          chain,
          wallet,
          fromBlock: o.startBlock - 1n,
          toBlock: cursor.block,
          transfers,
        });
        log({
          kind: 'reconcile',
          ...Object.fromEntries(
            Object.entries(r).map(([k, v]) => [
              k,
              typeof v === 'bigint' ? String(v) : v,
            ]),
          ),
        });
        out.push(r);
      }
      return out;
    }
  } finally {
    await pool.end();
  }
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  await runArcIndexer({ ...optionsFromEnv(), signal: ac.signal });
}
