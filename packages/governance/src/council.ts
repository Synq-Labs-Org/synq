import { hashTypedData, zeroAddress, type Address, type Hex } from 'viem';
import { transferActionHash } from '@synq/kernel/arc';
import {
  addr,
  deepFreeze,
  governanceDomain,
  recoverSigner,
  sameAddress,
} from './common.js';
import { GovernanceError } from './errors.js';
import { policyHash, type GovernancePolicy } from './policy.js';
import type { TallyResult } from './ballot.js';

/**
 * A small owner council executes for a large community. Each seat is held by
 * a distinct wallet; an action needs M distinct seat-holder signatures,
 * recovered from EIP-712 signatures over the exact action (duplicates and
 * non-holders never count). An approved action then waits out a challenge
 * window before it can execute, and only while the approving term is current.
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
  kind: CouncilActionKind;
  /** Hash of the exact effect (transfer, policy diff, next term, ballot result). */
  actionHash: Hex;
  nonce: Hex;
  expiresAt: number;
}>;

export type CouncilDecision = Readonly<{
  digest: Hex;
  action: CouncilAction;
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

export function councilActionTypedData(a: CouncilAction) {
  return {
    domain: governanceDomain(a.chainId),
    types: {
      CouncilAction: [
        { name: 'councilId', type: 'string' },
        { name: 'workspaceId', type: 'string' },
        { name: 'termId', type: 'uint64' },
        { name: 'termHash', type: 'bytes32' },
        { name: 'kind', type: 'string' },
        { name: 'actionHash', type: 'bytes32' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'CouncilAction' as const,
    message: {
      councilId: a.councilId,
      workspaceId: a.workspaceId,
      termId: BigInt(a.termId),
      termHash: a.termHash,
      kind: a.kind,
      actionHash: a.actionHash,
      nonce: a.nonce,
      expiresAt: BigInt(a.expiresAt),
    },
  };
}
export const councilActionDigest = (a: CouncilAction): Hex =>
  hashTypedData(councilActionTypedData(a));

/** The exact Arc ERC-20 transfer a WITHDRAWAL approves (same hash the Kernel grants bind). */
export const withdrawalActionHash = transferActionHash;

function assertActionForTerm(
  term: CouncilTerm,
  action: CouncilAction,
  now: number,
) {
  if (now < term.startsAt || now >= term.endsAt)
    throw new GovernanceError(
      'TERM_INACTIVE',
      `term ${term.termId} is not active`,
    );
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
  if (!COUNCIL_ACTION_KINDS.includes(action.kind))
    throw new GovernanceError('ACTION_MISMATCH', 'unknown action kind');
  if (now >= action.expiresAt)
    throw new GovernanceError('ACTION_MISMATCH', 'action expired');
}

export type QuorumReport = Readonly<{
  met: boolean;
  threshold: number;
  seats: number;
  /** Distinct seat holders whose signatures recovered, in seat order. */
  signers: readonly Address[];
  rejected: readonly {
    index: number;
    signer: Address | null;
    reason: 'UNRECOVERABLE' | 'NOT_A_SEAT_HOLDER' | 'DUPLICATE_SIGNER';
  }[];
}>;

/** Counts distinct seat holders who signed exactly this action. */
export async function verifyCouncilSignatures(input: {
  term: CouncilTerm;
  policy: GovernancePolicy;
  action: CouncilAction;
  signatures: readonly unknown[];
  now: number;
}): Promise<QuorumReport> {
  const { term, action } = input;
  validateTerm(term, input.policy);
  assertActionForTerm(term, action, input.now);
  const typed = councilActionTypedData(action);
  const seen = new Set<string>();
  const rejected: QuorumReport['rejected'][number][] = [];
  for (const [index, signature] of input.signatures.entries()) {
    const signer = await recoverSigner(typed, signature);
    if (!signer) rejected.push({ index, signer, reason: 'UNRECOVERABLE' });
    else if (!term.seats.some((s) => sameAddress(s.holder, signer)))
      rejected.push({ index, signer, reason: 'NOT_A_SEAT_HOLDER' });
    else if (seen.has(signer.toLowerCase()))
      rejected.push({ index, signer, reason: 'DUPLICATE_SIGNER' });
    else seen.add(signer.toLowerCase());
  }
  const signers = term.seats
    .map((s) => addr(s.holder))
    .filter((h) => seen.has(h.toLowerCase()));
  return deepFreeze({
    met: signers.length >= term.threshold,
    threshold: term.threshold,
    seats: term.seats.length,
    signers,
    rejected,
  });
}

/** M-of-N approval; below threshold is refused with the exact count. */
export async function approveCouncilAction(input: {
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
  const challengeEndsAt = input.now + input.policy.challengeWindowSeconds;
  if (input.action.expiresAt <= challengeEndsAt)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'action expires before its challenge window ends',
    );
  return deepFreeze({
    digest: councilActionDigest(input.action),
    action: input.action,
    signers: report.signers,
    approvedAt: input.now,
    challengeEndsAt,
  });
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

/**
 * A seat holder or eligible member (the caller supplies who may challenge)
 * halts a decision inside its window with a signed challenge.
 */
export async function admitChallenge(input: {
  decision: CouncilDecision;
  challenge: DecisionChallenge;
  signature: unknown;
  challengers: readonly Address[];
  now: number;
}): Promise<AcceptedChallenge> {
  const { decision: d, challenge: c, now } = input;
  if (c.decisionDigest !== d.digest || c.chainId !== d.action.chainId)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'challenge names another decision',
    );
  if (now >= d.challengeEndsAt || c.raisedAt > now || c.raisedAt < d.approvedAt)
    throw new GovernanceError('CHALLENGE_WINDOW_CLOSED');
  if (!input.challengers.some((w) => sameAddress(w, c.challenger)))
    throw new GovernanceError('NOT_A_CHALLENGER');
  const signer = await recoverSigner(challengeTypedData(c), input.signature);
  if (!signer || !sameAddress(signer, c.challenger))
    throw new GovernanceError(
      'BAD_SIGNATURE',
      'challenge not signed by the challenger',
    );
  return deepFreeze({
    ...c,
    challenger: signer,
    signature: input.signature as Hex,
  });
}

export type DecisionStatus =
  | 'CHALLENGE_WINDOW'
  | 'CHALLENGED'
  | 'EXECUTABLE'
  | 'EXPIRED'
  | 'TERM_ENDED';

export function decisionStatus(input: {
  decision: CouncilDecision;
  term: CouncilTerm;
  challenges: readonly AcceptedChallenge[];
  now: number;
}): DecisionStatus {
  const { decision: d, term, now } = input;
  if (input.challenges.some((c) => c.decisionDigest === d.digest))
    return 'CHALLENGED';
  if (
    term.termId !== d.action.termId ||
    termHash(term) !== d.action.termHash ||
    now >= term.endsAt
  )
    return 'TERM_ENDED';
  if (now >= d.action.expiresAt) return 'EXPIRED';
  if (now < d.challengeEndsAt) return 'CHALLENGE_WINDOW';
  return 'EXECUTABLE';
}

export function assertExecutable(input: {
  decision: CouncilDecision;
  term: CouncilTerm;
  challenges: readonly AcceptedChallenge[];
  now: number;
  kind: CouncilActionKind;
  actionHash: Hex;
}): void {
  const { decision: d } = input;
  if (d.action.kind !== input.kind || d.action.actionHash !== input.actionHash)
    throw new GovernanceError(
      'ACTION_MISMATCH',
      'the decision approved a different effect',
    );
  const status = decisionStatus(input);
  if (status === 'CHALLENGE_WINDOW')
    throw new GovernanceError(
      'CHALLENGE_WINDOW_OPEN',
      `executable after ${d.challengeEndsAt}`,
    );
  if (status === 'CHALLENGED')
    throw new GovernanceError('CHALLENGED', 'decision was challenged');
  if (status === 'TERM_ENDED')
    throw new GovernanceError(
      'TERM_INACTIVE',
      'approving term is no longer current',
    );
  if (status === 'EXPIRED')
    throw new GovernanceError('ACTION_MISMATCH', 'action expired');
}

function assertSuccessor(current: CouncilTerm, next: CouncilTerm) {
  if (
    next.councilId !== current.councilId ||
    next.termId !== current.termId + 1
  )
    throw new GovernanceError(
      'BAD_COUNCIL',
      'next term must succeed the current one',
    );
  if (next.startsAt > current.endsAt)
    throw new GovernanceError('BAD_COUNCIL', 'gap between terms');
}

/** Term rotation approved by the sitting council (M-of-N, after the challenge window). */
export function rotateTerm(input: {
  current: CouncilTerm;
  next: CouncilTerm;
  policy: GovernancePolicy;
  decision: CouncilDecision;
  challenges: readonly AcceptedChallenge[];
  now: number;
}): CouncilTerm {
  validateTerm(input.next, input.policy);
  assertSuccessor(input.current, input.next);
  if (input.next.endsAt <= input.now)
    throw new GovernanceError('BAD_COUNCIL', 'next term already over');
  assertExecutable({
    decision: input.decision,
    term: input.current,
    challenges: input.challenges,
    now: input.now,
    kind: 'ROTATE_TERM',
    actionHash: termHash(input.next),
  });
  return deepFreeze({ ...input.next });
}

/**
 * When the sitting term has ended (or cannot reach quorum), members install
 * the next term through a passed, final ballot whose proposal is that term.
 */
export function installTermFromBallot(input: {
  previous: CouncilTerm;
  next: CouncilTerm;
  policy: GovernancePolicy;
  result: TallyResult;
  now: number;
}): CouncilTerm {
  const { result } = input;
  validateTerm(input.next, input.policy);
  if (
    input.next.councilId !== input.previous.councilId ||
    input.next.termId !== input.previous.termId + 1
  )
    throw new GovernanceError(
      'BAD_COUNCIL',
      'next term must succeed the previous one',
    );
  if (
    !result.final ||
    result.status !== 'PASSED' ||
    result.policyHash !== policyHash(input.policy) ||
    result.proposalHash !== termHash(input.next)
  )
    throw new GovernanceError(
      'QUORUM_NOT_MET',
      'a passed, final ballot on exactly this term is required',
    );
  if (input.next.endsAt <= input.now)
    throw new GovernanceError('BAD_COUNCIL', 'next term already over');
  return deepFreeze({ ...input.next });
}
