import {
  encodeAbiParameters,
  keccak256,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { BPS, addr, canonicalJson, deepFreeze, isSafeTime } from './common.js';
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

/**
 * Canonical stable channel id, so `telegram:0777`, `Telegram:777` and
 * `telegram:777` are one identity for duplicate detection. Handles (`@name`)
 * are not channel ids.
 */
export function canonicalChannelId(raw: string): string | null {
  const m = /^([A-Za-z]+):(\S{1,128})$/.exec(raw.trim());
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  const id = m[2]!;
  if (kind === 'telegram' || kind === 'whatsapp')
    return /^\+?[0-9]{1,20}$/.test(id)
      ? `${kind}:${BigInt(id.replace('+', '')).toString()}`
      : null;
  if (kind === 'imessage') {
    if (/^\+[0-9]{6,15}$/.test(id))
      return `imessage:+${BigInt(id.slice(1)).toString()}`;
    return /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(id)
      ? `imessage:${id.toLowerCase()}`
      : null;
  }
  return null;
}

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
  const bad = (why: string): never => {
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
    const channelIds = m.channelIds.map(
      (c) =>
        canonicalChannelId(c) ??
        bad(`member ${m.memberId}: channel id ${c} is not a stable channel id`),
    );
    return {
      memberId: m.memberId,
      wallet: addr(m.wallet),
      channelIds: [...new Set(channelIds)].sort(),
      weight: m.weight,
    };
  });
  // Input order never influences the result (flags, quarantine, id).
  members.sort((a, b) =>
    a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
  );
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

/**
 * Content address of everything in the snapshot: policy id/version/hash,
 * members with channel ids, quarantined entries, flags, window and lineage.
 */
export function snapshotIdOf(s: Omit<BallotSnapshot, 'snapshotId'>): Hex {
  return keccak256(toHex(canonicalJson({ kind: 'BallotSnapshot/2', ...s })));
}

/**
 * Recomputes the snapshot id from its frozen contents; any tampering is
 * detected. With the policy, the snapshot is rebuilt from its raw entries and
 * must match exactly, so flags and quarantine cannot be hand-edited either.
 */
export function verifySnapshot(
  s: BallotSnapshot,
  policy?: GovernancePolicy,
): void {
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
  if (policy) {
    let rebuilt: BallotSnapshot;
    try {
      rebuilt = takeSnapshot({
        ballotId: s.ballotId,
        proposalHash: s.proposalHash,
        policy,
        members: [...s.members, ...s.quarantined],
        now: s.takenAt,
        opensAt: s.opensAt,
        supersedes: s.supersedes,
      });
    } catch {
      throw new GovernanceError('BAD_SNAPSHOT', 'snapshot cannot be rebuilt');
    }
    if (rebuilt.snapshotId !== snapshotId)
      throw new GovernanceError(
        'BAD_SNAPSHOT',
        'snapshot differs from a rebuild of its entries under this policy',
      );
  }
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
