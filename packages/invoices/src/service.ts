import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { invoiceCardContent } from './cards.js';
import { LedgerError, type Ledger, type OutboxEvent } from '@synq/ledger';
import {
  InvoiceError,
  applyPayment,
  extractMemoPayments,
  issueInvoice,
  paymentEntry,
  type Invoice,
  type MemoPayment,
} from './index.js';

type Sql = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

export type StoredInvoice = Readonly<{ invoice: Invoice; rev: number }>;

/** Invoices persist with a revision counter; a stale write is refused, never merged. */
export interface InvoiceStore {
  get(invoiceId: string): Promise<StoredInvoice | null>;
  byPaymentRef(ref: Hex): Promise<StoredInvoice | null>;
  /** `expectedRev` null = create. Returns the new revision or throws CONFLICT. */
  save(invoice: Invoice, expectedRev: number | null): Promise<number>;
  list(workspaceId: string): Promise<StoredInvoice[]>;
}

const conflict = (id: string) =>
  new InvoiceError('CONFLICT', `${id} changed concurrently; reload and retry`);

export class MemoryInvoiceStore implements InvoiceStore {
  private rows = new Map<string, StoredInvoice>();
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async byPaymentRef(ref: Hex) {
    return (
      [...this.rows.values()].find(
        (r) => r.invoice.paymentRef?.toLowerCase() === ref.toLowerCase(),
      ) ?? null
    );
  }
  async save(invoice: Invoice, expectedRev: number | null) {
    const cur = this.rows.get(invoice.invoiceId);
    if ((cur?.rev ?? null) !== expectedRev) throw conflict(invoice.invoiceId);
    const dup = [...this.rows.values()].find(
      (r) =>
        r.invoice.invoiceId !== invoice.invoiceId &&
        r.invoice.workspaceId === invoice.workspaceId &&
        r.invoice.number === invoice.number,
    );
    if (dup)
      throw new InvoiceError('DUPLICATE_NUMBER', `${invoice.number} exists`);
    const rev = (expectedRev ?? 0) + 1;
    this.rows.set(invoice.invoiceId, { invoice, rev });
    return rev;
  }
  async list(workspaceId: string) {
    return [...this.rows.values()].filter(
      (r) => r.invoice.workspaceId === workspaceId,
    );
  }
}

const enc = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const dec = <T>(raw: unknown): T =>
  JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;
const row = (r: Record<string, unknown> | undefined): StoredInvoice | null =>
  r ? { invoice: dec<Invoice>(r.data), rev: Number(r.rev) } : null;

/** Uses table `synq_invoices` from the finance migrations (`migrateFinance`). */
export class PostgresInvoiceStore implements InvoiceStore {
  constructor(readonly sql: Sql) {}
  async get(id: string) {
    const r = await this.sql.query(
      'SELECT data, rev FROM synq_invoices WHERE invoice_id=$1',
      [id],
    );
    return row(r.rows[0]);
  }
  async byPaymentRef(ref: Hex) {
    const r = await this.sql.query(
      'SELECT data, rev FROM synq_invoices WHERE payment_ref=$1',
      [ref.toLowerCase()],
    );
    return row(r.rows[0]);
  }
  async save(invoice: Invoice, expectedRev: number | null) {
    const ref = invoice.paymentRef?.toLowerCase() ?? null;
    try {
      const r =
        expectedRev === null
          ? await this.sql.query(
              `INSERT INTO synq_invoices (invoice_id, workspace_id, number, payment_ref, rev, data)
               VALUES ($1,$2,$3,$4,1,$5) ON CONFLICT (invoice_id) DO NOTHING RETURNING rev`,
              [
                invoice.invoiceId,
                invoice.workspaceId,
                invoice.number,
                ref,
                enc(invoice),
              ],
            )
          : await this.sql.query(
              `UPDATE synq_invoices SET payment_ref=$2, rev=rev+1, data=$3
               WHERE invoice_id=$1 AND rev=$4 RETURNING rev`,
              [invoice.invoiceId, ref, enc(invoice), expectedRev],
            );
      if (!r.rows[0]) throw conflict(invoice.invoiceId);
      return Number(r.rows[0].rev);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new InvoiceError('DUPLICATE_NUMBER', `${invoice.number} exists`);
      throw e;
    }
  }
  async list(workspaceId: string) {
    const r = await this.sql.query(
      'SELECT data, rev FROM synq_invoices WHERE workspace_id=$1 ORDER BY number',
      [workspaceId],
    );
    return r.rows.map((x) => row(x)!);
  }
}

/**
 * Persisted invoice lifecycle. Issuance posts its ledger entry (idempotent
 * key, with an outbox event) before saving the document, so a crash in
 * between is repaired by running the same step again.
 *
 * A payment is the other way round: the document is saved first, under its
 * revision, and only the winning save posts the entry. Concurrent settlers
 * (checkout verify, watcher, indexer replicas) or a revision racing a payment
 * therefore never leave an entry booked against a document that did not
 * record the payment; the loser reloads and applies the payment to the
 * current document (or finds its reference gone). A crash between the save
 * and the post is repaired when the payment is seen again: the duplicate
 * path re-posts the recorded entry, which the ledger accepts once.
 */
export class InvoiceService {
  constructor(
    readonly store: InvoiceStore,
    readonly ledger: Ledger,
    readonly now: () => number,
    readonly authorizeIssue?: (invoice: Invoice) => Promise<void>,
  ) {}

  async create(draft: Invoice): Promise<StoredInvoice> {
    if (draft.status !== 'DRAFT')
      throw new InvoiceError('WRONG_STATE', draft.status);
    return { invoice: draft, rev: await this.store.save(draft, null) };
  }

  async issue(invoiceId: string, signature: Hex): Promise<StoredInvoice> {
    const cur = await this.store.get(invoiceId);
    if (!cur) throw new InvoiceError('NOT_FOUND', invoiceId);
    if (cur.invoice.status !== 'DRAFT') return cur;
    await this.authorizeIssue?.(cur.invoice);
    const { invoice, entry } = await issueInvoice(
      cur.invoice,
      signature,
      this.now(),
    );
    await this.ledger.post(entry, [
      event(entry.idempotencyKey, 'invoice.issued', invoice),
    ]);
    return { invoice, rev: await this.store.save(invoice, cur.rev) };
  }

  /** Applies a verified on-chain payment; replays are no-ops. */
  async settle(
    p: MemoPayment,
  ): Promise<
    | { outcome: 'APPLIED' | 'DUPLICATE'; invoice: Invoice }
    | { outcome: 'UNMATCHED'; reason: string }
  > {
    for (let attempt = 1; ; attempt++) {
      const cur = await this.store.byPaymentRef(p.paymentRef);
      if (!cur) return { outcome: 'UNMATCHED', reason: 'unknown reference' };
      const r = applyPayment(cur.invoice, p, this.now());
      if (!r.applied) {
        const key = `chain:${p.chainId}:${p.txHash.toLowerCase()}:${p.logIndex}`;
        const rec = cur.invoice.payments.find((x) => x.key === key);
        const entry = rec ? paymentEntry(cur.invoice, rec) : null;
        if (entry)
          await this.ledger.post(entry, [
            event(entry.idempotencyKey, 'invoice.payment_applied', cur.invoice),
          ]);
        return { outcome: 'DUPLICATE', invoice: cur.invoice };
      }
      let rev: number;
      try {
        rev = await this.store.save(r.invoice, cur.rev);
      } catch (e) {
        if (
          e instanceof InvoiceError &&
          e.code === 'CONFLICT' &&
          attempt < MAX_SETTLE_ATTEMPTS
        )
          continue;
        throw e;
      }
      try {
        await this.ledger.post(r.entry!, [
          event(r.entry!.idempotencyKey, 'invoice.payment_applied', r.invoice),
        ]);
      } catch (e) {
        // This chain log is already booked with other lines (another
        // document): take the payment back off this one and refuse. One
        // transfer never settles two invoices.
        if (e instanceof LedgerError && e.code === 'IDEMPOTENCY_CONFLICT')
          await this.store.save(cur.invoice, rev).catch(() => undefined);
        throw e;
      }
      return { outcome: 'APPLIED', invoice: r.invoice };
    }
  }
}

/** A settle that keeps losing revision races gives up with CONFLICT. */
const MAX_SETTLE_ATTEMPTS = 16;

const event = (key: string, topic: string, i: Invoice): OutboxEvent => ({
  eventId: `${topic}:${key}`,
  topic,
  payload: {
    workspaceId: i.workspaceId,
    occurredAt: i.payments.find((p) => p.key === key)?.at ?? i.issuedAt ?? 0,
    card: invoiceCardContent(i),
    invoiceId: i.invoiceId,
    number: i.number,
    status: i.status,
    paid: i.paid,
    total: i.total,
  },
});

const MEMO_EVENT = parseAbiItem(
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
);

/**
 * Read-only Arc watcher: finds Memo events in a block range, then reads each
 * transaction's receipt and pairs memos with the registry-token Transfer they
 * caused. Never trusts a payer-supplied hash or amount.
 */
export async function scanMemoPayments(input: {
  client: PublicClient;
  chainId: number;
  token: Address;
  memoContract: Address;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<{
  payments: MemoPayment[];
  unreferenced: { txHash: Hex; logIndex: number; amount: bigint }[];
}> {
  const logs = await input.client.getLogs({
    address: input.memoContract,
    event: MEMO_EVENT,
    args: { target: input.token },
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
  });
  const txs = [...new Set(logs.map((l) => l.transactionHash!))];
  const payments: MemoPayment[] = [];
  const unreferenced: { txHash: Hex; logIndex: number; amount: bigint }[] = [];
  for (const txHash of txs) {
    const r = await paymentsInTx({ ...input, txHash });
    payments.push(...r.payments);
    unreferenced.push(...r.unreferenced);
  }
  return { payments, unreferenced };
}

/** Verifies one transaction (e.g. a hash the checkout page reports) from its receipt. */
export async function paymentsInTx(input: {
  client: PublicClient;
  chainId: number;
  token: Address;
  memoContract: Address;
  txHash: Hex;
}) {
  const receipt = await input.client.getTransactionReceipt({
    hash: input.txHash,
  });
  if (receipt.status !== 'success') return { payments: [], unreferenced: [] };
  const r = extractMemoPayments({
    chainId: input.chainId,
    txHash: input.txHash,
    logs: receipt.logs,
    token: input.token,
    memoContract: input.memoContract,
  });
  return {
    payments: r.payments,
    unreferenced: r.unreferenced.map((u) => ({
      txHash: input.txHash,
      logIndex: u.logIndex,
      amount: u.amount,
    })),
  };
}
