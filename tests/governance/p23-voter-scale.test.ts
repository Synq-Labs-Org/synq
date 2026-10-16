import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import {
  deepFreeze,
  delegationId,
  delegationTypedData,
  revocationTypedData,
  takeSnapshot,
  tally,
  voteTypedData,
  type AcceptedVote,
  type BallotVote,
  type Choice,
  type Delegation,
  type DelegationRecord,
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

/**
 * The electorate below is built from index ranges, so the expected tally is
 * computed from the fixture's own definition (who voted, who delegated to
 * whom, which delegation lapsed), never from the counting code under test.
 *
 *   0..499          delegates: vote directly, signing for their delegators
 *   500..42_499     direct voters (60% YES, 30% NO, 10% ABSTAIN by index)
 *   42_500..62_499  delegators, all ending at delegate (n % 500):
 *     42_500..43_499  two hops: delegate to n + 1000, who delegates on
 *     43_500..59_499  one hop (includes the 1,000 intermediates)
 *     59_500..59_999  delegation revoked before the close
 *     60_000..60_499  delegation expired before the close
 *     60_500..60_999  delegated AND voted directly (direct vote wins)
 *     61_000..62_499  delegated, but the delegate did not sign for them
 *   62_500..99_999  silent
 * plus two entries sharing one wallet (quarantined, not eligible).
 *
 * Every vote, delegation and revocation carries a real EIP-712 signature that
 * the tally re-verifies (about 61,500 secp256k1 recoveries).
 */
const N = 100_000;
const DELEGATES = 500;
const role = (n: number) =>
  n < DELEGATES
    ? 'DELEGATE'
    : n < 42_500
      ? 'DIRECT'
      : n < 43_500
        ? 'TWO_HOP'
        : n < 59_500
          ? 'ONE_HOP'
          : n < 60_000
            ? 'REVOKED'
            : n < 60_500
              ? 'EXPIRED'
              : n < 61_000
                ? 'OVERRIDE'
                : n < 62_500
                  ? 'UNLISTED'
                  : 'SILENT';
const delegateChoice = (d: number): Choice => (d % 5 === 4 ? 'NO' : 'YES');
const directChoice = (n: number): Choice =>
  n % 10 < 6 ? 'YES' : n % 10 < 9 ? 'NO' : 'ABSTAIN';
const signs = (n: number) => role(n) !== 'SILENT';

describe('X-LOA-01 / P23-03 100k community ballot at 60 percent turnout', () => {
  it('X-LOA-01 counts 100,000 eligible members with real signed votes, delegations, lapses and abstentions to the exact expected tally', async () => {
    const started = performance.now();
    const accounts = new Map<number, PrivateKeyAccount>();
    const walletOf = (n: number): Address => {
      if (!signs(n)) return address(n + 1);
      let a = accounts.get(n);
      if (!a) {
        a = privateKeyToAccount(keccak256(toHex(`synq-p23-voter:${n}`)));
        accounts.set(n, a);
      }
      return a.address;
    };
    const members: EligibleMember[] = Array.from({ length: N }, (_, n) => ({
      memberId: `member_${String(n).padStart(6, '0')}`,
      wallet: walletOf(n),
      channelIds: [],
      weight: 1n,
    }));
    // A duplicated wallet is quarantined for review, never counted.
    const dupe = address(9_999_999);
    members.push(
      { memberId: 'sybil_a', wallet: dupe, channelIds: [], weight: 1n },
      { memberId: 'sybil_b', wallet: dupe, channelIds: [], weight: 1n },
    );
    const snapshot = takeSnapshot({
      ballotId: 'bal_p23_100k_turnout',
      proposalHash: keccak256(toHex('P23 100k turnout ballot')),
      policy,
      members,
      now: NOW,
    });
    expect(snapshot.eligibleCount).toBe(N);
    expect(snapshot.quarantined).toHaveLength(2);

    // Delegations (one per delegator), revocations and expiries.
    const delegations: DelegationRecord[] = [];
    const onBehalf = new Map<number, Address[]>();
    for (let n = 42_500; n < 62_500; n++) {
      const r = role(n);
      const to = r === 'TWO_HOP' ? n + 1_000 : n % DELEGATES;
      const d: Delegation = {
        workspaceId: policy.workspaceId,
        chainId: policy.chainId,
        delegator: walletOf(n),
        delegate: walletOf(to),
        issuedAt: NOW - 100,
        expiresAt: r === 'EXPIRED' ? NOW + 1_800 : NOW + 86_000,
        nonce: keccak256(toHex(`p23-delegation:${n}`)),
      };
      const id = delegationId(d);
      const signer = accounts.get(n)!;
      const signature = await signer.signTypedData(delegationTypedData(d));
      let record: DelegationRecord = {
        id,
        delegation: d,
        signature,
        effectiveFrom: NOW,
        revokedAt: null,
        revocation: null,
        revocationSignature: null,
      };
      if (r === 'REVOKED') {
        const revocation = {
          workspaceId: policy.workspaceId,
          chainId: policy.chainId,
          delegationId: id,
          delegator: d.delegator,
          requestedAt: NOW + 1_000,
        };
        record = {
          ...record,
          revokedAt: NOW + 1_000,
          revocation,
          revocationSignature: await signer.signTypedData(
            revocationTypedData(revocation),
          ),
        };
      }
      delegations.push(deepFreeze(record));
      if (r !== 'UNLISTED') {
        const terminal = n % DELEGATES;
        const list = onBehalf.get(terminal) ?? [];
        list.push(walletOf(n));
        onBehalf.set(terminal, list);
      }
    }

    // Votes: delegates (with their represented members), direct voters and overrides.
    const votes: AcceptedVote[] = [];
    const castVote = async (n: number, choice: Choice, behalf: Address[]) => {
      const v: BallotVote = {
        ballotId: snapshot.ballotId,
        snapshotId: snapshot.snapshotId,
        policyHash: snapshot.policyHash,
        chainId: snapshot.chainId,
        voter: walletOf(n),
        choice,
        onBehalfOf: behalf,
        castAt: NOW + 60,
      };
      const signature: Hex = await accounts
        .get(n)!
        .signTypedData(voteTypedData(v));
      votes.push(deepFreeze({ ...v, signature }));
    };
    for (let d = 0; d < DELEGATES; d++)
      await castVote(d, delegateChoice(d), onBehalf.get(d) ?? []);
    for (let n = DELEGATES; n < 42_500; n++)
      await castVote(n, directChoice(n), []);
    for (let n = 60_500; n < 61_000; n++)
      await castVote(n, directChoice(n), []);
    const fixtureMs = performance.now() - started;

    // Expected tally from the fixture definition alone.
    const expected = { YES: 0, NO: 0, ABSTAIN: 0, notVoted: 0, via: 0 };
    for (let n = 0; n < N; n++) {
      const r = role(n);
      if (r === 'DELEGATE') expected[delegateChoice(n)]++;
      else if (r === 'DIRECT' || r === 'OVERRIDE') expected[directChoice(n)]++;
      else if (r === 'TWO_HOP' || r === 'ONE_HOP') {
        expected[delegateChoice(n % DELEGATES)]++;
        expected.via++;
      } else expected.notVoted++;
    }
    const participated = expected.YES + expected.NO + expected.ABSTAIN;
    expect(participated).toBe(60_000); // 60% turnout by construction
    expect(expected.via).toBe(17_000);

    const t0 = performance.now();
    const result = await tally({
      snapshot,
      policy,
      votes,
      delegations,
      at: snapshot.closesAt,
    });
    const tallyMs = performance.now() - t0;

    expect(result).toMatchObject({
      final: true,
      status: 'PASSED',
      eligible: { count: N, weight: BigInt(N) },
      participated: { count: participated, weight: BigInt(participated) },
      yes: { count: expected.YES, weight: BigInt(expected.YES) },
      no: { count: expected.NO, weight: BigInt(expected.NO) },
      abstain: { count: expected.ABSTAIN, weight: BigInt(expected.ABSTAIN) },
      notVoted: { count: expected.notVoted, weight: BigInt(expected.notVoted) },
      abstentions: {
        count: expected.ABSTAIN + expected.notVoted,
        weight: BigInt(expected.ABSTAIN + expected.notVoted),
      },
      viaDelegate: expected.via,
      quorumMet: true,
      approvalMet: true,
      unanimous: false,
      participationBps: 6_000,
    });
    // Every member is counted exactly once: buckets partition the electorate.
    expect(
      result.yes.count +
        result.no.count +
        result.abstain.count +
        result.notVoted.count,
    ).toBe(N);
    // Lapsed or overridden representations are dropped with their reason.
    const reasons = new Map<string, number>();
    for (const d of result.droppedRepresentations)
      reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
    expect(Object.fromEntries(reasons)).toEqual({
      DELEGATION_REVOKED: 500,
      DELEGATION_EXPIRED: 500,
      DIRECT_VOTE_OVERRIDES: 500,
    });
    expect(result.flags.map((f) => f.code)).toEqual(['DUPLICATE_WALLET']);

    // Order of votes and delegations never changes the result.
    const shuffled = <T>(xs: readonly T[]) =>
      xs
        .map((x, i) => ({ x, k: (i * 7_919) % xs.length }))
        .sort((a, b) => a.k - b.k)
        .map((e) => e.x);
    const again = await tally({
      snapshot,
      policy,
      votes: shuffled(votes),
      delegations: shuffled(delegations),
      at: snapshot.closesAt,
    });
    expect(again.resultHash).toBe(result.resultHash);
    console.info(
      `X-LOA-01 100k electorate: fixture ${Math.round(fixtureMs)} ms (${votes.length} votes, ${delegations.length} delegations signed), tally ${Math.round(tallyMs)} ms`,
    );
  }, 600_000);
});
