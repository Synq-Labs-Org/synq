import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { RiskCaseService, type RiskAlert } from '@synq/plugin-risk';
import {
  PostgresRiskCaseStore,
  RISK_MIGRATIONS,
  migrateRisk,
} from '@synq/plugin-risk/postgres';

/**
 * Risk cases, alerts and the audit chain on real Postgres (P20-04, P20-06).
 * Database: SYNQ_RISK_TEST_DATABASE_URL or the local throwaway server
 * (synq_m2_risk). Migrations live in their own table, synq_risk_migrations.
 */
const URL =
  process.env.SYNQ_RISK_TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:55433/synq_m2_risk';
let pool: pg.Pool;

beforeAll(async () => {
  const name = new globalThis.URL(URL).pathname.slice(1);
  if (!/^synq_m2_risk[a-z0-9_]*$/.test(name))
    throw new Error('risk test database must be named synq_m2_risk*');
  const admin = new pg.Client({
    connectionString: URL.replace(/\/[^/]+$/, '/postgres'),
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
  pool = new pg.Pool({ connectionString: URL, max: 6 });
  await migrateRisk(pool, 0);
});
afterAll(async () => {
  await migrateRisk(pool, 0);
  await pool.query('DROP TABLE IF EXISTS synq_risk_migrations');
  await pool.end();
});

const alert = (key: string, ws = 'w1'): RiskAlert => ({
  workspaceId: ws,
  alertKey: key,
  subjectRef: 'payout:sarah:0xee',
  counterparty: `0x${'ee'.repeat(20)}`,
  flags: [{ code: 'DESTINATION_CHANGED', severity: 'HARD', detail: 'x' }],
  raisedBy: 'RISK',
  at: 1_792_152_000,
});

describe('Postgres risk store', () => {
  it('migrates up, down and up again in its own table', async () => {
    expect(await migrateRisk(pool)).toBe(RISK_MIGRATIONS.at(-1)!.version);
    expect(await migrateRisk(pool, 0)).toBe(0);
    const t = await pool.query(
      "SELECT to_regclass('synq_risk_cases') AS c, to_regclass('synq_risk_migrations') AS m",
    );
    expect(t.rows[0]).toMatchObject({ c: null, m: 'synq_risk_migrations' });
    expect(await migrateRisk(pool)).toBe(RISK_MIGRATIONS.at(-1)!.version);
  });

  it('P20-04: concurrent replays of one alert freeze exactly once', async () => {
    const svc = new RiskCaseService(
      new PostgresRiskCaseStore(pool),
      () => 1_792_152_000,
    );
    const out = await Promise.all(
      Array.from({ length: 6 }, () => svc.raise(alert('a1'))),
    );
    expect(out.filter((r) => r.froze)).toHaveLength(1);
    expect(out.filter((r) => r.status === 'DUPLICATE_ALERT')).toHaveLength(5);
    // Distinct alerts racing on one subject: one case, one freeze.
    const race = await Promise.all(
      ['b1', 'b2', 'b3', 'b4'].map((k) => svc.raise(alert(k, 'w2'))),
    );
    expect(race.filter((r) => r.froze)).toHaveLength(1);
    const ids = new Set(race.map((r) => r.case?.caseId));
    expect(ids.size).toBe(1);
    const active = await pool.query(
      "SELECT count(*)::int AS n FROM synq_risk_cases WHERE workspace_id='w2'",
    );
    expect(active.rows[0]!.n).toBe(1);
  });

  it('P20-06: the audit chain survives concurrent appends and detects tampering at rest', async () => {
    const svc = new RiskCaseService(new PostgresRiskCaseStore(pool), () => 1);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        svc.record('w3', 'AUDIT', 'EVENT', { i, passport: 'X1234567' }),
      ),
    );
    const check = await svc.verifyTrail('w3');
    expect(check).toMatchObject({ ok: true, records: 8 });
    const stored = await pool.query(
      "SELECT data FROM synq_risk_audit WHERE workspace_id='w3'",
    );
    expect(JSON.stringify(stored.rows)).not.toContain('X1234567');
    await pool.query(
      `UPDATE synq_risk_audit SET data = jsonb_set(data, '{payload,i}', '42') WHERE workspace_id='w3' AND seq=4`,
    );
    expect(await svc.verifyTrail('w3')).toEqual({
      ok: false,
      seq: 4,
      reason: 'HASH_MISMATCH',
    });
  });

  it('P20-05: review state persists and a hard-policy release is refused', async () => {
    const store = new PostgresRiskCaseStore(pool);
    const svc = new RiskCaseService(store, () => 1_792_152_100);
    const c = (await svc.raise(alert('c1', 'w4'))).case!;
    const r = await svc.review(
      c.caseId,
      { principalId: 'u', kind: 'HUMAN', role: 'OWNER', proof: 'sig' },
      'RELEASE',
      'trust me',
    );
    expect(r.refused).toEqual(['DESTINATION_CHANGED']);
    expect((await store.getCase(c.caseId))!.status).toBe('IN_REVIEW');
    expect(await svc.holdFlags('w4', 'payout:sarah:0xee')).toHaveLength(1);
  });
  it('CR-08: a failed insert rolls back its alert claim on Postgres', async () => {
    const svc = new RiskCaseService(new PostgresRiskCaseStore(pool), () => 1);
    await pool.query(
      "CREATE FUNCTION synq_risk_reject_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'case insert rejected'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER reject_case BEFORE INSERT ON synq_risk_cases FOR EACH ROW EXECUTE FUNCTION synq_risk_reject_test()',
    );
    try {
      await expect(svc.raise(alert('rollback', 'rollback'))).rejects.toThrow(
        'case insert rejected',
      );
    } finally {
      await pool.query('DROP TRIGGER reject_case ON synq_risk_cases');
      await pool.query('DROP FUNCTION synq_risk_reject_test()');
    }
    expect((await svc.raise(alert('rollback', 'rollback'))).froze).toBe(true);
  });

  it('CR-13: NUL and lone surrogates are sanitized before jsonb audit storage', async () => {
    const svc = new RiskCaseService(new PostgresRiskCaseStore(pool), () => 1);
    await svc.record('unicode', 'RISK', 'EVENT', { note: 'a\u0000b\ud800' });
    expect((await svc.store.audit('unicode'))[0]!.payload).toEqual({
      note: 'ab�',
    });
  });
});
