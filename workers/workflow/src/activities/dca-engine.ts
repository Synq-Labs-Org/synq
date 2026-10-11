import { z } from 'zod';
import { HashSchema } from '@synq/schemas';
import {
  evaluateDcaTick,
  parseDcaPolicy,
  PositiveUintSchema,
  ReferenceStatusSchema,
  type DcaTickContext,
  type DcaTickVerdict,
} from '@synq/strategy-engine';
import type {
  DcaEvaluation,
  DcaFreshState,
  DcaStrategy,
  MarketEvidence,
} from './types.js';

export type DcaTickInput = {
  strategy: DcaStrategy;
  state: DcaFreshState;
  evidence: MarketEvidence;
};
export const DcaExecutionQuoteSchema = z.strictObject({
  amountIn: PositiveUintSchema,
  quotedOutputAmount: PositiveUintSchema,
  minOutputAmount: PositiveUintSchema,
  quoteExpiresAt: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  evidenceHash: HashSchema,
  riskStatus: ReferenceStatusSchema,
});
export type DcaExecutionQuote = z.input<typeof DcaExecutionQuoteSchema>;
export interface DcaContextSource {
  context(input: DcaTickInput): Promise<DcaTickContext | null>;
  requote?(
    input: DcaTickInput & { amount: string },
  ): Promise<DcaExecutionQuote>;
}

export function toDcaEvaluation(verdict: DcaTickVerdict): DcaEvaluation {
  const reasons = verdict.decisionId
    ? [...verdict.reasons, `DECISION:${verdict.decisionId}`]
    : verdict.reasons;
  return verdict.decision === 'EXECUTE'
    ? { decision: 'EXECUTE', amount: verdict.amount, reasons }
    : { decision: verdict.decision, reasons };
}

/** Network calls live in this Activity; the strategy engine remains pure. */
export function engineDcaEvaluator(
  source: DcaContextSource,
  options: { now?: () => number } = {},
): (input: DcaTickInput) => Promise<DcaEvaluation> {
  return async ({ strategy, state, evidence }) => {
    const input = { strategy, state, evidence };
    const context = await source.context(input);
    if (!context)
      return { decision: 'ESCALATE', reasons: ['NO_STRATEGY_POLICY'] };
    const facts = {
      strategyId: strategy.strategyId,
      inputAmountPerTick: strategy.inputAmountPerTick,
      maxSlippageBps: strategy.maxSlippageBps,
      maxTicks: strategy.maxTicks,
      mandateActive: state.mandateActive,
      mandateVersionMatches: state.mandateVersion === strategy.mandateVersion,
      ticksExecuted: state.ticksExecuted,
      remainingBudget: state.remainingBudget,
      observedAt: state.observedAt,
      quotedOutputAmount: evidence.quotedOutputAmount,
      quoteExpiresAt: evidence.quoteExpiresAt,
      riskStatus: evidence.riskStatus,
      evidenceObservedAt: evidence.observedAt,
    };
    const verdict = evaluateDcaTick(facts, context);
    if (
      verdict.decision !== 'EXECUTE' ||
      verdict.amount === strategy.inputAmountPerTick
    )
      return toDcaEvaluation(verdict);
    if (!source.requote)
      return { decision: 'ESCALATE', reasons: ['REQUOTE_REQUIRED'] };
    let raw: DcaExecutionQuote;
    try {
      raw = await source.requote({ ...input, amount: verdict.amount });
    } catch {
      return { decision: 'ESCALATE', reasons: ['REQUOTE_UNAVAILABLE'] };
    }
    const parsed = DcaExecutionQuoteSchema.safeParse(raw);
    if (!parsed.success)
      return { decision: 'ESCALATE', reasons: ['INVALID_EXECUTION_QUOTE'] };
    const quote = parsed.data;
    const policy = parseDcaPolicy(context.policy);
    const now = options.now?.() ?? state.observedAt;
    const maxAge = Math.min(300, policy.maxMarketDataAgeSeconds);
    if (
      quote.amountIn !== BigInt(verdict.amount) ||
      quote.observedAt > now ||
      quote.quoteExpiresAt <= now ||
      now - quote.observedAt > maxAge ||
      state.observedAt > now ||
      now - state.observedAt > maxAge ||
      quote.riskStatus !== 'HEALTHY'
    )
      return {
        decision: 'ESCALATE',
        reasons: ['EXECUTION_QUOTE_MISMATCH_OR_STALE'],
      };
    const slippage = Math.min(strategy.maxSlippageBps, policy.maxSlippageBps);
    const floor =
      (quote.quotedOutputAmount * BigInt(10000 - slippage) + 9999n) / 10000n;
    if (
      quote.minOutputAmount < floor ||
      quote.minOutputAmount > quote.quotedOutputAmount
    )
      return { decision: 'ESCALATE', reasons: ['MIN_OUTPUT_FLOOR'] };
    const refreshed = evaluateDcaTick(
      {
        ...facts,
        observedAt: now,
        quotedInputAmount: quote.amountIn,
        quotedOutputAmount: quote.quotedOutputAmount,
        quoteExpiresAt: quote.quoteExpiresAt,
        riskStatus: quote.riskStatus,
        evidenceObservedAt: quote.observedAt,
      },
      context,
    );
    if (refreshed.decision !== 'EXECUTE') return toDcaEvaluation(refreshed);
    if (refreshed.amount !== quote.amountIn.toString())
      return { decision: 'ESCALATE', reasons: ['REQUOTE_AMOUNT_CHANGED'] };
    return {
      ...toDcaEvaluation(refreshed),
      decision: 'EXECUTE',
      amount: refreshed.amount,
      evidence: {
        ...evidence,
        evidenceHash: quote.evidenceHash,
        quotedInputAmount: quote.amountIn.toString(),
        quotedOutputAmount: quote.quotedOutputAmount.toString(),
        minOutputAmount: quote.minOutputAmount.toString(),
        quoteExpiresAt: quote.quoteExpiresAt,
        riskStatus: quote.riskStatus,
        observedAt: quote.observedAt,
      },
    };
  };
}
