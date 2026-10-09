import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { PostgresProjectionStore } from '../../packages/read-model/src/storage.js';

export const databaseUrl =
  process.env.SYNQ_RM_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_test';
export const redisUrl =
  process.env.SYNQ_RM_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/7';

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}
export const uniqueSchema = (prefix: string) =>
  `${prefix}_${randomBytes(4).toString('hex')}`;

export async function freshStore(
  pool: pg.Pool,
  chainId: number,
  prefix = 'rm_ws4_test',
  created?: string[],
): Promise<PostgresProjectionStore> {
  const schema = uniqueSchema(prefix);
  created?.push(schema);
  const store = new PostgresProjectionStore({ pool }, chainId, schema);
  await store.migrate();
  return store;
}

export async function dropSchemas(pool: pg.Pool, schemas: string[]) {
  for (const s of schemas)
    if (/^rm_ws4_[a-z0-9_]+$/.test(s))
      await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
}
