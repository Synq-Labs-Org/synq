import type { Hex } from 'viem';
import {
  applyMigrations,
  withTransaction,
  type Migration,
  type SqlPool,
} from '@synq/domain/pg';
import { deepFreeze } from './common.js';
import type {
  AcceptedChallenge,
  CouncilDecision,
  CouncilStore,
  TermRecord,
} from './council.js';
import {
  GENESIS_HASH,
  type DelegationLogEntry,
  type DelegationLogHead,
  type DelegationLogStore,
} from './delegation-log.js';

/**
 * Postgres stores for council terms and decisions and for the delegation
 * log. Own migrations table: `synq_governance_migrations`.
 *
 * - A decision executes once: `synq_council_executions` is unique on the
 *   digest AND on (council, nonce), and the insert is one statement.
 * - The term log advances by compare-and-set on `synq_council_heads`, inside
 *   one transaction with the retirement of the previous term.
 * - Delegation events are append-only (trigger) and chained; the head row is
 *   updated in the same transaction as each append.
 */
export const GOVERNANCE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_council_heads (
      council_id text PRIMARY KEY,
      latest_term_id bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS synq_council_terms (
      council_id text NOT NULL REFERENCES synq_council_heads(council_id),
      term_id bigint NOT NULL,
      hash text NOT NULL,
      term jsonb NOT NULL,
      effective_end bigint NOT NULL,
      PRIMARY KEY (council_id, term_id));
    CREATE TABLE IF NOT EXISTS synq_council_decisions (
      digest text PRIMARY KEY,
      council_id text NOT NULL,
      nonce text NOT NULL,
      decision jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS synq_council_challenges (
      id bigserial PRIMARY KEY,
      digest text NOT NULL REFERENCES synq_council_decisions(digest),
      challenge jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS synq_council_challenges_digest ON synq_council_challenges (digest);
    CREATE TABLE IF NOT EXISTS synq_council_executions (
      digest text PRIMARY KEY REFERENCES synq_council_decisions(digest),
      council_id text NOT NULL,
      nonce text NOT NULL,
      executed_at bigint NOT NULL,
      UNIQUE (council_id, nonce));
    CREATE OR REPLACE FUNCTION synq_governance_append_only() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS synq_council_executions_keep ON synq_council_executions;
    CREATE TRIGGER synq_council_executions_keep BEFORE DELETE OR UPDATE ON synq_council_executions
      FOR EACH ROW EXECUTE FUNCTION synq_governance_append_only();
    DROP TRIGGER IF EXISTS synq_council_decisions_keep ON synq_council_decisions;
    CREATE TRIGGER synq_council_decisions_keep BEFORE DELETE OR UPDATE ON synq_council_decisions
      FOR EACH ROW EXECUTE FUNCTION synq_governance_append_only();`,
    down: `DROP TABLE IF EXISTS synq_council_executions;
    DROP TABLE IF EXISTS synq_council_challenges;
    DROP TABLE IF EXISTS synq_council_decisions;
    DROP TABLE IF EXISTS synq_council_terms;
    DROP TABLE IF EXISTS synq_council_heads;
    DROP FUNCTION IF EXISTS synq_governance_append_only();`,
  },
  {
    version: 2,
    up: `CREATE TABLE IF NOT EXISTS synq_delegation_log (
      workspace_id text NOT NULL,
      chain_id int NOT NULL,
      seq bigint NOT NULL CHECK (seq >= 1),
      kind text NOT NULL CHECK (kind IN ('REGISTER','REVOKE')),
      delegation_id text NOT NULL,
      entry jsonb NOT NULL,
      prev_hash text NOT NULL,
      hash text NOT NULL UNIQUE,
      PRIMARY KEY (workspace_id, chain_id, seq));
    CREATE UNIQUE INDEX IF NOT EXISTS synq_delegation_log_one_revocation
      ON synq_delegation_log (workspace_id, chain_id, delegation_id, kind);
    CREATE TABLE IF NOT EXISTS synq_delegation_heads (
      workspace_id text NOT NULL,
      chain_id int NOT NULL,
      seq bigint NOT NULL,
      hash text NOT NULL,
      PRIMARY KEY (workspace_id, chain_id));
    DROP TRIGGER IF EXISTS synq_delegation_log_keep ON synq_delegation_log;
    CREATE TRIGGER synq_delegation_log_keep BEFORE DELETE OR UPDATE ON synq_delegation_log
      FOR EACH ROW EXECUTE FUNCTION synq_governance_append_only();`,
    down: `DROP TABLE IF EXISTS synq_delegation_heads; DROP TABLE IF EXISTS synq_delegation_log;`,
  },
];

export const migrateGovernance = (pool: SqlPool, target?: number) =>
  applyMigrations(
    pool,
    'synq_governance_migrations',
    GOVERNANCE_MIGRATIONS,
    target,
  );

const json = (raw: unknown) =>
  deepFreeze(typeof raw === 'string' ? JSON.parse(raw) : raw);

export class PostgresCouncilStore implements CouncilStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateGovernance(this.pool);
  }

  async bootstrapTerm(record: TermRecord) {
    return withTransaction(this.pool, async (c) => {
      const head = await c.query(
        `INSERT INTO synq_council_heads (council_id, latest_term_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING RETURNING council_id`,
        [record.term.councilId, record.term.termId],
      );
      if (!head.rows.length) return false;
      await c.query(
        `INSERT INTO synq_council_terms (council_id, term_id, hash, term, effective_end)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          record.term.councilId,
          record.term.termId,
          record.hash,
          JSON.stringify(record.term),
          record.effectiveEnd,
        ],
      );
      return true;
    });
  }

  async terms(councilId: string) {
    const r = await this.pool.query(
      `SELECT term, hash, effective_end FROM synq_council_terms
       WHERE council_id=$1 ORDER BY term_id`,
      [councilId],
    );
    return r.rows.map(
      (x): TermRecord =>
        deepFreeze({
          term: json(x.term),
          hash: x.hash as Hex,
          effectiveEnd: Number(x.effective_end),
        }),
    );
  }

  async advanceTerm(
    councilId: string,
    fromTermId: number,
    retireAt: number,
    next: TermRecord,
  ) {
    return withTransaction(this.pool, async (c) => {
      // Compare-and-set on the head: only one writer moves it off fromTermId.
      const cas = await c.query(
        `UPDATE synq_council_heads SET latest_term_id=$3
         WHERE council_id=$1 AND latest_term_id=$2 RETURNING council_id`,
        [councilId, fromTermId, next.term.termId],
      );
      if (!cas.rows.length) return false;
      await c.query(
        `UPDATE synq_council_terms SET effective_end = LEAST(effective_end, $3)
         WHERE council_id=$1 AND term_id=$2`,
        [councilId, fromTermId, retireAt],
      );
      await c.query(
        `INSERT INTO synq_council_terms (council_id, term_id, hash, term, effective_end)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          councilId,
          next.term.termId,
          next.hash,
          JSON.stringify(next.term),
          next.effectiveEnd,
        ],
      );
      return true;
    });
  }

  async insertDecision(decision: CouncilDecision) {
    const r = await this.pool.query(
      `INSERT INTO synq_council_decisions (digest, council_id, nonce, decision)
       VALUES ($1,$2,$3,$4) ON CONFLICT (digest) DO NOTHING RETURNING digest`,
      [
        decision.digest.toLowerCase(),
        decision.action.councilId,
        decision.action.nonce.toLowerCase(),
        JSON.stringify(decision),
      ],
    );
    return r.rows.length > 0;
  }

  async getDecision(digest: Hex) {
    const r = await this.pool.query(
      'SELECT decision FROM synq_council_decisions WHERE digest=$1',
      [digest.toLowerCase()],
    );
    return r.rows[0] ? (json(r.rows[0].decision) as CouncilDecision) : null;
  }

  async insertChallenge(challenge: AcceptedChallenge) {
    await this.pool.query(
      'INSERT INTO synq_council_challenges (digest, challenge) VALUES ($1,$2)',
      [challenge.decisionDigest.toLowerCase(), JSON.stringify(challenge)],
    );
  }

  async listChallenges(digest: Hex) {
    const r = await this.pool.query(
      'SELECT challenge FROM synq_council_challenges WHERE digest=$1 ORDER BY id',
      [digest.toLowerCase()],
    );
    return r.rows.map((x) => json(x.challenge) as AcceptedChallenge);
  }

  async consumeDecision(input: {
    digest: Hex;
    councilId: string;
    nonce: Hex;
    at: number;
  }) {
    // One statement; unique on digest and on (council, nonce).
    const r = await this.pool.query(
      `INSERT INTO synq_council_executions (digest, council_id, nonce, executed_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING digest`,
      [
        input.digest.toLowerCase(),
        input.councilId,
        input.nonce.toLowerCase(),
        input.at,
      ],
    );
    return r.rows.length > 0;
  }

  async executedAt(digest: Hex) {
    const r = await this.pool.query(
      'SELECT executed_at FROM synq_council_executions WHERE digest=$1',
      [digest.toLowerCase()],
    );
    return r.rows[0] ? Number(r.rows[0].executed_at) : null;
  }
}

export class PostgresDelegationLogStore implements DelegationLogStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateGovernance(this.pool);
  }

  async load(workspaceId: string, chainId: number) {
    // One snapshot for the log and its head.
    return withTransaction(this.pool, async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const [entries, head] = await Promise.all([
        c.query(
          `SELECT entry FROM synq_delegation_log WHERE workspace_id=$1 AND chain_id=$2 ORDER BY seq`,
          [workspaceId, chainId],
        ),
        c.query(
          `SELECT seq, hash FROM synq_delegation_heads WHERE workspace_id=$1 AND chain_id=$2`,
          [workspaceId, chainId],
        ),
      ]);
      const h = head.rows[0];
      return {
        entries: entries.rows.map((x) => json(x.entry) as DelegationLogEntry),
        head: h
          ? ({ seq: Number(h.seq), hash: h.hash as Hex } as DelegationLogHead)
          : null,
      };
    });
  }

  async append(workspaceId: string, chainId: number, e: DelegationLogEntry) {
    return withTransaction(this.pool, async (c) => {
      // Compare-and-set on the head row (created at the first append).
      const moved =
        e.seq === 1 && e.prevHash === GENESIS_HASH
          ? await c.query(
              `INSERT INTO synq_delegation_heads (workspace_id, chain_id, seq, hash)
               VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING RETURNING seq`,
              [workspaceId, chainId, e.hash],
            )
          : await c.query(
              `UPDATE synq_delegation_heads SET seq=$3, hash=$4
               WHERE workspace_id=$1 AND chain_id=$2 AND seq=$5 AND hash=$6 RETURNING seq`,
              [workspaceId, chainId, e.seq, e.hash, e.seq - 1, e.prevHash],
            );
      if (!moved.rows.length) return false;
      await c.query(
        `INSERT INTO synq_delegation_log (workspace_id, chain_id, seq, kind, delegation_id, entry, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          workspaceId,
          chainId,
          e.seq,
          e.kind,
          e.delegationId,
          JSON.stringify(e),
          e.prevHash,
          e.hash,
        ],
      );
      return true;
    });
  }
}
