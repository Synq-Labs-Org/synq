import { hashTypedData, type Hex } from 'viem';
import { governanceDomain, isSafeTime } from './common.js';
import { GovernanceError } from './errors.js';

/**
 * The constitution a community ballot and its council operate under. Its
 * EIP-712 hash is frozen into every ballot snapshot: if any field changes, the
 * open snapshots are stale and must be retaken (see `resnapshot`).
 */
export type GovernancePolicy = Readonly<{
  policyId: string;
  version: number;
  workspaceId: string;
  chainId: number;
  /** Minimum share of eligible weight that must take part (YES, NO or ABSTAIN), bps. */
  quorumBps: number;
  /** Share of YES among YES+NO needed to pass, bps. */
  approvalBps: number;
  /**
   * YES must also reach this share of *all eligible* weight, so a small
   * turnout cannot pass something most members never saw.
   */
  minYesOfEligibleBps: number;
  votingPeriodSeconds: number;
  /** Time after a council approval during which seat holders or members can challenge it. */
  challengeWindowSeconds: number;
  maxDelegationDepth: number;
  /** Surface a delegate or member that controls more than this share of eligible weight. */
  concentrationFlagBps: number;
  councilSize: number;
  councilThreshold: number;
  termSeconds: number;
  /** Hash of the contributor launch terms this policy governs. */
  termsHash: Hex;
}>;

const POLICY_TYPES = {
  GovernancePolicy: [
    { name: 'policyId', type: 'string' },
    { name: 'version', type: 'uint64' },
    { name: 'workspaceId', type: 'string' },
    { name: 'quorumBps', type: 'uint16' },
    { name: 'approvalBps', type: 'uint16' },
    { name: 'minYesOfEligibleBps', type: 'uint16' },
    { name: 'votingPeriodSeconds', type: 'uint64' },
    { name: 'challengeWindowSeconds', type: 'uint64' },
    { name: 'maxDelegationDepth', type: 'uint8' },
    { name: 'concentrationFlagBps', type: 'uint16' },
    { name: 'councilSize', type: 'uint8' },
    { name: 'councilThreshold', type: 'uint8' },
    { name: 'termSeconds', type: 'uint64' },
    { name: 'termsHash', type: 'bytes32' },
  ],
} as const;

export function policyTypedData(p: GovernancePolicy) {
  return {
    domain: governanceDomain(p.chainId),
    types: POLICY_TYPES,
    primaryType: 'GovernancePolicy' as const,
    message: {
      policyId: p.policyId,
      version: BigInt(p.version),
      workspaceId: p.workspaceId,
      quorumBps: p.quorumBps,
      approvalBps: p.approvalBps,
      minYesOfEligibleBps: p.minYesOfEligibleBps,
      votingPeriodSeconds: BigInt(p.votingPeriodSeconds),
      challengeWindowSeconds: BigInt(p.challengeWindowSeconds),
      maxDelegationDepth: p.maxDelegationDepth,
      concentrationFlagBps: p.concentrationFlagBps,
      councilSize: p.councilSize,
      councilThreshold: p.councilThreshold,
      termSeconds: BigInt(p.termSeconds),
      termsHash: p.termsHash,
    },
  };
}

export function validatePolicy(p: GovernancePolicy): void {
  const bad = (why: string) => {
    throw new GovernanceError('BAD_POLICY', why);
  };
  const bps = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000;
  if (!p.policyId || !p.workspaceId) bad('policy and workspace ids required');
  if (!Number.isSafeInteger(p.version) || p.version < 1) bad('version');
  if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) bad('chain id');
  if (!bps(p.quorumBps) || p.quorumBps === 0)
    bad('quorum must be 1..10000 bps');
  // A simple majority of votes cast is the floor; abstention never counts as YES.
  if (!bps(p.approvalBps) || p.approvalBps <= 5_000)
    bad('approval must exceed 50% of YES+NO');
  if (!bps(p.minYesOfEligibleBps)) bad('minYesOfEligibleBps');
  if (!bps(p.concentrationFlagBps) || p.concentrationFlagBps === 0)
    bad('concentration flag');
  if (!isSafeTime(p.votingPeriodSeconds) || p.votingPeriodSeconds < 3_600)
    bad('voting period under one hour');
  if (!isSafeTime(p.challengeWindowSeconds) || p.challengeWindowSeconds < 3_600)
    bad('challenge window under one hour');
  if (
    !Number.isInteger(p.maxDelegationDepth) ||
    p.maxDelegationDepth < 1 ||
    p.maxDelegationDepth > 8
  )
    bad('delegation depth 1..8');
  if (
    !Number.isInteger(p.councilSize) ||
    p.councilSize < 3 ||
    p.councilSize > 21
  )
    bad('council size 3..21');
  // A council quorum must be a strict majority: two disjoint minorities can never both act.
  if (
    !Number.isInteger(p.councilThreshold) ||
    p.councilThreshold * 2 <= p.councilSize ||
    p.councilThreshold > p.councilSize
  )
    bad('council threshold must be a strict majority of seats');
  if (!isSafeTime(p.termSeconds) || p.termSeconds < 86_400)
    bad('term under one day');
  if (!/^0x[0-9a-f]{64}$/.test(p.termsHash)) bad('terms hash');
}

export function policyHash(p: GovernancePolicy): Hex {
  validatePolicy(p);
  return hashTypedData(policyTypedData(p));
}
