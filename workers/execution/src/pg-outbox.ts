import type { Hex } from 'viem';
import {
  fromJsonb,
  toJsonb,
  withTransaction,
  type SqlPool,
  type SqlQueryable,
} from '@synq/domain/pg';
import type { ExecutionGrant, NonceFence } from '@synq/kernel/arc';
import { ArcExecutionError } from './arc.js';
import type { OutboxRecord, OutboxStore } from './arc-outbox.js';
import { migrateExecution } from './pg-schema.js';

/**
 * Production stores for the exactly-once payout path.
 *
 * `PostgresOutboxStore` keeps the `OutboxStore` contract: a payout's signed
 * bytes and hash are inserted (unique on key, hash, and sender+nonce) before
 * broadcast; later attempts only read and settle the state. The signed fields
 * are immutable in the database (trigger), and terminal states never change.
 *
 * `PostgresGrantFence` is the durable consumed-grant store: a Kernel grant is
 * consumed once, unique on grant id and on nonce, across every executor
 * process sharing the database.
 */

const row = (r: Record<string, unknown>): OutboxRecord =>
  Object.freeze({
    key: String(r.key),
    state: r.state as OutboxRecord['state'],
    prepared: fromJsonb<OutboxRecord['prepared']>(r.prepared),
    raw: r.raw as Hex,
    hash: r.hash as Hex,
    evidence:
      r.evidence === null
        ? null
        : fromJsonb<NonNullable<OutboxRecord['evidence']>>(r.evidence),
    note: (r.note as string | null) ?? null,
    updatedAt: Number(r.updated_at),
  });

const COLUMNS =
  'key, state, prepared, raw, hash, evidence, note, updated_at, grant_id';

async function insertRecord(
  sql: SqlQueryable,
  r: OutboxRecord,
  grantId: string | null,
): Promise<boolean> {
  const ins = await sql.query(
    `INSERT INTO synq_arc_payout_outbox
       (key, state, chain_id, from_address, tx_nonce, hash, raw, prepared, evidence, note, grant_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
     ON CONFLICT DO NOTHING RETURNING key`,
    [
      r.key,
      r.state,
      r.prepared.chainId,
      r.prepared.from.toLowerCase(),
      r.prepared.nonce,
      r.hash.toLowerCase(),
      r.raw,
      toJsonb(r.prepared),
      r.evidence ? toJsonb(r.evidence) : null,
      r.note,
      grantId,
      r.updatedAt,
    ],
  );
  if (ins.rows.length) return true;
  const same = await sql.query(
    'SELECT 1 FROM synq_arc_payout_outbox WHERE key=$1',
    [r.key],
  );
  if (same.rows.length) return false;
  // Not this key: the hash, the sender's nonce or the grant is already
  // recorded under another key. Refuse before anything is broadcast.
  throw new ArcExecutionError(
    'TX_MISMATCH',
    `nonce ${r.prepared.nonce} of ${r.prepared.from}, hash ${r.hash} or the grant is already recorded under another key`,
  );
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateExecution(this.pool);
  }

  async get(key: string) {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM synq_arc_payout_outbox WHERE key=$1`,
      [key],
    );
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async create(r: OutboxRecord) {
    return insertRecord(this.pool, r, null);
  }

  /**
   * Only state, evidence and note move; the database refuses changes to the
   * signed fields and transitions out of CONFIRMED / FAILED / NEEDS_REVIEW.
   */
  async update(r: OutboxRecord) {
    const u = await this.pool.query(
      `UPDATE synq_arc_payout_outbox SET state=$3, evidence=$4, note=$5, updated_at=$6
       WHERE key=$1 AND hash=$2 RETURNING key`,
      [
        r.key,
        r.hash.toLowerCase(),
        r.state,
        r.evidence ? toJsonb(r.evidence) : null,
        r.note,
        r.updatedAt,
      ],
    );
    if (!u.rows.length)
      throw new ArcExecutionError(
        'TX_MISMATCH',
        `outbox ${r.key} has no record signed with ${r.hash}`,
      );
  }

  async createConsumingGrant(
    r: OutboxRecord,
    grant: ExecutionGrant,
    at: number,
  ): Promise<'CREATED' | 'KEY_EXISTS' | 'GRANT_REPLAYED'> {
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        r.key,
      ]);
      const existing = await c.query(
        'SELECT 1 FROM synq_arc_payout_outbox WHERE key=$1',
        [r.key],
      );
      if (existing.rows.length) return 'KEY_EXISTS' as const;
      if (!(await consumeGrantRow(c, grant, at)))
        return 'GRANT_REPLAYED' as const;
      return (await insertRecord(c, r, grant.grantId))
        ? ('CREATED' as const)
        : ('KEY_EXISTS' as const);
    });
  }

  /** Checks admission and stores signed bytes in the same transaction. */
  async createAdmittingGrant(
    record: OutboxRecord,
    grant: ExecutionGrant,
    admit: (fence: NonceFence) => Promise<void>,
  ): Promise<'CREATED' | 'KEY_EXISTS'> {
    return withTransaction(this.pool, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        record.key,
      ]);
      const existing = await sql.query(
        'SELECT 1 FROM synq_arc_payout_outbox WHERE key=$1',
        [record.key],
      );
      if (existing.rows.length) return 'KEY_EXISTS';
      const txPool: SqlPool = {
        query: sql.query.bind(sql),
        connect: async () => {
          throw new Error('nested transaction');
        },
      };
      await admit(new PostgresGrantFence(txPool));
      const consumed = await sql.query(
        'SELECT 1 FROM synq_consumed_grants WHERE grant_id=$1 AND nonce=$2',
        [grant.grantId, grant.nonce.toLowerCase()],
      );
      if (!consumed.rows.length)
        throw new Error('grant admission did not consume its nonce');
      if (!(await insertRecord(sql, record, grant.grantId)))
        throw new Error('outbox key raced during admission');
      return 'CREATED';
    });
  }

  /** Records still SIGNED (broadcast outcome unknown) for a recovery sweep. */
  async unsettled(limit = 100): Promise<OutboxRecord[]> {
    const r = await this.pool.query(
      `SELECT ${COLUMNS} FROM synq_arc_payout_outbox WHERE state='SIGNED' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return r.rows.map(row);
  }
}

async function consumeGrantRow(
  sql: SqlQueryable,
  g: ExecutionGrant,
  at: number,
): Promise<boolean> {
  const r = await sql.query(
    `INSERT INTO synq_consumed_grants (grant_id, nonce, intent_id, mandate_id, action_hash, chain_id, consumed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING grant_id`,
    [
      g.grantId,
      g.nonce.toLowerCase(),
      g.intentId,
      g.mandateId,
      g.actionHash,
      g.chainId,
      at,
    ],
  );
  return r.rows.length > 0;
}

export class PostgresGrantFence implements NonceFence {
  constructor(
    readonly pool: SqlPool,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async migrate() {
    await migrateExecution(this.pool);
  }

  /** Nonce-only form (no grant at hand): the nonce is still unique across grants. */
  async consume(nonce: Hex) {
    const r = await this.pool.query(
      `INSERT INTO synq_consumed_grants (grant_id, nonce, consumed_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING grant_id`,
      [`nonce:${nonce.toLowerCase()}`, nonce.toLowerCase(), this.clock()],
    );
    return r.rows.length > 0;
  }

  async consumeGrant(grant: ExecutionGrant, at: number) {
    return consumeGrantRow(this.pool, grant, at);
  }

  async revoke(nonce: Hex) {
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `escrow-nonce:${nonce.toLowerCase()}`,
      ]);
      const r = await c.query(
        'INSERT INTO synq_revoked_grants VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce',
        [nonce.toLowerCase()],
      );
      await c.query(
        'INSERT INTO synq_consumed_grants (grant_id,nonce,consumed_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [`revoked:${nonce.toLowerCase()}`, nonce.toLowerCase(), this.clock()],
      );
      return r.rows.length > 0;
    });
  }

  async consumed(grantId: string) {
    const r = await this.pool.query(
      'SELECT consumed_at FROM synq_consumed_grants WHERE grant_id=$1',
      [grantId],
    );
    return r.rows[0] ? Number(r.rows[0].consumed_at) : null;
  }
}
