import { afterAll, beforeAll } from 'vitest';
import type pg from 'pg';
import { dropSchemas, freshStore } from '../read-model/pg.js';
import { chainId } from '../read-model/fixtures.js';
import { ensureP08Database } from './pg.js';
import { treasuryScenarios } from './scenarios.js';

let pool: pg.Pool;
const created: string[] = [];
beforeAll(async () => {
  pool = await ensureP08Database();
});
afterAll(async () => {
  await dropSchemas(pool, created);
  await pool.end();
});

treasuryScenarios('postgres', () =>
  freshStore(pool, chainId, 'rm_ws4_p08', created),
);
