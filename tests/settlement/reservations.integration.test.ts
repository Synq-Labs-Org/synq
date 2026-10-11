import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  PostgresEconomicGrantLedger,
  PostgresRecourseStore,
  PostgresReservationStore,
} from '@synq/settlement';
import { EconomicGrantAuthority } from '@synq/kernel';
import { recourseScenarios } from './recourse-scenarios.js';
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

recourseScenarios('postgres', async () => {
  const reservations = await fresh();
  const schema = schemas.at(-1)!;
  const store = new PostgresRecourseStore(pool, schema);
  await store.migrate();
  return { store, reservations };
});

describe('durable Kernel grant ledger (Postgres)', () => {
  const unit = { currency: 'USD', decimals: 2 };
  const ASSET = AUSD;
  const mandate = {
    mandateId: 'web2',
    groupId: 'group-1',
    version: 1,
    status: 'ACTIVE' as const,
    domains: ['STAY' as const],
    providers: ['duffel-stays'],
    hosts: ['api.duffel.com'],
    perActionCap: { ...unit, amount: '50000' },
    cumulativeBudget: { ...unit, amount: '60000' },
    autoApproveMax: { ...unit, amount: '100000' },
    quorum: 1,
    members: ['alice'],
    maxQuoteAgeSeconds: 600,
    grantTtlSeconds: 600,
    environment: 'SANDBOX' as const,
    validUntil: T0 + 86_400,
  };
  const exec = (reservationId: string, amount = '30000') => ({
    domain: 'STAY' as const,
    providerId: 'duffel-stays',
    host: 'api.duffel.com',
    offerId: 'o',
    subjectHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
    quantity: 1,
    maxAmount: { ...unit, amount },
    reservationId,
    reservedAssetId: ASSET,
    reservedAmount: '100',
    settlementPlanHash: '0xp',
    recipientRef: null,
    payAsset: null,
  });
  async function world() {
    const reservations = await fresh();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: ASSET,
      confirmed: 10_000n,
      asOf: T0,
    });
    for (const id of ['g1', 'g2', 'g3'])
      await reservations.reserve(
        req({
          reservationId: `${id}-${schemas.length}`,
          amount: '100',
          settlementPlanHash: '0xp',
          expiresAt: T0 + 3_600,
        }),
        T0,
      );
    const ledger = new PostgresEconomicGrantLedger(pool, schemas.at(-1)!);
    await ledger.migrate();
    const key = new Uint8Array(32).fill(1);
    return { reservations, ledger, key, n: schemas.length };
  }
  it('survives restart: spent and consumption persist and mandate versions cannot be reinstalled', async () => {
    const w = await world();
    const a = new EconomicGrantAuthority({
      key: w.key,
      reservations: w.reservations,
      ledger: w.ledger,
    });
    await a.install(mandate);
    const r = {
      intentId: 'i1',
      groupId: 'group-1',
      mandateId: 'web2',
      execution: exec(`g1-${w.n}`),
      quoteExpiresAt: T0 + 600,
      revalidatedAt: T0,
    };
    const d = await a.authorize(r, [], T0);
    if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
    await a.consume(d.grant, exec(`g1-${w.n}`), T0);
    const restarted = new EconomicGrantAuthority({
      key: w.key,
      reservations: w.reservations,
      ledger: new PostgresEconomicGrantLedger(pool, schemas.at(-1)!),
    });
    await expect(restarted.install(mandate)).rejects.toThrow(
      /MANDATE_VERSION_NOT_NEWER/,
    );
    expect(await restarted.spentFor('web2')).toBe(30_000n);
    await expect(
      restarted.consume(d.grant, exec(`g1-${w.n}`), T0),
    ).rejects.toThrow(/GRANT_CONSUMED/);
    expect(await restarted.authorize(r, [], T0)).toMatchObject({
      code: 'INTENT_ALREADY_EXECUTED',
    });
    const r2 = { ...r, intentId: 'i2', execution: exec(`g2-${w.n}`) };
    expect((await restarted.authorize(r2, [], T0)).status).toBe('AUTHORIZED');
    const r3 = { ...r, intentId: 'i3', execution: exec(`g3-${w.n}`, '1') };
    expect(await restarted.authorize(r3, [], T0)).toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
  });
  it('concurrent consumes of one grant succeed exactly once', async () => {
    const w = await world();
    const a = new EconomicGrantAuthority({
      key: w.key,
      reservations: w.reservations,
      ledger: w.ledger,
    });
    await a.install(mandate);
    const d = await a.authorize(
      {
        intentId: 'c1',
        groupId: 'group-1',
        mandateId: 'web2',
        execution: exec(`g1-${w.n}`),
        quoteExpiresAt: T0 + 600,
        revalidatedAt: T0,
      },
      [],
      T0,
    );
    if (d.status !== 'AUTHORIZED') throw new Error(d.status);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        a.consume(d.grant, exec(`g1-${w.n}`), T0),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
