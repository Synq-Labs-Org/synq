import type {
  CancellationPolicy,
  EconomicOffer,
  Money,
  ProviderCapability,
} from '@synq/offer-exchange';
import {
  ReservationError,
  type TreasuryReservationStore,
} from './reservations.js';
import type { SettlementSqlPool } from './postgres.js';

export type ProviderEvent = {
  eventId: string;
  providerId: string;
  providerRef: string;
  reservationId: string;
  providerUpdatedAt: number;
} & (
  | { kind: 'CONFIRMED' }
  | { kind: 'PAYMENT_FAILED'; reason: string }
  | {
      kind: 'CANCELED';
      refundCore: string | null;
      refundDestination: string | null;
    }
  | {
      kind: 'REFUND_ISSUED';
      refundId: string;
      refundCore: string;
      refundDestination: string;
    }
);

export type RecourseOutcome =
  | 'APPLIED'
  | 'DUPLICATE'
  | 'STALE'
  | 'INCIDENT'
  | 'RELEASED'
  | 'REFUND_PENDING'
  | 'NO_RESERVATION';

export type Incident = {
  providerRef: string;
  code:
    | 'REFUND_DESTINATION_MISMATCH'
    | 'REFUND_EXCEEDS_CAPTURE'
    | 'REFUND_MISMATCH'
    | 'PAYMENT_FAILED_AFTER_CAPTURE';
  detail: string;
  at: number;
};

export interface RecourseStore {
  /** Atomically records the event id; returns false when already seen. */
  claim(
    eventId: string,
    providerRef: string,
    kind: string,
    at: number,
  ): Promise<boolean>;
  /** Advances the per-ref cursor; returns false when the update is older than the last applied one. */
  advance(providerRef: string, providerUpdatedAt: number): Promise<boolean>;
  incident(i: Incident): Promise<void>;
  incidents(): Promise<Incident[]>;
}

export class MemoryRecourseStore implements RecourseStore {
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, number>();
  private readonly list: Incident[] = [];
  async claim(eventId: string) {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
  async advance(ref: string, at: number) {
    const prior = this.cursors.get(ref);
    if (prior !== undefined && prior > at) return false;
    this.cursors.set(ref, at);
    return true;
  }
  async incident(i: Incident) {
    this.list.push(i);
  }
  async incidents() {
    return [...this.list];
  }
}

export class PostgresRecourseStore implements RecourseStore {
  private readonly s: string;
  constructor(
    private readonly pool: SettlementSqlPool,
    schema = 'public',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('invalid schema name');
    this.s = `"${schema}"`;
  }
  async migrate() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_recourse_events (
      event_id text PRIMARY KEY, provider_ref text NOT NULL, kind text NOT NULL, received_at bigint NOT NULL)`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_recourse_cursors (
      provider_ref text PRIMARY KEY, provider_updated_at bigint NOT NULL)`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_recourse_incidents (
      id bigserial PRIMARY KEY, provider_ref text NOT NULL, code text NOT NULL, detail text NOT NULL, at bigint NOT NULL)`);
  }
  async claim(eventId: string, providerRef: string, kind: string, at: number) {
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_recourse_events (event_id, provider_ref, kind, received_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [eventId, providerRef, kind, at],
    );
    return r.rowCount === 1;
  }
  async advance(ref: string, at: number) {
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_recourse_cursors (provider_ref, provider_updated_at) VALUES ($1,$2)
       ON CONFLICT (provider_ref) DO UPDATE SET provider_updated_at=EXCLUDED.provider_updated_at
       WHERE ${this.s}.synq_recourse_cursors.provider_updated_at <= EXCLUDED.provider_updated_at`,
      [ref, at],
    );
    return r.rowCount === 1;
  }
  async incident(i: Incident) {
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_recourse_incidents (provider_ref, code, detail, at) VALUES ($1,$2,$3,$4)`,
      [i.providerRef, i.code, i.detail.slice(0, 300), i.at],
    );
  }
  async incidents() {
    const r = await this.pool.query(
      `SELECT provider_ref, code, detail, at FROM ${this.s}.synq_recourse_incidents ORDER BY id`,
    );
    return r.rows.map((x) => ({
      providerRef: String(x.provider_ref),
      code: x.code as Incident['code'],
      detail: String(x.detail),
      at: Number(x.at),
    }));
  }
}

/**
 * Durable recourse (Bible §90): idempotent provider events, stale-state
 * rejection, reservation release only once the outcome is known, refunds held
 * as promises until the treasury observes them, incidents on any mismatch.
 */
export class RecourseReconciler {
  constructor(
    private readonly store: RecourseStore,
    private readonly reservations: TreasuryReservationStore,
    private readonly refundDestination: (
      reservationId: string,
    ) => Promise<string | null>,
    private readonly now: () => number,
  ) {}

  async apply(e: ProviderEvent): Promise<RecourseOutcome> {
    const now = this.now();
    if (!(await this.store.claim(e.eventId, e.providerRef, e.kind, now)))
      return 'DUPLICATE';
    if (!(await this.store.advance(e.providerRef, e.providerUpdatedAt)))
      return 'STALE';
    const r = await this.reservations.get(e.reservationId);
    if (!r) return 'NO_RESERVATION';
    const incident = async (code: Incident['code'], detail: string) => {
      await this.store.incident({
        providerRef: e.providerRef,
        code,
        detail,
        at: now,
      });
      return 'INCIDENT' as const;
    };
    switch (e.kind) {
      case 'CONFIRMED':
        return 'APPLIED';
      case 'PAYMENT_FAILED':
        if (r.state === 'ACTIVE') {
          await this.reservations.release(
            r.reservationId,
            `payment failed: ${e.reason}`,
            now,
          );
          return 'RELEASED';
        }
        return r.state === 'RELEASED'
          ? 'APPLIED'
          : incident('PAYMENT_FAILED_AFTER_CAPTURE', `reservation ${r.state}`);
      case 'CANCELED':
        if (r.state === 'ACTIVE') {
          await this.reservations.release(
            r.reservationId,
            'provider canceled before capture',
            now,
          );
          return 'RELEASED';
        }
        if (e.refundCore === null || BigInt(e.refundCore) === 0n)
          return 'APPLIED';
        return this.refund(
          e,
          `cancel-${e.eventId}`,
          e.refundCore,
          e.refundDestination,
          incident,
        );
      case 'REFUND_ISSUED':
        return this.refund(
          e,
          e.refundId,
          e.refundCore,
          e.refundDestination,
          incident,
        );
    }
  }

  private async refund(
    e: ProviderEvent,
    refundId: string,
    amount: string,
    destination: string | null,
    incident: (c: Incident['code'], d: string) => Promise<'INCIDENT'>,
  ): Promise<RecourseOutcome> {
    const expected = await this.refundDestination(e.reservationId);
    if (
      !destination ||
      !expected ||
      destination.toLowerCase() !== expected.toLowerCase()
    )
      return incident(
        'REFUND_DESTINATION_MISMATCH',
        `refund to ${destination ?? 'unknown'}`,
      );
    try {
      await this.reservations.recordRefund({
        refundId,
        reservationId: e.reservationId,
        amount: BigInt(amount),
        now: this.now(),
      });
      return 'REFUND_PENDING';
    } catch (err) {
      if (
        err instanceof ReservationError &&
        err.code === 'REFUND_EXCEEDS_CAPTURE'
      )
        return incident('REFUND_EXCEEDS_CAPTURE', `refund ${amount}`);
      throw err;
    }
  }

  /** Treasury observed an inbound refund; a mismatch opens an incident and is never marked settled. */
  async observeRefund(
    refundId: string,
    providerRef: string,
    observed: bigint,
  ): Promise<'SETTLED' | 'INCIDENT'> {
    const r = await this.reservations.settleRefund(
      refundId,
      observed,
      this.now(),
    );
    if (r.state === 'SETTLED') return 'SETTLED';
    await this.store.incident({
      providerRef,
      code: 'REFUND_MISMATCH',
      detail: `expected ${r.amount}, observed ${observed}`,
      at: this.now(),
    });
    return 'INCIDENT';
  }

  /** Expired holds are released deterministically. */
  async sweep(): Promise<string[]> {
    return (await this.reservations.expireDue(this.now())).map(
      (r) => r.reservationId,
    );
  }
}

export type CancellationPreview = {
  allowed: boolean;
  penalty: Money | null;
  expectedRefund: 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
  requiresApproval: boolean;
  reason: string;
};

/** Shown before any cancel: penalties and expected refund, with approval when material. */
export function cancellationPreview(
  policy: CancellationPolicy,
  now: number,
  materialPenalty: Money,
): CancellationPreview {
  if (policy.kind === 'NON_REFUNDABLE')
    return {
      allowed: true,
      penalty: null,
      expectedRefund: 'NONE',
      requiresApproval: true,
      reason: 'non-refundable: cancelling forfeits the full amount',
    };
  if (
    policy.kind === 'FREE_UNTIL' &&
    policy.freeUntil !== null &&
    now < policy.freeUntil
  )
    return {
      allowed: true,
      penalty: null,
      expectedRefund: 'FULL',
      requiresApproval: false,
      reason: 'free cancellation window open',
    };
  if (policy.kind === 'UNKNOWN')
    return {
      allowed: true,
      penalty: null,
      expectedRefund: 'UNKNOWN',
      requiresApproval: true,
      reason: 'provider did not state a refund',
    };
  const material =
    policy.penalty !== null &&
    policy.penalty.currency === materialPenalty.currency &&
    BigInt(policy.penalty.amount) >= BigInt(materialPenalty.amount);
  return {
    allowed: true,
    penalty: policy.penalty,
    expectedRefund: 'PARTIAL',
    requiresApproval:
      material ||
      policy.penalty === null ||
      policy.penalty.currency !== materialPenalty.currency,
    reason: 'cancellation penalty applies',
  };
}

/** The agent may only promise a return when the provider exposes one. */
export function returnSupported(
  capability: ProviderCapability | null,
  offer: EconomicOffer,
): boolean {
  return (
    !!capability &&
    capability.verbs.includes('RETURN') &&
    offer.cancellation.kind !== 'NON_REFUNDABLE'
  );
}
