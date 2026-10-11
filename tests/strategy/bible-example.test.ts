import { describe, expect, it } from 'vitest';
import {
  evaluateDca,
  type DcaDecision,
  type DcaExecution,
} from '@synq/strategy-engine';
import { START, UNIT, WEEK, baseInput, policy, price } from './fixtures.js';

function run(
  weeks: number,
  totalValue: bigint,
  marketFor: (week: number) => Partial<ReturnType<typeof baseInput>['market']>,
) {
  const executions: DcaExecution[] = [];
  let position = 0n;
  const decisions: DcaDecision[] = [];
  for (let week = 0; week < weeks; week++) {
    const now = START + week * WEEK + 3_600;
    const d = evaluateDca(
      baseInput({
        now,
        market: marketFor(week),
        executions,
        treasury: {
          freeBudgetAsset: totalValue - position,
          totalValueInBudgetAsset: totalValue,
          targetPositionValueInBudgetAsset: position,
        },
      }),
    );
    decisions.push(d);
    if (d.kind === 'EXECUTE') {
      executions.push({
        slot: d.slot,
        intentId: d.decisionId,
        at: now,
        amountIn: d.tranche!.amountIn,
        status: 'SETTLED',
      });
      position += d.tranche!.amountIn;
    }
  }
  return { decisions, executions, position };
}
const summary = (d: DcaDecision) =>
  `${d.slot}:${d.kind}:${d.tranche?.amountIn ?? '-'}:${d.reasons.join('+')}`;

describe('Bible section 23 compiled mandate', () => {
  it('matches the example: 400 AUSD, kuru, base 25 weekly, spike 8%, dip 1.5x at -10%, max 50, 40%, 75 bps', () => {
    expect(policy).toMatchObject({
      budget: 400n * UNIT,
      venue: 'kuru-flow',
      baseTranche: 25n * UNIT,
      maxTranche: 50n * UNIT,
      frequencySeconds: WEEK,
      maxAllocationBps: 4_000,
      maxSlippageBps: 75,
      spike: { skipIf24hChangeAboveBps: 800 },
      dip: { multiplierBps: 15_000, triggerBelowTrailingBps: 1_000 },
    });
    expect(policy.targetAsset.symbol).toBe('WMON');
    expect(policy.budgetAsset).toMatchObject({ symbol: 'AUSD', decimals: 6 });
  });

  it('walks a deterministic multi-week scenario to budget exhaustion', () => {
    const { decisions, position } = run(18, 1_000n * UNIT, (week) =>
      week === 3
        ? { change24hBps: 900 }
        : week === 5
          ? { price: price(22_000n), trailingReferencePrice: price(25_000n) }
          : {},
    );
    expect(decisions.map(summary)).toEqual([
      '0:EXECUTE:25000000:SCHEDULED',
      '1:EXECUTE:25000000:SCHEDULED',
      '2:EXECUTE:25000000:SCHEDULED',
      '3:SKIP:-:SPIKE',
      '4:EXECUTE:25000000:SCHEDULED',
      '5:EXECUTE:37500000:DIP_MULTIPLIER',
      ...Array.from(
        { length: 10 },
        (_, i) => `${i + 6}:EXECUTE:25000000:SCHEDULED`,
      ),
      '16:EXECUTE:12500000:BUDGET_EXHAUSTED_CAPPED',
      '17:SKIP:-:BUDGET_EXHAUSTED',
    ]);
    expect(position).toBe(400n * UNIT);
    for (const d of decisions)
      if (d.tranche) expect(d.tranche.amountIn).toBeLessThanOrEqual(50n * UNIT);
  });

  it('stops at the 40% allocation cap before the budget', () => {
    const { decisions, position } = run(10, 500n * UNIT, () => ({}));
    expect(decisions.map(summary).slice(7)).toEqual([
      '7:EXECUTE:25000000:SCHEDULED',
      '8:SKIP:-:ALLOCATION_CAP',
      '9:SKIP:-:ALLOCATION_CAP',
    ]);
    expect(position).toBe(200n * UNIT);
  });
});
