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
import { ensureP08Database } from '../treasury/pg.js';

const URL =
  process.env.SYNQ_ARC_FINANCE_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_arc_finance';
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
});
