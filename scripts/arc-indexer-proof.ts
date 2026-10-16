/**
 * Live proof of the Arc indexer service on Arc testnet (read-only).
 *
 *   node --import tsx scripts/arc-indexer-proof.ts [--db <url>] [--out <file.json>]
 *
 * Indexes a bounded block range that covers the P11 checkout payment
 * (0xcc30d381…, a Memo invoice payment) and the demo vault payout
 * (0x5dc5138e…). It runs in three processes' worth of steps against one
 * fresh Postgres database: run 1 stops after two batches (a "crash"), run 2
 * resumes from the durable cursor to the end, run 3 restarts on a finished
 * cursor. A second stream then re-scans the whole range to show a replayed
 * Memo payment settles nothing twice. The invoice is the P11 checkout invoice
 * read from its Postgres record and reset to its pre-payment state (ISSUED,
 * nothing paid); its signed terms and payment reference are unchanged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { Address, Hex } from 'viem';
import { contract } from '@synq/chain-registry/arc';
import { migrateFinance, PostgresLedgerStore } from '@synq/ledger';
import { PostgresInvoiceStore, type Invoice } from '@synq/invoices';
import {
  arcFallbackClient,
  runArcIndexer,
} from '../apps/api/src/arc-indexer.js';

const arg = (n: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : null;
const DB =
  arg('db') ?? 'postgresql://postgres@127.0.0.1:55433/synq_m2_indexer_proof';
const SOURCE =
  arg('source') ?? 'postgresql://postgres@127.0.0.1:55433/synq_p08_checkout';
const out =
  arg('out') ??
  join(process.cwd(), 'bounty-evidence', 'arc', 'm2-indexer-proof.json');
const CHECKOUT_TX =
  '0xcc30d3817ac94cc24117129dc106283cda33788030edcb111a4c57f914285d75' as Hex;
const PAYOUT_TX =
  '0x5dc5138eb08f9e52245e47bae7ea4db6962fb0e5b44c06dbe4feaf75acf92983' as Hex;
const INVOICE_ID = 'inv_f9aa042a727d27d402be';

const client = arcFallbackClient();
const [checkoutRcpt, payoutRcpt] = await Promise.all([
  client.getTransactionReceipt({ hash: CHECKOUT_TX }),
  client.getTransactionReceipt({ hash: PAYOUT_TX }),
]);
// Watched: the invoice payout address and payer (read from the checkout
// record and receipt, not hard-coded) and the registry vault Safe.
const wallets: Address[] = [
  checkoutRcpt.from,
  contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address,
];
const from = checkoutRcpt.blockNumber - 17n;
const to = payoutRcpt.blockNumber + 5n;

// Fresh proof database.
const name = new URL(DB).pathname.slice(1);
if (!/^synq_m2_[a-z0-9_]+$/.test(name))
  throw new Error('proof DB must be synq_m2_*');
const admin = new pg.Client({
  connectionString: DB.replace(/\/[^/]+$/, '/postgres'),
});
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${name}`);
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();

const pool = new pg.Pool({ connectionString: DB, max: 4 });
await migrateFinance(pool);
const src = new pg.Pool({ connectionString: SOURCE, max: 1 });
const paid = await new PostgresInvoiceStore(src).get(INVOICE_ID);
await src.end();
if (!paid) throw new Error('checkout invoice not found in the source database');
const unpaid: Invoice = Object.freeze({
  ...paid.invoice,
  status: 'ISSUED',
  paid: 0n,
  payments: [],
});
await new PostgresInvoiceStore(pool).save(unpaid, null);
wallets.unshift(unpaid.issuer.payoutAddress);

const lines: Record<string, unknown>[] = [];
const run = async (
  label: string,
  extra: { maxBatches?: number; stream?: string } = {},
) => {
  const r = await runArcIndexer({
    databaseUrl: DB,
    stream: extra.stream ?? 'arc-testnet:proof',
    wallets,
    startBlock: from,
    confirmations: 0,
    batchSize: 2000n,
    pollMs: 500,
    reconcileEvery: 0,
    toBlock: to,
    ...(extra.maxBatches ? { maxBatches: extra.maxBatches } : {}),
    client,
    log: (l) => {
      lines.push({ run: label, ...l });
      console.log(JSON.stringify({ run: label, ...l }));
    },
  });
  return {
    batches: r.batches,
    cursor: r.cursor && { block: String(r.cursor.block), hash: r.cursor.hash },
    reconciliation: r.reconciliation.map((x) =>
      Object.fromEntries(
        Object.entries(x).map(([k, v]) => [
          k,
          typeof v === 'bigint' ? String(v) : v,
        ]),
      ),
    ),
  };
};

const run1 = await run('1-crash-after-2-batches', { maxBatches: 2 });
const run2 = await run('2-restart-resume');
const run3 = await run('3-restart-finished');
const replay = await run('4-second-stream-rescan', {
  stream: 'arc-testnet:replay',
});

const q = async (sql: string, v: unknown[] = []) =>
  (await pool.query(sql, v)).rows;
const events = await q(
  `SELECT stream, kind, tx_hash, log_index, block_number::text, block_hash, emitter, removed, effect_outcome
   FROM synq_arc_index_events WHERE tx_hash = ANY($1) ORDER BY stream, block_number, log_index, kind`,
  [[CHECKOUT_TX, PAYOUT_TX]],
);
const totals = await q(
  `SELECT stream, kind, count(*)::int AS n FROM synq_arc_index_events GROUP BY stream, kind ORDER BY stream, kind`,
);
const dupes = await q(
  `SELECT stream, tx_hash, log_index, kind, count(*)::int AS n FROM synq_arc_index_events
   WHERE NOT removed GROUP BY 1,2,3,4 HAVING count(*) > 1`,
);
const invoice = await new PostgresInvoiceStore(pool).get(INVOICE_ID);
const entries = (
  await new PostgresLedgerStore(pool).entries(unpaid.workspaceId)
).filter(
  (e) => e.source.ref === CHECKOUT_TX || e.evidence?.txHash === CHECKOUT_TX,
);
await pool.end();

const evidence = {
  label: 'LIVE_ARC_TESTNET',
  kind: 'read-only indexer run (no transaction)',
  at: new Date().toISOString(),
  range: { from: String(from), to: String(to) },
  txs: {
    checkout: { hash: CHECKOUT_TX, block: String(checkoutRcpt.blockNumber) },
    payout: { hash: PAYOUT_TX, block: String(payoutRcpt.blockNumber) },
  },
  runs: { run1, run2, run3, replay },
  eventsForProofTxs: events,
  eventTotals: totals,
  duplicateLiveEvents: dupes,
  invoice: invoice && {
    status: invoice.invoice.status,
    paid: String(invoice.invoice.paid),
    payments: invoice.invoice.payments.length,
    rev: invoice.rev,
  },
  ledgerEntriesForCheckout: entries.length,
  log: lines,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
console.log(
  JSON.stringify({
    evidence: out,
    invoice: evidence.invoice,
    dupes: dupes.length,
    ledgerEntriesForCheckout: entries.length,
  }),
);
if (
  dupes.length ||
  entries.length !== 1 ||
  invoice?.invoice.payments.length !== 1
)
  throw new Error('indexer proof failed: duplicate ingestion or settlement');
