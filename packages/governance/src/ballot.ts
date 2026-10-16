import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import {
  BPS,
  addr,
  deepFreeze,
  governanceDomain,
  recoverSigner,
  sameAddress,
} from './common.js';
import {
  delegationChain,
  delegationConcentration,
  indexDelegations,
  quarantinedWallets,
  representationError,
  verifyDelegationRecords,
  type DelegationRecord,
} from './delegation.js';
import { GovernanceError, type GovernanceErrorCode } from './errors.js';
import { policyHash, type GovernancePolicy } from './policy.js';
import type {
  BallotSnapshot,
  EligibleMember,
  GovernanceFlag,
} from './snapshot.js';

export const CHOICES = ['YES', 'NO', 'ABSTAIN'] as const;
export type Choice = (typeof CHOICES)[number];

/**
 * A wallet-signed vote bound to one snapshot and policy hash. `onBehalfOf`
 * names, explicitly and under the voter's signature, the member wallets the
 * voter claims to represent through delegation.
 */
export type BallotVote = Readonly<{
  ballotId: string;
  snapshotId: Hex;
  policyHash: Hex;
  chainId: number;
  voter: Address;
  choice: Choice;
  onBehalfOf: readonly Address[];
  castAt: number;
}>;
export type AcceptedVote = Readonly<BallotVote & { signature: Hex }>;

export function voteTypedData(v: BallotVote) {
  return {
    domain: governanceDomain(v.chainId),
    types: {
      BallotVote: [
        { name: 'ballotId', type: 'string' },
        { name: 'snapshotId', type: 'bytes32' },
        { name: 'policyHash', type: 'bytes32' },
        { name: 'voter', type: 'address' },
        { name: 'choice', type: 'string' },
        { name: 'onBehalfOf', type: 'address[]' },
        { name: 'castAt', type: 'uint64' },
      ],
    },
    primaryType: 'BallotVote' as const,
    message: {
      ballotId: v.ballotId,
      snapshotId: v.snapshotId,
      policyHash: v.policyHash,
      voter: v.voter,
      choice: v.choice,
      onBehalfOf: [...v.onBehalfOf],
      castAt: BigInt(v.castAt),
    },
  };
}

function memberIndex(snapshot: BallotSnapshot) {
  return new Map<string, EligibleMember>(
    snapshot.members.map((m) => [m.wallet.toLowerCase(), m]),
  );
}

/** The current policy must be the one frozen into the snapshot. */
export function assertCurrentPolicy(
  snapshot: BallotSnapshot,
  policy: GovernancePolicy,
): void {
  if (policyHash(policy) !== snapshot.policyHash)
    throw new GovernanceError(
      'RESNAPSHOT_REQUIRED',
      `policy ${policy.policyId} v${policy.version} differs from the snapshot's v${snapshot.policyVersion}; retake the snapshot and collect fresh votes`,
    );
}

const VERIFIED_VOTES = new WeakSet<object>();

/**
 * Re-verifies a vote handed back to the ballot: bound to this snapshot, cast
 * inside its window, signed by its voter, and the voter not quarantined.
 */
export async function verifyAcceptedVote(
  s: BallotSnapshot,
  v: AcceptedVote,
): Promise<void> {
  if (
    v.ballotId !== s.ballotId ||
    v.snapshotId !== s.snapshotId ||
    v.policyHash !== s.policyHash ||
    v.chainId !== s.chainId ||
    !CHOICES.includes(v.choice) ||
    v.castAt < s.opensAt ||
    v.castAt >= s.closesAt
  )
    throw new GovernanceError(
      'BALLOT_MISMATCH',
      `vote by ${v.voter} is not a vote on this snapshot`,
    );
  if (quarantinedWallets(s).has(v.voter.toLowerCase()))
    throw new GovernanceError('NOT_ELIGIBLE', `${v.voter} is quarantined`);
  if (VERIFIED_VOTES.has(v)) return;
  const signer = await recoverSigner(voteTypedData(v), v.signature);
  if (!signer || !sameAddress(signer, v.voter))
    throw new GovernanceError(
      'BAD_SIGNATURE',
      `vote by ${v.voter} does not carry its signature`,
    );
  if (Object.isFrozen(v) && Object.isFrozen(v.onBehalfOf))
    VERIFIED_VOTES.add(v);
}

/**
 * Admits one vote. Only a recovered wallet signature counts: a chat message,
 * button tap or unsigned claim never becomes a vote. Each `onBehalfOf` member
 * must reach the voter through live delegations at `now`.
 */
export async function admitVote(input: {
  snapshot: BallotSnapshot;
  policy: GovernancePolicy;
  delegations: readonly DelegationRecord[];
  accepted: readonly AcceptedVote[];
  vote: BallotVote;
  signature: unknown;
  now: number;
}): Promise<AcceptedVote> {
  const { snapshot: s, vote: v, now } = input;
  assertCurrentPolicy(s, input.policy);
  await verifyDelegationRecords(input.delegations, input.policy);
  for (const a of input.accepted) await verifyAcceptedVote(s, a);
  const blocked = quarantinedWallets(s);
  if (
    v.ballotId !== s.ballotId ||
    v.snapshotId !== s.snapshotId ||
    v.policyHash !== s.policyHash ||
    v.chainId !== s.chainId
  )
    throw new GovernanceError(
      'BALLOT_MISMATCH',
      'vote is bound to another ballot, snapshot, policy or chain',
    );
  if (!CHOICES.includes(v.choice))
    throw new GovernanceError('BALLOT_MISMATCH', 'unknown choice');
  if (now < s.opensAt || now >= s.closesAt)
    throw new GovernanceError('BALLOT_NOT_OPEN');
  if (v.castAt > now || v.castAt < s.opensAt)
    throw new GovernanceError('BALLOT_MISMATCH', 'castAt outside the window');
  const signer = await recoverSigner(voteTypedData(v), input.signature);
  if (!signer || !sameAddress(signer, v.voter))
    throw new GovernanceError(
      'BAD_SIGNATURE',
      'a vote needs the voter wallet signature over this ballot',
    );
  const voter = addr(v.voter);
  if (input.accepted.some((a) => sameAddress(a.voter, voter)))
    throw new GovernanceError('DUPLICATE_VOTE', `${voter} already voted`);
  const members = memberIndex(s);
  const represented = v.onBehalfOf.map(addr);
  if (blocked.has(voter.toLowerCase()))
    throw new GovernanceError(
      'NOT_ELIGIBLE',
      `${voter} is quarantined pending duplicate-eligibility review`,
    );
  if (!members.has(voter.toLowerCase()) && !represented.length)
    throw new GovernanceError(
      'NOT_ELIGIBLE',
      `${voter} is not in the snapshot`,
    );
  if (
    new Set(represented.map((w) => w.toLowerCase())).size !== represented.length
  )
    throw new GovernanceError('BALLOT_MISMATCH', 'member listed twice');
  for (const member of represented) {
    if (sameAddress(member, voter))
      throw new GovernanceError(
        'BALLOT_MISMATCH',
        'voter listed as represented',
      );
    if (!members.has(member.toLowerCase()))
      throw new GovernanceError(
        'NOT_ELIGIBLE',
        `${member} is not in the snapshot`,
      );
    if (input.accepted.some((a) => sameAddress(a.voter, member)))
      throw new GovernanceError(
        'DUPLICATE_VOTE',
        `${member} already voted directly`,
      );
    const why = representationError(
      input.delegations,
      member,
      voter,
      now,
      input.policy.maxDelegationDepth,
      blocked,
    );
    if (why)
      throw new GovernanceError(
        why,
        `${voter} cannot vote for ${member}: ${why}`,
      );
    // Representation stops at the closest delegate who votes.
    const chain = delegationChain(
      input.delegations,
      member,
      now,
      input.policy.maxDelegationDepth,
      blocked,
    );
    const closer = chain
      .slice(
        0,
        chain.findIndex((w) => sameAddress(w, voter)),
      )
      .find((w) => input.accepted.some((a) => sameAddress(a.voter, w)));
    if (closer)
      throw new GovernanceError(
        'DUPLICATE_VOTE',
        `${member} is already represented by ${closer}, a closer delegate who voted`,
      );
  }
  const accepted: AcceptedVote = deepFreeze({
    ...v,
    voter,
    onBehalfOf: represented,
    signature: input.signature as Hex,
  });
  VERIFIED_VOTES.add(accepted);
  return accepted;
}

type Count = { count: number; weight: bigint };
export type TallyStatus =
  | 'OPEN'
  | 'PASSED'
  | 'REJECTED'
  | 'NO_QUORUM'
  | 'STALE_POLICY';

export type TallyResult = Readonly<{
  ballotId: string;
  snapshotId: Hex;
  proposalHash: Hex;
  policyHash: Hex;
  status: TallyStatus;
  final: boolean;
  eligible: Count;
  participated: Count;
  yes: Count;
  no: Count;
  /** Explicit ABSTAIN votes. */
  abstain: Count;
  /** Eligible members with no counted vote, direct or delegated. */
  notVoted: Count;
  /** All abstentions: explicit plus silent. Silence is never consent. */
  abstentions: Count;
  viaDelegate: number;
  quorumMet: boolean;
  approvalMet: boolean;
  /** True only on a final, current-policy result where every eligible member's weight voted YES. */
  unanimous: boolean;
  participationBps: number;
  yesOfEligibleBps: number;
  yesOfDecisiveBps: number;
  droppedRepresentations: readonly {
    member: Address;
    voter: Address;
    reason:
      | GovernanceErrorCode
      | 'DIRECT_VOTE_OVERRIDES'
      | 'CLOSER_DELEGATE_VOTED';
  }[];
  flags: readonly GovernanceFlag[];
  summary: string;
  resultHash: Hex;
}>;

const bps = (part: bigint, whole: bigint) =>
  whole === 0n ? 0 : Number((part * BPS) / whole);
const pct = (b: number) => `${(b / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * Counts every eligible member exactly once: a direct vote wins; otherwise the
 * first voter on the member's live delegation chain who signed for them;
 * otherwise the member abstained by not voting. Delegations revoked or expired
 * before the tally drop the represented weight back to abstention.
 */
export async function tally(input: {
  snapshot: BallotSnapshot;
  policy: GovernancePolicy;
  votes: readonly AcceptedVote[];
  delegations: readonly DelegationRecord[];
  at: number;
}): Promise<TallyResult> {
  const { snapshot: s, policy } = input;
  const stale = policyHash(policy) !== s.policyHash;
  const at = Math.min(input.at, s.closesAt);
  const final = input.at >= s.closesAt;
  // Nothing handed in is trusted: delegations and votes are re-verified.
  await verifyDelegationRecords(input.delegations, policy);
  const byVoter = new Map<string, AcceptedVote>();
  for (const v of input.votes) {
    await verifyAcceptedVote(s, v);
    const key = v.voter.toLowerCase();
    if (byVoter.has(key))
      throw new GovernanceError('DUPLICATE_VOTE', `${v.voter} voted twice`);
    byVoter.set(key, v);
  }
  const blocked = quarantinedWallets(s);
  const zero = (): Count => ({ count: 0, weight: 0n });
  const counts: Record<Choice, Count> = {
    YES: zero(),
    NO: zero(),
    ABSTAIN: zero(),
  };
  const notVoted = zero();
  const countedFor = new Map<string, string>(); // member -> voter
  let viaDelegate = 0;
  const index = indexDelegations(input.delegations);
  for (const m of s.members) {
    const key = m.wallet.toLowerCase();
    let vote = byVoter.get(key);
    if (vote) countedFor.set(key, key);
    else {
      // Bounded walk: stops at the first voter, never fails on what lies beyond.
      const chain = delegationChain(
        index,
        m.wallet,
        at,
        policy.maxDelegationDepth,
        blocked,
      );
      const first = chain.find((w) => byVoter.has(w.toLowerCase()));
      const candidate = first && byVoter.get(first.toLowerCase());
      if (candidate?.onBehalfOf.some((w) => sameAddress(w, m.wallet))) {
        vote = candidate;
        viaDelegate++;
        countedFor.set(key, candidate.voter.toLowerCase());
      }
    }
    const bucket = vote ? counts[vote.choice] : notVoted;
    bucket.count++;
    bucket.weight += m.weight;
  }
  const dropped: TallyResult['droppedRepresentations'][number][] = [];
  for (const v of byVoter.values())
    for (const member of v.onBehalfOf) {
      const key = member.toLowerCase();
      if (countedFor.get(key) === v.voter.toLowerCase()) continue;
      dropped.push({
        member,
        voter: v.voter,
        reason:
          countedFor.get(key) === key
            ? 'DIRECT_VOTE_OVERRIDES'
            : (representationError(
                input.delegations,
                member,
                v.voter,
                at,
                policy.maxDelegationDepth,
                blocked,
              ) ?? 'CLOSER_DELEGATE_VOTED'),
      });
    }

  const { YES: yes, NO: no, ABSTAIN: abstain } = counts;
  const eligible = { count: s.eligibleCount, weight: s.eligibleWeight };
  const participated = {
    count: yes.count + no.count + abstain.count,
    weight: yes.weight + no.weight + abstain.weight,
  };
  const abstentions = {
    count: abstain.count + notVoted.count,
    weight: abstain.weight + notVoted.weight,
  };
  const quorumMet =
    !stale &&
    participated.weight * BPS >= BigInt(policy.quorumBps) * eligible.weight;
  const decisive = yes.weight + no.weight;
  const approvalMet =
    !stale &&
    decisive > 0n &&
    yes.weight * BPS >= BigInt(policy.approvalBps) * decisive &&
    yes.weight * BPS >= BigInt(policy.minYesOfEligibleBps) * eligible.weight;
  const status: TallyStatus = stale
    ? 'STALE_POLICY'
    : !final
      ? 'OPEN'
      : !quorumMet
        ? 'NO_QUORUM'
        : approvalMet
          ? 'PASSED'
          : 'REJECTED';
  const participationBps = bps(participated.weight, eligible.weight);
  const flags = [
    ...s.flags,
    ...delegationConcentration({
      snapshot: s,
      records: input.delegations,
      policy,
      at,
    }),
  ];
  const summary =
    `${participated.count} of ${eligible.count} eligible members voted (${pct(participationBps)}): ` +
    `${yes.count} yes, ${no.count} no, ${abstain.count} abstained, ${notVoted.count} did not vote. ` +
    `${abstentions.count} abstentions in total; silence is not consent.` +
    (stale
      ? ' Policy changed after the snapshot: result void, resnapshot required.'
      : '');
  const resultHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'string' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        s.snapshotId,
        s.proposalHash,
        s.policyHash,
        status,
        yes.weight,
        no.weight,
        abstain.weight,
        notVoted.weight,
        eligible.weight,
      ],
    ),
  );
  return deepFreeze({
    ballotId: s.ballotId,
    snapshotId: s.snapshotId,
    proposalHash: s.proposalHash,
    policyHash: s.policyHash,
    status,
    final,
    eligible,
    participated,
    yes,
    no,
    abstain,
    notVoted,
    abstentions,
    viaDelegate,
    quorumMet,
    approvalMet,
    unanimous: final && !stale && yes.weight === eligible.weight,
    participationBps,
    yesOfEligibleBps: bps(yes.weight, eligible.weight),
    yesOfDecisiveBps: bps(yes.weight, decisive),
    droppedRepresentations: dropped,
    flags,
    summary,
    resultHash,
  });
}
