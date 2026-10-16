import { describe, expect, it } from 'vitest';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  DelegationRegistry,
  assentTypedData,
  delegationTypedData,
  takeSnapshot,
  type Delegation,
} from '@synq/governance';
import {
  GroupFund,
  GroupFundService,
  MemoryFundStore,
  cancelProposalHash,
  contributionRef,
  memberCustody,
  proRata,
  transferKey,
  type FundCharter,
} from '@synq/treasury';
import {
  DAY,
  NOW,
  accountFor,
  applyAll,
  assent,
  castVotes,
  charterFor,
  contribute,
  expectCode,
  nonce,
  snapshotFor,
  transfer,
  usdc,
} from './helpers.js';

const people = (labels: string[]) =>
  labels.map((l) => ({ memberId: l, account: accountFor(l) }));
const open = (charter: FundCharter) =>
  GroupFund.fold(GroupFund.open(charter, NOW));

async function fundedGift(amounts: Record<string, number>, fundId = 'gift') {
  const members = people(Object.keys(amounts));
  const fund = open(
    charterFor({ fundId, members, pool: accountFor(`${fundId}-pool`).address }),
  );
  for (const [id, n] of Object.entries(amounts)) {
    contribute(fund, id, usdc(n));
    await assent(fund, id, accountFor(id));
  }
  return { fund, members };
}

describe('P19 community gifts, trips and expense pooling', () => {
  it('P19-01 a pledge or an unconfirmed transfer is never spendable; only a final, referenced deposit is', async () => {
    const members = people(['ana', 'ben']);
    const fund = open(
      charterFor({
        fundId: 'birthday',
        kind: 'BIRTHDAY_FUND',
        members,
        pool: accountFor('birthday-pool').address,
        minConfirmations: 3,
      }),
    );
    await assent(fund, 'ana', accountFor('ana'));
    applyAll(
      fund,
      fund.pledge({ pledgeId: 'p1', memberId: 'ana', amount: usdc(50) }, NOW),
    );
    expect(fund.view()).toMatchObject({
      pledged: usdc(50),
      free: 0n,
      custody: 0n,
    });
    expect(fund.electorate()).toEqual([]);
    await expectCode(
      () =>
        fund.requestRefund(
          { refundId: 'r0', memberId: 'ana', reason: 'x' },
          NOW,
        ),
      'REFUND_NOT_ALLOWED',
    );

    // On chain but below the confirmation requirement: pending, not spendable.
    const t = transfer({
      from: fund.member('ana').wallet,
      to: fund.charter.pool,
      amount: usdc(20),
      ref: contributionRef('birthday', 'ana'),
      block: 500n,
    });
    applyAll(fund, fund.observeDeposit(t, NOW));
    expect(fund.view()).toMatchObject({ pending: usdc(20), free: 0n });
    await expectCode(
      () => fund.finalizeDeposit(transferKey(t), 501n, NOW),
      'NOT_FINAL',
    );
    applyAll(
      fund,
      fund.proposeSpend(
        {
          spendId: 's1',
          payee: accountFor('shop').address,
          amount: usdc(10),
          purpose: 'cake',
        },
        NOW,
      ),
    );
    // No bound, final money: there is no electorate to approve anything.
    await expectCode(
      () => snapshotFor(fund, fund.spends.get('s1')!.proposalHash, 'b1'),
      'BAD_SNAPSHOT',
    );

    // A pending transfer that is reorganized away never becomes a claim.
    const lost = transfer({
      from: fund.member('ana').wallet,
      to: fund.charter.pool,
      amount: usdc(5),
      ref: contributionRef('birthday', 'ana'),
      block: 501n,
    });
    applyAll(fund, fund.observeDeposit(lost, NOW));
    applyAll(fund, fund.reorgDeposit(transferKey(lost), NOW));
    // An unreferenced transfer (e.g. a gas top-up) credits nobody.
    applyAll(
      fund,
      fund.observeDeposit(
        transfer({
          from: fund.member('ben').wallet,
          to: fund.charter.pool,
          amount: usdc(7),
        }),
        NOW,
      ),
    );

    applyAll(fund, fund.finalizeDeposit(transferKey(t), 502n, NOW));
    await expectCode(
      () => fund.reorgDeposit(transferKey(t), NOW),
      'ALREADY_FINAL',
    );
    expect(fund.view()).toMatchObject({
      pledged: usdc(30),
      pending: 0n,
      free: usdc(20),
      custody: usdc(20),
      unapplied: usdc(7),
    });
    expect(fund.member('ben').contributed).toBe(0n);
    // A replayed observation is idempotent; a deposit to another account is refused.
    expect(fund.observeDeposit(t, NOW)).toEqual([]);
    await expectCode(
      () =>
        fund.observeDeposit(
          { ...t, logIndex: 9, to: accountFor('elsewhere').address },
          NOW,
        ),
      'WRONG_POOL',
    );
    // Recurring contributions due are instructions (pledges), never funds.
    expect(fund.recurringDue('ana', NOW)).toEqual([]);
  });

  it('P19-02 new terms bind only contributors who sign them; the rest keep original refund rights', async () => {
    const { fund } = await fundedGift({ ana: 10, ben: 20, cat: 30 });
    expect(fund.view().free).toBe(usdc(60));
    // A deposit, a ballot vote or a signature by someone else is not assent.
    const forged = {
      campaignId: 'gift',
      chainId: fund.charter.asset.chainId,
      contributor: accountFor('ben').address,
      termsHash: fund.termsHash,
      termsVersion: 1,
      issuedAt: NOW,
      nonce: nonce('forged'),
    };
    await expectCode(
      fund.recordAssent({
        memberId: 'ben',
        assent: forged,
        signature: await accountFor('cat').signTypedData(
          assentTypedData(forged),
        ),
        now: NOW,
      }),
      'BAD_ASSENT',
    );

    applyAll(
      fund,
      fund.amendTerms(
        {
          ...fund.terms,
          version: 2,
          targetBaseUnits: usdc(500),
          refundableUntil: NOW + DAY,
          summary: 'v2: luxury gift, shorter refund window',
        },
        NOW + 10,
      ),
    );
    await assent(fund, 'cat', accountFor('cat'), NOW + 20);
    // Only cat is bound to v2: ana and ben stay refundable under v1.
    expect(fund.view()).toMatchObject({
      free: usdc(30),
      refundableUnbound: usdc(30),
      termsVersion: 2,
    });
    expect(fund.electorate().map((m) => m.memberId)).toEqual(['cat']);
    applyAll(
      fund,
      fund.proposeSpend(
        {
          spendId: 'lux',
          payee: accountFor('jeweller').address,
          amount: usdc(45),
          purpose: 'luxury gift',
        },
        NOW + 30,
      ),
    );
    const snap = snapshotFor(
      fund,
      fund.spends.get('lux')!.proposalHash,
      'b-lux',
      NOW + 30,
    );
    const votes = await castVotes(
      fund,
      snap,
      [{ account: accountFor('cat'), choice: 'YES' }],
      [],
      NOW + 60,
    );
    // A unanimous ballot of the bound minority still cannot spend money of contributors who never agreed.
    await expectCode(
      fund.authorizeSpend({
        spendId: 'lux',
        snapshot: snap,
        votes,
        now: NOW + 61,
      }),
      'BOUND_FUNDS_SHORT',
    );
    // A ballot that includes the unbound members is refused as the wrong electorate.
    const stuffed = takeSnapshot({
      ballotId: 'b-lux-all',
      proposalHash: snap.proposalHash,
      policy: fund.charter.policy,
      members: ['ana', 'ben', 'cat'].map((id) => ({
        memberId: id,
        wallet: accountFor(id).address,
        channelIds: [],
        weight: 1n,
      })),
      now: NOW + 30,
    });
    await expectCode(
      fund.authorizeSpend({
        spendId: 'lux',
        snapshot: stuffed,
        votes: [],
        now: NOW + 61,
      }),
      'RESNAPSHOT_REQUIRED',
    );

    // After v2's refund window, unbound contributors can still withdraw; the bound one cannot.
    const late = NOW + 3 * DAY;
    applyAll(
      fund,
      fund.requestRefund(
        { refundId: 'r-ana', memberId: 'ana', reason: 'did not accept v2' },
        late,
      ),
    );
    await expectCode(
      () =>
        fund.requestRefund(
          { refundId: 'r-cat', memberId: 'cat', reason: 'changed mind' },
          late,
        ),
      'REFUND_NOT_ALLOWED',
    );
    expect(fund.refundInstruction('r-ana')).toEqual({
      to: accountFor('ana').address,
      amount: usdc(10),
    });
  });

  it('P19-03 60% turnout of 1,000 contributors is not 1,000 approvals; abstention and silence never count as support', async () => {
    const accounts = Array.from({ length: 1_000 }, (_, i) =>
      accountFor(`m${i}`),
    );
    const members = accounts.map((account, i) => ({
      memberId: `m${String(i).padStart(4, '0')}`,
      account,
    }));
    const fund = open(
      charterFor({
        fundId: 'pool1k',
        kind: 'CONTRIBUTOR_POOL',
        members,
        pool: accountFor('pool1k-pool').address,
      }),
    );
    for (const m of members) {
      contribute(fund, m.memberId, usdc(1));
      await assent(fund, m.memberId, m.account);
    }
    expect(fund.view().free).toBe(usdc(1_000));
    applyAll(
      fund,
      fund.proposeSpend(
        {
          spendId: 'grant',
          payee: accountFor('builder').address,
          amount: usdc(400),
          purpose: 'community grant',
        },
        NOW,
      ),
    );
    const snap = snapshotFor(
      fund,
      fund.spends.get('grant')!.proposalHash,
      'b-1k',
    );
    expect(snap.eligibleCount).toBe(1_000);

    // 50 members delegate to m0000 (signed, revocable delegations).
    const registry = new DelegationRegistry(fund.charter.policy);
    const delegators = members.slice(950);
    for (const d of delegators) {
      const del: Delegation = {
        workspaceId: fund.charter.policy.workspaceId,
        chainId: fund.charter.policy.chainId,
        delegator: d.account.address,
        delegate: members[0]!.account.address,
        issuedAt: NOW - 10,
        expiresAt: NOW + 30 * DAY,
        nonce: nonce(`del-${d.memberId}`),
      };
      await registry.register(
        del,
        await d.account.signTypedData(delegationTypedData(del)),
        NOW,
      );
    }
    // 600 sign: 450 YES (m0000 also for its 50 delegators), 100 NO, 50 ABSTAIN. 350 stay silent.
    const ballots: {
      account: PrivateKeyAccount;
      choice: 'YES' | 'NO' | 'ABSTAIN';
      onBehalfOf?: `0x${string}`[];
    }[] = members.slice(0, 600).map((m, i) => ({
      account: m.account,
      choice: i < 450 ? 'YES' : i < 550 ? 'NO' : 'ABSTAIN',
      ...(i === 0
        ? { onBehalfOf: delegators.map((d) => d.account.address) }
        : {}),
    }));
    const started = Date.now();
    const votes = await castVotes(fund, snap, ballots, registry.list());
    // While the window is open and members are silent, nothing is decided.
    await expectCode(
      fund.authorizeSpend({
        spendId: 'grant',
        snapshot: snap,
        votes,
        delegations: registry.list(),
        now: NOW + DAY,
      }),
      'VOTE_OPEN',
    );
    const events = await fund.authorizeSpend({
      spendId: 'grant',
      snapshot: snap,
      votes,
      delegations: registry.list(),
      now: snap.closesAt,
    });
    const tallyMs = Date.now() - started;
    applyAll(fund, events);
    const auth = fund.spends.get('grant')!.authorization!;
    expect(auth).toMatchObject({
      eligible: 1_000,
      yes: 500,
      no: 100,
      abstain: 50,
      notVoted: 350,
      participationBps: 6_500,
      yesOfEligibleBps: 5_000,
      final: true,
    });
    // Approval is recorded for the 450 wallets that signed YES (plus 50 represented by delegation) — never for 1,000.
    expect(auth.approvedBy).toHaveLength(450);
    expect(auth.yes).toBeLessThan(auth.eligible);
    expect(auth.summary).toContain('350 did not vote');
    expect(auth.summary).toContain('silence is not consent');
    // The spend draws pro rata on every bound claim under the terms all 1,000 signed.
    const alloc = Object.values(fund.spends.get('grant')!.allocation);
    expect(alloc.reduce((a, b) => a + b, 0n)).toBe(usdc(400));
    expect(new Set(alloc)).toEqual(new Set([400_000n]));
    expect(fund.view()).toMatchObject({
      free: usdc(600),
      committed: usdc(400),
    });
    console.log(`P19-03 1000-member sign+tally+authorize: ${tallyMs} ms`);
  }, 240_000);

  it('P19-04 an admin without quorum, a chat poll or a tampered ballot cannot purchase', async () => {
    const { fund } = await fundedGift({ org: 10, ben: 10, cat: 10, dan: 10 });
    const payee = accountFor('gift-shop').address;
    applyAll(
      fund,
      fund.proposeSpend(
        { spendId: 'buy', payee, amount: usdc(25), purpose: 'gift' },
        NOW,
      ),
    );
    const snap = snapshotFor(
      fund,
      fund.spends.get('buy')!.proposalHash,
      'b-buy',
    );
    // The chat poll was unanimous; it is recorded as indicative and authorizes nothing.
    applyAll(
      fund,
      fund.recordSocialPoll(
        { pollId: 'tg-1', question: 'buy the gift?', yes: 4, no: 0 },
        NOW,
      ),
    );
    await expectCode(
      fund.authorizeSpend({
        spendId: 'buy',
        snapshot: snap,
        votes: [],
        now: snap.closesAt,
      }),
      'QUORUM_NOT_MET',
    );
    // The organizer (admin) alone signs YES: 25% turnout under a 50% quorum.
    const adminOnly = await castVotes(fund, snap, [
      { account: accountFor('org'), choice: 'YES' },
    ]);
    await expectCode(
      fund.authorizeSpend({
        spendId: 'buy',
        snapshot: snap,
        votes: adminOnly,
        now: snap.closesAt,
      }),
      'QUORUM_NOT_MET',
    );
    await expectCode(() => fund.spendInstruction('buy'), 'SPEND_STATE');
    // A vote object edited after signing does not survive re-verification.
    const two = await castVotes(fund, snap, [
      { account: accountFor('org'), choice: 'YES' },
      { account: accountFor('ben'), choice: 'NO' },
    ]);
    await expectCode(
      fund.authorizeSpend({
        spendId: 'buy',
        snapshot: snap,
        votes: [two[0]!, { ...two[1]!, choice: 'YES' }],
        now: snap.closesAt,
      }),
      'BAD_SIGNATURE',
    );
    // A ballot on a different amount is a different proposal.
    const other = snapshotFor(
      fund,
      cancelProposalHash('gift', fund.termsHash),
      'b-other',
    );
    await expectCode(
      fund.authorizeSpend({
        spendId: 'buy',
        snapshot: other,
        votes: [],
        now: other.closesAt,
      }),
      'BALLOT_MISMATCH',
    );
    // Quorum met but approval not met.
    const split = await castVotes(fund, snap, [
      { account: accountFor('org'), choice: 'YES' },
      { account: accountFor('ben'), choice: 'NO' },
      { account: accountFor('cat'), choice: 'NO' },
    ]);
    await expectCode(
      fund.authorizeSpend({
        spendId: 'buy',
        snapshot: snap,
        votes: split,
        now: snap.closesAt,
      }),
      'NOT_APPROVED',
    );
    // With quorum and approval the spend is authorized; the executor must pay exactly it.
    const ok = await castVotes(fund, snap, [
      { account: accountFor('org'), choice: 'YES' },
      { account: accountFor('ben'), choice: 'YES' },
      { account: accountFor('cat'), choice: 'YES' },
    ]);
    applyAll(
      fund,
      await fund.authorizeSpend({
        spendId: 'buy',
        snapshot: snap,
        votes: ok,
        now: snap.closesAt,
      }),
    );
    expect(fund.spendInstruction('buy')).toEqual({
      to: payee,
      amount: usdc(25),
    });
    await expectCode(
      () =>
        fund.recordSpendExecution(
          'buy',
          transfer({
            from: fund.charter.pool,
            to: accountFor('org').address,
            amount: usdc(25),
          }),
          NOW,
        ),
      'EXECUTION_MISMATCH',
    );
    await expectCode(
      () =>
        fund.recordSpendExecution(
          'buy',
          transfer({ from: fund.charter.pool, to: payee, amount: usdc(26) }),
          NOW,
        ),
      'EXECUTION_MISMATCH',
    );
    const paid = transfer({
      from: fund.charter.pool,
      to: payee,
      amount: usdc(25),
    });
    applyAll(fund, fund.recordSpendExecution('buy', paid, NOW));
    expect(fund.recordSpendExecution('buy', paid, NOW)).toEqual([]);
    expect(fund.view()).toMatchObject({
      spent: usdc(25),
      custody: usdc(15),
      committed: 0n,
    });
  });

  it('P19-05 cancelling a campaign returns each contributor exactly their own remaining claim', async () => {
    const { fund } = await fundedGift({ ana: 10, ben: 20, cat: 30 }, 'trip');
    const all = ['ana', 'ben', 'cat'].map((id) => ({
      account: accountFor(id),
      choice: 'YES' as const,
    }));
    applyAll(
      fund,
      fund.proposeSpend(
        {
          spendId: 'deposit',
          payee: accountFor('hotel').address,
          amount: usdc(12),
          purpose: 'hotel deposit',
        },
        NOW,
      ),
    );
    let snap = snapshotFor(
      fund,
      fund.spends.get('deposit')!.proposalHash,
      'b-dep',
    );
    applyAll(
      fund,
      await fund.authorizeSpend({
        spendId: 'deposit',
        snapshot: snap,
        votes: await castVotes(fund, snap, all),
        now: NOW + 120,
      }),
    );
    applyAll(
      fund,
      fund.recordSpendExecution(
        'deposit',
        transfer({
          from: fund.charter.pool,
          to: accountFor('hotel').address,
          amount: usdc(12),
        }),
        NOW,
      ),
    );
    expect(fund.spends.get('deposit')!.allocation).toEqual({
      ana: usdc(2),
      ben: usdc(4),
      cat: usdc(6),
    });
    // A second spend is authorized but never executed; cancellation releases it.
    applyAll(
      fund,
      fund.proposeSpend(
        {
          spendId: 'flights',
          payee: accountFor('airline').address,
          amount: usdc(30),
          purpose: 'flights',
        },
        NOW,
      ),
    );
    snap = snapshotFor(fund, fund.spends.get('flights')!.proposalHash, 'b-fl');
    applyAll(
      fund,
      await fund.authorizeSpend({
        spendId: 'flights',
        snapshot: snap,
        votes: await castVotes(fund, snap, all),
        now: NOW + 120,
      }),
    );
    expect(fund.view().committed).toBe(usdc(30));

    // Cancellation itself needs the ballot; the organizer alone cannot cancel.
    const cs = snapshotFor(
      fund,
      cancelProposalHash('trip', fund.termsHash),
      'b-cancel',
    );
    await expectCode(
      fund.cancel({
        reason: 'trip off',
        snapshot: cs,
        votes: await castVotes(fund, cs, [all[0]!]),
        now: cs.closesAt,
      }),
      'QUORUM_NOT_MET',
    );
    applyAll(
      fund,
      await fund.cancel({
        reason: 'trip off',
        snapshot: cs,
        votes: await castVotes(fund, cs, all),
        now: NOW + 300,
      }),
    );
    expect(fund.spends.get('flights')!.status).toBe('RELEASED');
    const claims = fund.cancellationClaims();
    expect(claims.map((c) => [c.memberId, c.amount])).toEqual([
      ['ana', usdc(8)],
      ['ben', usdc(16)],
      ['cat', usdc(24)],
    ]);
    for (const c of claims) {
      applyAll(
        fund,
        fund.requestRefund(
          {
            refundId: `r-${c.memberId}`,
            memberId: c.memberId,
            reason: 'cancelled',
          },
          NOW + DAY * 30,
        ),
      );
      // A refund to anyone but the contributor's own wallet is refused.
      await expectCode(
        () =>
          fund.recordRefundExecution(
            `r-${c.memberId}`,
            transfer({
              from: fund.charter.pool,
              to: accountFor('org-wallet').address,
              amount: c.amount,
            }),
            NOW,
          ),
        'EXECUTION_MISMATCH',
      );
      applyAll(
        fund,
        fund.recordRefundExecution(
          `r-${c.memberId}`,
          transfer({ from: fund.charter.pool, to: c.wallet, amount: c.amount }),
          NOW,
        ),
      );
    }
    expect(fund.view()).toMatchObject({
      custody: 0n,
      spent: usdc(12),
      refunded: usdc(48),
      committed: 0n,
      refundInFlight: 0n,
    });
    expect(
      fund
        .statement()
        .map((s) => [s.memberId, s.contributed - s.spent - s.refunded]),
    ).toEqual([
      ['ana', 0n],
      ['ben', 0n],
      ['cat', 0n],
    ]);
    // Rounding is deterministic and conserving.
    const odd = proRata(
      [
        { memberId: 'a', claim: 1n },
        { memberId: 'b', claim: 1n },
        { memberId: 'c', claim: 1n },
      ],
      2n,
    );
    expect(odd).toEqual({ a: 1n, b: 1n, c: 0n });
  });

  it('P19-06 the same member in two groups never double counts custody; one transfer credits one fund', async () => {
    const store = new MemoryFundStore();
    const svc = new GroupFundService(store);
    const ana = accountFor('ana');
    const ben = accountFor('ben');
    const poolA = accountFor('team-pool').address;
    const poolB = accountFor('flat-pool').address;
    const mk = (fundId: string, pool: `0x${string}`) =>
      charterFor({
        fundId,
        kind: 'TEAM_EXPENSE',
        members: [
          { memberId: 'ana', account: ana },
          { memberId: 'ben', account: ben },
        ],
        pool,
      });
    await svc.open(mk('team', poolA), NOW);
    await svc.open(mk('flat', poolB), NOW);
    // Two funds can never share a custody account.
    await expectCode(svc.open(mk('copy', poolA), NOW), 'DUPLICATE_CLAIM');

    const tA = transfer({
      from: ana.address,
      to: poolA,
      amount: usdc(5),
      ref: contributionRef('team', 'ana'),
    });
    const tB = transfer({
      from: ana.address,
      to: poolB,
      amount: usdc(3),
      ref: contributionRef('flat', 'ana'),
    });
    await svc.run('team', (f) => f.observeDeposit(tA, NOW));
    await svc.run('team', (f) => f.finalizeDeposit(transferKey(tA), 200n, NOW));
    await svc.run('flat', (f) => f.observeDeposit(tB, NOW));
    await svc.run('flat', (f) => f.finalizeDeposit(transferKey(tB), 200n, NOW));
    // The team transfer cannot be re-credited to the flat fund, even relabelled.
    await expectCode(
      svc.run('flat', (f) => f.observeDeposit(tA, NOW)),
      'WRONG_POOL',
    );
    await expectCode(
      svc.run('flat', (f) =>
        f.observeDeposit(
          { ...tA, to: poolB, paymentRef: contributionRef('flat', 'ana') },
          NOW,
        ),
      ),
      'DUPLICATE_CLAIM',
    );
    // A wrong-fund reference credits nobody.
    await svc.run('flat', (f) =>
      f.observeDeposit(
        transfer({
          from: ana.address,
          to: poolB,
          amount: usdc(1),
          ref: contributionRef('team', 'ana'),
        }),
        NOW,
      ),
    );

    const team = await svc.load('team');
    const flat = await svc.load('flat');
    const custody = memberCustody(ana.address, [team, flat]);
    expect(custody.funds).toEqual([
      { fundId: 'team', claim: usdc(5), pending: 0n },
      { fundId: 'flat', claim: usdc(3), pending: 0n },
    ]);
    expect(custody.total).toBe(usdc(8));
    expect(flat.view()).toMatchObject({ custody: usdc(3), unapplied: usdc(1) });
    expect(await store.claimOwner(transferKey(tA))).toBe('team');
    // A stale writer is fenced.
    const stale = await svc.load('team');
    await svc.run('team', (f) =>
      f.pledge({ pledgeId: 'p', memberId: 'ben', amount: 1n }, NOW),
    );
    await expectCode(
      store.append(
        'team',
        stale.seq,
        stale.pledge({ pledgeId: 'q', memberId: 'ben', amount: 1n }, NOW),
        [],
      ),
      'CONFLICT',
    );
  });

  it('P19-07 a shared trip has one provider booking and explicit seat and funding rights', async () => {
    const store = new MemoryFundStore();
    const svc = new GroupFundService(store);
    const members = people(['ana', 'ben', 'cat']);
    const charter = charterFor({
      fundId: 'lisbon',
      kind: 'TRIP_FUND',
      members,
      pool: accountFor('lisbon-pool').address,
    });
    await svc.open(charter, NOW);
    for (const id of ['ana', 'ben', 'cat']) {
      const t = transfer({
        from: accountFor(id).address,
        to: charter.pool,
        amount: usdc(id === 'cat' ? 40 : 30),
        ref: contributionRef('lisbon', id),
      });
      await svc.run('lisbon', (f) => f.observeDeposit(t, NOW));
      await svc.run('lisbon', (f) =>
        f.finalizeDeposit(transferKey(t), 200n, NOW),
      );
      await svc.run('lisbon', async (f) => {
        const a = {
          campaignId: 'lisbon',
          chainId: f.charter.asset.chainId,
          contributor: accountFor(id).address,
          termsHash: f.termsHash,
          termsVersion: 1,
          issuedAt: NOW,
          nonce: nonce(id),
        };
        return f.recordAssent({
          memberId: id,
          assent: a,
          signature: await accountFor(id).signTypedData(assentTypedData(a)),
          now: NOW,
        });
      });
    }
    let fund = await svc.load('lisbon');
    await svc.run('lisbon', (f) =>
      f.proposeSpend(
        {
          spendId: 'flights',
          payee: accountFor('travel-desk').address,
          amount: usdc(90),
          purpose: 'LIS flights for ana and ben',
        },
        NOW,
      ),
    );
    fund = await svc.load('lisbon');
    const snap = snapshotFor(
      fund,
      fund.spends.get('flights')!.proposalHash,
      'b-trip',
    );
    const votes = await castVotes(
      fund,
      snap,
      ['ana', 'ben', 'cat'].map((id) => ({
        account: accountFor(id),
        choice: 'YES' as const,
      })),
    );
    await svc.run('lisbon', (f) =>
      f.authorizeSpend({
        spendId: 'flights',
        snapshot: snap,
        votes,
        now: NOW + 120,
      }),
    );

    // cat funds but does not travel; ben cannot hold two seats.
    await expectCode(
      svc.run('lisbon', (f) =>
        f.registerTrip(
          {
            tripId: 'trip1',
            spendId: 'flights',
            travelers: [
              { memberId: 'ben', travelerRef: 'pv_b' },
              { memberId: 'ben', travelerRef: 'pv_b2' },
            ],
          },
          NOW,
        ),
      ),
      'TRIP_INVALID',
    );
    await svc.run('lisbon', (f) =>
      f.registerTrip(
        {
          tripId: 'trip1',
          spendId: 'flights',
          travelers: [
            { memberId: 'ana', travelerRef: 'pv_a' },
            { memberId: 'ben', travelerRef: 'pv_b' },
          ],
        },
        NOW,
      ),
    );
    await expectCode(
      svc.run('lisbon', (f) =>
        f.registerTrip(
          {
            tripId: 'trip2',
            spendId: 'flights',
            travelers: [{ memberId: 'cat', travelerRef: 'pv_c' }],
          },
          NOW,
        ),
      ),
      'TRIP_INVALID',
    );
    fund = await svc.load('lisbon');
    const key = fund.tripBookingKey('trip1');
    expect(fund.tripBookingKey('trip1')).toBe(key);
    expect(key).toMatch(/^synq-trip-[0-9a-f]{32}$/);
    await svc.run('lisbon', (f) =>
      f.recordTripBooking(
        {
          tripId: 'trip1',
          providerId: 'duffel-flights',
          providerRef: 'ord_0001',
        },
        NOW,
      ),
    );
    // The same confirmation replays idempotently; a second, different booking is refused.
    await svc.run('lisbon', (f) =>
      f.recordTripBooking(
        {
          tripId: 'trip1',
          providerId: 'duffel-flights',
          providerRef: 'ord_0001',
        },
        NOW,
      ),
    );
    await expectCode(
      svc.run('lisbon', (f) =>
        f.recordTripBooking(
          {
            tripId: 'trip1',
            providerId: 'duffel-flights',
            providerRef: 'ord_0002',
          },
          NOW,
        ),
      ),
      'DUPLICATE_BOOKING',
    );
    fund = await svc.load('lisbon');
    const rights = fund.tripRights('trip1');
    expect(rights.booking).toEqual({
      providerId: 'duffel-flights',
      providerRef: 'ord_0001',
    });
    expect(rights.seats.map((s) => s.memberId)).toEqual(['ana', 'ben']);
    expect(rights.funding).toEqual([
      { memberId: 'ana', amount: usdc(27) },
      { memberId: 'ben', amount: usdc(27) },
      { memberId: 'cat', amount: usdc(36) },
    ]);
    // Another fund cannot claim the same provider booking.
    const other = charterFor({
      fundId: 'porto',
      kind: 'TRIP_FUND',
      members,
      pool: accountFor('porto-pool').address,
    });
    await svc.open(other, NOW);
    const ev = {
      type: 'TRIP_BOOKED' as const,
      tripId: 'x',
      providerId: 'duffel-flights',
      providerRef: 'ord_0001',
      at: NOW,
    };
    await expectCode(
      store.append('porto', 1, [ev], ['booking:duffel-flights:ord_0001']),
      'DUPLICATE_CLAIM',
    );
  });
});
