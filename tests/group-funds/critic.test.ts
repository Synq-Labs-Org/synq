import { describe, expect, it } from 'vitest';
import {
  GroupFund,
  cancelProposalHash,
  encodeEvent,
  decodeEvent,
} from '@synq/treasury';
import {
  NOW,
  accountFor,
  applyAll,
  assent,
  castVotes,
  charterFor,
  contribute,
  snapshotFor,
  transfer,
} from './helpers.js';

async function prepared() {
  const accounts = ['a', 'b', 'c'].map(accountFor);
  const charter = charterFor({
    fundId: 'critic',
    members: accounts.map((account, i) => ({ memberId: String(i), account })),
    pool: accountFor('pool').address,
  });
  const events = GroupFund.open(charter, NOW);
  const fund = GroupFund.fold(events);
  const apply = fund.apply.bind(fund);
  fund.apply = (e) => {
    events.push(e);
    apply(e);
  };
  for (const [i, a] of accounts.entries()) {
    contribute(fund, String(i), 10000n);
    await assent(fund, String(i), a);
  }
  applyAll(
    fund,
    fund.proposeSpend(
      {
        spendId: 'spend',
        payee: accountFor('payee').address,
        amount: 15000n,
        purpose: 'approved gift',
      },
      NOW,
    ),
  );
  const snapshot = snapshotFor(
    fund,
    fund.spends.get('spend')!.proposalHash,
    'buy',
  );
  const votes = await castVotes(
    fund,
    snapshot,
    accounts.map((account) => ({ account, choice: 'YES' as const })),
  );
  applyAll(
    fund,
    await fund.authorizeSpend({
      spendId: 'spend',
      snapshot,
      votes,
      now: NOW + 120,
    }),
  );
  return { fund, events, accounts };
}

describe('group execution adversarial regressions', () => {
  it('COM-05: cancellation cannot release an in-flight spend, including after replay', async () => {
    const { fund, events, accounts } = await prepared();
    expect(() => fund.spendInstruction('spend')).toThrow();
    applyAll(fund, fund.beginSpendExecution('spend', NOW + 121));
    const replayed = GroupFund.fold(
      events.map((e) => decodeEvent(encodeEvent(e))),
    );
    expect(replayed.view().committed).toBe(15000n);
    const snapshot = snapshotFor(
      replayed,
      cancelProposalHash(replayed.fundId, replayed.termsHash),
      'cancel',
    );
    const votes = await castVotes(
      replayed,
      snapshot,
      accounts.map((account) => ({ account, choice: 'YES' as const })),
    );
    await expect(
      replayed.cancel({ reason: 'cancel', snapshot, votes, now: NOW + 120 }),
    ).rejects.toMatchObject({ code: 'SPEND_STATE' });
    expect(replayed.view().committed).toBe(15000n);
    expect(() => replayed.beginSpendExecution('spend', NOW)).toThrow();
    const instruction = replayed.spendInstruction('spend');
    applyAll(
      replayed,
      replayed.recordSpendExecution(
        'spend',
        transfer({
          from: replayed.charter.pool,
          to: instruction.to,
          amount: instruction.amount,
        }),
        NOW,
      ),
    );
    expect(replayed.view().committed).toBe(0n);
    expect(replayed.view().spent).toBe(15000n);
  });
  it('COM-06: traveler fields must remain opaque ProfileVault references', async () => {
    const { fund } = await prepared();
    expect(() =>
      fund.registerTrip(
        {
          tripId: 'trip',
          spendId: 'spend',
          travelers: [{ memberId: '0', travelerRef: 'P12345678' }],
        },
        NOW,
      ),
    ).toThrow();
  });
});
