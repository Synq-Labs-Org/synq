import { describe, expect, it } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { moneyFromDecimal } from '@synq/domain';
import { signTelegramLoginForTest, verifyTelegramLogin } from '@synq/channels';
import {
  ChannelLinkService,
  MemoryChannelLinkStore,
  channelLinkTypedData,
} from '@synq/identity/server';
import {
  DelegationRegistry,
  GovernanceError,
  admitChallenge,
  admitVote,
  applyPolicyChange,
  approveCouncilAction,
  assentTypedData,
  assertExecutable,
  challengeTypedData,
  councilActionTypedData,
  delegationConcentration,
  delegationId,
  delegationTypedData,
  installTermFromBallot,
  isActiveAt,
  launchReadiness,
  launchTermsHash,
  policyChangeHash,
  requireAssent,
  resnapshot,
  revocationTypedData,
  rotateTerm,
  takeSnapshot,
  tally,
  termHash,
  validateTerm,
  verifyAssent,
  verifyCouncilSignatures,
  verifySnapshot,
  voteTypedData,
  withdrawalActionHash,
  type AcceptedVote,
  type BallotSnapshot,
  type BallotVote,
  type Choice,
  type Contribution,
  type CouncilAction,
  type CouncilTerm,
  type Delegation,
  type EligibleMember,
  type GovernancePolicy,
  type LaunchTerms,
  type VerifiedAssent,
} from '@synq/governance';

// Test keys come from labels, never from literal key material.
const accountFor = (label: string) =>
  privateKeyToAccount(keccak256(toHex(`synq-p05:${label}`)));
const nonce = (label: string): Hex => keccak256(toHex(`nonce:${label}`));

const USDC = token('arc-testnet', 'USDC');
const CHAIN = USDC.chainId;
const NOW = 1_790_000_000;
const DAY = 86_400;
const WORKSPACE = 'wsp_community';

const termsV1: LaunchTerms = {
  campaignId: 'cmp_launch',
  version: 1,
  asset: USDC,
  targetBaseUnits: 10_000_000_000n,
  refundableUntil: NOW + 30 * DAY,
  allocationHash: keccak256(toHex('allocation v1: 70% build, 30% reserve')),
  summary: 'Launch v1: 10,000 USDC target, refundable for 30 days',
};
const termsV2: LaunchTerms = {
  ...termsV1,
  version: 2,
  targetBaseUnits: 25_000_000_000n,
  allocationHash: keccak256(toHex('allocation v2: 90% build, 10% reserve')),
  summary: 'Launch v2: 25,000 USDC target, smaller reserve',
};

const policyV1: GovernancePolicy = {
  policyId: 'pol_community',
  version: 1,
  workspaceId: WORKSPACE,
  chainId: CHAIN,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 7 * DAY,
  challengeWindowSeconds: 2 * DAY,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 7,
  councilThreshold: 5,
  termSeconds: 365 * DAY,
  termsHash: launchTermsHash(termsV1),
};

const member = (
  id: string,
  wallet: Address,
  channelIds: string[] = [],
  weight = 1n,
): EligibleMember => ({ memberId: id, wallet, channelIds, weight });

async function signedVote(
  voter: PrivateKeyAccount,
  snapshot: BallotSnapshot,
  choice: Choice,
  onBehalfOf: Address[] = [],
  castAt = NOW + 60,
) {
  const vote: BallotVote = {
    ballotId: snapshot.ballotId,
    snapshotId: snapshot.snapshotId,
    policyHash: snapshot.policyHash,
    chainId: snapshot.chainId,
    voter: voter.address,
    choice,
    onBehalfOf,
    castAt,
  };
  return { vote, signature: await voter.signTypedData(voteTypedData(vote)) };
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect((e as { code?: string }).code, (e as Error).message).toBe(code);
    return e as Error;
  }
  throw new Error(`expected ${code}`);
}

const council = Array.from({ length: 7 }, (_, i) => accountFor(`seat-${i}`));
const term1: CouncilTerm = {
  councilId: 'cnc_community',
  workspaceId: WORKSPACE,
  chainId: CHAIN,
  termId: 1,
  seats: council.map((a, i) => ({ seatId: `seat-${i}`, holder: a.address })),
  threshold: 5,
  startsAt: NOW - DAY,
  endsAt: NOW + 300 * DAY,
};
const actionFor = (
  t: CouncilTerm,
  kind: CouncilAction['kind'],
  actionHash: Hex,
  label: string,
): CouncilAction => ({
  councilId: t.councilId,
  workspaceId: t.workspaceId,
  chainId: t.chainId,
  termId: t.termId,
  termHash: termHash(t),
  kind,
  actionHash,
  nonce: nonce(label),
  expiresAt: NOW + 30 * DAY,
});
const signAction = (signers: PrivateKeyAccount[], a: CouncilAction) =>
  Promise.all(signers.map((s) => s.signTypedData(councilActionTypedData(a))));

describe('P05 principal linking and large-group governance', () => {
  it('P05-01 a copied Telegram handle cannot bind a wallet without the signed challenge', async () => {
    const BOT = 'p05-test-bot-token';
    let clock = NOW;
    const store = new MemoryChannelLinkStore();
    const links = new ChannelLinkService(store, {
      now: () => clock,
      challengeTtlSeconds: 300,
      verifiers: {
        telegram: (proof, now) => {
          const id = verifyTelegramLogin(proof, BOT, now);
          const username = (proof as { username?: unknown }).username;
          return id
            ? {
                channelUserId: id,
                ...(typeof username === 'string'
                  ? { displayHandle: username }
                  : {}),
              }
            : null;
        },
      },
    });
    const alice = accountFor('alice');
    const bob = accountFor('bob');
    const mallory = accountFor('mallory');
    const login = (id: number, username: string) =>
      signTelegramLoginForTest({ id, username, auth_date: clock }, BOT);

    // Alice proves Telegram user 1001 and signs the wallet challenge.
    const c1 = await links.requestLink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelProof: login(1001, 'alice'),
      wallet: alice.address,
    });
    expect(c1).toMatchObject({ channelUserId: '1001', displayHandle: 'alice' });
    const sig1 = await alice.signTypedData(channelLinkTypedData(c1));
    const linked = await links.completeLink({
      challengeId: c1.challengeId,
      signature: sig1,
    });
    expect(linked.wallet).toBe(alice.address);
    expect(
      await links.resolve({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelUserId: '1001',
      }),
    ).toBe(alice.address);

    // A copied handle is not a channel proof, and a forged login hash fails Telegram's HMAC.
    await expectCode(
      links.requestLink({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelProof: { username: 'alice' },
        wallet: mallory.address,
      }),
      'UNAUTHORIZED',
    );
    await expectCode(
      links.requestLink({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelProof: {
          id: 1001,
          username: 'alice',
          auth_date: clock,
          hash: '0'.repeat(64),
        },
        wallet: mallory.address,
      }),
      'UNAUTHORIZED',
    );
    // Handles are never identities: resolving by handle is refused, not searched.
    for (const handle of ['alice', '@alice'])
      await expectCode(
        links.resolve({
          workspaceId: WORKSPACE,
          channel: 'telegram',
          channelUserId: handle,
        }),
        'INVALID_INPUT',
      );

    // Mallory renames her own Telegram account (6666) to "bob" and claims Bob's wallet:
    // she gets a challenge for Bob's wallet but cannot sign it.
    const c2 = await links.requestLink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelProof: login(6666, 'bob'),
      wallet: bob.address,
    });
    await expectCode(
      links.completeLink({
        challengeId: c2.challengeId,
        signature: await mallory.signTypedData(channelLinkTypedData(c2)),
      }),
      'SIGNATURE_MISMATCH',
    );
    // Alice's earlier signature does not transfer to another challenge.
    await expectCode(
      links.completeLink({ challengeId: c2.challengeId, signature: sig1 }),
      'SIGNATURE_MISMATCH',
    );
    // A chat reply is not a signature.
    await expectCode(
      links.completeLink({
        challengeId: c2.challengeId,
        signature: 'yes, link it',
      }),
      'SIGNATURE_MISMATCH',
    );
    expect(
      await links.resolve({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelUserId: '6666',
      }),
    ).toBeNull();

    // One-use and expiring.
    await expectCode(
      links.completeLink({ challengeId: c1.challengeId, signature: sig1 }),
      'CHALLENGE_CONSUMED',
    );
    const c3 = await links.requestLink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelProof: login(2002, 'bob'),
      wallet: bob.address,
    });
    clock += 301;
    await expectCode(
      links.completeLink({
        challengeId: c3.challengeId,
        signature: await bob.signTypedData(channelLinkTypedData(c3)),
      }),
      'CHALLENGE_EXPIRED',
    );

    // Unlink needs the bound wallet's signature; Mallory cannot unlink Alice.
    const u = await links.requestUnlink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelUserId: '1001',
    });
    expect(u.wallet).toBe(alice.address);
    await expectCode(
      links.completeUnlink({
        challengeId: u.challengeId,
        signature: await mallory.signTypedData(channelLinkTypedData(u)),
      }),
      'SIGNATURE_MISMATCH',
    );
    const ended = await links.completeUnlink({
      challengeId: u.challengeId,
      signature: await alice.signTypedData(channelLinkTypedData(u)),
    });
    expect(ended.unlinkedAt).toBe(clock);
    expect(
      await links.resolve({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelUserId: '1001',
      }),
    ).toBeNull();
  });

  it('P05-02 1,000 eligible with 600 voters records 400 abstentions, never unanimity', async () => {
    const accounts = Array.from({ length: 1_000 }, (_, i) =>
      accountFor(`member-${i}`),
    );
    const snapshot = takeSnapshot({
      ballotId: 'bal_treasury_q4',
      proposalHash: keccak256(toHex('fund the Q4 build budget')),
      policy: policyV1,
      members: accounts.map((a, i) =>
        member(`m${i}`, a.address, [`telegram:${100_000 + i}`]),
      ),
      now: NOW,
    });
    expect(snapshot.eligibleCount).toBe(1_000);
    expect(snapshot.flags).toEqual([]);
    expect(Object.isFrozen(snapshot.members)).toBe(true);
    verifySnapshot(snapshot);

    const accepted: AcceptedVote[] = [];
    for (const voter of accounts.slice(0, 600)) {
      const { vote, signature } = await signedVote(voter, snapshot, 'YES');
      accepted.push(
        await admitVote({
          snapshot,
          policy: policyV1,
          delegations: [],
          accepted,
          vote,
          signature,
          now: NOW + 60,
        }),
      );
    }
    // A chat "yes" and a second vote from the same wallet are not counted.
    const chat = await signedVote(accounts[700]!, snapshot, 'YES');
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: [],
        accepted,
        vote: chat.vote,
        signature: '👍 yes',
        now: NOW + 60,
      }),
      'BAD_SIGNATURE',
    );
    const again = await signedVote(accounts[0]!, snapshot, 'NO');
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: [],
        accepted,
        ...again,
        now: NOW + 61,
      }),
      'DUPLICATE_VOTE',
    );

    const open = tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: [],
      at: NOW + DAY,
    });
    expect(open.status).toBe('OPEN');
    const result = tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: [],
      at: snapshot.closesAt,
    });
    expect(result).toMatchObject({
      status: 'PASSED',
      final: true,
      eligible: { count: 1_000, weight: 1_000n },
      participated: { count: 600, weight: 600n },
      yes: { count: 600 },
      no: { count: 0 },
      notVoted: { count: 400, weight: 400n },
      abstentions: { count: 400, weight: 400n },
      participationBps: 6_000,
      yesOfEligibleBps: 6_000,
      unanimous: false,
    });
    expect(result.summary).toContain(
      '600 of 1000 eligible members voted (60%)',
    );
    expect(result.summary).toContain('400 did not vote');
    expect(result.summary).not.toMatch(/100%|unanim/i);
  }, 120_000);

  it('P05-03 delegation cycles and votes through revoked or expired delegations are rejected', async () => {
    const [A, B, C, D, E, F] = ['A', 'B', 'C', 'D', 'E', 'F'].map((l) =>
      accountFor(`deleg-${l}`),
    ) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    const registry = new DelegationRegistry(policyV1);
    const delegate = async (
      from: PrivateKeyAccount,
      to: PrivateKeyAccount,
      over: Partial<Delegation> = {},
      signer = from,
    ) => {
      const d: Delegation = {
        workspaceId: WORKSPACE,
        chainId: CHAIN,
        delegator: from.address,
        delegate: to.address,
        issuedAt: NOW - 10,
        expiresAt: NOW + 30 * DAY,
        nonce: nonce(`${from.address}->${to.address}`),
        ...over,
      };
      return registry.register(
        d,
        await signer.signTypedData(delegationTypedData(d)),
        NOW,
      );
    };
    await delegate(A, B);
    await delegate(B, C);
    await expectCode(delegate(C, A), 'DELEGATION_CYCLE');
    await delegate(D, E);
    await expectCode(delegate(E, D), 'DELEGATION_CYCLE');
    await expectCode(delegate(C, D, {}, F), 'BAD_SIGNATURE'); // not signed by the delegator
    await delegate(F, E, { expiresAt: NOW + 3_600 });

    const snapshot = takeSnapshot({
      ballotId: 'bal_proxy',
      proposalHash: keccak256(toHex('proxy proposal')),
      policy: policyV1,
      members: [A, B, C, D, E, F].map((a, i) => member(`p${i}`, a.address)),
      now: NOW,
    });
    const accepted: AcceptedVote[] = [];
    const admit = async (
      voter: PrivateKeyAccount,
      onBehalfOf: Address[],
      at: number,
    ) => {
      const { vote, signature } = await signedVote(
        voter,
        snapshot,
        'YES',
        onBehalfOf,
        at,
      );
      const v = await admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted,
        vote,
        signature,
        now: at,
      });
      accepted.push(v);
      return v;
    };
    // C represents A and B through A -> B -> C.
    await admit(C, [A.address, B.address], NOW + 60);

    // D revokes; a later vote by E on D's behalf is rejected.
    const dId = registry
      .list()
      .find((r) => r.delegation.delegator === D.address)!.id;
    const revokeD = {
      workspaceId: WORKSPACE,
      chainId: CHAIN,
      delegationId: dId,
      delegator: D.address,
      requestedAt: NOW + 100,
    };
    await expectCode(
      registry.revoke(
        revokeD,
        await E.signTypedData(revocationTypedData(revokeD)),
        NOW + 100,
      ),
      'BAD_SIGNATURE',
    );
    await registry.revoke(
      revokeD,
      await D.signTypedData(revocationTypedData(revokeD)),
      NOW + 100,
    );
    await expectCode(admit(E, [D.address], NOW + 200), 'DELEGATION_REVOKED');
    // F's delegation expired after an hour.
    await expectCode(admit(E, [F.address], NOW + 4_000), 'DELEGATION_EXPIRED');
    await admit(E, [], NOW + 4_000);

    // A revokes after C voted: A's weight drops back to abstention at the tally.
    const aId = registry
      .list()
      .find((r) => r.delegation.delegator === A.address)!.id;
    const revokeA = {
      workspaceId: WORKSPACE,
      chainId: CHAIN,
      delegationId: aId,
      delegator: A.address,
      requestedAt: NOW + 5_000,
    };
    await registry.revoke(
      revokeA,
      await A.signTypedData(revocationTypedData(revokeA)),
      NOW + 5_000,
    );
    const result = tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: registry.list(),
      at: snapshot.closesAt,
    });
    expect(result.yes.count).toBe(3); // C, B via C, E
    expect(result.viaDelegate).toBe(1);
    expect(result.notVoted.count).toBe(3); // A, D, F
    expect(result.droppedRepresentations).toEqual([
      { member: A.address, voter: C.address, reason: 'DELEGATION_REVOKED' },
    ]);
    expect(delegationId(registry.list()[0]!.delegation)).toBe(
      registry.list()[0]!.id,
    );
  });

  it('P05-03 representation stops at the closest voting delegate; late delegations cannot rewrite a tally', async () => {
    const [G, H, I, J] = ['G', 'H', 'I', 'J'].map((l) =>
      accountFor(`chain-${l}`),
    ) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    const registry = new DelegationRegistry(policyV1);
    const delegate = async (
      from: PrivateKeyAccount,
      to: PrivateKeyAccount,
      issuedAt: number,
      now: number,
    ) => {
      const d: Delegation = {
        workspaceId: WORKSPACE,
        chainId: CHAIN,
        delegator: from.address,
        delegate: to.address,
        issuedAt,
        expiresAt: issuedAt + 30 * DAY,
        nonce: nonce(`chain:${from.address}`),
      };
      return registry.register(
        d,
        await from.signTypedData(delegationTypedData(d)),
        now,
      );
    };
    await delegate(G, H, NOW, NOW);
    await delegate(H, I, NOW, NOW);
    await expectCode(delegate(I, J, NOW - 3_600, NOW), 'DELEGATION_INVALID'); // stale signature
    const snapshot = takeSnapshot({
      ballotId: 'bal_chain',
      proposalHash: keccak256(toHex('chain proposal')),
      policy: policyV1,
      members: [G, H, I, J].map((a, i) => member(`c${i}`, a.address)),
      now: NOW,
    });
    const accepted: AcceptedVote[] = [];
    const h = await signedVote(H, snapshot, 'NO', [], NOW + 60);
    accepted.push(
      await admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted,
        ...h,
        now: NOW + 60,
      }),
    );
    const i = await signedVote(I, snapshot, 'YES', [G.address], NOW + 70);
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted,
        ...i,
        now: NOW + 70,
      }),
      'DUPLICATE_VOTE',
    );
    // A delegation registered after the close takes effect only from registration.
    const late = await delegate(
      J,
      I,
      snapshot.closesAt - 100,
      snapshot.closesAt + 100,
    );
    expect(isActiveAt(late, snapshot.closesAt)).toBe(false);
    const result = tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: registry.list(),
      at: snapshot.closesAt + 200,
    });
    expect(result).toMatchObject({
      no: { count: 1 },
      yes: { count: 0 },
      notVoted: { count: 3 },
    });
  });

  it('P05-04 a funding contribution is not assent to new launch terms', async () => {
    const x = accountFor('contributor-x');
    const y = accountFor('contributor-y');
    const v1 = launchTermsHash(termsV1);
    const v2 = launchTermsHash(termsV2);
    const assent = (
      who: PrivateKeyAccount,
      terms: LaunchTerms,
      label: string,
    ) => ({
      campaignId: terms.campaignId,
      chainId: CHAIN,
      contributor: who.address,
      termsHash: launchTermsHash(terms),
      termsVersion: terms.version,
      issuedAt: NOW,
      nonce: nonce(label),
    });
    const xV1 = assent(x, termsV1, 'x-v1');
    const xV1Assent = await verifyAssent({
      assent: xV1,
      signature: await x.signTypedData(assentTypedData(xV1)),
      terms: termsV1,
      now: NOW,
    });
    const deposit = (
      who: PrivateKeyAccount,
      amount: string,
      termsHash: Hex,
      id: string,
    ): Contribution => ({
      contributionId: id,
      campaignId: termsV1.campaignId,
      contributor: who.address,
      amount: moneyFromDecimal(USDC, amount),
      termsHash,
      txHash: keccak256(toHex(`tx:${id}`)),
      at: NOW,
    });
    // X funded under v1, and again after v2 was published, but never signed v2.
    const contributions = [
      deposit(x, '100', v1, 'c1'),
      deposit(x, '50', v2, 'c2'),
      deposit(y, '40', v1, 'c3'),
    ];
    const assents: VerifiedAssent[] = [xV1Assent];
    const before = launchReadiness({ terms: termsV2, contributions, assents });
    expect(before.allAssented).toBe(false);
    expect(before.bound.baseUnits).toBe(0n);
    expect(before.refundable.baseUnits).toBe(190_000_000n);
    expect(
      before.positions.find((p) => p.contributor === x.address),
    ).toMatchObject({
      status: 'REFUNDABLE_UNDER_ORIGINAL_TERMS',
      contributed: { baseUnits: 150_000_000n },
    });
    expect(() =>
      requireAssent({ terms: termsV2, contributor: x.address, assents }),
    ).toThrow(/deposit is not assent/);

    // X's v1 assent cannot be relabelled as v2, and a YES ballot vote is not assent either.
    await expectCode(
      verifyAssent({
        assent: xV1,
        signature: xV1Assent.signature,
        terms: termsV2,
        now: NOW,
      }),
      'BAD_ASSENT',
    );
    const relabelled = { ...xV1, termsHash: v2, termsVersion: 2 };
    await expectCode(
      verifyAssent({
        assent: relabelled,
        signature: xV1Assent.signature,
        terms: termsV2,
        now: NOW,
      }),
      'BAD_ASSENT',
    );
    const snapshot = takeSnapshot({
      ballotId: 'bal_terms_v2',
      proposalHash: v2,
      policy: policyV1,
      members: [member('x', x.address), member('y', y.address)],
      now: NOW,
    });
    const yes = await signedVote(x, snapshot, 'YES');
    await expectCode(
      verifyAssent({
        assent: assent(x, termsV2, 'x-v2'),
        signature: yes.signature,
        terms: termsV2,
        now: NOW,
      }),
      'BAD_ASSENT',
    );

    // Y signs v2: only Y's funds are bound by the new terms.
    const yV2 = assent(y, termsV2, 'y-v2');
    assents.push(
      await verifyAssent({
        assent: yV2,
        signature: await y.signTypedData(assentTypedData(yV2)),
        terms: termsV2,
        now: NOW,
      }),
    );
    const after = launchReadiness({ terms: termsV2, contributions, assents });
    expect(after.bound.baseUnits).toBe(40_000_000n);
    expect(after.refundable.baseUnits).toBe(150_000_000n);
    expect(after.pending).toEqual([x.address]);
    requireAssent({ terms: termsV2, contributor: y.address, assents });
  });

  it('P05-05 four-of-seven council signatures are rejected under a five-of-seven policy', async () => {
    validateTerm(term1, policyV1);
    const vault = `0x${'a1'.repeat(20)}` as Address;
    const recipient = `0x${'5a'.repeat(20)}` as Address;
    const transfer = {
      chainId: CHAIN,
      token: USDC.address,
      payer: vault,
      recipient,
      amount: 2_500_000_000n,
    };
    const withdraw = actionFor(
      term1,
      'WITHDRAWAL',
      withdrawalActionHash(transfer),
      'withdraw-1',
    );
    const four = await signAction(council.slice(0, 4), withdraw);
    const err = await expectCode(
      approveCouncilAction({
        term: term1,
        policy: policyV1,
        action: withdraw,
        signatures: four,
        now: NOW,
      }),
      'QUORUM_NOT_MET',
    );
    expect(err.message).toBe(
      '4 of 7 seat holders signed; policy requires 5-of-7',
    );

    // Padding the four with a repeat, an outsider, or a seat holder's signature
    // over a different amount never reaches five independent signers.
    const outsider = accountFor('outsider');
    const otherAmount = actionFor(
      term1,
      'WITHDRAWAL',
      withdrawalActionHash({ ...transfer, amount: 1n }),
      'withdraw-1',
    );
    const padded = [
      ...four,
      four[0]!,
      await outsider.signTypedData(councilActionTypedData(withdraw)),
      await council[4]!.signTypedData(councilActionTypedData(otherAmount)),
      'approved in chat',
    ];
    const report = await verifyCouncilSignatures({
      term: term1,
      policy: policyV1,
      action: withdraw,
      signatures: padded,
      now: NOW,
    });
    expect(report.met).toBe(false);
    expect(report.signers).toHaveLength(4);
    expect(report.rejected.map((r) => r.reason)).toEqual([
      'DUPLICATE_SIGNER',
      'NOT_A_SEAT_HOLDER',
      'NOT_A_SEAT_HOLDER',
      'UNRECOVERABLE',
    ]);
    await expectCode(
      approveCouncilAction({
        term: term1,
        policy: policyV1,
        action: withdraw,
        signatures: padded,
        now: NOW,
      }),
      'QUORUM_NOT_MET',
    );

    // Five distinct seat holders approve; execution still waits out the challenge window.
    const five = await signAction(council.slice(0, 5), withdraw);
    const decision = await approveCouncilAction({
      term: term1,
      policy: policyV1,
      action: withdraw,
      signatures: five,
      now: NOW,
    });
    const exec = (
      now: number,
      challenges = [] as Awaited<ReturnType<typeof admitChallenge>>[],
      hash = withdraw.actionHash,
    ) =>
      assertExecutable({
        decision,
        term: term1,
        challenges,
        now,
        kind: 'WITHDRAWAL',
        actionHash: hash,
      });
    await expectCode(() => exec(NOW + DAY), 'CHALLENGE_WINDOW_OPEN');
    await expectCode(
      () => exec(NOW + 3 * DAY, [], otherAmount.actionHash),
      'ACTION_MISMATCH',
    );
    exec(NOW + 2 * DAY);

    // A seat with two seats' worth of one wallet is not an independent council.
    const sharedSeat = {
      ...term1,
      seats: term1.seats.map((s, i) =>
        i === 6 ? { ...s, holder: council[0]!.address } : s,
      ),
    };
    await expectCode(() => validateTerm(sharedSeat, policyV1), 'BAD_COUNCIL');

    // A signed challenge inside the window halts the decision.
    const objector = accountFor('member-objector');
    const challenge = {
      chainId: CHAIN,
      decisionDigest: decision.digest,
      challenger: objector.address,
      reasonHash: keccak256(toHex('recipient not on vendor master')),
      raisedAt: NOW + 3_600,
    };
    const accepted = await admitChallenge({
      decision,
      challenge,
      signature: await objector.signTypedData(challengeTypedData(challenge)),
      challengers: [objector.address, ...council.map((c) => c.address)],
      now: NOW + 3_600,
    });
    await expectCode(() => exec(NOW + 3 * DAY, [accepted]), 'CHALLENGED');
    await expectCode(
      admitChallenge({
        decision,
        challenge: { ...challenge, raisedAt: NOW + 3 * DAY },
        signature: await objector.signTypedData(
          challengeTypedData({ ...challenge, raisedAt: NOW + 3 * DAY }),
        ),
        challengers: [objector.address],
        now: NOW + 3 * DAY,
      }),
      'CHALLENGE_WINDOW_CLOSED',
    );
  });

  it('P05-05 term rotation retires old seat holders and needs the sitting quorum', async () => {
    const newcomers = [accountFor('seat-new-a'), accountFor('seat-new-b')];
    const term2: CouncilTerm = {
      ...term1,
      termId: 2,
      seats: [...council.slice(0, 5), ...newcomers].map((a, i) => ({
        seatId: `seat-${i}`,
        holder: a.address,
      })),
      startsAt: NOW + 3 * DAY,
      endsAt: NOW + 360 * DAY,
    };
    const rotate = actionFor(term1, 'ROTATE_TERM', termHash(term2), 'rotate-1');
    await expectCode(
      approveCouncilAction({
        term: term1,
        policy: policyV1,
        action: rotate,
        signatures: await signAction(council.slice(2, 6), rotate),
        now: NOW,
      }),
      'QUORUM_NOT_MET',
    );
    const decision = await approveCouncilAction({
      term: term1,
      policy: policyV1,
      action: rotate,
      signatures: await signAction(council.slice(2, 7), rotate),
      now: NOW,
    });
    await expectCode(
      () =>
        rotateTerm({
          current: term1,
          next: term2,
          policy: policyV1,
          decision,
          challenges: [],
          now: NOW + DAY,
        }),
      'CHALLENGE_WINDOW_OPEN',
    );
    const active = rotateTerm({
      current: term1,
      next: term2,
      policy: policyV1,
      decision,
      challenges: [],
      now: NOW + 2 * DAY,
    });
    expect(active.termId).toBe(2);

    // Retired holders (seats 5, 6) no longer count; term-1 actions do not bind term 2.
    const later = NOW + 4 * DAY;
    const pay = {
      ...actionFor(term2, 'WITHDRAWAL', keccak256(toHex('pay')), 'pay-2'),
      expiresAt: later + 30 * DAY,
    };
    const report = await verifyCouncilSignatures({
      term: active,
      policy: policyV1,
      action: pay,
      signatures: await signAction(
        [
          council[5]!,
          council[6]!,
          council[0]!,
          council[1]!,
          council[2]!,
          council[3]!,
        ],
        pay,
      ),
      now: later,
    });
    expect(report.signers).toHaveLength(4);
    expect(report.met).toBe(false);
    const stale = {
      ...actionFor(term1, 'WITHDRAWAL', keccak256(toHex('pay')), 'pay-1'),
    };
    await expectCode(
      verifyCouncilSignatures({
        term: active,
        policy: policyV1,
        action: stale,
        signatures: [],
        now: later,
      }),
      'ACTION_MISMATCH',
    );

    // If the sitting council lapses, members install the next term only by a passed ballot on it.
    const members = Array.from({ length: 10 }, (_, i) =>
      accountFor(`installer-${i}`),
    );
    const term3: CouncilTerm = {
      ...term2,
      termId: 3,
      startsAt: term2.endsAt,
      endsAt: term2.endsAt + 300 * DAY,
    };
    const snapshot = takeSnapshot({
      ballotId: 'bal_term3',
      proposalHash: termHash(term3),
      policy: policyV1,
      members: members.map((a, i) => member(`i${i}`, a.address)),
      now: later,
    });
    const votes: AcceptedVote[] = [];
    for (const m of members.slice(0, 7)) {
      const { vote, signature } = await signedVote(
        m,
        snapshot,
        'YES',
        [],
        later + 10,
      );
      votes.push(
        await admitVote({
          snapshot,
          policy: policyV1,
          delegations: [],
          accepted: votes,
          vote,
          signature,
          now: later + 10,
        }),
      );
    }
    const result = tally({
      snapshot,
      policy: policyV1,
      votes,
      delegations: [],
      at: snapshot.closesAt,
    });
    expect(
      installTermFromBallot({
        previous: term2,
        next: term3,
        policy: policyV1,
        result,
        now: snapshot.closesAt,
      }).termId,
    ).toBe(3);
    await expectCode(
      () =>
        installTermFromBallot({
          previous: term2,
          next: { ...term3, endsAt: term3.endsAt - 1 },
          policy: policyV1,
          result,
          now: snapshot.closesAt,
        }),
      'QUORUM_NOT_MET',
    );
  }, 60_000);

  it('P05-06 concentration and duplicate-eligibility flags are surfaced', async () => {
    const people = Array.from({ length: 20 }, (_, i) =>
      accountFor(`sybil-${i}`),
    );
    const twin = accountFor('twin-wallet');
    const tgA = accountFor('tg-a');
    const tgB = accountFor('tg-b');
    const snapshot = takeSnapshot({
      ballotId: 'bal_sybil',
      proposalHash: keccak256(toHex('sybil proposal')),
      policy: policyV1,
      members: [
        ...people.map((a, i) =>
          member(
            `s${i}`,
            a.address,
            [`telegram:${500 + i}`],
            i === 19 ? 5n : 1n,
          ),
        ),
        member('dup-a', twin.address, ['telegram:900']),
        member('dup-b', twin.address, ['telegram:901']),
        member('tg-x', tgA.address, ['telegram:777']),
        member('tg-y', tgB.address, ['telegram:777']),
      ],
      now: NOW,
    });
    const codes = snapshot.flags.map((f) => [
      f.code,
      f.severity,
      [...f.memberIds],
    ]);
    expect(codes).toContainEqual([
      'DUPLICATE_WALLET',
      'HARD',
      ['dup-a', 'dup-b'],
    ]);
    expect(codes).toContainEqual([
      'DUPLICATE_CHANNEL_ID',
      'HARD',
      ['tg-x', 'tg-y'],
    ]);
    expect(codes).toContainEqual(['MEMBER_CONCENTRATION', 'SOFT', ['s19']]);
    expect(snapshot.quarantined.map((m) => m.memberId).sort()).toEqual([
      'dup-a',
      'dup-b',
      'tg-x',
      'tg-y',
    ]);
    expect(snapshot.eligibleCount).toBe(20);
    expect(snapshot.eligibleWeight).toBe(24n);

    // Quarantined entries cannot vote.
    const q = await signedVote(twin, snapshot, 'YES');
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: [],
        accepted: [],
        ...q,
        now: NOW + 60,
      }),
      'NOT_ELIGIBLE',
    );

    // Five members delegating to s0 gives s0 6/24 = 25% of eligible weight.
    const registry = new DelegationRegistry(policyV1);
    for (const a of people.slice(1, 6)) {
      const d: Delegation = {
        workspaceId: WORKSPACE,
        chainId: CHAIN,
        delegator: a.address,
        delegate: people[0]!.address,
        issuedAt: NOW,
        expiresAt: NOW + 30 * DAY,
        nonce: nonce(`conc-${a.address}`),
      };
      await registry.register(
        d,
        await a.signTypedData(delegationTypedData(d)),
        NOW,
      );
    }
    const flags = delegationConcentration({
      snapshot,
      records: registry.list(),
      policy: policyV1,
      at: NOW + 1,
    });
    expect(flags).toEqual([
      expect.objectContaining({
        code: 'DELEGATE_CONCENTRATION',
        subject: people[0]!.address,
        memberIds: ['s1', 's2', 's3', 's4', 's5'],
        detail: expect.stringContaining('2500 bps'),
      }),
    ]);
    const result = tally({
      snapshot,
      policy: policyV1,
      votes: [],
      delegations: registry.list(),
      at: NOW + 1,
    });
    expect(result.flags.map((f) => f.code).sort()).toEqual([
      'DELEGATE_CONCENTRATION',
      'DUPLICATE_CHANNEL_ID',
      'DUPLICATE_WALLET',
      'MEMBER_CONCENTRATION',
    ]);
  });

  it('P05-07 a policy change after the ballot requires a resnapshot and proper assent', async () => {
    const voters = Array.from({ length: 10 }, (_, i) =>
      accountFor(`reset-${i}`),
    );
    const members = voters.map((a, i) => member(`r${i}`, a.address));
    const s1 = takeSnapshot({
      ballotId: 'bal_launch',
      proposalHash: keccak256(toHex('launch under current terms')),
      policy: policyV1,
      members,
      now: NOW,
    });
    const votes: AcceptedVote[] = [];
    const early = await signedVote(voters[0]!, s1, 'YES');
    votes.push(
      await admitVote({
        snapshot: s1,
        policy: policyV1,
        delegations: [],
        accepted: votes,
        ...early,
        now: NOW + 60,
      }),
    );

    // The council moves to policy v2 (new launch terms, higher quorum).
    const policyV2: GovernancePolicy = {
      ...policyV1,
      version: 2,
      quorumBps: 6_000,
      termsHash: launchTermsHash(termsV2),
    };
    const change = actionFor(
      term1,
      'POLICY_CHANGE',
      policyChangeHash(policyV1, policyV2),
      'policy-v2',
    );
    await expectCode(
      approveCouncilAction({
        term: term1,
        policy: policyV1,
        action: change,
        signatures: await signAction(council.slice(0, 4), change),
        now: NOW + 100,
      }),
      'QUORUM_NOT_MET',
    );
    const decision = await approveCouncilAction({
      term: term1,
      policy: policyV1,
      action: change,
      signatures: await signAction(council.slice(1, 6), change),
      now: NOW + 100,
    });
    const x = accountFor('contributor-x');
    const y = accountFor('contributor-y');
    const contributions: Contribution[] = [x, y].map((who, i) => ({
      contributionId: `dep-${i}`,
      campaignId: termsV1.campaignId,
      contributor: who.address,
      amount: moneyFromDecimal(USDC, '25'),
      termsHash: launchTermsHash(termsV1),
      txHash: keccak256(toHex(`dep-${i}`)),
      at: NOW,
    }));
    const yAssent = {
      campaignId: termsV2.campaignId,
      chainId: CHAIN,
      contributor: y.address,
      termsHash: launchTermsHash(termsV2),
      termsVersion: 2,
      issuedAt: NOW,
      nonce: nonce('y-v2-reset'),
    };
    const assents = [
      await verifyAssent({
        assent: yAssent,
        signature: await y.signTypedData(assentTypedData(yAssent)),
        terms: termsV2,
        now: NOW,
      }),
    ];
    const apply = (now: number, newTerms?: LaunchTerms) =>
      applyPolicyChange({
        current: policyV1,
        proposed: policyV2,
        term: term1,
        decision,
        challenges: [],
        now,
        contributions,
        assents,
        ...(newTerms ? { newTerms } : {}),
      });
    await expectCode(() => apply(NOW + DAY, termsV2), 'CHALLENGE_WINDOW_OPEN');
    await expectCode(() => apply(NOW + 3 * DAY), 'BAD_TERMS');
    const applied = apply(NOW + 3 * DAY, termsV2);
    expect(applied.requiresResnapshot).toBe(true);
    expect(applied.materialTermsChange).toBe(true);
    expect(applied.contributorRights?.pending).toEqual([x.address]);
    expect(applied.contributorRights?.bound.baseUnits).toBe(25_000_000n);

    // The old snapshot is void under v2: no new votes, no result.
    const late = await signedVote(voters[1]!, s1, 'YES', [], NOW + 3 * DAY);
    await expectCode(
      admitVote({
        snapshot: s1,
        policy: policyV2,
        delegations: [],
        accepted: votes,
        ...late,
        now: NOW + 3 * DAY,
      }),
      'RESNAPSHOT_REQUIRED',
    );
    const stale = tally({
      snapshot: s1,
      policy: policyV2,
      votes,
      delegations: [],
      at: s1.closesAt,
    });
    expect(stale).toMatchObject({
      status: 'STALE_POLICY',
      quorumMet: false,
      approvalMet: false,
    });

    // Resnapshot: fresh window under the new hash; old signatures do not carry over.
    await expectCode(
      () =>
        resnapshot({
          stale: s1,
          policy: policyV1,
          members,
          now: NOW + 3 * DAY,
        }),
      'BAD_SNAPSHOT',
    );
    const s2 = resnapshot({
      stale: s1,
      policy: policyV2,
      members,
      now: NOW + 3 * DAY,
    });
    expect(s2.supersedes).toBe(s1.snapshotId);
    expect(s2.policyHash).not.toBe(s1.policyHash);
    await expectCode(
      admitVote({
        snapshot: s2,
        policy: policyV2,
        delegations: [],
        accepted: [],
        ...early,
        now: NOW + 3 * DAY + 60,
      }),
      'BALLOT_MISMATCH',
    );
    const fresh = await signedVote(
      voters[0]!,
      s2,
      'YES',
      [],
      NOW + 3 * DAY + 60,
    );
    const v = await admitVote({
      snapshot: s2,
      policy: policyV2,
      delegations: [],
      accepted: [],
      ...fresh,
      now: NOW + 3 * DAY + 60,
    });
    expect(v.snapshotId).toBe(s2.snapshotId);

    // A tampered snapshot is detected.
    const tampered = { ...s2, members: s2.members.slice(1) } as BallotSnapshot;
    await expectCode(() => verifySnapshot(tampered), 'BAD_SNAPSHOT');
    expect(GovernanceError).toBeDefined();
  });
});
