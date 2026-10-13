import type { ProfileKind, ProfileStore, SealedProfile } from './vault.js';

export interface ProfileSqlPool {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/**
 * Durable sealed profiles: only ciphertext, IV, tag and the redacted summary
 * are stored. A ref is written once; a second put under the same ref fails.
 */
export class PostgresProfileStore implements ProfileStore {
  private readonly s: string;
  constructor(
    private readonly pool: ProfileSqlPool,
    schema = 'public',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('invalid schema name');
    this.s = `"${schema}"`;
  }

  async migrate() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_profile_vault (
      ref text PRIMARY KEY, group_id text NOT NULL, kind text NOT NULL, key_id text NOT NULL,
      iv text NOT NULL, ciphertext text NOT NULL, tag text NOT NULL, summary text NOT NULL,
      expires_at bigint, created_at bigint NOT NULL)`);
  }

  async put(r: SealedProfile) {
    const out = await this.pool.query(
      `INSERT INTO ${this.s}.synq_profile_vault (ref, group_id, kind, key_id, iv, ciphertext, tag, summary, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        r.ref,
        r.groupId,
        r.kind,
        r.keyId,
        r.iv,
        r.ciphertext,
        r.tag,
        r.summary,
        r.expiresAt,
        r.createdAt,
      ],
    );
    if (out.rowCount !== 1) throw new Error('PROFILE_REF_EXISTS');
  }

  async get(ref: string): Promise<SealedProfile | null> {
    const r = await this.pool.query(
      `SELECT * FROM ${this.s}.synq_profile_vault WHERE ref=$1`,
      [ref],
    );
    const row = r.rows[0];
    return row
      ? {
          ref: String(row.ref),
          groupId: String(row.group_id),
          kind: row.kind as ProfileKind,
          keyId: String(row.key_id),
          iv: String(row.iv),
          ciphertext: String(row.ciphertext),
          tag: String(row.tag),
          summary: String(row.summary),
          expiresAt: row.expires_at === null ? null : Number(row.expires_at),
          createdAt: Number(row.created_at),
        }
      : null;
  }

  async delete(ref: string) {
    await this.pool.query(
      `DELETE FROM ${this.s}.synq_profile_vault WHERE ref=$1`,
      [ref],
    );
  }
}
