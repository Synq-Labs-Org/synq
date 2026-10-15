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
  MemoryCouncilStore,
  admitChallenge,
  admitVote,
  applyPolicyChange,
  approveCouncilAction,
  assentTypedData,
  challengeTypedData,
  councilActionDigest,
  councilActionTypedData,
  currentTerm,
  decisionStatus,
  deepFreeze,
  delegationConcentration,
  delegationId,
  delegationTypedData,
  establishCouncil,
  executeDecision,
  installTermFromBallot,
  isActiveAt,
  launchReadiness,
  launchTermsHash,
  policyChangeHash,
  policyHash,
  requireAssent,
  resnapshot,
  revocationTypedData,
  rotateTerm,
  snapshotIdOf,
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
  type CouncilDecision,
  type CouncilStore,
  type CouncilTerm,
  type Delegation,
  type DelegationRecord,
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
  over: Partial<CouncilAction> = {},
): CouncilAction => ({
  councilId: t.councilId,
  workspaceId: t.workspaceId,
  chainId: t.chainId,
  termId: t.termId,
  termHash: termHash(t),
  policyHash: policyHash(policyV1),
  kind,
  actionHash,
  nonce: nonce(label),
  proposedAt: NOW - 60,
  expiresAt: NOW + 30 * DAY,
  ...over,
});
const signAction = (signers: PrivateKeyAccount[], a: CouncilAction) =>
  Promise.all(signers.map((s) => s.signTypedData(councilActionTypedData(a))));
async function newCouncil(): Promise<CouncilStore> {
  const store = new MemoryCouncilStore();
  await establishCouncil({ store, term: term1, policy: policyV1 });
  return store;
}
const approve = async (
  store: CouncilStore,
  action: CouncilAction,
  signers: PrivateKeyAccount[],
  now = NOW,
  term = term1,
  policy = policyV1,
) =>
  approveCouncilAction({
    store,
    term,
    policy,
    action,
    signatures: await signAction(signers, action),
    now,
  });

describe('P05 principal linking and large-group governance', () => {
  it('P05-01 a copied Telegram handle or captured login cannot bind a wallet without the challenge', async () => {
    const BOT = 'p05-test-bot-token';
    let clock = NOW;
    const outbox = new Map<string, string>(); // bot DMs: channel user id -> code
    const store = new MemoryChannelLinkStore();
    const links = new ChannelLinkService(store, {
      now: () => clock,
      challengeTtlSeconds: 300,
      deliverCode: async ({ channelUserId, code }) => {
        outbox.set(channelUserId, code);
      },
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
    const carol = accountFor('carol');
    const mallory = accountFor('mallory');
    const login = (id: number, username: string) =>
      signTelegramLoginForTest({ id, username, auth_date: clock }, BOT);
    const resolve = (channelUserId: string) =>
      links.resolve({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelUserId,
      });
    const request = (proof: unknown, wallet: Address) =>
      links.requestLink({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelProof: proof,
        wallet,
      });

    // Alice proves Telegram user 1001, reads the code the bot DMs her, and signs.
    const aliceLogin = login(1001, 'alice');
    const c1 = await request(aliceLogin, alice.address);
    expect(c1).toMatchObject({ channelUserId: '1001', displayHandle: 'alice' });
    const sig1 = await alice.signTypedData(channelLinkTypedData(c1));
    const linked = await links.completeLink({
      challengeId: c1.challengeId,
      channelCode: outbox.get('1001')!,
      signature: sig1,
    });
    expect(linked.wallet).toBe(alice.address);
    expect(await resolve('1001')).toBe(alice.address);

    // A copied handle is not a channel proof; a forged hash fails Telegram's HMAC;
    // a login payload is accepted once only.
    await expectCode(
      request({ username: 'alice' }, mallory.address),
      'UNAUTHORIZED',
    );
    await expectCode(
      request(
        { id: 1001, username: 'alice', auth_date: clock, hash: '0'.repeat(64) },
        mallory.address,
      ),
      'UNAUTHORIZED',
    );
    await expectCode(request(aliceLogin, mallory.address), 'UNAUTHORIZED');
    for (const handle of ['alice', '@alice'])
      await expectCode(resolve(handle), 'INVALID_INPUT');

    // Regression: an attacker holding Bob's valid, unused login payload can no
    // longer bind Bob's Telegram id to their own wallet. The code goes to Bob.
    const bobLogin = login(2002, 'bob');
    const stolen = await request(bobLogin, mallory.address);
    const malloriesSig = await mallory.signTypedData(
      channelLinkTypedData(stolen),
    );
    for (let i = 0; i < 3; i++)
      await expectCode(
        links.completeLink({
          challengeId: stolen.challengeId,
          channelCode: '00000000',
          signature: malloriesSig,
        }),
        'CHALLENGE_MISMATCH',
      );
    await expectCode(
      links.completeLink({
        challengeId: stolen.challengeId,
        channelCode: outbox.get('2002')!,
        signature: malloriesSig,
      }),
      'CHALLENGE_CONSUMED',
    );
    expect(await resolve('2002')).toBeNull();

    // Mallory renames her own Telegram account (6666) to "bob" and claims Bob's
    // wallet: she receives her own code but cannot sign for Bob's wallet.
    const c2 = await request(login(6666, 'bob'), bob.address);
    const code6666 = outbox.get('6666')!;
    await expectCode(
      links.completeLink({
        challengeId: c2.challengeId,
        channelCode: code6666,
        signature: await mallory.signTypedData(channelLinkTypedData(c2)),
      }),
      'SIGNATURE_MISMATCH',
    );
    await expectCode(
      links.completeLink({
        challengeId: c2.challengeId,
        channelCode: code6666,
        signature: sig1,
      }),
      'SIGNATURE_MISMATCH',
    );
    await expectCode(
      links.completeLink({
        challengeId: c2.challengeId,
        channelCode: code6666,
        signature: 'yes, link it',
      }),
      'SIGNATURE_MISMATCH',
    );
    expect(await resolve('6666')).toBeNull();

    // One-use and expiring.
    await expectCode(
      links.completeLink({
        challengeId: c1.challengeId,
        channelCode: outbox.get('1001')!,
        signature: sig1,
      }),
      'CHALLENGE_CONSUMED',
    );
    clock += 1;
    const c3 = await request(login(2002, 'bob'), bob.address);
    clock += 301;
    await expectCode(
      links.completeLink({
        challengeId: c3.challengeId,
        channelCode: outbox.get('2002')!,
        signature: await bob.signTypedData(channelLinkTypedData(c3)),
      }),
      'CHALLENGE_EXPIRED',
    );

    // Regression: completion is atomic per wallet. Two pending challenges for
    // one wallet from different Telegram ids cannot both bind.
    const ca = await request(login(3003, 'carol'), carol.address);
    const cb = await request(login(4004, 'carol2'), carol.address);
    await links.completeLink({
      challengeId: ca.challengeId,
      channelCode: outbox.get('3003')!,
      signature: await carol.signTypedData(channelLinkTypedData(ca)),
    });
    await expectCode(
      links.completeLink({
        challengeId: cb.challengeId,
        channelCode: outbox.get('4004')!,
        signature: await carol.signTypedData(channelLinkTypedData(cb)),
      }),
      'PRINCIPAL_EXISTS',
    );

    // Wallet unlink needs the bound wallet; requests are rate limited per link.
    const u = await links.requestUnlink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelUserId: '1001',
    });
    expect(u.wallet).toBe(alice.address);
    await expectCode(
      links.requestUnlink({
        workspaceId: WORKSPACE,
        channel: 'telegram',
        channelUserId: '1001',
      }),
      'RATE_LIMITED',
    );
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
    expect(ended).toMatchObject({ unlinkedAt: clock, unlinkedBy: 'WALLET' });
    expect(await resolve('1001')).toBeNull();

    // Carol lost her wallet: she unlinks her own Telegram id with a fresh
    // channel proof and the code delivered to her.
    clock += 1;
    const cu = await links.requestChannelUnlink({
      workspaceId: WORKSPACE,
      channel: 'telegram',
      channelProof: login(3003, 'carol'),
    });
    await expectCode(
      links.completeChannelUnlink({
        challengeId: cu.challengeId,
        channelCode: '12345678',
      }),
      'CHALLENGE_MISMATCH',
    );
    const carolEnded = await links.completeChannelUnlink({
      challengeId: cu.challengeId,
      channelCode: outbox.get('3003')!,
    });
    expect(carolEnded).toMatchObject({
      unlinkedBy: 'CHANNEL',
      wallet: carol.address,
    });
    expect(await resolve('3003')).toBeNull();
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
    verifySnapshot(snapshot, policyV1);

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
    // A vote object altered after admission does not survive the tally's re-verification.
    const forged = { ...accepted[0]!, choice: 'NO' as const };
    await expectCode(
      tally({
        snapshot,
        policy: policyV1,
        votes: [forged, ...accepted.slice(1)],
        delegations: [],
        at: snapshot.closesAt,
      }),
      'BAD_SIGNATURE',
    );

    const open = await tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: [],
      at: NOW + DAY,
    });
    expect(open.status).toBe('OPEN');
    const result = await tally({
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

  it('P05-02 unanimity is only reported on a final, current-policy result', async () => {
    const [a, b] = [accountFor('unan-a'), accountFor('unan-b')];
    const snapshot = takeSnapshot({
      ballotId: 'bal_unanimous',
      proposalHash: keccak256(toHex('unanimous')),
      policy: policyV1,
      members: [member('ua', a.address), member('ub', b.address)],
      now: NOW,
    });
    const votes: AcceptedVote[] = [];
    for (const v of [a, b]) {
      const s = await signedVote(v, snapshot, 'YES');
      votes.push(
        await admitVote({
          snapshot,
          policy: policyV1,
          delegations: [],
          accepted: votes,
          ...s,
          now: NOW + 60,
        }),
      );
    }
    const at = (t: number, policy = policyV1) =>
      tally({ snapshot, policy, votes, delegations: [], at: t });
    expect((await at(NOW + 100)).unanimous).toBe(false); // OPEN
    const stale = await at(snapshot.closesAt, { ...policyV1, version: 2 });
    expect(stale).toMatchObject({ status: 'STALE_POLICY', unanimous: false });
    expect((await at(snapshot.closesAt)).unanimous).toBe(true);
  });

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
    const result = await tally({
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

    // Regression: hand-made delegation records are re-verified, not trusted.
    const aRecord = registry.list().find((r) => r.id === aId)!;
    const redirected: DelegationRecord = {
      ...aRecord,
      delegation: { ...aRecord.delegation, delegate: E.address },
    };
    const unsignedRevocation: DelegationRecord = {
      ...registry.list().find((r) => r.delegation.delegator === B.address)!,
      revokedAt: NOW + 50,
      revocation: null,
      revocationSignature: null,
    };
    const dRecord = registry.list().find((r) => r.id === dId)!;
    const revokedByOther: DelegationRecord = {
      ...dRecord,
      revocationSignature: await E.signTypedData(
        revocationTypedData(dRecord.revocation!),
      ),
    };
    const others = registry.list().filter((r) => r.id !== aId);
    await expectCode(
      tally({
        snapshot,
        policy: policyV1,
        votes: accepted,
        delegations: [
          revokedByOther,
          ...registry.list().filter((r) => r.id !== dId),
        ],
        at: snapshot.closesAt,
      }),
      'BAD_SIGNATURE',
    );
    await expectCode(
      tally({
        snapshot,
        policy: policyV1,
        votes: accepted,
        delegations: [redirected, ...others],
        at: snapshot.closesAt,
      }),
      'DELEGATION_INVALID',
    );
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: [
          unsignedRevocation,
          ...registry
            .list()
            .filter((r) => r.delegation.delegator !== B.address),
        ],
        accepted: [],
        ...(await signedVote(C, snapshot, 'YES', [], NOW + 70)),
        now: NOW + 70,
      }),
      'DELEGATION_INVALID',
    );
  });

  it('P05-03 a downstream delegation cannot wipe out representation that resolves upstream', async () => {
    // Regression: with maxDepth 3, X -> A -> B -> C and A votes for X; then
    // C -> D is added. X must stay represented by A.
    const [X, A, B, C, D] = ['X', 'A', 'B', 'C', 'D'].map((l) =>
      accountFor(`depth-${l}`),
    ) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    const registry = new DelegationRegistry(policyV1);
    const link = async (
      from: PrivateKeyAccount,
      to: PrivateKeyAccount,
      now: number,
    ) => {
      const d: Delegation = {
        workspaceId: WORKSPACE,
        chainId: CHAIN,
        delegator: from.address,
        delegate: to.address,
        issuedAt: now,
        expiresAt: now + 30 * DAY,
        nonce: nonce(`depth:${from.address}`),
      };
      return registry.register(
        d,
        await from.signTypedData(delegationTypedData(d)),
        now,
      );
    };
    await link(X, A, NOW);
    await link(A, B, NOW);
    await link(B, C, NOW);
    const snapshot = takeSnapshot({
      ballotId: 'bal_depth',
      proposalHash: keccak256(toHex('depth')),
      policy: policyV1,
      members: [X, A, B, C, D].map((a, i) => member(`d${i}`, a.address)),
      now: NOW,
    });
    const v = await signedVote(A, snapshot, 'YES', [X.address], NOW + 60);
    const accepted = [
      await admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted: [],
        ...v,
        now: NOW + 60,
      }),
    ];
    await link(C, D, NOW + 100); // pushes X's full chain to four hops
    const result = await tally({
      snapshot,
      policy: policyV1,
      votes: accepted,
      delegations: registry.list(),
      at: snapshot.closesAt,
    });
    expect(result.yes.count).toBe(2); // A and X via A
    expect(result.viaDelegate).toBe(1);
    expect(result.droppedRepresentations).toEqual([]);
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
    const result = await tally({
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

  it('P05-05 four-of-seven council signatures are rejected under a five-of-seven policy; approvals execute once', async () => {
    const store = await newCouncil();
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
    const err = await expectCode(
      approve(store, withdraw, council.slice(0, 4)),
      'QUORUM_NOT_MET',
    );
    expect(err.message).toBe(
      '4 of 7 seat holders signed; policy requires 5-of-7',
    );

    // Padding the four with a repeat, an outsider, or a seat holder's signature
    // over a different amount never reaches five independent signers.
    const four = await signAction(council.slice(0, 4), withdraw);
    const otherAmount = actionFor(
      term1,
      'WITHDRAWAL',
      withdrawalActionHash({ ...transfer, amount: 1n }),
      'withdraw-1',
    );
    const padded = [
      ...four,
      four[0]!,
      await accountFor('outsider').signTypedData(
        councilActionTypedData(withdraw),
      ),
      await council[4]!.signTypedData(councilActionTypedData(otherAmount)),
      'approved in chat',
    ];
    const report = await verifyCouncilSignatures({
      store,
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
        store,
        term: term1,
        policy: policyV1,
        action: withdraw,
        signatures: padded,
        now: NOW,
      }),
      'QUORUM_NOT_MET',
    );

    // Five distinct seat holders approve; execution waits out the challenge window.
    const decision = await approve(store, withdraw, council.slice(0, 5));
    expect(decision.signatures).toHaveLength(5);
    const exec = (
      d: Pick<CouncilDecision, 'digest'>,
      now: number,
      hash = withdraw.actionHash,
    ) =>
      executeDecision({
        store,
        decision: d,
        policy: policyV1,
        now,
        kind: 'WITHDRAWAL',
        actionHash: hash,
      });
    await expectCode(exec(decision, NOW + DAY), 'CHALLENGE_WINDOW_OPEN');
    await expectCode(
      exec(decision, NOW + 3 * DAY, otherAmount.actionHash),
      'ACTION_MISMATCH',
    );
    const receipt = await exec(decision, NOW + 2 * DAY);
    expect(receipt.signers).toHaveLength(5);
    // Regression: the same decision cannot execute a second time.
    await expectCode(exec(decision, NOW + 2 * DAY + 1), 'ALREADY_EXECUTED');
    expect(
      await decisionStatus({
        store,
        digest: decision.digest,
        policy: policyV1,
        now: NOW + 3 * DAY,
      }),
    ).toBe('EXECUTED');
    // Nor can another approval that reuses its nonce.
    const sameNonce = await approve(
      store,
      { ...withdraw, expiresAt: withdraw.expiresAt + 1 },
      council.slice(2, 7),
    );
    await expectCode(exec(sameNonce, NOW + 3 * DAY), 'ALREADY_EXECUTED');

    // Regression: a hand-made decision is not trusted. Unrecorded, it is unknown;
    // written straight into the store, its signatures and window are re-derived.
    const fakeAction = actionFor(
      term1,
      'WITHDRAWAL',
      withdraw.actionHash,
      'withdraw-fake',
    );
    const fake: CouncilDecision = {
      digest: councilActionDigest(fakeAction),
      action: fakeAction,
      signatures: [],
      signers: council.slice(0, 5).map((c) => c.address),
      approvedAt: 0,
      challengeEndsAt: 0,
    };
    await expectCode(exec(fake, NOW + 3 * DAY), 'UNKNOWN_DECISION');
    await store.insertDecision(fake);
    await expectCode(exec(fake, NOW + 3 * DAY), 'QUORUM_NOT_MET');
    const earlyAction = actionFor(
      term1,
      'WITHDRAWAL',
      withdraw.actionHash,
      'withdraw-early',
      { proposedAt: NOW + DAY },
    );
    await store.insertDecision({
      digest: councilActionDigest(earlyAction),
      action: earlyAction,
      signatures: await signAction(council.slice(0, 5), earlyAction),
      signers: [],
      approvedAt: 0,
      challengeEndsAt: 0,
    });
    await expectCode(
      exec({ digest: councilActionDigest(earlyAction) }, NOW + 2 * DAY),
      'CHALLENGE_WINDOW_OPEN',
    );

    // One wallet holding two seats is not an independent council.
    const sharedSeat = {
      ...term1,
      seats: term1.seats.map((s, i) =>
        i === 6 ? { ...s, holder: council[0]!.address } : s,
      ),
    };
    await expectCode(() => validateTerm(sharedSeat, policyV1), 'BAD_COUNCIL');

    // A signed challenge inside the window halts a decision.
    const withdraw2 = actionFor(
      term1,
      'WITHDRAWAL',
      withdraw.actionHash,
      'withdraw-2',
    );
    const decision2 = await approve(store, withdraw2, council.slice(0, 5));
    const objector = accountFor('member-objector');
    const challenge = {
      chainId: CHAIN,
      decisionDigest: decision2.digest,
      challenger: objector.address,
      reasonHash: keccak256(toHex('recipient not on vendor master')),
      raisedAt: NOW + 3_600,
    };
    await admitChallenge({
      store,
      policy: policyV1,
      digest: decision2.digest,
      challenge,
      signature: await objector.signTypedData(challengeTypedData(challenge)),
      challengers: [objector.address, ...council.map((c) => c.address)],
      now: NOW + 3_600,
    });
    await expectCode(exec(decision2, NOW + 3 * DAY), 'CHALLENGED');
    const late = { ...challenge, raisedAt: NOW + 3 * DAY };
    await expectCode(
      admitChallenge({
        store,
        policy: policyV1,
        digest: decision2.digest,
        challenge: late,
        signature: await objector.signTypedData(challengeTypedData(late)),
        challengers: [objector.address],
        now: NOW + 3 * DAY,
      }),
      'CHALLENGE_WINDOW_CLOSED',
    );
  });

  it('P05-05 term rotation retires the old term, refuses forks and back-dating, and needs the sitting quorum', async () => {
    const store = await newCouncil();
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
    const term2Fork: CouncilTerm = { ...term2, endsAt: term2.endsAt - DAY };
    const term2Back: CouncilTerm = {
      ...term2,
      startsAt: NOW,
      endsAt: NOW + 300 * DAY,
    };
    const rotate = actionFor(term1, 'ROTATE_TERM', termHash(term2), 'rotate-1');
    await expectCode(
      approve(store, rotate, council.slice(2, 6)),
      'QUORUM_NOT_MET',
    );
    const decision = await approve(store, rotate, council.slice(2, 7));
    const fork = await approve(
      store,
      actionFor(term1, 'ROTATE_TERM', termHash(term2Fork), 'rotate-fork'),
      council.slice(0, 5),
    );
    const back = await approve(
      store,
      actionFor(term1, 'ROTATE_TERM', termHash(term2Back), 'rotate-back'),
      council.slice(0, 5),
    );
    const pendingPay = await approve(
      store,
      actionFor(term1, 'WITHDRAWAL', keccak256(toHex('pay')), 'pay-1'),
      council.slice(0, 5),
    );

    await expectCode(
      rotateTerm({
        store,
        next: term2,
        policy: policyV1,
        decision,
        now: NOW + DAY,
      }),
      'CHALLENGE_WINDOW_OPEN',
    );
    await expectCode(
      rotateTerm({
        store,
        next: term2Back,
        policy: policyV1,
        decision: back,
        now: NOW + 2 * DAY,
      }),
      'BAD_COUNCIL',
    );
    const active = await rotateTerm({
      store,
      next: term2,
      policy: policyV1,
      decision,
      now: NOW + 2 * DAY,
    });
    expect(active.term.termId).toBe(2);
    // Regression: a second, competing rotation from term 1 is a fork and is refused.
    await expectCode(
      rotateTerm({
        store,
        next: term2Fork,
        policy: policyV1,
        decision: fork,
        now: NOW + 2 * DAY + 10,
      }),
      'BAD_COUNCIL',
    );
    const terms = await store.terms(term1.councilId);
    expect(terms.map((t) => [t.term.termId, t.effectiveEnd])).toEqual([
      [1, term2.startsAt],
      [2, term2.endsAt],
    ]);

    // Regression: after the handover, the old term object can neither approve nor execute.
    const later = NOW + 4 * DAY;
    expect(
      (await currentTerm(store, term1.councilId, later))?.term.termId,
    ).toBe(2);
    const oldTermPay = actionFor(
      term1,
      'WITHDRAWAL',
      keccak256(toHex('pay')),
      'pay-old',
      { proposedAt: later },
    );
    await expectCode(
      approve(store, oldTermPay, council.slice(0, 5), later, term1),
      'TERM_INACTIVE',
    );
    await expectCode(
      executeDecision({
        store,
        decision: pendingPay,
        policy: policyV1,
        now: later,
        kind: 'WITHDRAWAL',
        actionHash: keccak256(toHex('pay')),
      }),
      'TERM_INACTIVE',
    );
    expect(
      await decisionStatus({
        store,
        digest: pendingPay.digest,
        policy: policyV1,
        now: later,
      }),
    ).toBe('TERM_ENDED');

    // Retired holders (seats 5, 6) do not count toward term 2.
    const pay = actionFor(
      term2,
      'WITHDRAWAL',
      keccak256(toHex('pay')),
      'pay-2',
      { proposedAt: later, expiresAt: later + 30 * DAY },
    );
    const report = await verifyCouncilSignatures({
      store,
      term: term2,
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

    // If the sitting council lapses, members install the next term by a passed
    // ballot; the tally is recomputed from the signed votes, not trusted.
    const voters = Array.from({ length: 10 }, (_, i) =>
      accountFor(`installer-${i}`),
    );
    const closes = later + policyV1.votingPeriodSeconds;
    const term3: CouncilTerm = {
      ...term2,
      termId: 3,
      startsAt: closes + 10,
      endsAt: closes + 300 * DAY,
    };
    const ballot = takeSnapshot({
      ballotId: 'bal_term3',
      proposalHash: termHash(term3),
      policy: policyV1,
      members: voters.map((a, i) => member(`i${i}`, a.address)),
      now: later,
    });
    expect(ballot.closesAt).toBe(closes);
    const votes: AcceptedVote[] = [];
    for (const m of voters.slice(0, 7)) {
      const { vote, signature } = await signedVote(
        m,
        ballot,
        'YES',
        [],
        later + 10,
      );
      votes.push(
        await admitVote({
          snapshot: ballot,
          policy: policyV1,
          delegations: [],
          accepted: votes,
          vote,
          signature,
          now: later + 10,
        }),
      );
    }
    const install = (next: CouncilTerm, v = votes, s = ballot) =>
      installTermFromBallot({
        store,
        next,
        policy: policyV1,
        snapshot: s,
        votes: v,
        delegations: [],
        now: ballot.closesAt,
      });
    await expectCode(install(term3, votes.slice(0, 2)), 'QUORUM_NOT_MET'); // recomputed: 2 of 10 is no quorum
    await expectCode(
      install({ ...term3, endsAt: term3.endsAt - 1 }),
      'QUORUM_NOT_MET',
    );
    const tampered = {
      ...ballot,
      members: ballot.members.slice(3),
    } as BallotSnapshot;
    await expectCode(install(term3, votes, tampered), 'BAD_SNAPSHOT');
    expect((await install(term3)).term.termId).toBe(3);
    await expectCode(install(term3), 'BAD_COUNCIL'); // the same ballot cannot install twice
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
        // The same Telegram id written two ways is still one identity.
        member('tg-x', tgA.address, ['telegram:777']),
        member('tg-y', tgB.address, ['Telegram:0777']),
      ],
      now: NOW,
    });
    const codes = snapshot.flags.map((f) => [
      f.code,
      f.severity,
      f.subject,
      [...f.memberIds],
    ]);
    expect(codes).toContainEqual([
      'DUPLICATE_WALLET',
      'HARD',
      twin.address,
      ['dup-a', 'dup-b'],
    ]);
    expect(codes).toContainEqual([
      'DUPLICATE_CHANNEL_ID',
      'HARD',
      'telegram:777',
      ['tg-x', 'tg-y'],
    ]);
    expect(codes).toContainEqual([
      'MEMBER_CONCENTRATION',
      'SOFT',
      people[19]!.address,
      ['s19'],
    ]);
    expect(snapshot.quarantined.map((m) => m.memberId).sort()).toEqual([
      'dup-a',
      'dup-b',
      'tg-x',
      'tg-y',
    ]);
    expect(snapshot.eligibleCount).toBe(20);
    expect(snapshot.eligibleWeight).toBe(24n);

    // Quarantined entries cannot vote directly...
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

    const registry = new DelegationRegistry(policyV1);
    const link = async (from: PrivateKeyAccount, to: PrivateKeyAccount) => {
      const d: Delegation = {
        workspaceId: WORKSPACE,
        chainId: CHAIN,
        delegator: from.address,
        delegate: to.address,
        issuedAt: NOW,
        expiresAt: NOW + 30 * DAY,
        nonce: nonce(`conc-${from.address}`),
      };
      await registry.register(
        d,
        await from.signTypedData(delegationTypedData(d)),
        NOW,
      );
    };
    // ...nor as a delegate (regression), and a quarantined wallet breaks a chain through it.
    await link(people[6]!, twin);
    await link(twin, people[7]!);
    const asDelegate = await signedVote(twin, snapshot, 'YES', [
      people[6]!.address,
    ]);
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted: [],
        ...asDelegate,
        now: NOW + 60,
      }),
      'NOT_ELIGIBLE',
    );
    const through = await signedVote(people[7]!, snapshot, 'YES', [
      people[6]!.address,
    ]);
    await expectCode(
      admitVote({
        snapshot,
        policy: policyV1,
        delegations: registry.list(),
        accepted: [],
        ...through,
        now: NOW + 60,
      }),
      'NOT_ELIGIBLE',
    );

    // Five members delegating to s0 gives s0 6/24 = 25% of eligible weight.
    for (const a of people.slice(1, 6)) await link(a, people[0]!);
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
    const result = await tally({
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
    const store = await newCouncil();
    const voters = Array.from({ length: 10 }, (_, i) =>
      accountFor(`reset-${i}`),
    );
    const members = voters.map((a, i) =>
      member(`r${i}`, a.address, [`telegram:${7_000 + i}`]),
    );
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

    // A withdrawal approved under v1 is still pending when the policy changes.
    const pendingPay = await approve(
      store,
      actionFor(
        term1,
        'WITHDRAWAL',
        keccak256(toHex('pending')),
        'pending-pay',
      ),
      council.slice(0, 5),
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
      approve(store, change, council.slice(0, 4), NOW + 100),
      'QUORUM_NOT_MET',
    );
    const decision = await approve(
      store,
      change,
      council.slice(1, 6),
      NOW + 100,
    );
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
        store,
        current: policyV1,
        proposed: policyV2,
        decision,
        now,
        contributions,
        assents,
        ...(newTerms ? { newTerms } : {}),
      });
    await expectCode(apply(NOW + DAY, termsV2), 'CHALLENGE_WINDOW_OPEN');
    await expectCode(apply(NOW + 3 * DAY), 'BAD_TERMS');
    const applied = await apply(NOW + 3 * DAY, termsV2);
    expect(applied.requiresResnapshot).toBe(true);
    expect(applied.materialTermsChange).toBe(true);
    expect(applied.contributorRights?.pending).toEqual([x.address]);
    expect(applied.contributorRights?.bound.baseUnits).toBe(25_000_000n);
    await expectCode(apply(NOW + 3 * DAY + 1, termsV2), 'ALREADY_EXECUTED');

    // Regression: council decisions signed under v1 are void under v2.
    expect(
      await decisionStatus({
        store,
        digest: pendingPay.digest,
        policy: policyV2,
        now: NOW + 3 * DAY,
      }),
    ).toBe('POLICY_CHANGED');
    await expectCode(
      executeDecision({
        store,
        decision: pendingPay,
        policy: policyV2,
        now: NOW + 3 * DAY,
        kind: 'WITHDRAWAL',
        actionHash: keccak256(toHex('pending')),
      }),
      'POLICY_CHANGED',
    );

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
    const stale = await tally({
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
      unanimous: false,
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

    // Regression: every snapshot field is covered by its id, and with the policy
    // a re-hashed forgery is caught by rebuilding from the raw entries.
    verifySnapshot(s2, policyV2);
    const edits: Partial<BallotSnapshot>[] = [
      { members: s2.members.slice(1) },
      {
        flags: [
          {
            code: 'DUPLICATE_WALLET',
            severity: 'HARD',
            subject: 'x',
            memberIds: [],
            detail: '',
          },
        ],
      },
      { quarantined: [s2.members[0]!] },
      { policyId: 'pol_other' },
      { policyVersion: 9 },
      {
        members: s2.members.map((m, i) =>
          i === 0 ? { ...m, channelIds: ['telegram:1'] } : m,
        ),
      },
    ];
    for (const edit of edits)
      await expectCode(
        () => verifySnapshot({ ...s2, ...edit } as BallotSnapshot),
        'BAD_SNAPSHOT',
      );
    const { snapshotId: _id, ...body } = { ...s2, quarantined: [], flags: [] };
    const rehashed = {
      ...body,
      members: s2.members.map((m, i) =>
        i === 0 ? { ...m, channelIds: ['telegram:7001'] } : m,
      ),
    };
    const forgery = {
      snapshotId: snapshotIdOf(rehashed),
      ...rehashed,
    } as BallotSnapshot;
    await expectCode(() => verifySnapshot(forgery, policyV2), 'BAD_SNAPSHOT');
  });

  it('deepFreeze freezes children of an already shallow-frozen record', () => {
    const inner = { weight: 1 };
    const outer = Object.freeze({ inner });
    deepFreeze(outer);
    expect(Object.isFrozen(inner)).toBe(true);
  });
});
