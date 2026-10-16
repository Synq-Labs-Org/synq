import type { Address, Hex } from 'viem';
import type { ExecutionGrant } from '@synq/kernel/arc';
import type { PolicyRegistration, StoredRevocation } from './registry.js';
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
  /** A hold that was released or rolled forward (no money moved). */
  'RELEASED',
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
  /**
   * On-chain reference emitted with the payment (keccak256 of the leg key),
   * or null when the payment path carries none (plain wallet transfer).
   */
  ref: Hex | null;
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
  /** `treasuryScope(...)`: holds are counted per treasury account and token. */
  scope: string;
  /**
   * What the hold is for, e.g. `bill:<id>@<date>`, `payable:<id>`,
   * `tax:<receiptId>`, `floor:<legKey>`. At most one ACTIVE hold per
   * (scope, workspace, holdKey) except floor top-ups.
   */
  holdKey: string;
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
  /** Every hold on one treasury scope, any workspace. */
  reservations(scope: string): Promise<Reservation[]>;
  /** Transfer legs of a policy authorized at or after `since` (any split). */
  transfersSince(policyId: string, since: number): Promise<LegRecord[]>;
  /** Legs of a policy holding a grant or paid (obligation fence). */
  grantedLegs(policyId: string): Promise<LegRecord[]>;
  /** Splits of a policy created at or after `since`. */
  splitsSince(policyId: string, since: number): Promise<SplitRecord[]>;
  /** Splits of a policy that passed POLICY_VALIDATED at or after `since` (not cancelled). */
  validatedSince(policyId: string, since: number): Promise<string[]>;
  /**
   * Runs `fn` holding the named locks (sorted, held to the end). On
   * Postgres this is one transaction with transaction-scoped advisory locks;
   * `fn` must use the store it is given. Never nest calls.
   */
  atomically<T>(
    locks: readonly string[],
    fn: (tx: SplitStore) => Promise<T>,
  ): Promise<T>;
  /** Insert-if-absent; returns the stored registration. */
  putPolicy(r: PolicyRegistration): Promise<PolicyRegistration>;
  policyVersions(policyId: string): Promise<PolicyRegistration[]>;
  putRevocation(r: StoredRevocation): Promise<void>;
  revocations(policyId: string): Promise<StoredRevocation[]>;
  events(splitId: string): Promise<SplitEvent[]>;
  /** Non-terminal splits, oldest first (for restart recovery). */
  open(): Promise<SplitRecord[]>;
}

export const GRANTED_STATES: readonly LegState[] = [
  'AUTHORIZED',
  'SUBMITTED',
  'CONFIRMED',
  'RECONCILED',
  // May have moved money until a human resolves it.
  'NEEDS_REVIEW',
];

/** A leg that holds a grant or may have paid: counted in windows and fences. */
export const holdsOrSpent = (l: Pick<LegRecord, 'state' | 'txHash'>) =>
  GRANTED_STATES.includes(l.state) || (l.state === 'FAILED' && !!l.txHash);

/** Holds are counted per (chain, token, treasury). */
export const treasuryScope = (p: {
  chainId: number;
  token: string;
  treasury: string;
}) => `${p.chainId}:${p.token.toLowerCase()}:${p.treasury.toLowerCase()}`;

/** Minimal async mutex per key, for the memory store. */
class Locks {
  private tails = new Map<string, Promise<void>>();
  async with<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const releases: (() => void)[] = [];
    for (const k of sorted) {
      const prev = this.tails.get(k) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      this.tails.set(
        k,
        prev.then(() => next),
      );
      await prev;
      releases.push(release);
    }
    try {
      return await fn();
    } finally {
      for (const r of releases) r();
    }
  }
}

/**
 * In-memory store for tests. `atomically` serializes on its locks but does
 * not roll back: callers do their compare-and-set first.
 */
export class MemorySplitStore implements SplitStore {
  private locks = new Locks();
  private policies: PolicyRegistration[] = [];
  private revoked: StoredRevocation[] = [];
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
    if (
      !r.holdKey.startsWith('floor:') &&
      [...this.res.values()].some(
        (x) =>
          x.status === 'ACTIVE' &&
          x.scope === r.scope &&
          x.workspaceId === r.workspaceId &&
          x.holdKey === r.holdKey,
      )
    )
      throw new AllocationError('CONFLICT', `${r.holdKey} is already held`);
    this.res.set(r.reservationId, r);
  }
  async setReservation(id: string, status: Reservation['status'], at: number) {
    const cur = this.res.get(id);
    if (!cur) throw new AllocationError('NOT_FOUND', id);
    if (cur.status === 'ACTIVE')
      this.res.set(id, { ...cur, status, updatedAt: at });
  }
  async reservations(scope: string) {
    return [...this.res.values()].filter((r) => r.scope === scope);
  }
  async transfersSince(policyId: string, since: number) {
    return [...this.legRows.values()].filter(
      (l) =>
        l.policyId === policyId &&
        l.kind === 'TRANSFER' &&
        holdsOrSpent(l) &&
        (l.authorizedAt ?? 0) >= since,
    );
  }
  async grantedLegs(policyId: string) {
    return [...this.legRows.values()].filter(
      (l) => l.policyId === policyId && holdsOrSpent(l),
    );
  }
  async validatedSince(policyId: string, since: number) {
    const ids = new Set(
      this.log
        .filter((e) => e.to === 'POLICY_VALIDATED' && e.at >= since)
        .map((e) => e.splitId),
    );
    return [...ids].filter((id) => {
      const s = this.splits.get(id);
      return s && s.policyId === policyId && s.state !== 'CANCELLED';
    });
  }
  async atomically<T>(
    locks: readonly string[],
    fn: (tx: SplitStore) => Promise<T>,
  ): Promise<T> {
    return this.locks.with(locks, () => fn(this));
  }
  async putPolicy(r: PolicyRegistration) {
    const cur = this.policies.find(
      (x) => x.policyId === r.policyId && x.version === r.version,
    );
    if (cur) return cur;
    this.policies.push(r);
    return r;
  }
  async policyVersions(policyId: string) {
    return this.policies.filter((x) => x.policyId === policyId);
  }
  async putRevocation(r: StoredRevocation) {
    this.revoked.push(r);
  }
  async revocations(policyId: string) {
    return this.revoked.filter((x) => x.policyId === policyId);
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
