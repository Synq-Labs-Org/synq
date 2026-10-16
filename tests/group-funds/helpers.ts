import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  admitVote,
  assentTypedData,
  takeSnapshot,
  voteTypedData,
  type AcceptedVote,
  type BallotSnapshot,
  type Choice,
  type DelegationRecord,
} from '@synq/governance';
import {
  contributionRef,
  draftCharter,
  type FundCharter,
  type FundKind,
  type GroupFund,
  type ObservedTransfer,
} from '@synq/treasury';

// Test keys come from labels, never from literal key material.
export const accountFor = (label: string) =>
  privateKeyToAccount(keccak256(toHex(`synq-p19:${label}`)));
export const nonce = (label: string): Hex => keccak256(toHex(`nonce:${label}`));

export const USDC = token('arc-testnet', 'USDC');
export const CHAIN = USDC.chainId;
export const NOW = 1_790_000_000;
export const DAY = 86_400;
export const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

export function charterFor(input: {
  fundId: string;
  kind?: FundKind;
  members: { memberId: string; account: PrivateKeyAccount }[];
  pool: Address;
  quorumBps?: number;
  approvalBps?: number;
  minYesOfEligibleBps?: number;
  refundableUntil?: number;
  withdrawal?: FundCharter['rights']['withdrawal'];
  minConfirmations?: number;
}): FundCharter {
  return draftCharter({
    base: {
      fundId: input.fundId,
      groupId: `grp_${input.fundId}`,
      kind: input.kind ?? 'GROUP_GIFT',
      purpose: `${input.fundId} purpose`,
      organizer: input.members[0]!.memberId,
      asset: USDC,
      pool: input.pool,
      members: input.members.map((m) => ({
        memberId: m.memberId,
        wallet: m.account.address,
      })),
      rights: {
        withdrawal: input.withdrawal ?? 'UNSPENT_CLAIM_WHILE_REFUNDABLE',
        cancellation: 'REMAINING_CLAIM',
        spendApproval: 'SIGNED_BALLOT_OF_BOUND_CONTRIBUTORS',
      },
      minConfirmations: input.minConfirmations ?? 2,
      recurring: null,
    },
    policy: {
      policyId: `pol_${input.fundId}`,
      version: 1,
      workspaceId: `grp_${input.fundId}`,
      chainId: CHAIN,
      quorumBps: input.quorumBps ?? 5_000,
      approvalBps: input.approvalBps ?? 6_000,
      minYesOfEligibleBps: input.minYesOfEligibleBps ?? 3_000,
      votingPeriodSeconds: 2 * DAY,
      challengeWindowSeconds: DAY,
      maxDelegationDepth: 3,
      concentrationFlagBps: 10_000,
      councilSize: 3,
      councilThreshold: 2,
      termSeconds: 365 * DAY,
    },
    terms: {
      version: 1,
      targetBaseUnits: usdc(1_000_000),
      refundableUntil: input.refundableUntil ?? NOW + 7 * DAY,
      summary: `${input.fundId}: spend only by signed contributor ballot`,
    },
  });
}

let seq = 0;
export function transfer(input: {
  from: Address;
  to: Address;
  amount: bigint;
  ref?: Hex | null;
  block?: bigint;
}): ObservedTransfer {
  seq++;
  return {
    chainId: CHAIN,
    token: USDC.address,
    txHash: keccak256(toHex(`tx-${seq}`)),
    logIndex: 1,
    from: input.from,
    to: input.to,
    amount: input.amount,
    paymentRef: input.ref === undefined ? null : input.ref,
    blockNumber: input.block ?? 100n,
  };
}

/** A final, referenced contribution from a member. */
export function contribute(
  fund: GroupFund,
  memberId: string,
  amount: bigint,
  at = NOW,
): string {
  const m = fund.member(memberId);
  const t = transfer({
    from: m.wallet,
    to: fund.charter.pool,
    amount,
    ref: contributionRef(fund.fundId, memberId),
  });
  for (const e of fund.observeDeposit(t, at)) fund.apply(e);
  const key = `chain:${t.chainId}:${t.txHash.toLowerCase()}:${t.logIndex}`;
  for (const e of fund.finalizeDeposit(key, t.blockNumber + 5n, at))
    fund.apply(e);
  return key;
}

export async function assent(
  fund: GroupFund,
  memberId: string,
  account: PrivateKeyAccount,
  at = NOW,
) {
  const a = {
    campaignId: fund.terms.campaignId,
    chainId: CHAIN,
    contributor: account.address,
    termsHash: fund.termsHash,
    termsVersion: fund.terms.version,
    issuedAt: at,
    nonce: nonce(`${memberId}:${fund.terms.version}`),
  };
  for (const e of await fund.recordAssent({
    memberId,
    assent: a,
    signature: await account.signTypedData(assentTypedData(a)),
    now: at,
  }))
    fund.apply(e);
}

export function snapshotFor(
  fund: GroupFund,
  proposalHash: Hex,
  ballotId: string,
  at = NOW,
): BallotSnapshot {
  return takeSnapshot({
    ballotId,
    proposalHash,
    policy: fund.charter.policy,
    members: fund.electorate(),
    now: at,
  });
}

export async function castVotes(
  fund: GroupFund,
  snapshot: BallotSnapshot,
  ballots: {
    account: PrivateKeyAccount;
    choice: Choice;
    onBehalfOf?: Address[];
  }[],
  delegations: readonly DelegationRecord[] = [],
  at = NOW + 60,
): Promise<AcceptedVote[]> {
  const accepted: AcceptedVote[] = [];
  for (const b of ballots) {
    const vote = {
      ballotId: snapshot.ballotId,
      snapshotId: snapshot.snapshotId,
      policyHash: snapshot.policyHash,
      chainId: snapshot.chainId,
      voter: b.account.address,
      choice: b.choice,
      onBehalfOf: b.onBehalfOf ?? [],
      castAt: at,
    };
    accepted.push(
      await admitVote({
        snapshot,
        policy: fund.charter.policy,
        delegations,
        accepted,
        vote,
        signature: await b.account.signTypedData(voteTypedData(vote)),
        now: at,
      }),
    );
  }
  return accepted;
}

export async function expectCode(
  p: Promise<unknown> | (() => unknown),
  code: string,
): Promise<Error> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if ((e as { code?: string }).code !== code)
      throw new Error(
        `expected ${code}, got ${(e as { code?: string }).code}: ${(e as Error).message}`,
      );
    return e as Error;
  }
  throw new Error(`expected ${code}`);
}

export const applyAll = (
  fund: GroupFund,
  events: readonly import('@synq/treasury').FundEvent[],
) => {
  for (const e of events) fund.apply(e);
};
