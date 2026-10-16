/**
 * Minimal Postgres contracts shared by the durable stores. Every package that
 * persists financial state keeps its own versioned migrations and its own
 * migrations table (so packages can migrate independently), and uses these
 * structural types so `pg.Pool` / `pg.PoolClient` fit without a driver import.
 */

export type SqlResult = {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
};

export type SqlQueryable = {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
};

export type SqlClient = SqlQueryable & { release(): void };

export type SqlPool = SqlQueryable & { connect(): Promise<SqlClient> };

export type Migration = Readonly<{ version: number; up: string; down: string }>;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Runs `fn` inside BEGIN/COMMIT on one pooled connection; rolls back on throw. */
export async function withTransaction<T>(
  pool: SqlPool,
  fn: (c: SqlQueryable) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Applies `migrations` up to `target` (or rolls back to it; `down` is for
 * development dry runs only) and records each version in `table`. The whole
 * run holds a transaction-scoped advisory lock keyed by the table name, so
 * two processes starting together never apply the same version twice.
 */
export async function applyMigrations(
  pool: SqlPool,
  table: string,
  migrations: readonly Migration[],
  target = migrations.at(-1)?.version ?? 0,
): Promise<number> {
  if (!IDENT.test(table)) throw new Error(`invalid migrations table ${table}`);
  for (let i = 1; i < migrations.length; i++)
    if (migrations[i]!.version <= migrations[i - 1]!.version)
      throw new Error(`${table}: migration versions must increase`);
  return withTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${table} (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const r = await c.query(
      `SELECT coalesce(max(version), 0) AS v FROM ${table}`,
    );
    let current = Number(r.rows[0]?.v ?? 0);
    for (const m of migrations)
      if (m.version > current && m.version <= target) {
        await c.query(m.up);
        await c.query(`INSERT INTO ${table} (version) VALUES ($1)`, [
          m.version,
        ]);
        current = m.version;
      }
    for (const m of [...migrations].reverse())
      if (m.version <= current && m.version > target) {
        await c.query(m.down);
        await c.query(`DELETE FROM ${table} WHERE version=$1`, [m.version]);
        current = m.version - 1;
      }
    return current;
  });
}

/** JSON with bigint as `{ "$big": "<digits>" }`, so no string is ever mistaken for one. */
export const toJsonb = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? { $big: v.toString() } : v,
  );

export const fromJsonb = <T>(raw: unknown): T =>
  JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), (_k, v) =>
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as { $big?: unknown }).$big === 'string'
      ? BigInt((v as { $big: string }).$big)
      : v,
  ) as T;
