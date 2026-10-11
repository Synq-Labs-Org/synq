import { describe, expect, it } from 'vitest';
import {
  assembleDcaEvaluationInput,
  evaluateDcaTick,
  type DcaTickContext,
  type DcaTickFacts,
} from '@synq/strategy-engine';
import { engineDcaEvaluator } from '../../workers/workflow/src/activities/dca-engine.js';
import { createStrategyActivities } from '../../workers/workflow/src/activities/strategy.js';
import { AUSD, START, UNIT, WMON, policy, price } from './fixtures.js';

const NOW = START + 3_600;
const facts = (o: Partial<DcaTickFacts> = {}): DcaTickFacts => ({
  strategyId: policy.strategyId,
  inputAmountPerTick: (25n * UNIT).toString(),
  maxSlippageBps: 75,
  maxTicks: 26,
  mandateActive: true,
  mandateVersionMatches: true,
  ticksExecuted: 0,
  remainingBudget: (1_000n * UNIT).toString(),
  observedAt: NOW,
  quotedOutputAmount: (1_000n * 10n ** 18n).toString(),
  quoteExpiresAt: NOW + 60,
  riskStatus: 'HEALTHY',
  evidenceObservedAt: NOW,
  ...o,
});
const context = (o: Partial<DcaTickContext> = {}): DcaTickContext => ({
  policy,
  treasury: {
    freeBudgetAsset: 1_000n * UNIT,
    totalValueInBudgetAsset: 1_000n * UNIT,
    targetPositionValueInBudgetAsset: 0n,
  },
  history: { executions: [] },
  market: {
    venue: 'kuru-flow',
    assetIn: AUSD.address,
    assetOut: WMON.address,
    change24hBps: 100,
    venueHealthy: true,
    liquidityMaxInput: 1_000n * UNIT,
    sourcesConflict: false,
  },
  ...o,
});

describe('DCA tick input assembly', () => {
  it('derives the executable price from the tick quote and caps free balance by the mandate budget', () => {
    const input = assembleDcaEvaluationInput(
      facts({ remainingBudget: (10n * UNIT).toString(), maxSlippageBps: 30 }),
      context(),
    );
    if ('decision' in input) throw new Error('expected an input');
    expect(input.market.price).toBe(price(25_000n));
    expect(input.market.trailingReferencePrice).toBe(price(25_000n));
    expect(input.market.referenceStatus).toBe('HEALTHY');
    expect(input.treasury.freeBudgetAsset).toBe(10n * UNIT);
    expect(input.policy.maxSlippageBps).toBe(30);
    expect(input.now).toBe(NOW);
  });

  it('executes the base tranche and is deterministic', () => {
    const a = evaluateDcaTick(facts(), context());
    expect(a).toEqual(evaluateDcaTick(facts(), context()));
    expect(a).toMatchObject({
      decision: 'EXECUTE',
      amount: (25n * UNIT).toString(),
      decisionId: `${policy.strategyId}:0`,
    });
  });
  it('P09-N1 future evidence cannot advance a weekly slot or expire the strategy', () => {
    const result = evaluateDcaTick(
      facts({
        evidenceObservedAt: NOW + 7 * 86400,
        quoteExpiresAt: NOW + 7 * 86400 + 60,
      }),
      context(),
    );
    expect(result).toEqual({
      decision: 'ESCALATE',
      reasons: ['EVIDENCE_FUTURE'],
      decisionId: null,
    });
  });

  it('pending lots from the read model count against budget and slot', () => {
    const v = evaluateDcaTick(
      facts(),
      context({
        history: {
          executions: [
            {
              slot: 0,
              intentId: 'intent_a',
              at: NOW - 100,
              amountIn: 25n * UNIT,
              status: 'PENDING',
            },
          ],
        },
      }),
    );
    expect(v).toMatchObject({
      decision: 'SKIP',
      reasons: ['ALREADY_EXECUTED_IN_SLOT'],
    });
  });

  it.each([
    [{ mandateActive: false }, {}, 'ESCALATE', 'MANDATE_INACTIVE'],
    [
      { mandateVersionMatches: false },
      {},
      'ESCALATE',
      'MANDATE_VERSION_CHANGED',
    ],
    [{ strategyId: 'other' }, {}, 'ESCALATE', 'STRATEGY_POLICY_MISMATCH'],
    [{ inputAmountPerTick: '1' }, {}, 'ESCALATE', 'STRATEGY_POLICY_MISMATCH'],
    [{}, { policy: { nope: true } }, 'ESCALATE', 'INVALID_STRATEGY_POLICY'],
    [{ ticksExecuted: 26 }, {}, 'SKIP', 'MAX_TICKS_REACHED'],
    [{ quoteExpiresAt: NOW }, {}, 'SKIP', 'QUOTE_EXPIRED'],
    [{ evidenceObservedAt: NOW + 1 }, {}, 'ESCALATE', 'EVIDENCE_FUTURE'],
    [{ evidenceObservedAt: NOW - 301 }, {}, 'SKIP', 'EVIDENCE_STALE'],
    [{ quotedOutputAmount: '0' }, {}, 'ESCALATE', 'NO_OUTPUT_QUOTED'],
    [{ riskStatus: 'DEGRADED' }, {}, 'ESCALATE', 'AUSD_RISK_DEGRADED'],
    [{ riskStatus: 'UNKNOWN' }, {}, 'ESCALATE', 'AUSD_RISK_UNKNOWN'],
    [{ remainingBudget: '0' }, {}, 'SKIP', 'INSUFFICIENT_FREE_BALANCE'],
  ] as const)('%o %o -> %s %s', (f, c, decision, reason) => {
    const v = evaluateDcaTick(facts(f), context(c as Partial<DcaTickContext>));
    expect(v.decision).toBe(decision);
    expect(v.reasons).toContain(reason);
  });
});

describe('engine-bound evaluateDca activity', () => {
  const strategy = {
    strategyId: policy.strategyId,
    groupId: 'g',
    mandateId: 'm',
    mandateVersion: 2,
    inputAmountPerTick: (25n * UNIT).toString(),
    maxSlippageBps: 75,
    maxTicks: 26,
  };
  const state = {
    mandateVersion: 2,
    mandateActive: true,
    ticksExecuted: 0,
    remainingBudget: (1_000n * UNIT).toString(),
    observedAt: NOW,
  };
  const evidence = {
    evidenceHash: `0x${'1'.repeat(64)}` as const,
    referencePrice: '1',
    quotedOutputAmount: (1_000n * 10n ** 18n).toString(),
    quoteExpiresAt: NOW + 60,
    riskStatus: 'HEALTHY' as const,
    observedAt: NOW,
  };
  const activities = (ctx: DcaTickContext | null) =>
    createStrategyActivities({
      freshState: async () => state,
      marketEvidence: async () => evidence,
      buildAction: async () => {
        throw new Error('unused');
      },
      ticks: { record: () => ({ recorded: true, ticks: 0 }) },
      evaluator: engineDcaEvaluator({ context: async () => ctx }),
    });

  it('runs the strategy engine and tags the decision id', async () => {
    await expect(
      activities(context()).evaluateDca({ strategy, state, evidence }),
    ).resolves.toEqual({
      decision: 'EXECUTE',
      amount: (25n * UNIT).toString(),
      reasons: ['SCHEDULED', `DECISION:${policy.strategyId}:0`],
    });
  });

  it('a strategy with no policy escalates instead of executing', async () => {
    await expect(
      activities(null).evaluateDca({ strategy, state, evidence }),
    ).resolves.toEqual({
      decision: 'ESCALATE',
      reasons: ['NO_STRATEGY_POLICY'],
    });
  });

  const dipContext = () =>
    context({
      market: { ...context().market, trailingReferencePrice: price(30_000n) },
    });
  const multipliedQuote = () => ({
    amountIn: '37500000',
    quotedOutputAmount: (1500n * 10n ** 18n).toString(),
    minOutputAmount: ((1500n * 10n ** 18n * 9925n) / 10000n).toString(),
    quoteExpiresAt: NOW + 60,
    observedAt: NOW,
    evidenceHash: evidence.evidenceHash,
    riskStatus: 'HEALTHY' as const,
  });
  it('P09-N2 requotes the multiplied input and forwards the exact minimum output', async () => {
    const amounts: string[] = [];
    const evaluate = engineDcaEvaluator({
      context: async () => dipContext(),
      requote: async ({ amount }) => {
        amounts.push(amount);
        return multipliedQuote();
      },
    });
    const result = await evaluate({ strategy, state, evidence });
    expect(amounts).toEqual(['37500000']);
    expect(result).toMatchObject({
      decision: 'EXECUTE',
      amount: '37500000',
      evidence: {
        quotedInputAmount: '37500000',
        minOutputAmount: multipliedQuote().minOutputAmount,
        quotedOutputAmount: multipliedQuote().quotedOutputAmount,
      },
    });
  });
  it('P09-N2 refuses to reuse a base-tranche quote without a requote source', async () => {
    expect(
      await engineDcaEvaluator({ context: async () => dipContext() })({
        strategy,
        state,
        evidence,
      }),
    ).toEqual({ decision: 'ESCALATE', reasons: ['REQUOTE_REQUIRED'] });
  });
  it.each([
    [{ amountIn: '25000000' }, 'EXECUTION_QUOTE_MISMATCH_OR_STALE'],
    [{ minOutputAmount: '1' }, 'MIN_OUTPUT_FLOOR'],
    [{ observedAt: NOW + 1 }, 'EXECUTION_QUOTE_MISMATCH_OR_STALE'],
    [{ quoteExpiresAt: NOW }, 'EXECUTION_QUOTE_MISMATCH_OR_STALE'],
    [{ riskStatus: 'UNKNOWN' as const }, 'EXECUTION_QUOTE_MISMATCH_OR_STALE'],
    [
      {
        quotedOutputAmount: (1000n * 10n ** 18n).toString(),
        minOutputAmount: (1000n * 10n ** 18n).toString(),
      },
      'REQUOTE_AMOUNT_CHANGED',
    ],
  ])('P09-N2 refuses unusable requote %o', async (patch, reason) => {
    const result = await engineDcaEvaluator({
      context: async () => dipContext(),
      requote: async () => ({ ...multipliedQuote(), ...patch }),
    })({ strategy, state, evidence });
    expect(result).toMatchObject({ decision: 'ESCALATE', reasons: [reason] });
  });

  it('a mandate version change escalates', async () => {
    await expect(
      activities(context()).evaluateDca({
        strategy: { ...strategy, mandateVersion: 3 },
        state,
        evidence,
      }),
    ).resolves.toMatchObject({
      decision: 'ESCALATE',
      reasons: ['MANDATE_VERSION_CHANGED'],
    });
  });
});
