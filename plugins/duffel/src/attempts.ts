import { createHash } from 'node:crypto';

export interface DuffelAttemptStore {
  readonly durable: boolean;
  /** First claim wins forever; an ambiguous mutation is reconciled, never reissued. */
  claim(
    key: string,
    fingerprint: string,
  ): Promise<'NEW' | 'EXISTING' | 'CONFLICT'>;
}

export const attemptFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class MemoryDuffelAttempts implements DuffelAttemptStore {
  readonly durable = false;
  private readonly attempts = new Map<string, string>();
  async claim(key: string, fingerprint: string) {
    const prior = this.attempts.get(key);
    if (prior !== undefined)
      return prior === fingerprint ? 'EXISTING' : 'CONFLICT';
    this.attempts.set(key, fingerprint);
    return 'NEW' as const;
  }
}

type Sql = {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
export const DUFFEL_ATTEMPT_MIGRATIONS = [
  {
    version: 1,
    up: 'CREATE TABLE IF NOT EXISTS synq_duffel_attempts (attempt_key text PRIMARY KEY, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
    down: 'DROP TABLE IF EXISTS synq_duffel_attempts',
  },
] as const;

export class PostgresDuffelAttempts implements DuffelAttemptStore {
  readonly durable = true;
  constructor(private readonly sql: Sql) {}
  async migrate(target = 1) {
    if (target !== 0 && target !== 1)
      throw new Error('invalid Duffel migration target');
    await this.sql.query(
      'CREATE TABLE IF NOT EXISTS synq_duffel_migrations (version int PRIMARY KEY)',
    );
    if (target === 0) {
      await this.sql.query(DUFFEL_ATTEMPT_MIGRATIONS[0].down);
      await this.sql.query('DELETE FROM synq_duffel_migrations');
    } else {
      await this.sql.query(DUFFEL_ATTEMPT_MIGRATIONS[0].up);
      await this.sql.query(
        'INSERT INTO synq_duffel_migrations(version) VALUES (1) ON CONFLICT DO NOTHING',
      );
    }
  }
  async claim(key: string, fingerprint: string) {
    const inserted = await this.sql.query(
      'INSERT INTO synq_duffel_attempts(attempt_key,fingerprint) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING attempt_key',
      [key, fingerprint],
    );
    if (inserted.rows.length) return 'NEW' as const;
    const found = await this.sql.query(
      'SELECT fingerprint FROM synq_duffel_attempts WHERE attempt_key=$1',
      [key],
    );
    return found.rows[0]?.fingerprint === fingerprint
      ? ('EXISTING' as const)
      : ('CONFLICT' as const);
  }
}
