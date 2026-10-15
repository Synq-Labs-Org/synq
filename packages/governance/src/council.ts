import { hashTypedData, zeroAddress, type Address, type Hex } from 'viem';
import { transferActionHash } from '@synq/kernel/arc';
import {
  addr,
  deepFreeze,
  governanceDomain,
  recoverSigner,
  sameAddress,
} from './common.js';
import { tally, type AcceptedVote } from './ballot.js';
import type { DelegationRecord } from './delegation.js';
import { GovernanceError } from './errors.js';
import { policyHash, type GovernancePolicy } from './policy.js';
import { verifySnapshot, type BallotSnapshot } from './snapshot.js';

/**
 * A small owner council executes for a large community.
 *
 * - Each seat is held by a distinct wallet. An action needs M distinct
 *   seat-holder signatures recovered from EIP-712 signatures over the exact
 *   action, which binds council, term, policy hash, effect, nonce and expiry.
 * - Approved decisions are recorded with their signatures. Execution never
 *   trusts a decision object: it reloads it, re-verifies every signature
 *   against the current term and policy, recomputes the challenge window, and
 *   consumes it atomically. A decision executes at most once.
 * - Terms advance monotonically in a `CouncilStore`. Rotating or installing a
 *   term retires the previous one at the new term's start, so a retired term
 *   can never approve or execute again.
 */
export type CouncilSeat = Readonly<{ seatId: string; holder: Address }>;
export type CouncilTerm = Readonly<{
  councilId: string;
  workspaceId: string;
  chainId: number;
  termId: number;
  seats: readonly CouncilSeat[];
  threshold: number;
  startsAt: number;
  endsAt: number;
}>;

export const COUNCIL_ACTION_KINDS = [
  'WITHDRAWAL',
  'POLICY_CHANGE',
  'ROTATE_TERM',
  'EXECUTE_BALLOT',
] as const;
export type CouncilActionKind = (typeof COUNCIL_ACTION_KINDS)[number];

export type CouncilAction = Readonly<{
  councilId: string;
  workspaceId: string;
  chainId: number;
  termId: number;
  termHash: Hex;
  /** Policy in force when signed; a policy change voids pending decisions. */
  policyHash: Hex;
  kind: CouncilActionKind;
  /** Hash of the exact effect (transfer, policy diff, next term, ballot result). */
  actionHash: Hex;
  nonce: Hex;
  /** Signed proposal time: the challenge window never starts before it. */
  proposedAt: number;
  expiresAt: number;
}>;

export type CouncilDecision = Readonly<{
  digest: Hex;
  action: CouncilAction;
  /** The seat-holder signatures that met the threshold, re-verified at execution. */
  signatures: readonly Hex[];
  signers: readonly Address[];
  approvedAt: number;
  challengeEndsAt: number;
}>;

export type DecisionChallenge = Readonly<{
  chainId: number;
  decisionDigest: Hex;
  challenger: Address;
  reasonHash: Hex;
  raisedAt: number;
}>;
export type AcceptedChallenge = Readonly<
  DecisionChallenge & { signature: Hex }
>;

export type TermRecord = Readonly<{
  term: CouncilTerm;
  hash: Hex;
  /** The term stops being current here: its own end, or its successor's start. */
  effectiveEnd: number;
}>;

export type ExecutionReceipt = Readonly<{
  digest: Hex;
  kind: CouncilActionKind;
  actionHash: Hex;
  executedAt: number;
  signers: readonly Address[];
}>;

export interface CouncilStore {
  /** Installs a council's first term; false if it already has one. */
  bootstrapTerm(record: TermRecord): Promise<boolean>;
  terms(councilId: string): Promise<readonly TermRecord[]>;
  /**
   * Atomic compare-and-set: appends `next` only if `fromTermId` is still the
   * latest term, and retires that term at `retireAt`.
   */
  advanceTerm(
    councilId: string,
    fromTermId: number,
    retireAt: number,
    next: TermRecord,
  ): Promise<boolean>;
  /** False when a decision with this digest is already recorded. */
  insertDecision(decision: CouncilDecision): Promise<boolean>;
  getDecision(digest: Hex): Promise<CouncilDecision | null>;
  insertChallenge(challenge: AcceptedChallenge): Promise<void>;
  listChallenges(digest: Hex): Promise<readonly AcceptedChallenge[]>;
  /**
   * Atomically marks a decision executed. False when the digest, or the
   * council's nonce, was already consumed.
   */
  consumeDecision(input: {
    digest: Hex;
    councilId: string;
    nonce: Hex;
    at: number;
  }): Promise<boolean>;
  executedAt(digest: Hex): Promise<number | null>;
}

export class MemoryCouncilStore implements CouncilStore {
  private termLog = new Map<string, TermRecord[]>();
  private decisions = new Map<string, CouncilDecision>();
  private challenges = new Map<string, AcceptedChallenge[]>();
  private executed = new Map<string, number>();
  private nonces = new Set<string>();
  async bootstrapTerm(record: TermRecord) {
    if (this.termLog.has(record.term.councilId)) return false;
    this.termLog.set(record.term.councilId, [record]);
    return true;
  }
  async terms(councilId: string) {
    return [...(this.termLog.get(councilId) ?? [])];
  }
  async advanceTerm(
    councilId: string,
    fromTermId: number,
    retireAt: number,
    next: TermRecord,
  ) {
    const log = this.termLog.get(councilId);
    const latest = log?.at(-1);
    if (!log || !latest || latest.term.termId !== fromTermId) return false;
    log[log.length - 1] = deepFreeze({
      ...latest,
      effectiveEnd: Math.min(latest.effectiveEnd, retireAt),
    });
    log.push(next);
    return true;
  }
  async insertDecision(decision: CouncilDecision) {
    if (this.decisions.has(decision.digest)) return false;
    this.decisions.set(decision.digest, decision);
    return true;
  }
  async getDecision(digest: Hex) {
    return this.decisions.get(digest) ?? null;
  }
  async insertChallenge(challenge: AcceptedChallenge) {
    const list = this.challenges.get(challenge.decisionDigest) ?? [];
    this.challenges.set(challenge.decisionDigest, [...list, challenge]);
  }
  async listChallenges(digest: Hex) {
    return this.challenges.get(digest) ?? [];
  }
  async consumeDecision(input: {
    digest: Hex;
    councilId: string;
    nonce: Hex;
    at: number;
  }) {
    const nonceKey = `${input.councilId}/${input.nonce}`;
    if (this.executed.has(input.digest) || this.nonces.has(nonceKey))
      return false;
    this.executed.set(input.digest, input.at);
    this.nonces.add(nonceKey);
    return true;
  }
  async executedAt(digest: Hex) {
    return this.executed.get(digest) ?? null;
  }
}

export function termTypedData(t: CouncilTerm) {
  return {
    domain: governanceDomain(t.chainId),
    types: {
      CouncilTerm: [
        { name: 'councilId', type: 'string' },
        { name: 'workspaceId', type: 'string' },
        { name: 'termId', type: 'uint64' },
        { name: 'seats', type: 'CouncilSeat[]' },
        { name: 'threshold', type: 'uint8' },
        { name: 'startsAt', type: 'uint64' },
        { name: 'endsAt', type: 'uint64' },
      ],
      CouncilSeat: [
        { name: 'seatId', type: 'string' },
        { name: 'holder', type: 'address' },
      ],
    },
    primaryType: 'CouncilTerm' as const,
    message: {
      councilId: t.councilId,
      workspaceId: t.workspaceId,
      termId: BigInt(t.termId),
      seats: t.seats.map((s) => ({ seatId: s.seatId, holder: s.holder })),
      threshold: t.threshold,
      startsAt: BigInt(t.startsAt),
      endsAt: BigInt(t.endsAt),
    },
  };
}
export const termHash = (t: CouncilTerm): Hex =>
  hashTypedData(termTypedData(t));

export function validateTerm(t: CouncilTerm, policy: GovernancePolicy): void {
  const bad = (why: string) => {
    throw new GovernanceError('BAD_COUNCIL', why);
  };
  if (t.workspaceId !== policy.workspaceId || t.chainId !== policy.chainId)
    bad('term belongs to another workspace or chain');
  if (!Number.isSafeInteger(t.termId) || t.termId < 1) bad('term id');
  if (t.seats.length !== policy.councilSize)
    bad(`${t.seats.length} seats; policy requires ${policy.councilSize}`);
  if (t.threshold !== policy.councilThreshold)
    bad(`threshold ${t.threshold}; policy requires ${policy.councilThreshold}`);
  if (new Set(t.seats.map((s) => s.seatId)).size !== t.seats.length)
    bad('duplicate seat id');
  const holders = t.seats.map((s) => addr(s.holder).toLowerCase());
  if (new Set(holders).size !== holders.length)
    bad('one wallet holds two seats; seats need independent signers');
  if (holders.includes(zeroAddress)) bad('empty seat');
  if (!(t.startsAt < t.endsAt) || t.endsAt - t.startsAt > policy.termSeconds)
    bad('term length outside policy');
}

const termRecord = (t: CouncilTerm): TermRecord =>
  deepFreeze({ term: { ...t }, hash: termHash(t), effectiveEnd: t.endsAt });

/** Installs the council's genesis term (set by the workspace constitution). */
export async function establishCouncil(input: {
  store: CouncilStore;
  term: CouncilTerm;
  policy: GovernancePolicy;
}): Promise<TermRecord> {
  validateTerm(input.term, input.policy);
  const record = termRecord(input.term);
  if (!(await input.store.bootstrapTerm(record)))
    throw new GovernanceError(
      'BAD_COUNCIL',
      'council already established; terms only advance by rotation or ballot',
    );
  return record;
}

/** The term that is current at `at`, from the monotonic term log. */
export async function currentTerm(
  store: CouncilStore,
  councilId: string,
  at: number,
): Promise<TermRecord | null> {
  return (
    (await store.terms(councilId)).find(
      (r) => r.term.startsAt <= at && at < r.effectiveEnd,
    ) ?? null
  );
}

async function requireCurrentTerm(
  store: CouncilStore,
  term: CouncilTerm,
  now: number,
): Promise<TermRecord> {
  const current = await currentTerm(store, term.councilId, now);
  if (!current || current.hash !== termHash(term))
    throw new GovernanceError(
      'TERM_INACTIVE',
      `term ${term.termId} is not the council's current term`,
    );
  return current;
}

export function councilActionTypedData(a: CouncilAction) {
  return {
    domain: governanceDomain(a.chainId),
    types: {
      CouncilAction: [
        { name: 'councilId', type: 'string' },
        { name: 'workspaceId', type: 'string' },
        { name: 'termId', type: 'uint64' },
        { name: 'termHash', type: 'bytes32' },
        { name: 'policyHash', type: 'bytes32' },
        { name: 'kind', type: 'string' },
        { name: 'actionHash', type: 'bytes32' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'proposedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'CouncilAction' as const,
    message: {
      councilId: a.councilId,
      workspaceId: a.workspaceId,
      termId: BigInt(a.termId),
      termHash: a.termHash,
      policyHash: a.policyHash,
      kind: a.kind,
      actionHash: a.actionHash,
      nonce: a.nonce,
      proposedAt: BigInt(a.proposedAt),
      expiresAt: BigInt(a.expiresAt),
    },
  };
}
export const councilActionDigest = (a: CouncilAction): Hex =>
  hashTypedData(councilActionTypedData(a));

/** The exact Arc ERC-20 transfer a WITHDRAWAL approves (same hash the Kernel grants bind). */
export const withdrawalActionHash = transferActionHash;

function assertActionFor(
  term: CouncilTerm,
  policy: GovernancePolicy,
  action: CouncilAction,
  now: number,
) {
  if (
    action.councilId !== term.councilId ||
    action.workspaceId !== term.workspaceId ||
    action.chainId !== term.chainId ||
    action.termId !== term.termId ||
    action.termHash !== termHash(term)
  )
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'action is bound to another council term',
    );
  if (action.policyHash !== policyHash(policy))
    throw new GovernanceError(
      'POLICY_CHANGED',
      'action was signed under another policy',
    );
  if (!COUNCIL_ACTION_KINDS.includes(action.kind))
    throw new GovernanceError('ACTION_MISMATCH', 'unknown action kind');
  if (action.proposedAt > now)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'action proposed in the future',
    );
  if (now >= action.expiresAt)
    throw new GovernanceError('ACTION_MISMATCH', 'action expired');
}

export type QuorumReport = Readonly<{
  met: boolean;
  threshold: number;
  seats: number;
  /** Distinct seat holders whose signatures recovered, in seat order. */
  signers: readonly Address[];
  /** The counted signatures, in seat order. */
  signatures: readonly Hex[];
  rejected: readonly {
    index: number;
    signer: Address | null;
    reason: 'UNRECOVERABLE' | 'NOT_A_SEAT_HOLDER' | 'DUPLICATE_SIGNER';
  }[];
}>;

/**
 * Counts distinct seat holders of the council's *current* term who signed
 * exactly this action under the current policy.
 */
export async function verifyCouncilSignatures(input: {
  store: CouncilStore;
  term: CouncilTerm;
  policy: GovernancePolicy;
  action: CouncilAction;
  signatures: readonly unknown[];
  now: number;
}): Promise<QuorumReport> {
  const { term, action } = input;
  validateTerm(term, input.policy);
  await requireCurrentTerm(input.store, term, input.now);
  assertActionFor(term, input.policy, action, input.now);
  const typed = councilActionTypedData(action);
  const counted = new Map<string, Hex>();
  const rejected: QuorumReport['rejected'][number][] = [];
  for (const [index, signature] of input.signatures.entries()) {
    const signer = await recoverSigner(typed, signature);
    if (!signer) rejected.push({ index, signer, reason: 'UNRECOVERABLE' });
    else if (!term.seats.some((s) => sameAddress(s.holder, signer)))
      rejected.push({ index, signer, reason: 'NOT_A_SEAT_HOLDER' });
    else if (counted.has(signer.toLowerCase()))
      rejected.push({ index, signer, reason: 'DUPLICATE_SIGNER' });
    else counted.set(signer.toLowerCase(), signature as Hex);
  }
  const signers = term.seats
    .map((s) => addr(s.holder))
    .filter((h) => counted.has(h.toLowerCase()));
  return deepFreeze({
    met: signers.length >= term.threshold,
    threshold: term.threshold,
    seats: term.seats.length,
    signers,
    signatures: signers.map((h) => counted.get(h.toLowerCase())!),
    rejected,
  });
}

const windowEnd = (
  d: Pick<CouncilDecision, 'approvedAt' | 'action'>,
  policy: GovernancePolicy,
) =>
  Math.max(d.approvedAt, d.action.proposedAt) + policy.challengeWindowSeconds;

/** M-of-N approval, recorded with its signatures; below threshold is refused with the exact count. */
export async function approveCouncilAction(input: {
  store: CouncilStore;
  term: CouncilTerm;
  policy: GovernancePolicy;
  action: CouncilAction;
  signatures: readonly unknown[];
  now: number;
}): Promise<CouncilDecision> {
  const report = await verifyCouncilSignatures(input);
  if (!report.met)
    throw new GovernanceError(
      'QUORUM_NOT_MET',
      `${report.signers.length} of ${report.seats} seat holders signed; policy requires ${report.threshold}-of-${report.seats}`,
    );
  const digest = councilActionDigest(input.action);
  const existing = await input.store.getDecision(digest);
  if (existing) return existing;
  const recorded: CouncilDecision = deepFreeze({
    digest,
    action: { ...input.action },
    signatures: report.signatures,
    signers: report.signers,
    approvedAt: input.now,
    challengeEndsAt: windowEnd(
      { approvedAt: input.now, action: input.action },
      input.policy,
    ),
  });
  if (recorded.action.expiresAt <= recorded.challengeEndsAt)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'action expires before its challenge window ends',
    );
  if (!(await input.store.insertDecision(recorded)))
    return loadDecision(input.store, digest);
  return recorded;
}

export function challengeTypedData(c: DecisionChallenge) {
  return {
    domain: governanceDomain(c.chainId),
    types: {
      DecisionChallenge: [
        { name: 'decisionDigest', type: 'bytes32' },
        { name: 'challenger', type: 'address' },
        { name: 'reasonHash', type: 'bytes32' },
        { name: 'raisedAt', type: 'uint64' },
      ],
    },
    primaryType: 'DecisionChallenge' as const,
    message: {
      decisionDigest: c.decisionDigest,
      challenger: c.challenger,
      reasonHash: c.reasonHash,
      raisedAt: BigInt(c.raisedAt),
    },
  };
}

async function loadDecision(
  store: CouncilStore,
  digest: Hex,
): Promise<CouncilDecision> {
  const d = await store.getDecision(digest);
  if (!d || councilActionDigest(d.action) !== digest)
    throw new GovernanceError(
      'UNKNOWN_DECISION',
      'no recorded council decision with this digest',
    );
  return d;
}

/**
 * A seat holder or eligible member (the caller supplies who may challenge)
 * halts a recorded decision inside its window with a signed challenge.
 */
export async function admitChallenge(input: {
  store: CouncilStore;
  policy: GovernancePolicy;
  digest: Hex;
  challenge: DecisionChallenge;
  signature: unknown;
  challengers: readonly Address[];
  now: number;
}): Promise<AcceptedChallenge> {
  const { challenge: c, now } = input;
  const d = await loadDecision(input.store, input.digest);
  if (c.decisionDigest !== d.digest || c.chainId !== d.action.chainId)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'challenge names another decision',
    );
  if (
    now >= windowEnd(d, input.policy) ||
    c.raisedAt > now ||
    c.raisedAt < d.approvedAt
  )
    throw new GovernanceError('CHALLENGE_WINDOW_CLOSED');
  if (!input.challengers.some((w) => sameAddress(w, c.challenger)))
    throw new GovernanceError('NOT_A_CHALLENGER');
  const signer = await recoverSigner(challengeTypedData(c), input.signature);
  if (!signer || !sameAddress(signer, c.challenger))
    throw new GovernanceError(
      'BAD_SIGNATURE',
      'challenge not signed by the challenger',
    );
  const accepted = deepFreeze({
    ...c,
    challenger: signer,
    signature: input.signature as Hex,
  });
  await input.store.insertChallenge(accepted);
  return accepted;
}

export type DecisionStatus =
  | 'CHALLENGE_WINDOW'
  | 'CHALLENGED'
  | 'EXECUTABLE'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'TERM_ENDED'
  | 'POLICY_CHANGED';

/** Status from the store only; challenges are re-verified, the window recomputed. */
export async function decisionStatus(input: {
  store: CouncilStore;
  digest: Hex;
  policy: GovernancePolicy;
  now: number;
}): Promise<DecisionStatus> {
  const { store, now } = input;
  const d = await loadDecision(store, input.digest);
  if ((await store.executedAt(d.digest)) !== null) return 'EXECUTED';
  for (const c of await store.listChallenges(d.digest)) {
    const signer = await recoverSigner(challengeTypedData(c), c.signature);
    if (
      signer &&
      sameAddress(signer, c.challenger) &&
      c.decisionDigest === d.digest
    )
      return 'CHALLENGED';
  }
  if (d.action.policyHash !== policyHash(input.policy)) return 'POLICY_CHANGED';
  const current = await currentTerm(store, d.action.councilId, now);
  if (!current || current.hash !== d.action.termHash) return 'TERM_ENDED';
  if (now >= d.action.expiresAt) return 'EXPIRED';
  if (now < windowEnd(d, input.policy)) return 'CHALLENGE_WINDOW';
  return 'EXECUTABLE';
}

/**
 * Read-only check that a recorded decision may execute exactly this effect
 * now: status EXECUTABLE and every stored signature re-verified against the
 * current term and policy.
 */
export async function assertExecutable(input: {
  store: CouncilStore;
  decision: Pick<CouncilDecision, 'digest'>;
  policy: GovernancePolicy;
  now: number;
  kind: CouncilActionKind;
  actionHash: Hex;
}): Promise<CouncilDecision> {
  const { store } = input;
  const d = await loadDecision(store, input.decision.digest);
  if (d.action.kind !== input.kind || d.action.actionHash !== input.actionHash)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'the decision approved a different effect',
    );
  const status = await decisionStatus({
    store,
    digest: d.digest,
    policy: input.policy,
    now: input.now,
  });
  const refuse: Record<
    Exclude<DecisionStatus, 'EXECUTABLE'>,
    [ConstructorParameters<typeof GovernanceError>[0], string]
  > = {
    EXECUTED: ['ALREADY_EXECUTED', 'decision already executed'],
    CHALLENGED: ['CHALLENGED', 'decision was challenged'],
    POLICY_CHANGED: ['POLICY_CHANGED', 'policy changed since approval'],
    TERM_ENDED: ['TERM_INACTIVE', 'approving term is no longer current'],
    EXPIRED: ['ACTION_MISMATCH', 'action expired'],
    CHALLENGE_WINDOW: [
      'CHALLENGE_WINDOW_OPEN',
      `executable after ${windowEnd(d, input.policy)}`,
    ],
  };
  if (status !== 'EXECUTABLE') throw new GovernanceError(...refuse[status]);
  const current = (await currentTerm(store, d.action.councilId, input.now))!;
  const report = await verifyCouncilSignatures({
    store,
    term: current.term,
    policy: input.policy,
    action: d.action,
    signatures: d.signatures,
    now: input.now,
  });
  if (!report.met)
    throw new GovernanceError(
      'QUORUM_NOT_MET',
      `recorded decision re-verifies to ${report.signers.length} of ${report.seats} seat holders`,
    );
  return d;
}

/** Executes a recorded decision once: re-verifies, then consumes atomically. */
export async function executeDecision(input: {
  store: CouncilStore;
  decision: Pick<CouncilDecision, 'digest'>;
  policy: GovernancePolicy;
  now: number;
  kind: CouncilActionKind;
  actionHash: Hex;
}): Promise<ExecutionReceipt> {
  const d = await assertExecutable(input);
  if (
    !(await input.store.consumeDecision({
      digest: d.digest,
      councilId: d.action.councilId,
      nonce: d.action.nonce,
      at: input.now,
    }))
  )
    throw new GovernanceError(
      'ALREADY_EXECUTED',
      'decision or its nonce already executed',
    );
  return deepFreeze({
    digest: d.digest,
    kind: d.action.kind,
    actionHash: d.action.actionHash,
    executedAt: input.now,
    signers: d.signers,
  });
}

async function successorChecks(
  store: CouncilStore,
  next: CouncilTerm,
  policy: GovernancePolicy,
  now: number,
): Promise<TermRecord> {
  validateTerm(next, policy);
  const log = await store.terms(next.councilId);
  const latest = log.at(-1);
  if (!latest)
    throw new GovernanceError('BAD_COUNCIL', 'council not established');
  if (latest.term.startsAt > now)
    throw new GovernanceError(
      'BAD_COUNCIL',
      'a successor term is already scheduled; terms cannot fork',
    );
  if (next.termId !== latest.term.termId + 1)
    throw new GovernanceError(
      'BAD_COUNCIL',
      `next term must be ${latest.term.termId + 1}`,
    );
  if (next.startsAt < now)
    throw new GovernanceError('BAD_COUNCIL', 'next term is back-dated');
  return latest;
}

/**
 * Term rotation approved by the sitting council (M-of-N, after the challenge
 * window, executed once). The sitting term is retired at the new term's start.
 */
export async function rotateTerm(input: {
  store: CouncilStore;
  next: CouncilTerm;
  policy: GovernancePolicy;
  decision: Pick<CouncilDecision, 'digest'>;
  now: number;
}): Promise<TermRecord> {
  const { store, next, now } = input;
  const latest = await successorChecks(store, next, input.policy, now);
  if (next.startsAt > latest.effectiveEnd)
    throw new GovernanceError('BAD_COUNCIL', 'gap between terms');
  const d = await loadDecision(store, input.decision.digest);
  if (d.action.termHash !== latest.hash)
    throw new GovernanceError(
      'TERM_INACTIVE',
      'rotation must be approved by the sitting term',
    );
  await executeDecision({
    store,
    decision: d,
    policy: input.policy,
    now,
    kind: 'ROTATE_TERM',
    actionHash: termHash(next),
  });
  const record = termRecord(next);
  if (
    !(await store.advanceTerm(
      next.councilId,
      latest.term.termId,
      next.startsAt,
      record,
    ))
  )
    throw new GovernanceError('BAD_COUNCIL', 'term log advanced concurrently');
  return record;
}

/**
 * When the sitting term has ended (or cannot reach quorum), members install
 * the next term through a passed, final ballot on exactly that term. The
 * tally is recomputed here from the snapshot, signed votes and delegations.
 */
export async function installTermFromBallot(input: {
  store: CouncilStore;
  next: CouncilTerm;
  policy: GovernancePolicy;
  snapshot: BallotSnapshot;
  votes: readonly AcceptedVote[];
  delegations: readonly DelegationRecord[];
  now: number;
}): Promise<TermRecord> {
  const { store, next, now, policy } = input;
  verifySnapshot(input.snapshot, policy);
  const result = await tally({
    snapshot: input.snapshot,
    policy,
    votes: input.votes,
    delegations: input.delegations,
    at: now,
  });
  if (
    !result.final ||
    result.status !== 'PASSED' ||
    result.proposalHash !== termHash(next)
  )
    throw new GovernanceError(
      'QUORUM_NOT_MET',
      `a passed, final ballot on exactly this term is required (ballot is ${result.status})`,
    );
  const latest = await successorChecks(store, next, policy, now);
  const record = termRecord(next);
  if (
    !(await store.advanceTerm(
      next.councilId,
      latest.term.termId,
      Math.min(latest.effectiveEnd, next.startsAt),
      record,
    ))
  )
    throw new GovernanceError('BAD_COUNCIL', 'term log advanced concurrently');
  return record;
}
