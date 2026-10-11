import { z } from 'zod';
import { AmountSchema, IdSchema, TimestampSchema } from '@synq/schemas';

export const RESERVATION_STATES = [
  'ACTIVE',
  'CAPTURED',
  'SETTLED',
  'RELEASED',
] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
/** States that still hold treasury value out of the free balance. */
export const HOLDING_STATES: readonly ReservationState[] = [
  'ACTIVE',
  'CAPTURED',
];

export const ReservationRequestSchema = z.strictObject({
  reservationId: IdSchema,
  groupId: IdSchema,
  assetId: z.string().min(1).max(160),
  amount: AmountSchema.refine((v) => BigInt(v) > 0n, 'amount must be positive'),
  intentId: IdSchema,
  purpose: z.enum([
    'STAY',
    'FLIGHT',
    'COMMERCE',
    'DCA',
    'X402',
    'CONVERSION',
    'OTHER',
  ]),
  settlementPlanHash: z.string().max(80).nullable(),
  expiresAt: TimestampSchema,
});
export type ReservationRequest = z.output<typeof ReservationRequestSchema>;

export type TreasuryReservation = ReservationRequest & {
  state: ReservationState;
  captured: string;
  createdAt: number;
  updatedAt: number;
  reason: string | null;
};

export type RefundRecord = {
  refundId: string;
  reservationId: string;
  amount: string;
  state: 'PROMISED' | 'SETTLED' | 'MISMATCH';
  observedAt: number;
};

export type FreeBalance = {
  groupId: string;
  assetId: string;
  confirmed: string;
  held: string;
  mandatoryReserve: string;
  free: string;
  pendingRefunds: string;
  asOf: number | null;
};

export type ReservationErrorCode =
  | 'INSUFFICIENT_FREE_BALANCE'
  | 'NO_CONFIRMED_BALANCE'
  | 'RESERVATION_CONFLICT'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_EXPIRED'
  | 'INVALID_RESERVATION_TRANSITION'
  | 'CAPTURE_EXCEEDS_RESERVATION'
  | 'REFUND_EXCEEDS_CAPTURE';

export class ReservationError extends Error {
  constructor(
    readonly code: ReservationErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReservationError';
  }
}

/**
 * Bible §89: free = confirmedBalance − active reservations − mandatory reserves.
 * Promised refunds never count as free until the confirmed balance reflects them.
 */
export interface TreasuryReservationStore {
  setConfirmedBalance(input: {
    groupId: string;
    assetId: string;
    confirmed: bigint;
    mandatoryReserve?: bigint;
    asOf: number;
  }): Promise<void>;
  reserve(raw: ReservationRequest, now: number): Promise<TreasuryReservation>;
  get(reservationId: string): Promise<TreasuryReservation | null>;
  /** Marks value as spent at the provider; any unspent remainder is released. */
  capture(
    reservationId: string,
    amount: bigint,
    now: number,
  ): Promise<TreasuryReservation>;
  /** Settled once the confirmed balance already reflects the debit. */
  settle(reservationId: string, now: number): Promise<TreasuryReservation>;
  release(
    reservationId: string,
    reason: string,
    now: number,
  ): Promise<TreasuryReservation>;
  expireDue(now: number): Promise<TreasuryReservation[]>;
  recordRefund(input: {
    refundId: string;
    reservationId: string;
    amount: bigint;
    now: number;
  }): Promise<RefundRecord>;
  settleRefund(
    refundId: string,
    observedAmount: bigint,
    now: number,
  ): Promise<RefundRecord>;
  free(groupId: string, assetId: string): Promise<FreeBalance>;
}

export function sameRequest(
  a: ReservationRequest,
  b: ReservationRequest,
): boolean {
  return (
    a.groupId === b.groupId &&
    a.assetId === b.assetId &&
    a.amount === b.amount &&
    a.intentId === b.intentId &&
    a.purpose === b.purpose &&
    a.settlementPlanHash === b.settlementPlanHash &&
    a.expiresAt === b.expiresAt
  );
}

export function heldAmount(r: TreasuryReservation): bigint {
  if (r.state === 'ACTIVE') return BigInt(r.amount);
  if (r.state === 'CAPTURED') return BigInt(r.captured);
  return 0n;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prior = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((r) => (done = r));
    await prior;
    try {
      return await fn();
    } finally {
      done();
    }
  }
}

export class MemoryReservationStore implements TreasuryReservationStore {
  private readonly lock = new Mutex();
  private readonly balances = new Map<
    string,
    { confirmed: bigint; reserve: bigint; asOf: number }
  >();
  private readonly reservations = new Map<string, TreasuryReservation>();
  private readonly refunds = new Map<string, RefundRecord>();
  private key = (g: string, a: string) => `${g}|${a}`;

  async setConfirmedBalance(input: {
    groupId: string;
    assetId: string;
    confirmed: bigint;
    mandatoryReserve?: bigint;
    asOf: number;
  }) {
    await this.lock.run(() => {
      const prior = this.balances.get(this.key(input.groupId, input.assetId));
      if (prior && prior.asOf > input.asOf) return;
      this.balances.set(this.key(input.groupId, input.assetId), {
        confirmed: input.confirmed,
        reserve: input.mandatoryReserve ?? 0n,
        asOf: input.asOf,
      });
    });
  }

  private computeFree(groupId: string, assetId: string): FreeBalance {
    const b = this.balances.get(this.key(groupId, assetId));
    let held = 0n;
    let pending = 0n;
    for (const r of this.reservations.values())
      if (r.groupId === groupId && r.assetId === assetId) held += heldAmount(r);
    for (const f of this.refunds.values()) {
      const r = this.reservations.get(f.reservationId);
      if (
        f.state === 'PROMISED' &&
        r?.groupId === groupId &&
        r.assetId === assetId
      )
        pending += BigInt(f.amount);
    }
    const confirmed = b?.confirmed ?? 0n;
    const reserve = b?.reserve ?? 0n;
    const free = confirmed - held - reserve;
    return {
      groupId,
      assetId,
      confirmed: String(confirmed),
      held: String(held),
      mandatoryReserve: String(reserve),
      free: String(free > 0n ? free : 0n),
      pendingRefunds: String(pending),
      asOf: b?.asOf ?? null,
    };
  }

  private expireLocked(now: number): TreasuryReservation[] {
    const out: TreasuryReservation[] = [];
    for (const r of this.reservations.values())
      if (r.state === 'ACTIVE' && r.expiresAt <= now) {
        const next = {
          ...r,
          state: 'RELEASED' as const,
          updatedAt: now,
          reason: 'EXPIRED',
        };
        this.reservations.set(r.reservationId, next);
        out.push(next);
      }
    return out;
  }

  async reserve(raw: ReservationRequest, now: number) {
    const req = ReservationRequestSchema.parse(raw);
    return this.lock.run(() => {
      this.expireLocked(now);
      const prior = this.reservations.get(req.reservationId);
      if (prior) {
        if (!sameRequest(prior, req))
          throw new ReservationError('RESERVATION_CONFLICT', req.reservationId);
        return prior;
      }
      if (req.expiresAt <= now)
        throw new ReservationError('RESERVATION_EXPIRED');
      if (!this.balances.has(this.key(req.groupId, req.assetId)))
        throw new ReservationError('NO_CONFIRMED_BALANCE');
      const free = BigInt(this.computeFree(req.groupId, req.assetId).free);
      if (BigInt(req.amount) > free)
        throw new ReservationError(
          'INSUFFICIENT_FREE_BALANCE',
          `requested ${req.amount}, free ${free}`,
        );
      const r: TreasuryReservation = {
        ...req,
        state: 'ACTIVE',
        captured: '0',
        createdAt: now,
        updatedAt: now,
        reason: null,
      };
      this.reservations.set(r.reservationId, r);
      return r;
    });
  }

  async get(id: string) {
    return this.reservations.get(id) ?? null;
  }

  private mutate(
    id: string,
    fn: (r: TreasuryReservation) => TreasuryReservation,
  ): Promise<TreasuryReservation> {
    return this.lock.run(() => {
      const r = this.reservations.get(id);
      if (!r) throw new ReservationError('RESERVATION_NOT_FOUND', id);
      const next = fn(r);
      this.reservations.set(id, next);
      return next;
    });
  }

  capture(id: string, amount: bigint, now: number) {
    return this.mutate(id, (r) => applyCapture(r, amount, now));
  }
  settle(id: string, now: number) {
    return this.mutate(id, (r) => applySettle(r, now));
  }
  release(id: string, reason: string, now: number) {
    return this.mutate(id, (r) => applyRelease(r, reason, now));
  }
  expireDue(now: number) {
    return this.lock.run(() => this.expireLocked(now));
  }

  recordRefund(input: {
    refundId: string;
    reservationId: string;
    amount: bigint;
    now: number;
  }) {
    return this.lock.run(() => {
      const r = this.reservations.get(input.reservationId);
      if (!r) throw new ReservationError('RESERVATION_NOT_FOUND');
      const prior = this.refunds.get(input.refundId);
      if (prior) {
        if (
          prior.reservationId !== input.reservationId ||
          prior.amount !== String(input.amount)
        )
          throw new ReservationError(
            'RESERVATION_CONFLICT',
            'refund id reused',
          );
        return prior;
      }
      let refunded = 0n;
      for (const f of this.refunds.values())
        if (f.reservationId === r.reservationId) refunded += BigInt(f.amount);
      if (input.amount <= 0n || refunded + input.amount > BigInt(r.captured))
        throw new ReservationError('REFUND_EXCEEDS_CAPTURE');
      const f: RefundRecord = {
        refundId: input.refundId,
        reservationId: input.reservationId,
        amount: String(input.amount),
        state: 'PROMISED',
        observedAt: input.now,
      };
      this.refunds.set(f.refundId, f);
      return f;
    });
  }

  settleRefund(refundId: string, observed: bigint, now: number) {
    return this.lock.run(() => {
      const f = this.refunds.get(refundId);
      if (!f) throw new ReservationError('RESERVATION_NOT_FOUND', refundId);
      if (f.state !== 'PROMISED') return f;
      const next: RefundRecord = {
        ...f,
        state: observed === BigInt(f.amount) ? 'SETTLED' : 'MISMATCH',
        observedAt: now,
      };
      this.refunds.set(refundId, next);
      return next;
    });
  }

  async free(groupId: string, assetId: string) {
    return this.lock.run(() => this.computeFree(groupId, assetId));
  }
}

export function applyCapture(
  r: TreasuryReservation,
  amount: bigint,
  now: number,
): TreasuryReservation {
  if (r.state === 'CAPTURED' && BigInt(r.captured) === amount) return r;
  if (r.state !== 'ACTIVE')
    throw new ReservationError(
      'INVALID_RESERVATION_TRANSITION',
      `${r.state} -> CAPTURED`,
    );
  if (amount <= 0n || amount > BigInt(r.amount))
    throw new ReservationError('CAPTURE_EXCEEDS_RESERVATION');
  return { ...r, state: 'CAPTURED', captured: String(amount), updatedAt: now };
}

export function applySettle(
  r: TreasuryReservation,
  now: number,
): TreasuryReservation {
  if (r.state === 'SETTLED') return r;
  if (r.state !== 'CAPTURED')
    throw new ReservationError(
      'INVALID_RESERVATION_TRANSITION',
      `${r.state} -> SETTLED`,
    );
  return { ...r, state: 'SETTLED', updatedAt: now };
}

export function applyRelease(
  r: TreasuryReservation,
  reason: string,
  now: number,
): TreasuryReservation {
  if (r.state === 'RELEASED') return r;
  if (r.state !== 'ACTIVE')
    throw new ReservationError(
      'INVALID_RESERVATION_TRANSITION',
      `${r.state} -> RELEASED`,
    );
  return {
    ...r,
    state: 'RELEASED',
    updatedAt: now,
    reason: reason.slice(0, 200),
  };
}
