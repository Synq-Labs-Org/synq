import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  DuffelClient,
  DuffelBookingExecutor,
  PostgresDuffelAttempts,
  type HttpFetch,
} from '@synq/plugin-duffel';
import { FakeDuffel } from './fake-duffel.js';
let pool: pg.Pool;
beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: 'postgresql://postgres@127.0.0.1:55433/postgres',
  });
  await admin.connect();
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname='synq_m2_duffel_test'",
  );
  if (!exists.rows.length)
    await admin.query('CREATE DATABASE synq_m2_duffel_test');
  await admin.end();
  pool = new pg.Pool({
    connectionString:
      'postgresql://postgres@127.0.0.1:55433/synq_m2_duffel_test',
    max: 4,
  });
  await new PostgresDuffelAttempts(pool).migrate(0);
});
afterAll(async () => {
  if (pool) {
    await new PostgresDuffelAttempts(pool).migrate(0);
    await pool.end();
  }
});

describe('durable Duffel attempts', () => {
  it('migrates up/down and has exactly one winner under concurrent claims', async () => {
    const a = new PostgresDuffelAttempts(pool);
    await a.migrate();
    await a.migrate(0);
    await a.migrate();
    const claims = await Promise.all(
      Array.from({ length: 40 }, () => a.claim('concurrent', 'fingerprint')),
    );
    expect(claims.filter((x) => x === 'NEW')).toHaveLength(1);
    expect(claims.filter((x) => x === 'EXISTING')).toHaveLength(39);
    const restarted = new PostgresDuffelAttempts(pool);
    expect(await restarted.claim('concurrent', 'fingerprint')).toBe('EXISTING');
    expect(await restarted.claim('concurrent', 'changed')).toBe('CONFLICT');
  });
  it('cold restart plus a lagging provider list cannot duplicate a committed order', async () => {
    const fake = new FakeDuffel();
    fake.faults.set('order', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const fetch: HttpFetch = (url, init) =>
      init.method === 'GET' && url.includes('/air/orders?')
        ? Promise.resolve({
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ data: [] }),
          })
        : fake.fetch(url, init);
    const client = new DuffelClient('duffel_test_fixture', fetch, {
      evidence: 'MOCKED',
    });
    const input = {
      offerId: 'off_fixture',
      passengerIds: ['pas_fixture'],
      passengers: [
        {
          givenName: 'Fixture',
          familyName: 'Traveler',
          bornOn: '1990-01-01',
          email: 'fixture@example.com',
          phone: '+442080160509',
        },
      ],
      amount: { amount: '31240', currency: 'GBP', decimals: 2 },
      amountDecimal: '312.40',
      idempotencyKey: 'cold-restart',
    };
    const first = new DuffelBookingExecutor(
      client,
      5,
      new PostgresDuffelAttempts(pool),
    );
    expect((await first.bookFlight(input)).status).toBe('UNKNOWN');
    const restarted = new DuffelBookingExecutor(
      client,
      5,
      new PostgresDuffelAttempts(pool),
    );
    expect((await restarted.bookFlight(input)).status).toBe('UNKNOWN');
    expect(fake.orders.size).toBe(1);
    expect(
      JSON.stringify(
        (await pool.query('SELECT * FROM synq_duffel_attempts')).rows,
      ),
    ).not.toContain('fixture@example.com');
  });
});
