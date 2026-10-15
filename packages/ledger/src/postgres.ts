import type { JournalEntry, LedgerStore } from './index.js';

type Sql = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Versioned, reversible schema migrations for the finance tables. `down` is
 * only for development dry runs; production never runs it.
 */
export const LEDGER_MIGRATIONS: readonly {
  version: number;
  up: string;
  down: string;
}[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_ledger_entries (
      entry_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      occurred_at bigint NOT NULL,
      reversal_of text REFERENCES synq_ledger_entries(entry_id),
      data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS synq_ledger_entries_ws ON synq_ledger_entries (workspace_id, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS synq_ledger_one_reversal ON synq_ledger_entries (reversal_of) WHERE reversal_of IS NOT NULL;`,
    down: `DROP TABLE IF EXISTS synq_ledger_entries;`,
  },
];

const enc = (e: JournalEntry) =>
  JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const dec = (raw: unknown): JournalEntry =>
  JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as JournalEntry;

export async function migrateFinance(
  sql: Sql,
  target = LEDGER_MIGRATIONS.at(-1)!.version,
): Promise<number> {
  await sql.query(
    'CREATE TABLE IF NOT EXISTS synq_finance_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const r = await sql.query(
    'SELECT coalesce(max(version), 0) AS v FROM synq_finance_migrations',
  );
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of LEDGER_MIGRATIONS)
    if (m.version > current && m.version <= target) {
      await sql.query(m.up);
      await sql.query(
        'INSERT INTO synq_finance_migrations (version) VALUES ($1)',
        [m.version],
      );
      current = m.version;
    }
  for (const m of [...LEDGER_MIGRATIONS].reverse())
    if (m.version <= current && m.version > target) {
      await sql.query(m.down);
      await sql.query('DELETE FROM synq_finance_migrations WHERE version=$1', [
        m.version,
      ]);
      current = m.version - 1;
    }
  return current;
}

export class PostgresLedgerStore implements LedgerStore {
  constructor(readonly sql: Sql) {}
  async migrate() {
    await migrateFinance(this.sql);
  }
  async insert(e: JournalEntry) {
    const r = await this.sql.query(
      `INSERT INTO synq_ledger_entries (entry_id, workspace_id, idempotency_key, occurred_at, reversal_of, data)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING data`,
      [
        e.entryId,
        e.workspaceId,
        e.idempotencyKey,
        e.occurredAt,
        e.reversalOf,
        enc(e),
      ],
    );
    if (r.rows[0]) return { entry: e, created: true };
    const existing = await this.sql.query(
      'SELECT data FROM synq_ledger_entries WHERE idempotency_key=$1',
      [e.idempotencyKey],
    );
    return { entry: dec(existing.rows[0]!.data), created: false };
  }
  async get(id: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_ledger_entries WHERE entry_id=$1',
      [id],
    );
    return r.rows[0] ? dec(r.rows[0].data) : null;
  }
  async reversed(id: string) {
    const r = await this.sql.query(
      'SELECT 1 FROM synq_ledger_entries WHERE reversal_of=$1',
      [id],
    );
    return r.rows.length > 0;
  }
  async entries(workspaceId: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_ledger_entries WHERE workspace_id=$1 ORDER BY occurred_at, entry_id',
      [workspaceId],
    );
    return r.rows.map((x) => dec(x.data));
  }
}
