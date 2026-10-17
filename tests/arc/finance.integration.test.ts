import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { token } from '@synq/chain-registry/arc';
import {
  LEDGER_MIGRATIONS,
  Ledger,
  PostgresConsumerInbox,
  PostgresLedgerStore,
  consumeOnce,
  relayOutbox,
  migrateFinance,
  type JournalEntry,
} from '@synq/ledger';
import {
  InvoiceService,
  PostgresInvoiceStore,
  draftInvoice,
  issueTypedData,
} from '@synq/invoices';
import { PostgresVendorStore, VendorConflictError } from '@synq/payables';
import { privateKeyToAccount } from 'viem/accounts';
import { ensureP08Database } from '../treasury/pg.js';
import { testDatabaseUrl } from '../durable/pg.js';

const URL = testDatabaseUrl(
  'SYNQ_ARC_FINANCE_TEST_DATABASE_URL',
  'synq_p08_arc_finance',
);
const USDC = token('arc-testnet', 'USDC');
let pool: pg.Pool;

beforeAll(async () => {
  pool = await ensureP08Database(URL);
  await migrateFinance(pool, 0);
});
afterAll(async () => {
  await migrateFinance(pool, 0);
  await pool.query('DROP TABLE IF EXISTS synq_finance_migrations');
  await pool.end();
});

const entry = (n: number): JournalEntry => ({
  entryId: `je_${n}`,
  workspaceId: 'wsp_pg',
  occurredAt: 1_790_000_000 + n,
  memo: `receipt ${n}`,
  source: { kind: 'CHAIN_TX', ref: `inv_${n}` },
  evidence: {
    chainId: USDC.chainId,
    txHash: `0x${String(n).padStart(2, '0').repeat(32)}`,
    logIndex: n,
  },
  idempotencyKey: `chain:${USDC.chainId}:${n}`,
  postings: [
    {
      account: 'CASH_ARC_USDC',
      assetId: USDC.assetId,
      amount: 1_000_000n * BigInt(n),
    },
    {
      account: 'ACCOUNTS_RECEIVABLE',
      assetId: USDC.assetId,
      amount: -1_000_000n * BigInt(n),
    },
  ],
  reversalOf: null,
});

describe('finance schema on Postgres', { timeout: 30_000 }, () => {
  it('P01-05 migrates forward and back (dry run) and the journal round-trips exactly', async () => {
    expect(await migrateFinance(pool)).toBe(LEDGER_MIGRATIONS.at(-1)!.version);
    expect(await migrateFinance(pool)).toBe(LEDGER_MIGRATIONS.at(-1)!.version); // idempotent
    const ledger = new Ledger(new PostgresLedgerStore(pool));
    for (const n of [1, 2, 3]) await ledger.post(entry(n));
    const before = await ledger.store.entries('wsp_pg');
    // Dry run on a copy: back to 0 and forward again inside a rolled-back transaction.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await migrateFinance(c, 0)).toBe(0);
      const gone = await c.query(
        "SELECT to_regclass('synq_ledger_entries') AS t",
      );
      expect(gone.rows[0]!.t).toBeNull();
      expect(await migrateFinance(c)).toBe(LEDGER_MIGRATIONS.at(-1)!.version);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const after = await new PostgresLedgerStore(pool).entries('wsp_pg');
    expect(after).toEqual(before);
    expect(after[2]!.postings[0]!.amount).toBe(3_000_000n);
  });

  it('P08-02 / P08-06 replaying the same chain events (e.g. after a reorg rebuild) gives identical balances', async () => {
    const ledger = new Ledger(new PostgresLedgerStore(pool));
    const once = await ledger.balances('wsp_pg', USDC.assetId);
    for (const n of [3, 1, 2, 3])
      expect(
        (await ledger.post({ ...entry(n), entryId: `je_${n}_replay` })).created,
      ).toBe(false);
    expect(await ledger.balances('wsp_pg', USDC.assetId)).toEqual(once);
    expect(once.CASH_ARC_USDC).toBe(6_000_000n);
  });

  it('P08-06 the entry and its outbox events commit together; the inbox fences duplicates', async () => {
    const store = new PostgresLedgerStore(pool);
    const ledger = new Ledger(store);
    const event = {
      eventId: 'evt_pg_paid_4',
      topic: 'invoice.paid',
      payload: { invoice: 'inv_4', amount: 4_000_000n },
    };
    expect((await ledger.post(entry(4), [event])).created).toBe(true);
    expect((await ledger.post(entry(4), [event])).created).toBe(false);
    const pending = await store.pendingEvents(10);
    expect(pending.map((e) => e.eventId)).toEqual(['evt_pg_paid_4']);
    expect(pending[0]!.payload).toEqual({
      invoice: 'inv_4',
      amount: '4000000n',
    });
    const inbox = new PostgresConsumerInbox(pool);
    const seen: string[] = [];
    const deliver = (e: (typeof pending)[number]) =>
      consumeOnce(inbox, 'audit', e, async (x) => void seen.push(x.eventId));
    await expect(
      relayOutbox(store, async (e) => {
        await deliver(e);
        throw new Error('relay crash');
      }),
    ).rejects.toThrow();
    expect(await relayOutbox(store, async (e) => void (await deliver(e)))).toBe(
      1,
    );
    expect(await relayOutbox(store, async (e) => void (await deliver(e)))).toBe(
      0,
    );
    expect(seen).toEqual(['evt_pg_paid_4']);
  });

  it("a workspace-scoped relay publishes only that workspace's events", async () => {
    const store = new PostgresLedgerStore(pool);
    const ledger = new Ledger(store);
    await ledger.post({ ...entry(5), workspaceId: 'wsp_pg_a' }, [
      { eventId: 'evt_pg_a', topic: 'invoice.paid', payload: {} },
    ]);
    await ledger.post({ ...entry(6), workspaceId: 'wsp_pg_b' }, [
      { eventId: 'evt_pg_b', topic: 'invoice.paid', payload: {} },
    ]);
    const seen: string[] = [];
    expect(
      await relayOutbox(
        store,
        async (e) => void seen.push(e.eventId),
        100,
        'wsp_pg_b',
      ),
    ).toBe(1);
    expect(seen).toEqual(['evt_pg_b']);
    expect(
      (await store.pendingEvents(10, 'wsp_pg_a')).map((e) => e.eventId),
    ).toEqual(['evt_pg_a']);
  });

  it('P11 invoices and vendors persist with revision fencing', async () => {
    const issuer = privateKeyToAccount(`0x${'71'.repeat(32)}`);
    const store = new PostgresInvoiceStore(pool);
    const svc = new InvoiceService(
      store,
      new Ledger(new PostgresLedgerStore(pool)),
      () => 1_800_000_000,
    );
    const d = draftInvoice({
      workspaceId: 'wsp_pg_inv',
      number: 'INV-PG-1',
      issuer: {
        principalId: 'p',
        name: 'Studio',
        wallet: issuer.address,
        payoutAddress: issuer.address,
      },
      payer: { name: 'Acme', contact: null },
      asset: USDC,
      lineItems: [{ description: 'Work', quantity: 2, unitPrice: 150_000n }],
      dueDate: '2026-10-30',
      draftedBy: 'test',
      now: 1_800_000_000,
    });
    await svc.create(d);
    const issued = (
      await svc.issue(
        d.invoiceId,
        await issuer.signTypedData(issueTypedData(d)),
      )
    ).invoice;
    const settled = await svc.settle({
      chainId: USDC.chainId,
      txHash: `0x${'5e'.repeat(32)}`,
      logIndex: 1,
      paymentRef: issued.paymentRef!,
      payer: issuer.address,
      recipient: issuer.address,
      amount: 300_000n,
    });
    expect(settled).toMatchObject({
      outcome: 'APPLIED',
      invoice: { status: 'PAID' },
    });
    const fresh = await new PostgresInvoiceStore(pool).byPaymentRef(
      issued.paymentRef!,
    );
    expect(fresh!.invoice.paid).toBe(300_000n);
    expect(fresh!.invoice.total).toBe(300_000n);
    expect(fresh!.rev).toBe(3);
    await expect(store.save(fresh!.invoice, 1)).rejects.toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    await expect(
      store.save({ ...d, invoiceId: 'other' }, null),
    ).rejects.toThrow(expect.objectContaining({ code: 'DUPLICATE_NUMBER' }));
    const vendors = new PostgresVendorStore(pool);
    const v = {
      vendorId: 'ven_pg_1',
      workspaceId: 'wsp_pg_inv',
      name: 'Sarah',
      kind: 'CONTRACTOR' as const,
      addresses: [],
    };
    const r1 = await vendors.save(v, null);
    await vendors.save({ ...v, name: 'Sarah K' }, r1);
    await expect(vendors.save({ ...v, name: 'stale' }, r1)).rejects.toThrow(
      VendorConflictError,
    );
    expect((await vendors.list('wsp_pg_inv'))[0]!.name).toBe('Sarah K');
  });
});
