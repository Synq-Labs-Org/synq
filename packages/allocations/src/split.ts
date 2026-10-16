import type { Address, Hex } from 'viem';
import type { ExecutionGrant } from '@synq/kernel/arc';
import {
  AllocationError,
  type AllocationLeg,
  type AllocationPlan,
  type FinalReceipt,
} from './waterfall.js';

/**
 * Durable split workflow state.
 *
 *   RECEIPT_FINAL → LIABILITIES_RECONCILED → RESERVATIONS_CREATED →
 *   POLICY_VALIDATED → SPLIT_AUTHORIZED → EXECUTING → EACH_LEG_RECONCILED →
 *   COMPLETED, with FAILED (retryable, nothing unknown), NEEDS_REVIEW (a
 *   human decides) and CANCELLED (only before execution).
 *
 * One split per receipt (unique receipt id). Each leg is its own row keyed
 * `<receiptId>#<legIndex>`; every transition is compare-and-set on the
 * current state, so two runners can never both advance the same step.
 */

export const SPLIT_STATES = [
  'RECEIPT_FINAL',
  'LIABILITIES_RECONCILED',
  'RESERVATIONS_CREATED',
  'POLICY_VALIDATED',
  'SPLIT_AUTHORIZED',
  'EXECUTING',
  'EACH_LEG_RECONCILED',
  'COMPLETED',
  'FAILED',
  'NEEDS_REVIEW',
  'CANCELLED',
] as const;
export type SplitState = (typeof SPLIT_STATES)[number];

const CANCELLABLE: readonly SplitState[] = [
  'RECEIPT_FINAL',
  'LIABILITIES_RECONCILED',
  'RESERVATIONS_CREATED',
  'POLICY_VALIDATED',
  'SPLIT_AUTHORIZED',
];

export const SPLIT_TRANSITIONS: Readonly<
  Record<SplitState, readonly SplitState[]>
> = {
  RECEIPT_FINAL: ['LIABILITIES_RECONCILED', 'NEEDS_REVIEW', 'CANCELLED'],
  LIABILITIES_RECONCILED: ['RESERVATIONS_CREATED', 'NEEDS_REVIEW', 'CANCELLED'],
  RESERVATIONS_CREATED: ['POLICY_VALIDATED', 'NEEDS_REVIEW', 'CANCELLED'],
  POLICY_VALIDATED: ['SPLIT_AUTHORIZED', 'NEEDS_REVIEW', 'CANCELLED'],
  SPLIT_AUTHORIZED: ['EXECUTING', 'NEEDS_REVIEW', 'CANCELLED'],
  EXECUTING: ['EACH_LEG_RECONCILED', 'FAILED', 'NEEDS_REVIEW'],
  EACH_LEG_RECONCILED: ['COMPLETED', 'NEEDS_REVIEW'],
  FAILED: ['EXECUTING', 'NEEDS_REVIEW'],
  COMPLETED: [],
  NEEDS_REVIEW: [],
  CANCELLED: [],
};
export const TERMINAL: readonly SplitState[] = [
  'COMPLETED',
  'NEEDS_REVIEW',
  'CANCELLED',
];
export const isCancellable = (s: SplitState) => CANCELLABLE.includes(s);

export function assertTransition(from: SplitState, to: SplitState) {
  if (!SPLIT_TRANSITIONS[from].includes(to))
    throw new AllocationError('WRONG_STATE', `${from} -> ${to}`);
}

export const LEG_STATES = [
  'PLANNED',
  'RESERVED',
  'AWAITING_APPROVAL',
  'AUTHORIZED',
  'SUBMITTED',
  'CONFIRMED',
  'RECONCILED',
  'FREE',
  'FAILED',
  'NEEDS_REVIEW',
  'CANCELLED',
] as const;
export type LegState = (typeof LEG_STATES)[number];

/** On-chain proof of one transfer leg. */
export type LegEvidence = Readonly<{
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  /** Index of the token Transfer(treasury → payee) log. */
  logIndex: number;
  from: Address;
  to: Address;
  amount: bigint;
  /** On-chain reference emitted with the payment (keccak256 of the leg key). */
  ref: Hex;
  gasPayer: Address;
  feeWei: bigint;
  explorer: string;
}>;

export type SplitRecord = Readonly<{
  splitId: string;
  workspaceId: string;
  receiptId: string;
  invoiceId: string;
  policyId: string;
  policyVersion: number;
  state: SplitState;
  rev: number;
  receipt: FinalReceipt;
  plan: AllocationPlan | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type LegRecord = Readonly<
  AllocationLeg & {
    splitId: string;
    receiptId: string;
    policyId: string;
    state: LegState;
    grant: ExecutionGrant | null;
    authorizedAt: number | null;
    reasons: readonly string[];
    txHash: Hex | null;
    evidence: LegEvidence | null;
    note: string | null;
    updatedAt: number;
  }
>;

export type ReservationPurpose = AllocationLeg['purpose'];
export type Reservation = Readonly<{
  reservationId: string;
  workspaceId: string;
  splitId: string;
  purpose: ReservationPurpose;
  amount: bigint;
  status: 'ACTIVE' | 'CONSUMED' | 'RELEASED';
  /**
   * Always false: a reservation holds the treasury's own cash. A tax estimate
   * reserved here has not been paid to any tax authority.
   */
  remitted: false;
  createdAt: number;
  updatedAt: number;
}>;

export type SplitEvent = Readonly<{
  splitId: string;
  seq: number;
  from: SplitState | null;
  to: SplitState;
  note: string | null;
  at: number;
}>;

export interface SplitStore {
  migrate(): Promise<void>;
  /** Creates unless the receipt already has a split; returns the stored one. */
  create(s: SplitRecord): Promise<{ split: SplitRecord; created: boolean }>;
  get(splitId: string): Promise<SplitRecord | null>;
  byReceipt(receiptId: string): Promise<SplitRecord | null>;
  /** Compare-and-set on (state, rev) plus an audit event, atomically. */
  advance(
    splitId: string,
    expect: { state: SplitState; rev: number },
    next: { state: SplitState; plan?: AllocationPlan; note?: string | null },
    at: number,
  ): Promise<SplitRecord>;
  /** Inserts legs that are not yet stored; existing legs are untouched. */
  putLegs(legs: readonly LegRecord[]): Promise<void>;
  legs(splitId: string): Promise<LegRecord[]>;
  /** Compare-and-set on the leg state. */
  updateLeg(
    legKey: string,
    expect: LegState,
    patch: Partial<Omit<LegRecord, 'legKey' | 'splitId' | 'legIndex'>> & {
      state: LegState;
    },
  ): Promise<LegRecord>;
  /** Idempotent: an existing id with the same amount is a no-op. */
  reserve(r: Reservation): Promise<void>;
  setReservation(
    reservationId: string,
    status: Reservation['status'],
    at: number,
  ): Promise<void>;
  reservations(workspaceId: string): Promise<Reservation[]>;
  /** Transfer legs of a policy authorized at or after `since` (any split). */
  transfersSince(policyId: string, since: number): Promise<LegRecord[]>;
  /** Legs of a policy holding a grant or paid (obligation fence). */
  grantedLegs(policyId: string): Promise<LegRecord[]>;
  /** Splits of a policy created at or after `since`. */
  splitsSince(policyId: string, since: number): Promise<SplitRecord[]>;
  events(splitId: string): Promise<SplitEvent[]>;
  /** Non-terminal splits, oldest first (for restart recovery). */
  open(): Promise<SplitRecord[]>;
}

export const GRANTED_STATES: readonly LegState[] = [
  'AUTHORIZED',
  'SUBMITTED',
  'CONFIRMED',
  'RECONCILED',
];

export class MemorySplitStore implements SplitStore {
  private splits = new Map<string, SplitRecord>();
  private legRows = new Map<string, LegRecord>();
  private res = new Map<string, Reservation>();
  private log: SplitEvent[] = [];
  async migrate() {}
  async create(s: SplitRecord) {
    const existing = await this.byReceipt(s.receiptId);
    if (existing) return { split: existing, created: false };
    this.splits.set(s.splitId, s);
    this.log.push({
      splitId: s.splitId,
      seq: 1,
      from: null,
      to: s.state,
      note: s.note,
      at: s.createdAt,
    });
    return { split: s, created: true };
  }
  async get(id: string) {
    return this.splits.get(id) ?? null;
  }
  async byReceipt(receiptId: string) {
    return (
      [...this.splits.values()].find((s) => s.receiptId === receiptId) ?? null
    );
  }
  async advance(
    splitId: string,
    expect: { state: SplitState; rev: number },
    next: { state: SplitState; plan?: AllocationPlan; note?: string | null },
    at: number,
  ) {
    const cur = this.splits.get(splitId);
    if (!cur) throw new AllocationError('NOT_FOUND', splitId);
    assertTransition(expect.state, next.state);
    if (cur.state !== expect.state || cur.rev !== expect.rev)
      throw new AllocationError(
        'CONFLICT',
        `${splitId} is ${cur.state}@${cur.rev}, expected ${expect.state}@${expect.rev}`,
      );
    const updated: SplitRecord = {
      ...cur,
      state: next.state,
      rev: cur.rev + 1,
      plan: next.plan ?? cur.plan,
      note: next.note === undefined ? cur.note : next.note,
      updatedAt: at,
    };
    this.splits.set(splitId, updated);
    this.log.push({
      splitId,
      seq: this.log.filter((e) => e.splitId === splitId).length + 1,
      from: cur.state,
      to: next.state,
      note: next.note ?? null,
      at,
    });
    return updated;
  }
  async putLegs(legs: readonly LegRecord[]) {
    for (const l of legs)
      if (!this.legRows.has(l.legKey)) this.legRows.set(l.legKey, l);
  }
  async legs(splitId: string) {
    return [...this.legRows.values()]
      .filter((l) => l.splitId === splitId)
      .sort((a, b) => a.legIndex - b.legIndex);
  }
  async updateLeg(
    legKey: string,
    expect: LegState,
    patch: Partial<LegRecord> & { state: LegState },
  ) {
    const cur = this.legRows.get(legKey);
    if (!cur) throw new AllocationError('NOT_FOUND', legKey);
    if (cur.state !== expect)
      throw new AllocationError(
        'CONFLICT',
        `${legKey} is ${cur.state}, expected ${expect}`,
      );
    const next = { ...cur, ...patch } as LegRecord;
    this.legRows.set(legKey, next);
    return next;
  }
  async reserve(r: Reservation) {
    const cur = this.res.get(r.reservationId);
    if (cur) {
      if (cur.amount !== r.amount)
        throw new AllocationError(
          'CONFLICT',
          `${r.reservationId} holds ${cur.amount}`,
        );
      return;
    }
    this.res.set(r.reservationId, r);
  }
  async setReservation(id: string, status: Reservation['status'], at: number) {
    const cur = this.res.get(id);
    if (!cur) throw new AllocationError('NOT_FOUND', id);
    if (cur.status === 'ACTIVE')
      this.res.set(id, { ...cur, status, updatedAt: at });
  }
  async reservations(workspaceId: string) {
    return [...this.res.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async transfersSince(policyId: string, since: number) {
    return [...this.legRows.values()].filter(
      (l) =>
        l.policyId === policyId &&
        l.kind === 'TRANSFER' &&
        GRANTED_STATES.includes(l.state) &&
        (l.authorizedAt ?? 0) >= since,
    );
  }
  async grantedLegs(policyId: string) {
    return [...this.legRows.values()].filter(
      (l) => l.policyId === policyId && GRANTED_STATES.includes(l.state),
    );
  }
  async splitsSince(policyId: string, since: number) {
    return [...this.splits.values()].filter(
      (s) => s.policyId === policyId && s.createdAt >= since,
    );
  }
  async events(splitId: string) {
    return this.log.filter((e) => e.splitId === splitId);
  }
  async open() {
    return [...this.splits.values()]
      .filter((s) => !TERMINAL.includes(s.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}
