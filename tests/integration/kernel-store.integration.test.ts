import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DurableKernel } from '../../apps/api/src/kernel-runtime.js';
import {
  PostgresKernelStateStore,
  anchoredSink,
  verifyPersistedKernel,
} from '../../apps/api/src/kernel-store.js';
import { Kernel } from '../../packages/kernel/src/index.js';
import {
  AUDIT_KEY,
  allPlugins,
  authorizeWith,
  evidence,
  harness,
  intent,
} from '../kernel/fixtures.js';

const url =
  process.env.SYNQ_KERNEL_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_kernel_test';
let pool: pg.Pool;

beforeAll(async () => {
  const name = new URL(url).pathname.slice(1);
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
  pool = new pg.Pool({ connectionString: url, max: 4 });
});
afterAll(async () => {
  await pool?.end();
});

it('Postgres Kernel state store persists append-only audit records with the state and refuses tampering', async () => {
  const instance = `test:${randomBytes(6).toString('hex')}`;
  const store = new PostgresKernelStateStore(pool, instance);
  await store.migrate();
  await store.migrate();
  const data = evidence(intent());
  const h = harness(data);
  expect((await authorizeWith(h, data)).status).toBe('AUTHORIZED');
  const durable = new DurableKernel(h.kernel, store, AUDIT_KEY, 0);
  await durable.mutate(() => undefined);
  await durable.mutate(() => undefined);
  const persisted = (await store.load())!;
  expect(persisted.records.length).toBe(persisted.sequence);
  const restored = Kernel.restore(verifyPersistedKernel(persisted, AUDIT_KEY), {
    clock: h.clock,
    approvalLedger: h.ledger,
    membershipDirectory: h.directory,
    freshness: { probe: h.probe, maxLagBlocks: 0 },
    plugins: allPlugins(),
    auditKey: AUDIT_KEY,
    auditSink: anchoredSink(() => persisted.head),
  });
  expect(restored.auditLog()).toEqual(h.kernel.auditLog());

  await expect(
    pool.query(
      `UPDATE synq_kernel.audit_record SET record = record WHERE instance=$1`,
      [instance],
    ),
  ).rejects.toThrow('append-only');
  await expect(
    pool.query(`DELETE FROM synq_kernel.audit_record WHERE instance=$1`, [
      instance,
    ]),
  ).rejects.toThrow('append-only');

  await pool.query(
    `UPDATE synq_kernel.state SET state = jsonb_set(state, '{claimSequence}', '99') WHERE instance=$1`,
    [instance],
  );
  const tampered = (await store.load())!;
  expect(() => verifyPersistedKernel(tampered, AUDIT_KEY)).toThrow(
    'SNAPSHOT_INVALID',
  );

  const stale = new DurableKernel(h.kernel, store, AUDIT_KEY, 0);
  await expect(stale.mutate(() => undefined)).rejects.toThrow(
    'AUDIT_UNAVAILABLE',
  );
});
