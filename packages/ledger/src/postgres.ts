import type {
  ConsumerInbox,
  JournalEntry,
  LedgerStore,
  OutboxEvent,
} from './index.js';

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
  {
    version: 2,
    up: `CREATE TABLE IF NOT EXISTS synq_event_outbox (
      seq bigserial PRIMARY KEY,
      event_id text NOT NULL UNIQUE,
      entry_id text NOT NULL REFERENCES synq_ledger_entries(entry_id),
      topic text NOT NULL,
      payload jsonb NOT NULL,
      published_at timestamptz);
    CREATE INDEX IF NOT EXISTS synq_event_outbox_pending ON synq_event_outbox (seq) WHERE published_at IS NULL;
    CREATE TABLE IF NOT EXISTS synq_consumer_inbox (
      consumer text NOT NULL,
      event_id text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id));`,
    down: `DROP TABLE IF EXISTS synq_consumer_inbox; DROP TABLE IF EXISTS synq_event_outbox;`,
  },
  {
    version: 3,
    up: `CREATE TABLE IF NOT EXISTS synq_invoices (
      invoice_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      number text NOT NULL,
      payment_ref text UNIQUE,
      rev int NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (workspace_id, number));
    CREATE TABLE IF NOT EXISTS synq_vendors (
      vendor_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      rev int NOT NULL,
      data jsonb NOT NULL);`,
    down: `DROP TABLE IF EXISTS synq_vendors; DROP TABLE IF EXISTS synq_invoices;`,
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
  async insert(e: JournalEntry, events: readonly OutboxEvent[] = []) {
    // One statement, so the entry and its events commit or fail together.
    const r = await this.sql.query(
      `WITH entry AS (
         INSERT INTO synq_ledger_entries (entry_id, workspace_id, idempotency_key, occurred_at, reversal_of, data)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING entry_id),
       ev AS (
         INSERT INTO synq_event_outbox (event_id, entry_id, topic, payload)
         SELECT x.event_id, entry.entry_id, x.topic, x.payload
         FROM entry, jsonb_to_recordset($7::jsonb) AS x(event_id text, topic text, payload jsonb)
         RETURNING event_id)
       SELECT entry_id FROM entry`,
      [
        e.entryId,
        e.workspaceId,
        e.idempotencyKey,
        e.occurredAt,
        e.reversalOf,
        enc(e),
        JSON.stringify(
          events.map((v) => ({
            event_id: v.eventId,
            topic: v.topic,
            payload: JSON.parse(
              JSON.stringify(v.payload ?? null, (_k, x) =>
                typeof x === 'bigint' ? `${x}n` : x,
              ),
            ),
          })),
        ),
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
  async pendingEvents(
    limit: number,
    workspaceId?: string,
  ): Promise<OutboxEvent[]> {
    // Workspace scoping follows the event's journal entry (entry_id -> workspace).
    const r =
      workspaceId === undefined
        ? await this.sql.query(
            'SELECT event_id, topic, payload FROM synq_event_outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1',
            [limit],
          )
        : await this.sql.query(
            `SELECT o.event_id, o.topic, o.payload FROM synq_event_outbox o
             JOIN synq_ledger_entries e ON e.entry_id = o.entry_id
             WHERE o.published_at IS NULL AND e.workspace_id = $2 ORDER BY o.seq LIMIT $1`,
            [limit, workspaceId],
          );
    return r.rows.map((x) => ({
      eventId: String(x.event_id),
      topic: String(x.topic),
      payload: x.payload,
    }));
  }
  async markPublished(ids: readonly string[]) {
    if (!ids.length) return;
    await this.sql.query(
      'UPDATE synq_event_outbox SET published_at = now() WHERE event_id = ANY($1::text[]) AND published_at IS NULL',
      [ids],
    );
  }
}

export class PostgresConsumerInbox implements ConsumerInbox {
  constructor(readonly sql: Sql) {}
  async claim(consumer: string, eventId: string) {
    const r = await this.sql.query(
      'INSERT INTO synq_consumer_inbox (consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1',
      [consumer, eventId],
    );
    return r.rows.length > 0;
  }
  async release(consumer: string, eventId: string) {
    await this.sql.query(
      'DELETE FROM synq_consumer_inbox WHERE consumer=$1 AND event_id=$2',
      [consumer, eventId],
    );
  }
}
