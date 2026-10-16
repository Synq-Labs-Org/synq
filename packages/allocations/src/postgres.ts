import type { AllocationPlan } from './waterfall.js';
import { AllocationError } from './waterfall.js';
import type { PolicyRegistration, StoredRevocation } from './registry.js';
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
/** A pool (`connect` gives a dedicated client) or a client already in a transaction. */
type PoolLike = Sql & {
  connect?: () => Promise<Sql & { release(): void }>;
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
  {
    // Holds per treasury scope with a hold key; legs that may have paid stay
    // fenced; the policy registry and owner-signed revocations.
    version: 2,
    up: `ALTER TABLE synq_alloc_reservations ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
    ALTER TABLE synq_alloc_reservations ADD COLUMN IF NOT EXISTS hold_key text NOT NULL DEFAULT '';
    UPDATE synq_alloc_reservations h SET
      scope = (s.data->'receipt'->>'chainId') || ':' || lower(s.data->'receipt'->>'token') || ':' || lower(s.data->'receipt'->>'recipient'),
      hold_key = CASE
        WHEN h.purpose='OPERATING_FLOOR' THEN 'floor:' || h.reservation_id
        WHEN h.purpose='TAX_ESTIMATE' THEN 'tax:' || s.receipt_id
        ELSE COALESCE(l.data->>'obligationRef', 'legacy:' || h.reservation_id) END
      FROM synq_alloc_splits s, synq_alloc_legs l
      WHERE h.split_id=s.split_id AND l.leg_key=h.reservation_id AND h.scope='';
    CREATE INDEX IF NOT EXISTS synq_alloc_reservations_scope ON synq_alloc_reservations (scope, status);
    CREATE UNIQUE INDEX IF NOT EXISTS synq_alloc_one_active_hold
      ON synq_alloc_reservations (scope, workspace_id, hold_key)
      WHERE status = 'ACTIVE' AND hold_key NOT LIKE 'floor:%' AND hold_key <> '';
    DROP INDEX IF EXISTS synq_alloc_one_grant_per_obligation;
    CREATE UNIQUE INDEX IF NOT EXISTS synq_alloc_one_grant_per_obligation_v2
      ON synq_alloc_legs (policy_id, obligation_ref)
      WHERE obligation_ref IS NOT NULL AND (
        state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED','NEEDS_REVIEW')
        OR (state = 'FAILED' AND data->>'txHash' IS NOT NULL));
    CREATE TABLE IF NOT EXISTS synq_alloc_policies (
      policy_id text NOT NULL,
      version int NOT NULL,
      workspace_id text NOT NULL,
      owner text NOT NULL,
      policy_hash text NOT NULL,
      registered_at bigint NOT NULL,
      PRIMARY KEY (policy_id, version));
    CREATE TABLE IF NOT EXISTS synq_alloc_policy_revocations (
      policy_id text NOT NULL,
      workspace_id text NOT NULL,
      through_version int NOT NULL,
      signer text NOT NULL,
      signature text NOT NULL,
      reason text NOT NULL,
      signed_at bigint NOT NULL,
      recorded_at bigint NOT NULL,
      PRIMARY KEY (policy_id, signature));`,
    down: `DROP TABLE IF EXISTS synq_alloc_policy_revocations; DROP TABLE IF EXISTS synq_alloc_policies;
      DROP INDEX IF EXISTS synq_alloc_one_grant_per_obligation_v2;
      CREATE UNIQUE INDEX IF NOT EXISTS synq_alloc_one_grant_per_obligation
        ON synq_alloc_legs (policy_id, obligation_ref)
        WHERE obligation_ref IS NOT NULL AND state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED');
      DROP INDEX IF EXISTS synq_alloc_one_active_hold; DROP INDEX IF EXISTS synq_alloc_reservations_scope;
      ALTER TABLE synq_alloc_reservations DROP COLUMN IF EXISTS hold_key;
      ALTER TABLE synq_alloc_reservations DROP COLUMN IF EXISTS scope;`,
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
  scope: String(x.scope),
  holdKey: String(x.hold_key),
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
  constructor(readonly sql: PoolLike) {}
  async atomically<T>(
    locks: readonly string[],
    fn: (tx: SplitStore) => Promise<T>,
  ): Promise<T> {
    const lock = async (c: Sql) => {
      for (const k of [...new Set(locks)].sort())
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `synq_alloc:${k}`,
        ]);
    };
    if (!this.sql.connect) {
      // Already a transaction's client: take the locks and run.
      await lock(this.sql);
      return fn(this);
    }
    const client = await this.sql.connect();
    try {
      await client.query('BEGIN');
      await lock(client);
      const out = await fn(new PostgresSplitStore(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async putPolicy(r: PolicyRegistration) {
    await this.sql.query(
      `INSERT INTO synq_alloc_policies (policy_id, version, workspace_id, owner, policy_hash, registered_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (policy_id, version) DO NOTHING`,
      [
        r.policyId,
        r.version,
        r.workspaceId,
        r.owner,
        r.policyHash,
        r.registeredAt,
      ],
    );
    return (await this.policyVersions(r.policyId)).find(
      (x) => x.version === r.version,
    )!;
  }
  async policyVersions(policyId: string) {
    const r = await this.sql.query(
      'SELECT * FROM synq_alloc_policies WHERE policy_id=$1 ORDER BY version',
      [policyId],
    );
    return r.rows.map(
      (x): PolicyRegistration => ({
        policyId: String(x.policy_id),
        version: Number(x.version),
        workspaceId: String(x.workspace_id),
        owner: String(x.owner) as PolicyRegistration['owner'],
        policyHash: String(x.policy_hash) as PolicyRegistration['policyHash'],
        registeredAt: Number(x.registered_at),
      }),
    );
  }
  async putRevocation(r: StoredRevocation) {
    await this.sql.query(
      `INSERT INTO synq_alloc_policy_revocations (policy_id, workspace_id, through_version, signer, signature, reason, signed_at, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        r.policyId,
        r.workspaceId,
        r.throughVersion,
        r.signer,
        r.signature,
        r.reason,
        r.at,
        r.recordedAt,
      ],
    );
  }
  async revocations(policyId: string) {
    const r = await this.sql.query(
      'SELECT * FROM synq_alloc_policy_revocations WHERE policy_id=$1',
      [policyId],
    );
    return r.rows.map(
      (x): StoredRevocation => ({
        policyId: String(x.policy_id),
        workspaceId: String(x.workspace_id),
        throughVersion: Number(x.through_version),
        reason: String(x.reason),
        at: Number(x.signed_at),
        signer: String(x.signer) as StoredRevocation['signer'],
        signature: String(x.signature) as StoredRevocation['signature'],
        recordedAt: Number(x.recorded_at),
      }),
    );
  }
  async validatedSince(policyId: string, since: number) {
    const r = await this.sql.query(
      `SELECT DISTINCT e.split_id FROM synq_alloc_events e JOIN synq_alloc_splits s ON s.split_id = e.split_id
       WHERE s.policy_id=$1 AND e.to_state='POLICY_VALIDATED' AND e.at >= $2 AND s.state <> 'CANCELLED'`,
      [policyId, since],
    );
    return r.rows.map((x) => String(x.split_id));
  }
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
    await this.sql
      .query(
        `INSERT INTO synq_alloc_reservations (reservation_id, workspace_id, split_id, purpose, amount, status, created_at, updated_at, scope, hold_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) ON CONFLICT (reservation_id) DO NOTHING`,
        [
          res.reservationId,
          res.workspaceId,
          res.splitId,
          res.purpose,
          res.amount.toString(),
          res.status,
          res.createdAt,
          res.scope,
          res.holdKey,
        ],
      )
      .catch((e: { code?: string }) => {
        if (e.code === '23505')
          throw new AllocationError(
            'CONFLICT',
            `${res.holdKey} is already held`,
          );
        throw e;
      });
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
  async reservations(scope: string) {
    const r = await this.sql.query(
      'SELECT * FROM synq_alloc_reservations WHERE scope=$1 ORDER BY created_at, reservation_id',
      [scope],
    );
    return r.rows.map(reservationOf);
  }
  async transfersSince(policyId: string, since: number) {
    const r = await this.sql.query(
      `SELECT data FROM synq_alloc_legs WHERE policy_id=$1 AND kind='TRANSFER'
       AND (state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED','NEEDS_REVIEW')
            OR (state = 'FAILED' AND data->>'txHash' IS NOT NULL))
       AND coalesce(authorized_at,0) >= $2`,
      [policyId, since],
    );
    return r.rows.map((x) => dec<LegRecord>(x.data));
  }
  async grantedLegs(policyId: string) {
    const r = await this.sql.query(
      `SELECT data FROM synq_alloc_legs WHERE policy_id=$1
       AND (state IN ('AUTHORIZED','SUBMITTED','CONFIRMED','RECONCILED','NEEDS_REVIEW')
            OR (state = 'FAILED' AND data->>'txHash' IS NOT NULL))`,
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
