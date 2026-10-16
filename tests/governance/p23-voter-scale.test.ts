import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  takeSnapshot,
  tally,
  type EligibleMember,
  type GovernancePolicy,
} from '@synq/governance';

const NOW = 1_800_000_000;
const policy: GovernancePolicy = {
  policyId: 'pol_p23_scale',
  version: 1,
  workspaceId: 'wsp_p23_scale',
  chainId: token('arc-testnet', 'USDC').chainId,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 3600,
  challengeWindowSeconds: 3600,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 3,
  councilThreshold: 2,
  termSeconds: 86_400,
  termsHash: keccak256(toHex('P23 scale-test terms')),
};

const address = (n: number) =>
  `0x${n.toString(16).padStart(40, '0')}` as Address;

describe('P23-03 100,000 eligible voters', () => {
  it('counts the complete eligible population and abstentions consistently', async () => {
    const members: EligibleMember[] = Array.from(
      { length: 100_000 },
      (_, n) => ({
        memberId: `member_${n}`,
        wallet: address(n + 1),
        channelIds: [],
        weight: 1n,
      }),
    );
    const snapshot = takeSnapshot({
      ballotId: 'bal_p23_100k',
      proposalHash: keccak256(toHex('P23 100k count')),
      policy,
      members,
      now: NOW,
    });
    const result = await tally({
      snapshot,
      policy,
      votes: [],
      delegations: [],
      at: snapshot.closesAt,
    });

    expect(result).toMatchObject({
      final: true,
      eligible: { count: 100_000, weight: 100_000n },
      participated: { count: 0, weight: 0n },
      abstentions: { count: 100_000, weight: 100_000n },
      notVoted: { count: 100_000, weight: 100_000n },
      unanimous: false,
    });
  }, 30_000);
});
