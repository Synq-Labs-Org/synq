import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { durablePool } from '../durable/pg.js';

export async function workspacePool(url: string) {
  const bootstrap = await durablePool(url);
  const schema = `ws_${randomUUID().replaceAll('-', '')}`;
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await bootstrap.end();
  }
  return new pg.Pool({
    connectionString: url,
    max: 8,
    options: `-c search_path=${schema}`,
  });
}
