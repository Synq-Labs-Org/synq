import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  PostgresOutboxStore,
  PostgresGrantFence,
} from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import {
  ALLOCATION_MIGRATIONS,
  PostgresSplitStore,
  treasuryScope,
  migrateAllocations,
} from '@synq/allocations';
import { splitScenarios } from './split-scenarios.js';
import { criticScenarios } from './critic-scenarios.js';
import { policy1500, world } from './harness.js';
import { testDatabaseUrl } from '../durable/pg.js';

const URL = testDatabaseUrl(
  'SYNQ_ALLOCATIONS_TEST_DATABASE_URL',
  'synq_m2_allocations_test',
);
let pool: pg.Pool;

async function ensureDatabase(url: string) {
  const name = new globalThis.URL(url).pathname.slice(1);
  if (!/^synq_m2_allocations[a-z0-9_]*$/.test(name))
    throw new Error(
      'allocations test database must be named synq_m2_allocations*',
    );
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return new pg.Pool({ connectionString: url, max: 4 });
}

beforeAll(async () => {
  pool = await ensureDatabase(URL);
  await migrateAllocations(pool, 0);
});
afterAll(async () => {
  await migrateAllocations(pool, 0);
  await pool.query('DROP TABLE IF EXISTS synq_allocations_migrations');
  await pool.end();
});

describe('allocation migrations', () => {
  it('migrate forward and back to zero and forward again', async () => {
    const top = ALLOCATION_MIGRATIONS.at(-1)!.version;
    expect(await migrateAllocations(pool)).toBe(top);
    expect(await migrateAllocations(pool, 0)).toBe(0);
    const t = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE left(table_name, 11) = 'synq_alloc_'",
    );
    expect(t.rows[0].n).toBe(0);
    expect(await migrateAllocations(pool)).toBe(top);
  });

  it('upgrading existing holds preserves their treasury scope instead of hiding reserved cash', async () => {
    await migrateAllocations(pool, 1);
    const p = policy1500();
    await pool.query(
      `INSERT INTO synq_alloc_splits VALUES ('s_upgrade','w','r_upgrade','p','RESERVATIONS_CREATED',1,0,0,$1)`,
      [
        JSON.stringify({
          receipt: {
            chainId: p.chainId,
            token: p.token,
            recipient: p.treasury,
          },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO synq_alloc_legs VALUES ('l_upgrade','s_upgrade',0,'p','TRANSFER','RESERVED','payable:upgrade',NULL,$1)`,
      [JSON.stringify({ obligationRef: 'payable:upgrade' })],
    );
    await pool.query(
      `INSERT INTO synq_alloc_reservations VALUES ('l_upgrade','w','s_upgrade','CONTRACTOR_PAYABLE',100,'ACTIVE',false,0,0)`,
    );
    await migrateAllocations(pool);
    const rows = await new PostgresSplitStore(pool).reservations(
      treasuryScope(p),
    );
    expect(rows.find((r) => r.reservationId === 'l_upgrade')).toMatchObject({
      amount: 100n,
      holdKey: 'payable:upgrade',
      status: 'ACTIVE',
    });
    await migrateAllocations(pool, 0);
    await migrateAllocations(pool);
  });

  it('a reservation can never be marked remitted', async () => {
    await migrateAllocations(pool);
    await expect(
      pool
        .query(
          "INSERT INTO synq_alloc_splits VALUES ('s_x','w','r_x','p','RECEIPT_FINAL',1,0,0,'{}')",
        )
        .then(() =>
          pool.query(
            "INSERT INTO synq_alloc_reservations VALUES ('r1','w','s_x','TAX_ESTIMATE',1,'ACTIVE',true,0,0)",
          ),
        ),
    ).rejects.toThrow(/check constraint/);
    await pool.query("DELETE FROM synq_alloc_splits WHERE split_id='s_x'");
  });
});

splitScenarios('postgres', async () => {
  await migrateAllocations(pool, 0);
  const store = new PostgresSplitStore(pool);
  await store.migrate();
  return store;
});

criticScenarios('postgres', async () => {
  await migrateAllocations(pool, 0);
  const store = new PostgresSplitStore(pool);
  await store.migrate();
  return store;
});

describe('integrated durable split execution', () => {
  it('records signed vault bytes and grant consumption together, then recovers after a crash', async () => {
    await migrateAllocations(pool, 0);
    await migrateAllocations(pool);
    await migrateExecution(pool, 0);
    await migrateExecution(pool);
    const outbox = new PostgresOutboxStore(pool);
    const w = await world({ store: new PostgresSplitStore(pool), outbox });
    const split = (await w.runner.trigger(w.receipt)).split;
    const legKey = `${w.receipt.receiptId}#1`;
    w.crash.at = legKey;
    expect((await w.runner.run(split.splitId)).state).toBe('FAILED');
    const leg = (await w.store.legs(split.splitId)).find(
      (l) => l.legKey === legKey,
    )!;
    const record = await outbox.get(leg.legKey);
    expect(record?.state).toBe('SIGNED');
    expect(
      await new PostgresGrantFence(pool).consumed(leg.grant!.grantId),
    ).not.toBeNull();
    expect((await w.makeRunner().run(split.splitId)).state).toBe('COMPLETED');
    expect(w.fake.paid).toHaveLength(2);
    expect(w.signer.total).toBe(2);
  });
});
