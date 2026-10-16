import type { AllocationPlan } from './waterfall.js';
import { AllocationError } from './waterfall.js';
import {
  TERMINAL,
  assertTransition,
  type LegRecord,
  type LegState,
  type Reservation,
  type SplitEvent,
  type SplitRecord,
  type SplitState,
  type SplitStore,
} from './split.js';

type Sql = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Versioned, reversible migrations for the split workflow, tracked in their
 * own table (`synq_allocations_migrations`). `down` is for development dry
 * runs only.
 */
export const ALLOCATION_MIGRATIONS: readonly {
  version: number;
  up: string;
  down: string;
}[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_alloc_splits (
      split_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      receipt_id text NOT NULL UNIQUE,
      policy_id text NOT NULL,
      state text NOT NULL,
      rev int NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS synq_alloc_splits_policy ON synq_alloc_splits (policy_id, created_at);
    CREATE TABLE IF NOT EXISTS synq_alloc_legs (
      leg_key text PRIMARY KEY,
      split_id text NOT NULL REFERENCES synq_alloc_splits(split_id),
      leg_index int NOT NULL,
      policy_id text NOT NULL,
      kind text NOT NULL,
      state text NOT NULL,
      obligation_ref text,
      authorized_at bigint,
      data jsonb NOT NULL,
      UNIQUE (split_id, leg_index));
    CREATE UNIQUE INDEX IF NOT EXISTS synq_alloc_one_grant_per_obligation
      ON synq_alloc_legs (policy_id, obligation_ref)
      WHERE obligation_ref IS NOT NULL AND state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED');
    CREATE TABLE IF NOT EXISTS synq_alloc_reservations (
      reservation_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      split_id text NOT NULL REFERENCES synq_alloc_splits(split_id),
      purpose text NOT NULL,
      amount numeric(78,0) NOT NULL CHECK (amount > 0),
      status text NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','RELEASED')),
      remitted boolean NOT NULL DEFAULT false CHECK (remitted = false),
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS synq_alloc_events (
      split_id text NOT NULL REFERENCES synq_alloc_splits(split_id),
      seq int NOT NULL,
      from_state text,
      to_state text NOT NULL,
      note text,
      at bigint NOT NULL,
      PRIMARY KEY (split_id, seq));`,
    down: `DROP TABLE IF EXISTS synq_alloc_events; DROP TABLE IF EXISTS synq_alloc_reservations;
      DROP TABLE IF EXISTS synq_alloc_legs; DROP TABLE IF EXISTS synq_alloc_splits;`,
  },
];

export async function migrateAllocations(
  sql: Sql,
  target = ALLOCATION_MIGRATIONS.at(-1)!.version,
): Promise<number> {
  await sql.query(
    'CREATE TABLE IF NOT EXISTS synq_allocations_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const r = await sql.query(
    'SELECT coalesce(max(version), 0) AS v FROM synq_allocations_migrations',
  );
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of ALLOCATION_MIGRATIONS)
    if (m.version > current && m.version <= target) {
      await sql.query(m.up);
      await sql.query(
        'INSERT INTO synq_allocations_migrations (version) VALUES ($1)',
        [m.version],
      );
      current = m.version;
    }
  for (const m of [...ALLOCATION_MIGRATIONS].reverse())
    if (m.version <= current && m.version > target) {
      await sql.query(m.down);
      await sql.query(
        'DELETE FROM synq_allocations_migrations WHERE version=$1',
        [m.version],
      );
      current = m.version - 1;
    }
  return current;
}

const enc = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const dec = <T>(raw: unknown): T =>
  JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;

const reservationOf = (x: Record<string, unknown>): Reservation => ({
  reservationId: String(x.reservation_id),
  workspaceId: String(x.workspace_id),
  splitId: String(x.split_id),
  purpose: String(x.purpose) as Reservation['purpose'],
  amount: BigInt(String(x.amount)),
  status: String(x.status) as Reservation['status'],
  remitted: false,
  createdAt: Number(x.created_at),
  updatedAt: Number(x.updated_at),
});

export class PostgresSplitStore implements SplitStore {
  constructor(readonly sql: Sql) {}
  async migrate() {
    await migrateAllocations(this.sql);
  }
  async create(s: SplitRecord) {
    const r = await this.sql.query(
      `WITH ins AS (
         INSERT INTO synq_alloc_splits (split_id, workspace_id, receipt_id, policy_id, state, rev, created_at, updated_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) ON CONFLICT (receipt_id) DO NOTHING RETURNING split_id),
       ev AS (
         INSERT INTO synq_alloc_events (split_id, seq, from_state, to_state, note, at)
         SELECT split_id, 1, NULL, $5, $9, $7 FROM ins RETURNING 1)
       SELECT split_id FROM ins`,
      [
        s.splitId,
        s.workspaceId,
        s.receiptId,
        s.policyId,
        s.state,
        s.rev,
        s.createdAt,
        enc(s),
        s.note,
      ],
    );
    if (r.rows[0]) return { split: s, created: true };
    return { split: (await this.byReceipt(s.receiptId))!, created: false };
  }
  async get(id: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_alloc_splits WHERE split_id=$1',
      [id],
    );
    return r.rows[0] ? dec<SplitRecord>(r.rows[0].data) : null;
  }
  async byReceipt(receiptId: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_alloc_splits WHERE receipt_id=$1',
      [receiptId],
    );
    return r.rows[0] ? dec<SplitRecord>(r.rows[0].data) : null;
  }
  async advance(
    splitId: string,
    expect: { state: SplitState; rev: number },
    next: { state: SplitState; plan?: AllocationPlan; note?: string | null },
    at: number,
  ) {
    assertTransition(expect.state, next.state);
    const cur = await this.get(splitId);
    if (!cur) throw new AllocationError('NOT_FOUND', splitId);
    const updated: SplitRecord = {
      ...cur,
      state: next.state,
      rev: expect.rev + 1,
      plan: next.plan ?? cur.plan,
      note: next.note === undefined ? cur.note : next.note,
      updatedAt: at,
    };
    // One statement: the compare-and-set and its audit event commit together.
    const r = await this.sql.query(
      `WITH upd AS (
         UPDATE synq_alloc_splits SET state=$4, rev=rev+1, updated_at=$5, data=$6
         WHERE split_id=$1 AND state=$2 AND rev=$3 RETURNING split_id),
       ev AS (
         INSERT INTO synq_alloc_events (split_id, seq, from_state, to_state, note, at)
         SELECT upd.split_id, $3 + 1, $2, $4, $7, $5 FROM upd RETURNING 1)
       SELECT split_id FROM upd`,
      [
        splitId,
        expect.state,
        expect.rev,
        next.state,
        at,
        enc(updated),
        next.note ?? null,
      ],
    );
    if (!r.rows[0])
      throw new AllocationError(
        'CONFLICT',
        `${splitId} moved on from ${expect.state}@${expect.rev}`,
      );
    return updated;
  }
  async putLegs(legs: readonly LegRecord[]) {
    for (const l of legs)
      await this.sql.query(
        `INSERT INTO synq_alloc_legs (leg_key, split_id, leg_index, policy_id, kind, state, obligation_ref, authorized_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (leg_key) DO NOTHING`,
        [
          l.legKey,
          l.splitId,
          l.legIndex,
          l.policyId,
          l.kind,
          l.state,
          l.obligationRef,
          l.authorizedAt,
          enc(l),
        ],
      );
  }
  async legs(splitId: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_alloc_legs WHERE split_id=$1 ORDER BY leg_index',
      [splitId],
    );
    return r.rows.map((x) => dec<LegRecord>(x.data));
  }
  async updateLeg(
    legKey: string,
    expect: LegState,
    patch: Partial<LegRecord> & { state: LegState },
  ) {
    const r0 = await this.sql.query(
      'SELECT data FROM synq_alloc_legs WHERE leg_key=$1',
      [legKey],
    );
    if (!r0.rows[0]) throw new AllocationError('NOT_FOUND', legKey);
    const next = { ...dec<LegRecord>(r0.rows[0].data), ...patch } as LegRecord;
    try {
      const r = await this.sql.query(
        `UPDATE synq_alloc_legs SET state=$3, authorized_at=$4, data=$5
         WHERE leg_key=$1 AND state=$2 RETURNING leg_key`,
        [legKey, expect, next.state, next.authorizedAt, enc(next)],
      );
      if (!r.rows[0])
        throw new AllocationError('CONFLICT', `${legKey} is not ${expect}`);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new AllocationError(
          'CONFLICT',
          `${next.obligationRef} already holds a grant or payment`,
        );
      throw e;
    }
    return next;
  }
  async reserve(res: Reservation) {
    await this.sql.query(
      `INSERT INTO synq_alloc_reservations (reservation_id, workspace_id, split_id, purpose, amount, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (reservation_id) DO NOTHING`,
      [
        res.reservationId,
        res.workspaceId,
        res.splitId,
        res.purpose,
        res.amount.toString(),
        res.status,
        res.createdAt,
      ],
    );
    const r = await this.sql.query(
      'SELECT amount FROM synq_alloc_reservations WHERE reservation_id=$1',
      [res.reservationId],
    );
    if (BigInt(String(r.rows[0]!.amount)) !== res.amount)
      throw new AllocationError(
        'CONFLICT',
        `${res.reservationId} holds ${String(r.rows[0]!.amount)}`,
      );
  }
  async setReservation(id: string, status: Reservation['status'], at: number) {
    const r = await this.sql.query(
      `UPDATE synq_alloc_reservations SET status=$2, updated_at=$3
       WHERE reservation_id=$1 AND status='ACTIVE' RETURNING 1`,
      [id, status, at],
    );
    if (!r.rows[0]) {
      const x = await this.sql.query(
        'SELECT 1 FROM synq_alloc_reservations WHERE reservation_id=$1',
        [id],
      );
      if (!x.rows[0]) throw new AllocationError('NOT_FOUND', id);
    }
  }
  async reservations(workspaceId: string) {
    const r = await this.sql.query(
      'SELECT * FROM synq_alloc_reservations WHERE workspace_id=$1 ORDER BY reservation_id',
      [workspaceId],
    );
    return r.rows.map(reservationOf);
  }
  async transfersSince(policyId: string, since: number) {
    const r = await this.sql.query(
      `SELECT data FROM synq_alloc_legs WHERE policy_id=$1 AND kind='TRANSFER'
       AND state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED') AND coalesce(authorized_at,0) >= $2`,
      [policyId, since],
    );
    return r.rows.map((x) => dec<LegRecord>(x.data));
  }
  async grantedLegs(policyId: string) {
    const r = await this.sql.query(
      `SELECT data FROM synq_alloc_legs WHERE policy_id=$1
       AND state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED')`,
      [policyId],
    );
    return r.rows.map((x) => dec<LegRecord>(x.data));
  }
  async splitsSince(policyId: string, since: number) {
    const r = await this.sql.query(
      'SELECT data FROM synq_alloc_splits WHERE policy_id=$1 AND created_at >= $2 ORDER BY created_at',
      [policyId, since],
    );
    return r.rows.map((x) => dec<SplitRecord>(x.data));
  }
  async events(splitId: string): Promise<SplitEvent[]> {
    const r = await this.sql.query(
      'SELECT * FROM synq_alloc_events WHERE split_id=$1 ORDER BY seq',
      [splitId],
    );
    return r.rows.map((x) => ({
      splitId: String(x.split_id),
      seq: Number(x.seq),
      from: (x.from_state as SplitState | null) ?? null,
      to: String(x.to_state) as SplitState,
      note: (x.note as string | null) ?? null,
      at: Number(x.at),
    }));
  }
  async open() {
    const r = await this.sql.query(
      'SELECT data FROM synq_alloc_splits WHERE NOT (state = ANY($1::text[])) ORDER BY created_at, split_id',
      [[...TERMINAL]],
    );
    return r.rows.map((x) => dec<SplitRecord>(x.data));
  }
}
