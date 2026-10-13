import {
  EconomicGrantSchema,
  EconomicMandateSchema,
  MandateVersionError,
  type EconomicGrant,
  type EconomicGrantLedger,
  type EconomicMandate,
} from '@synq/kernel';
import type { SettlementSqlClient, SettlementSqlPool } from './postgres.js';

/**
 * Durable Kernel grant state: mandate versions, budget spent and one-time
 * consumption survive restarts. Consumption is one atomic insert unique on
 * both the grant and the intent.
 */
export class PostgresEconomicGrantLedger implements EconomicGrantLedger {
  private readonly s: string;
  constructor(
    private readonly pool: SettlementSqlPool,
    schema = 'public',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('invalid schema name');
    this.s = `"${schema}"`;
  }

  async migrate() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_econ_mandates (
      mandate_id text PRIMARY KEY, version integer NOT NULL, data jsonb NOT NULL)`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_econ_spent (
      mandate_id text PRIMARY KEY, spent numeric(78,0) NOT NULL CHECK (spent >= 0))`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_econ_grants (
      grant_id text PRIMARY KEY, intent_id text NOT NULL, mandate_id text NOT NULL, issued_at bigint NOT NULL, data jsonb NOT NULL)`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS synq_econ_grants_intent ON ${this.s}.synq_econ_grants (intent_id, issued_at DESC)`,
    );
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_econ_consumed (
      grant_id text PRIMARY KEY, intent_id text NOT NULL UNIQUE, execution_hash text NOT NULL, consumed_at bigint NOT NULL)`);
  }

  private async tx<T>(run: (c: SettlementSqlClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await run(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async installMandate(m: EconomicMandate) {
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_econ_mandates (mandate_id, version, data) VALUES ($1,$2,$3)
       ON CONFLICT (mandate_id) DO UPDATE SET version=EXCLUDED.version, data=EXCLUDED.data
       WHERE ${this.s}.synq_econ_mandates.version < EXCLUDED.version`,
      [m.mandateId, m.version, JSON.stringify(m)],
    );
    if (r.rowCount !== 1) throw new MandateVersionError(m.mandateId);
  }

  async mandate(id: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_econ_mandates WHERE mandate_id=$1`,
      [id],
    );
    return r.rows[0] ? EconomicMandateSchema.parse(r.rows[0].data) : null;
  }

  async revoke(id: string) {
    await this.pool.query(
      `UPDATE ${this.s}.synq_econ_mandates SET data = jsonb_set(data, '{status}', '"REVOKED"') WHERE mandate_id=$1`,
      [id],
    );
  }

  async latestGrant(intentId: string): Promise<EconomicGrant | null> {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_econ_grants WHERE intent_id=$1 ORDER BY issued_at DESC LIMIT 1`,
      [intentId],
    );
    return r.rows[0] ? EconomicGrantSchema.parse(r.rows[0].data) : null;
  }

  async grant(grantId: string): Promise<EconomicGrant | null> {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_econ_grants WHERE grant_id=$1`,
      [grantId],
    );
    return r.rows[0] ? EconomicGrantSchema.parse(r.rows[0].data) : null;
  }

  async intentConsumed(intentId: string) {
    const r = await this.pool.query(
      `SELECT 1 FROM ${this.s}.synq_econ_consumed WHERE intent_id=$1`,
      [intentId],
    );
    return r.rows.length > 0;
  }

  async issue(grant: EconomicGrant, amount: bigint, budget: bigint) {
    return this.tx(async (c) => {
      const consumed = await c.query(
        `SELECT 1 FROM ${this.s}.synq_econ_consumed WHERE intent_id=$1`,
        [grant.intentId],
      );
      if (consumed.rows.length) return 'INTENT_CONSUMED' as const;
      await c.query(
        `INSERT INTO ${this.s}.synq_econ_spent (mandate_id, spent) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
        [grant.mandateId],
      );
      const charged = await c.query(
        `UPDATE ${this.s}.synq_econ_spent SET spent = spent + $2::numeric
         WHERE mandate_id=$1 AND spent + $2::numeric <= $3::numeric`,
        [grant.mandateId, String(amount), String(budget)],
      );
      if (charged.rowCount !== 1) return 'BUDGET_EXHAUSTED' as const;
      await c.query(
        `INSERT INTO ${this.s}.synq_econ_grants (grant_id, intent_id, mandate_id, issued_at, data) VALUES ($1,$2,$3,$4,$5)`,
        [
          grant.grantId,
          grant.intentId,
          grant.mandateId,
          grant.issuedAt,
          JSON.stringify(grant),
        ],
      );
      return 'ISSUED' as const;
    });
  }

  async consume(grant: EconomicGrant, executionHash: string, at: number) {
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_econ_consumed (grant_id, intent_id, execution_hash, consumed_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [grant.grantId, grant.intentId, executionHash, at],
    );
    return r.rowCount === 1;
  }

  async spent(id: string) {
    const r = await this.pool.query(
      `SELECT spent::text AS s FROM ${this.s}.synq_econ_spent WHERE mandate_id=$1`,
      [id],
    );
    return BigInt((r.rows[0]?.s as string | undefined) ?? '0');
  }

  async isConsumed(grantId: string) {
    const r = await this.pool.query(
      `SELECT 1 FROM ${this.s}.synq_econ_consumed WHERE grant_id=$1`,
      [grantId],
    );
    return r.rows.length > 0;
  }
}
