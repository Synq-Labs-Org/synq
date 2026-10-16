import type { AuditRecord } from './audit.js';
import {
  ACTIVE_CASE_STATUSES,
  type RiskAlert,
  type RiskCase,
  type RiskCaseStore,
} from './cases.js';

type Sql = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

const ACTIVE_SQL = ACTIVE_CASE_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * Versioned, reversible migrations for risk cases, alerts and the audit
 * chain, tracked in their own table (`synq_risk_migrations`). `down` is for
 * development dry runs only.
 */
export const RISK_MIGRATIONS: readonly {
  version: number;
  up: string;
  down: string;
}[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_risk_alerts (
      workspace_id text NOT NULL,
      alert_key text NOT NULL,
      subject_ref text NOT NULL,
      claimed_at bigint NOT NULL,
      PRIMARY KEY (workspace_id, alert_key));
    CREATE TABLE IF NOT EXISTS synq_risk_cases (
      case_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      subject_ref text NOT NULL,
      status text NOT NULL,
      rev int NOT NULL,
      data jsonb NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS synq_risk_one_active_case
      ON synq_risk_cases (workspace_id, subject_ref) WHERE status IN (${ACTIVE_SQL});
    CREATE TABLE IF NOT EXISTS synq_risk_audit (
      workspace_id text NOT NULL,
      seq int NOT NULL,
      prev_hash text NOT NULL,
      hash text NOT NULL UNIQUE,
      data jsonb NOT NULL,
      PRIMARY KEY (workspace_id, seq));`,
    down: `DROP TABLE IF EXISTS synq_risk_audit; DROP TABLE IF EXISTS synq_risk_cases; DROP TABLE IF EXISTS synq_risk_alerts;`,
  },
];

export async function migrateRisk(
  sql: Sql,
  target = RISK_MIGRATIONS.at(-1)!.version,
): Promise<number> {
  await sql.query(
    'CREATE TABLE IF NOT EXISTS synq_risk_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const r = await sql.query(
    'SELECT coalesce(max(version), 0) AS v FROM synq_risk_migrations',
  );
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of RISK_MIGRATIONS)
    if (m.version > current && m.version <= target) {
      await sql.query(m.up);
      await sql.query(
        'INSERT INTO synq_risk_migrations (version) VALUES ($1)',
        [m.version],
      );
      current = m.version;
    }
  for (const m of [...RISK_MIGRATIONS].reverse())
    if (m.version <= current && m.version > target) {
      await sql.query(m.down);
      await sql.query('DELETE FROM synq_risk_migrations WHERE version=$1', [
        m.version,
      ]);
      current = m.version - 1;
    }
  return current;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'bigint' ? String(x) : x,
  );
const parse = <T>(raw: unknown): T =>
  (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
const uniqueViolation = (e: unknown) =>
  (e as { code?: string } | null)?.code === '23505';

export class PostgresRiskCaseStore implements RiskCaseStore {
  constructor(readonly sql: Sql) {}
  async migrate() {
    await migrateRisk(this.sql);
  }
  async claimAlert(a: RiskAlert) {
    const r = await this.sql.query(
      `INSERT INTO synq_risk_alerts (workspace_id, alert_key, subject_ref, claimed_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING alert_key`,
      [a.workspaceId, a.alertKey, a.subjectRef, a.at],
    );
    return r.rows.length === 1;
  }
  async activeCase(ws: string, subject: string) {
    const r = await this.sql.query(
      `SELECT data FROM synq_risk_cases WHERE workspace_id=$1 AND subject_ref=$2 AND status IN (${ACTIVE_SQL})`,
      [ws, subject],
    );
    return r.rows[0] ? parse<RiskCase>(r.rows[0].data) : null;
  }
  async getCase(id: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_risk_cases WHERE case_id=$1',
      [id],
    );
    return r.rows[0] ? parse<RiskCase>(r.rows[0].data) : null;
  }
  async insertCase(c: RiskCase) {
    // The partial unique index admits one active case per subject.
    const r = await this.sql.query(
      `INSERT INTO synq_risk_cases (case_id, workspace_id, subject_ref, status, rev, data)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING case_id`,
      [c.caseId, c.workspaceId, c.subjectRef, c.status, c.rev, json(c)],
    );
    return r.rows.length === 1;
  }
  async saveCase(c: RiskCase, expectedRev: number) {
    try {
      const r = await this.sql.query(
        `UPDATE synq_risk_cases SET status=$2, rev=$3, data=$4
         WHERE case_id=$1 AND rev=$5 RETURNING case_id`,
        [c.caseId, c.status, c.rev, json(c), expectedRev],
      );
      return r.rows.length === 1;
    } catch (e) {
      if (uniqueViolation(e)) return false;
      throw e;
    }
  }
  async auditHead(ws: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_risk_audit WHERE workspace_id=$1 ORDER BY seq DESC LIMIT 1',
      [ws],
    );
    return r.rows[0] ? parse<AuditRecord>(r.rows[0].data) : null;
  }
  async appendAudit(rec: AuditRecord) {
    // One statement: the record lands only as the direct successor of the
    // current head (same seq and prev hash), so a race loses cleanly.
    const r = await this.sql.query(
      `WITH head AS (
         SELECT coalesce(max(seq), 0) AS seq,
                coalesce((SELECT hash FROM synq_risk_audit WHERE workspace_id=$1 ORDER BY seq DESC LIMIT 1), $6) AS hash
           FROM synq_risk_audit WHERE workspace_id=$1)
       INSERT INTO synq_risk_audit (workspace_id, seq, prev_hash, hash, data)
       SELECT $1, $2, $3, $4, $5 FROM head WHERE head.seq + 1 = $2 AND head.hash = $3
       ON CONFLICT DO NOTHING RETURNING seq`,
      [
        rec.workspaceId,
        rec.seq,
        rec.prevHash,
        rec.hash,
        json(rec),
        `0x${'00'.repeat(32)}`,
      ],
    );
    return r.rows.length === 1;
  }
  async audit(ws: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_risk_audit WHERE workspace_id=$1 ORDER BY seq',
      [ws],
    );
    return r.rows.map((x) => parse<AuditRecord>(x.data));
  }
}
