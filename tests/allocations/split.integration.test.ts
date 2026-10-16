import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ALLOCATION_MIGRATIONS,
  PostgresSplitStore,
  migrateAllocations,
} from '@synq/allocations';
import { splitScenarios } from './split-scenarios.js';

const URL =
  process.env.SYNQ_ALLOCATIONS_TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:55433/synq_m2_allocations_test';
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
