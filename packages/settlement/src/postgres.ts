import {
  ReservationError,
  ReservationRequestSchema,
  applyCapture,
  applyRelease,
  applyBegin,
  applyHold,
  applyReleaseHeld,
  applySettle,
  sameRequest,
  type FreeBalance,
  type RefundRecord,
  type ReservationRequest,
  type TreasuryReservation,
  type TreasuryReservationStore,
} from './reservations.js';

type Row = Record<string, unknown>;
export interface SettlementSqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}
export interface SettlementSqlPool {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<SettlementSqlClient>;
}

const str = (v: unknown) => String(v);

function toReservation(row: Row): TreasuryReservation {
  const req = ReservationRequestSchema.parse(row.request);
  return {
    ...req,
    state: row.state as TreasuryReservation['state'],
    captured: str(row.captured),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reason: (row.reason as string | null) ?? null,
  };
}
function toRefund(row: Row): RefundRecord {
  return {
    refundId: str(row.refund_id),
    reservationId: str(row.reservation_id),
    amount: str(row.amount),
    state: row.state as RefundRecord['state'],
    observedAt: Number(row.observed_at),
  };
}

/**
 * Atomic reservations: every reserve serializes on the (group, asset) balance
 * row with SELECT … FOR UPDATE, so concurrent intents can never oversubscribe
 * the same confirmed balance.
 */
export class PostgresReservationStore implements TreasuryReservationStore {
  private readonly s: string;
  constructor(
    private readonly pool: SettlementSqlPool,
    schema = 'public',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('invalid schema name');
    this.s = `"${schema}"`;
  }

  async migrate(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_treasury_balances (
      group_id text NOT NULL, asset_id text NOT NULL, confirmed numeric(78,0) NOT NULL CHECK (confirmed >= 0),
      mandatory_reserve numeric(78,0) NOT NULL DEFAULT 0, as_of bigint NOT NULL,
      PRIMARY KEY (group_id, asset_id))`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_treasury_reservations (
      reservation_id text PRIMARY KEY, group_id text NOT NULL, asset_id text NOT NULL,
      amount numeric(78,0) NOT NULL CHECK (amount > 0), captured numeric(78,0) NOT NULL DEFAULT 0 CHECK (captured <= amount),
      state text NOT NULL CHECK (state IN ('ACTIVE','EXECUTING','HELD','CAPTURED','SETTLED','RELEASED')),
      expires_at bigint NOT NULL, request jsonb NOT NULL, reason text,
      created_at bigint NOT NULL, updated_at bigint NOT NULL)`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS synq_treasury_reservations_holding ON ${this.s}.synq_treasury_reservations (group_id, asset_id) WHERE state IN ('ACTIVE','EXECUTING','HELD','CAPTURED')`,
    );
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_treasury_refunds (
      refund_id text PRIMARY KEY, reservation_id text NOT NULL REFERENCES ${this.s}.synq_treasury_reservations(reservation_id),
      amount numeric(78,0) NOT NULL CHECK (amount > 0),
      state text NOT NULL CHECK (state IN ('PROMISED','SETTLED','MISMATCH')), observed_at bigint NOT NULL)`);
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

  async setConfirmedBalance(input: {
    groupId: string;
    assetId: string;
    confirmed: bigint;
    mandatoryReserve?: bigint;
    asOf: number;
  }) {
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_treasury_balances (group_id, asset_id, confirmed, mandatory_reserve, as_of)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (group_id, asset_id) DO UPDATE SET confirmed=EXCLUDED.confirmed,
         mandatory_reserve=EXCLUDED.mandatory_reserve, as_of=EXCLUDED.as_of
       WHERE ${this.s}.synq_treasury_balances.as_of <= EXCLUDED.as_of`,
      [
        input.groupId,
        input.assetId,
        String(input.confirmed),
        String(input.mandatoryReserve ?? 0n),
        input.asOf,
      ],
    );
  }

  private async freeWith(
    c: SettlementSqlClient | SettlementSqlPool,
    groupId: string,
    assetId: string,
  ): Promise<FreeBalance> {
    const r = await c.query(
      `SELECT b.confirmed::text AS confirmed, b.mandatory_reserve::text AS reserve, b.as_of,
        COALESCE((SELECT SUM(CASE WHEN state='CAPTURED' THEN captured ELSE amount END) FROM ${this.s}.synq_treasury_reservations
          WHERE group_id=$1 AND asset_id=$2 AND state IN ('ACTIVE','EXECUTING','HELD','CAPTURED')),0)::text AS held,
        COALESCE((SELECT SUM(f.amount) FROM ${this.s}.synq_treasury_refunds f JOIN ${this.s}.synq_treasury_reservations t USING (reservation_id)
          WHERE t.group_id=$1 AND t.asset_id=$2 AND f.state='PROMISED'),0)::text AS pending
       FROM (SELECT 1) one LEFT JOIN ${this.s}.synq_treasury_balances b ON b.group_id=$1 AND b.asset_id=$2`,
      [groupId, assetId],
    );
    const row = r.rows[0]!;
    const confirmed = BigInt((row.confirmed as string | null) ?? '0');
    const reserve = BigInt((row.reserve as string | null) ?? '0');
    const held = BigInt(row.held as string);
    const free = confirmed - held - reserve;
    return {
      groupId,
      assetId,
      confirmed: String(confirmed),
      held: String(held),
      mandatoryReserve: String(reserve),
      free: String(free > 0n ? free : 0n),
      pendingRefunds: String(row.pending),
      asOf:
        row.as_of === null || row.as_of === undefined
          ? null
          : Number(row.as_of),
    };
  }

  async reserve(
    raw: ReservationRequest,
    now: number,
  ): Promise<TreasuryReservation> {
    return (await this.reservePlan([raw], now))[0]!;
  }

  async reservePlan(
    raws: readonly ReservationRequest[],
    now: number,
  ): Promise<TreasuryReservation[]> {
    const reqs = raws.map((r) => ReservationRequestSchema.parse(r));
    return this.tx(async (c) => {
      const keys = [
        ...new Set(reqs.map((r) => JSON.stringify([r.groupId, r.assetId]))),
      ].sort();
      const present = new Set<string>();
      for (const k of keys) {
        const [groupId, assetId] = JSON.parse(k) as [string, string];
        const bal = await c.query(
          `SELECT 1 FROM ${this.s}.synq_treasury_balances WHERE group_id=$1 AND asset_id=$2 FOR UPDATE`,
          [groupId, assetId],
        );
        if (bal.rows.length) present.add(k);
        await c.query(
          `UPDATE ${this.s}.synq_treasury_reservations SET state='RELEASED', reason='EXPIRED', updated_at=$3
           WHERE group_id=$1 AND asset_id=$2 AND state='ACTIVE' AND expires_at <= $3`,
          [groupId, assetId, now],
        );
      }
      const out: TreasuryReservation[] = [];
      for (const req of reqs) {
        const prior = await c.query(
          `SELECT * FROM ${this.s}.synq_treasury_reservations WHERE reservation_id=$1 FOR UPDATE`,
          [req.reservationId],
        );
        if (prior.rows[0]) {
          const existing = toReservation(prior.rows[0]);
          if (!sameRequest(existing, req))
            throw new ReservationError(
              'RESERVATION_CONFLICT',
              req.reservationId,
            );
          out.push(existing);
          continue;
        }
        if (req.expiresAt <= now)
          throw new ReservationError('RESERVATION_EXPIRED');
        if (!present.has(JSON.stringify([req.groupId, req.assetId])))
          throw new ReservationError('NO_CONFIRMED_BALANCE');
        const free = BigInt(
          (await this.freeWith(c, req.groupId, req.assetId)).free,
        );
        if (BigInt(req.amount) > free)
          throw new ReservationError(
            'INSUFFICIENT_FREE_BALANCE',
            `requested ${req.amount}, free ${free}`,
          );
        const r = await c.query(
          `INSERT INTO ${this.s}.synq_treasury_reservations
            (reservation_id, group_id, asset_id, amount, captured, state, expires_at, request, reason, created_at, updated_at)
           VALUES ($1,$2,$3,$4,0,'ACTIVE',$5,$6,NULL,$7,$7) RETURNING *`,
          [
            req.reservationId,
            req.groupId,
            req.assetId,
            req.amount,
            req.expiresAt,
            JSON.stringify(req),
            now,
          ],
        );
        out.push(toReservation(r.rows[0]!));
      }
      return out;
    });
  }

  async get(id: string) {
    const r = await this.pool.query(
      `SELECT * FROM ${this.s}.synq_treasury_reservations WHERE reservation_id=$1`,
      [id],
    );
    return r.rows[0] ? toReservation(r.rows[0]) : null;
  }

  private mutate(
    id: string,
    fn: (
      r: TreasuryReservation,
      balanceAsOf: number | null,
    ) => TreasuryReservation,
  ) {
    return this.tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM ${this.s}.synq_treasury_reservations WHERE reservation_id=$1 FOR UPDATE`,
        [id],
      );
      if (!r.rows[0]) throw new ReservationError('RESERVATION_NOT_FOUND', id);
      const current = toReservation(r.rows[0]);
      const b = await c.query(
        `SELECT as_of FROM ${this.s}.synq_treasury_balances WHERE group_id=$1 AND asset_id=$2`,
        [current.groupId, current.assetId],
      );
      const next = fn(current, b.rows[0] ? Number(b.rows[0].as_of) : null);
      await c.query(
        `UPDATE ${this.s}.synq_treasury_reservations SET state=$2, captured=$3, reason=$4, updated_at=$5 WHERE reservation_id=$1`,
        [id, next.state, next.captured, next.reason, next.updatedAt],
      );
      return next;
    });
  }

  capture(id: string, amount: bigint, now: number) {
    return this.mutate(id, (r) => applyCapture(r, amount, now));
  }
  settle(id: string, now: number) {
    return this.mutate(id, (r, asOf) => applySettle(r, now, asOf));
  }
  release(id: string, reason: string, now: number) {
    return this.mutate(id, (r) => applyRelease(r, reason, now));
  }
  beginExecution(
    id: string,
    expect: { groupId: string; settlementPlanHash: string },
    now: number,
  ) {
    return this.mutate(id, (r) => applyBegin(r, expect, now));
  }
  hold(id: string, reason: string, now: number) {
    return this.mutate(id, (r) => applyHold(r, reason, now));
  }
  releaseHeld(id: string, reason: string, now: number) {
    return this.mutate(id, (r) => applyReleaseHeld(r, reason, now));
  }

  async expireDue(now: number) {
    const r = await this.pool.query(
      `UPDATE ${this.s}.synq_treasury_reservations SET state='RELEASED', reason='EXPIRED', updated_at=$1
       WHERE state='ACTIVE' AND expires_at <= $1 RETURNING *`,
      [now],
    );
    return r.rows.map(toReservation);
  }

  async recordRefund(input: {
    refundId: string;
    reservationId: string;
    amount: bigint;
    now: number;
  }) {
    return this.tx(async (c) => {
      const res = await c.query(
        `SELECT * FROM ${this.s}.synq_treasury_reservations WHERE reservation_id=$1 FOR UPDATE`,
        [input.reservationId],
      );
      if (!res.rows[0]) throw new ReservationError('RESERVATION_NOT_FOUND');
      const reservation = toReservation(res.rows[0]);
      const prior = await c.query(
        `SELECT * FROM ${this.s}.synq_treasury_refunds WHERE refund_id=$1`,
        [input.refundId],
      );
      if (prior.rows[0]) {
        const f = toRefund(prior.rows[0]);
        if (
          f.reservationId !== input.reservationId ||
          f.amount !== String(input.amount)
        )
          throw new ReservationError(
            'RESERVATION_CONFLICT',
            'refund id reused',
          );
        return f;
      }
      const sum = await c.query(
        `SELECT COALESCE(SUM(amount),0)::text AS s FROM ${this.s}.synq_treasury_refunds WHERE reservation_id=$1`,
        [input.reservationId],
      );
      if (
        input.amount <= 0n ||
        BigInt(sum.rows[0]!.s as string) + input.amount >
          BigInt(reservation.captured)
      )
        throw new ReservationError('REFUND_EXCEEDS_CAPTURE');
      const r = await c.query(
        `INSERT INTO ${this.s}.synq_treasury_refunds (refund_id, reservation_id, amount, state, observed_at)
         VALUES ($1,$2,$3,'PROMISED',$4) RETURNING *`,
        [input.refundId, input.reservationId, String(input.amount), input.now],
      );
      return toRefund(r.rows[0]!);
    });
  }

  async settleRefund(refundId: string, observed: bigint, now: number) {
    return this.tx(async (c) => {
      const r = await c.query(
        `SELECT * FROM ${this.s}.synq_treasury_refunds WHERE refund_id=$1 FOR UPDATE`,
        [refundId],
      );
      if (!r.rows[0])
        throw new ReservationError('RESERVATION_NOT_FOUND', refundId);
      const f = toRefund(r.rows[0]);
      if (f.state !== 'PROMISED') return f;
      const state = observed === BigInt(f.amount) ? 'SETTLED' : 'MISMATCH';
      await c.query(
        `UPDATE ${this.s}.synq_treasury_refunds SET state=$2, observed_at=$3 WHERE refund_id=$1`,
        [refundId, state, now],
      );
      return { ...f, state, observedAt: now } as RefundRecord;
    });
  }

  free(groupId: string, assetId: string) {
    return this.freeWith(this.pool, groupId, assetId);
  }
}
