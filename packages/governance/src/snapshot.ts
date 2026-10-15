import {
  encodeAbiParameters,
  keccak256,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { BPS, addr, deepFreeze, isSafeTime } from './common.js';
import { GovernanceError } from './errors.js';
import { policyHash, type GovernancePolicy } from './policy.js';

/** One member as known to the workspace when the snapshot is taken. */
export type EligibleMember = Readonly<{
  memberId: string;
  /** Wallet linked through the authenticated channel-link challenge. */
  wallet: Address;
  /** Stable channel ids, e.g. `telegram:1001`; handles are never used. */
  channelIds: readonly string[];
  /** Voting weight (1 per member for one-member-one-vote). */
  weight: bigint;
}>;

export type GovernanceFlagCode =
  | 'DUPLICATE_WALLET'
  | 'DUPLICATE_CHANNEL_ID'
  | 'MEMBER_CONCENTRATION'
  | 'DELEGATE_CONCENTRATION';

export type GovernanceFlag = Readonly<{
  code: GovernanceFlagCode;
  /** HARD flags remove the affected entries from eligibility pending review. */
  severity: 'HARD' | 'SOFT';
  subject: string;
  memberIds: readonly string[];
  detail: string;
}>;

export type BallotSnapshot = Readonly<{
  snapshotId: Hex;
  ballotId: string;
  /** Hash of exactly what is being decided. */
  proposalHash: Hex;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  chainId: number;
  takenAt: number;
  opensAt: number;
  closesAt: number;
  /** Frozen eligible set, sorted by wallet, one entry per wallet. */
  members: readonly EligibleMember[];
  /** Entries excluded by a HARD flag; they cannot vote or be represented. */
  quarantined: readonly EligibleMember[];
  eligibleCount: number;
  eligibleWeight: bigint;
  eligibilityHash: Hex;
  flags: readonly GovernanceFlag[];
  /** The stale snapshot this one replaces after a policy change. */
  supersedes: Hex | null;
}>;

const CHANNEL_ID = /^(telegram|imessage|whatsapp):[^\s@][^\s]{0,127}$/;

function eligibilityHash(members: readonly EligibleMember[]): Hex {
  let h: Hex = zeroHash;
  for (const m of members)
    h = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        [h, keccak256(toHex(m.memberId)), m.wallet, m.weight],
      ),
    );
  return h;
}

function duplicates(
  members: readonly EligibleMember[],
  keysOf: (m: EligibleMember) => readonly string[],
): Map<string, EligibleMember[]> {
  const by = new Map<string, EligibleMember[]>();
  for (const m of members)
    for (const k of new Set(keysOf(m))) by.set(k, [...(by.get(k) ?? []), m]);
  return new Map([...by].filter(([, list]) => list.length > 1));
}

/**
 * Freezes who may vote on one proposal under one policy. Duplicate wallets and
 * duplicate channel ids are sybil signals: every entry involved is quarantined
 * and surfaced, rather than silently picking one. A member holding more than
 * the policy's concentration share is surfaced as a SOFT flag.
 */
export function takeSnapshot(input: {
  ballotId: string;
  proposalHash: Hex;
  policy: GovernancePolicy;
  members: readonly EligibleMember[];
  now: number;
  opensAt?: number;
  supersedes?: Hex | null;
}): BallotSnapshot {
  const bad = (why: string) => {
    throw new GovernanceError('BAD_SNAPSHOT', why);
  };
  const { policy, now } = input;
  const pHash = policyHash(policy);
  if (!input.ballotId) bad('ballot id required');
  if (!/^0x[0-9a-f]{64}$/.test(input.proposalHash)) bad('proposal hash');
  if (!isSafeTime(now)) bad('time');
  const opensAt = input.opensAt ?? now;
  if (opensAt < now) bad('snapshot must precede the voting window');
  const members = input.members.map((m) => {
    if (!m.memberId) bad('member id required');
    if (m.weight <= 0n) bad(`member ${m.memberId} has no weight`);
    for (const c of m.channelIds)
      if (!CHANNEL_ID.test(c))
        bad(`member ${m.memberId}: channel id ${c} is not a stable channel id`);
    return { ...m, wallet: addr(m.wallet), channelIds: [...m.channelIds] };
  });
  if (new Set(members.map((m) => m.memberId)).size !== members.length)
    bad('duplicate member id');

  const flags: GovernanceFlag[] = [];
  const quarantine = new Set<string>();
  for (const [wallet, list] of duplicates(members, (m) => [m.wallet])) {
    list.forEach((m) => quarantine.add(m.memberId));
    flags.push({
      code: 'DUPLICATE_WALLET',
      severity: 'HARD',
      subject: wallet,
      memberIds: list.map((m) => m.memberId),
      detail: `wallet ${wallet} is listed for ${list.length} members`,
    });
  }
  for (const [channelId, list] of duplicates(members, (m) => m.channelIds)) {
    list.forEach((m) => quarantine.add(m.memberId));
    flags.push({
      code: 'DUPLICATE_CHANNEL_ID',
      severity: 'HARD',
      subject: channelId,
      memberIds: list.map((m) => m.memberId),
      detail: `${channelId} is claimed by ${list.length} members`,
    });
  }
  const eligible = members
    .filter((m) => !quarantine.has(m.memberId))
    .sort((a, b) => (a.wallet.toLowerCase() < b.wallet.toLowerCase() ? -1 : 1));
  if (!eligible.length) bad('no eligible members');
  const eligibleWeight = eligible.reduce((s, m) => s + m.weight, 0n);
  for (const m of eligible)
    if (m.weight * BPS > BigInt(policy.concentrationFlagBps) * eligibleWeight)
      flags.push({
        code: 'MEMBER_CONCENTRATION',
        severity: 'SOFT',
        subject: m.wallet,
        memberIds: [m.memberId],
        detail: `member holds ${(m.weight * BPS) / eligibleWeight} bps of eligible weight`,
      });

  const body = {
    ballotId: input.ballotId,
    proposalHash: input.proposalHash,
    policyId: policy.policyId,
    policyVersion: policy.version,
    policyHash: pHash,
    chainId: policy.chainId,
    takenAt: now,
    opensAt,
    closesAt: opensAt + policy.votingPeriodSeconds,
    members: eligible,
    quarantined: members.filter((m) => quarantine.has(m.memberId)),
    eligibleCount: eligible.length,
    eligibleWeight,
    eligibilityHash: eligibilityHash(eligible),
    flags,
    supersedes: input.supersedes ?? null,
  };
  return deepFreeze({ snapshotId: snapshotIdOf(body), ...body });
}

export function snapshotIdOf(s: Omit<BallotSnapshot, 'snapshotId'>): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [
        s.ballotId,
        s.proposalHash,
        s.policyHash,
        s.eligibilityHash,
        s.eligibleWeight,
        BigInt(s.eligibleCount),
        BigInt(s.chainId),
        BigInt(s.takenAt),
        BigInt(s.opensAt),
        BigInt(s.closesAt),
        s.supersedes ?? zeroHash,
      ],
    ),
  );
}

/** Recomputes the snapshot id from its frozen contents; any tampering is detected. */
export function verifySnapshot(s: BallotSnapshot): void {
  const { snapshotId, ...body } = s;
  if (
    eligibilityHash(s.members) !== s.eligibilityHash ||
    snapshotIdOf(body) !== snapshotId ||
    s.members.reduce((a, m) => a + m.weight, 0n) !== s.eligibleWeight ||
    s.members.length !== s.eligibleCount
  )
    throw new GovernanceError(
      'BAD_SNAPSHOT',
      'snapshot contents do not match its id',
    );
}

/**
 * After the governing policy changes, a stale snapshot is replaced by a new one
 * under the new policy hash, with a fresh voting window. Votes signed against
 * the old snapshot id do not carry over: every voter must sign again.
 */
export function resnapshot(input: {
  stale: BallotSnapshot;
  policy: GovernancePolicy;
  members: readonly EligibleMember[];
  now: number;
  proposalHash?: Hex;
}): BallotSnapshot {
  if (policyHash(input.policy) === input.stale.policyHash)
    throw new GovernanceError(
      'BAD_SNAPSHOT',
      'policy unchanged; the existing snapshot is still valid',
    );
  if (input.policy.policyId !== input.stale.policyId)
    throw new GovernanceError('BAD_SNAPSHOT', 'different policy lineage');
  return takeSnapshot({
    ballotId: input.stale.ballotId,
    proposalHash: input.proposalHash ?? input.stale.proposalHash,
    policy: input.policy,
    members: input.members,
    now: input.now,
    supersedes: input.stale.snapshotId,
  });
}
