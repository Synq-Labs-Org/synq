import pg from 'pg';

/**
 * Test database URL: the named env var, else `SYNQ_TEST_PG_BASE` (for example
 * postgresql://postgres@127.0.0.1:55433 locally), else the CI compose Postgres.
 */
export function testDatabaseUrl(
  envVar: string | null,
  database: string,
): string {
  const base =
    process.env.SYNQ_TEST_PG_BASE ??
    'postgresql://postgres:synq_local@127.0.0.1:55432';
  return (
    (envVar ? process.env[envVar] : undefined) ??
    `${base.replace(/\/+$/, '')}/${database}`
  );
}

export const DURABLE_DATABASE_URL = testDatabaseUrl(
  'SYNQ_DURABLE_TEST_DATABASE_URL',
  'synq_m2_durable',
);

export async function durablePool(url = DURABLE_DATABASE_URL, max = 8) {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_m2_[a-z0-9_]+$/.test(name))
    throw new Error('durable-state test database must be named synq_m2_*');
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
  return new pg.Pool({ connectionString: url, max });
}

/** A unique suffix per test run, so reruns never collide with old rows. */
export const runId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
