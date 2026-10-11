import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PostgresReservationStore } from '@synq/settlement';
import { ensureP08Database } from '../treasury/pg.js';
import {
  AUSD,
  T0,
  req,
  reservationScenarios,
} from './reservation-scenarios.js';

let pool: pg.Pool;
const schemas: string[] = [];
let n = 0;
beforeAll(async () => {
  pool = await ensureP08Database(
    process.env.SYNQ_P11_TEST_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_p11',
  );
});
afterAll(async () => {
  for (const s of schemas)
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
});
async function fresh() {
  const schema = `p11_res_${process.pid}_${++n}`;
  schemas.push(schema);
  const store = new PostgresReservationStore(pool, schema);
  await store.migrate();
  return store;
}

reservationScenarios('postgres', fresh);

describe('postgres reservation invariant under load', () => {
  it('SET-006 forty concurrent random reservations never exceed the confirmed balance', async () => {
    const s = await fresh();
    await s.setConfirmedBalance({
      groupId: 'group-1',
      assetId: AUSD,
      confirmed: 10_000n,
      asOf: T0,
    });
    const amounts = Array.from({ length: 40 }, (_, i) =>
      String(((i * 7919) % 900) + 100),
    );
    const results = await Promise.allSettled(
      amounts.map((amount) => s.reserve(req({ amount }), T0)),
    );
    const reserved = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<Awaited<ReturnType<typeof s.reserve>>> =>
          r.status === 'fulfilled',
      )
      .reduce((sum, r) => sum + BigInt(r.value.amount), 0n);
    const free = await s.free('group-1', AUSD);
    expect(reserved).toBeLessThanOrEqual(10_000n);
    expect(BigInt(free.held)).toBe(reserved);
    expect(BigInt(free.free)).toBe(10_000n - reserved);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
  });
});
