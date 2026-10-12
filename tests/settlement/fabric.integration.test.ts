import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  PostgresReservationStore,
  PostgresSettlementFabricStore,
  ReservationError,
  type ReservationRequest,
} from '@synq/settlement';
import { ensureP08Database } from '../treasury/pg.js';
import { AUSD, T0, fabricScenarios } from './fabric-scenarios.js';

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
  const schema = `v13_fab_${process.pid}_${++n}`;
  schemas.push(schema);
  const reservations = new PostgresReservationStore(pool, schema);
  await reservations.migrate();
  const store = new PostgresSettlementFabricStore(pool, schema);
  await store.migrate();
  return { store, reservations, schema };
}

fabricScenarios('postgres', fresh);

describe('postgres fabric invariants', () => {
  it('FAB-PG-001 database CHECKs refuse a sandbox merchant settlement and an unbacked confirmed refund', async () => {
    const { schema } = await fresh();
    await expect(
      pool.query(
        `INSERT INTO "${schema}".synq_settle_orders (provider_order_id, provider_id, idempotency_key, intent_id, mode, state, data)
         VALUES ('po1','lithic','k1','i1','PROVIDER_SANDBOX','MERCHANT_SETTLED','{}')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.query(
        `INSERT INTO "${schema}".synq_settle_refunds (refund_id, provider_order_id, ledger, mode, onchain, treasury_credit, data)
         VALUES ('r1','po1','PROVIDER_REPORTED_REFUND','PROVIDER_SANDBOX',false,true,'{}')`,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.query(
        `INSERT INTO "${schema}".synq_settle_refunds (refund_id, provider_order_id, ledger, mode, onchain, treasury_credit, data)
         VALUES ('r2','po1','CONFIRMED_REFUND','PROVIDER_SANDBOX',true,true,'{}')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('FAB-PG-002 concurrent gift, DCA, hotel and card reservations with interleaved execution never exceed the authorized balance', async () => {
    const { reservations } = await fresh();
    const confirmed = 50_000_000n;
    const mandatory = 5_000_000n;
    await reservations.setConfirmedBalance({
      groupId: 'g1',
      assetId: AUSD,
      confirmed,
      mandatoryReserve: mandatory,
      asOf: T0,
    });
    const purposes = ['GIFT_CARD', 'DCA', 'STAY', 'CARD'] as const;
    const reqs: ReservationRequest[] = Array.from({ length: 48 }, (_, i) => ({
      reservationId: `mix-${process.pid}-${i}`,
      groupId: 'g1',
      assetId: AUSD,
      amount: String(((i * 7_919) % 3_000_000) + 1_000_000),
      intentId: `mix-intent-${i}`,
      purpose: purposes[i % 4]!,
      settlementPlanHash: `plan-${i}`,
      expiresAt: T0 + 600,
    }));
    const outcomes = await Promise.allSettled(
      reqs.map(async (r, i) => {
        const res = await reservations.reserve(r, T0);
        // Interleave the lifecycle: some execute and capture, some release.
        if (i % 3 === 0) {
          await reservations.beginExecution(
            r.reservationId,
            { groupId: 'g1', settlementPlanHash: r.settlementPlanHash! },
            T0 + 1,
          );
          await reservations.capture(
            r.reservationId,
            BigInt(r.amount) / 2n,
            T0 + 2,
          );
        } else if (i % 3 === 1) {
          await reservations.release(r.reservationId, 'cancelled', T0 + 1);
        }
        return res;
      }),
    );
    for (const o of outcomes)
      if (o.status === 'rejected')
        expect((o.reason as ReservationError).code).toBe(
          'INSUFFICIENT_FREE_BALANCE',
        );
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    const free = await reservations.free('g1', AUSD);
    expect(BigInt(free.held) + mandatory).toBeLessThanOrEqual(confirmed);
    // A last reservation must see exactly the remaining free balance.
    const remaining = BigInt(free.free);
    if (remaining > 0n)
      await expect(
        reservations.reserve(
          {
            ...reqs[0]!,
            reservationId: `mix-${process.pid}-last`,
            intentId: 'last',
            amount: String(remaining + 1n),
          },
          T0 + 3,
        ),
      ).rejects.toThrow(/INSUFFICIENT_FREE_BALANCE/);
  });
});
