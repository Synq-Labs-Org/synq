import { z } from 'zod';
import { evaluateDca, PRICE_SCALE } from './evaluate.js';
import {
  AssetRefSchema,
  DcaHistorySchema,
  DcaPolicySchema,
  ReferenceStatusSchema,
  TreasuryStateSchema,
  UintSchema,
  type DcaEvaluationInput,
} from './schema.js';

/** What a scheduled DCA tick already carries: the workflow's strategy, fresh mandate state and market evidence. */
export const DcaTickFactsSchema = z.strictObject({
  strategyId: z.string().min(1),
  inputAmountPerTick: UintSchema,
  maxSlippageBps: z.number().int().min(0).max(10_000),
  maxTicks: z.number().int().nonnegative(),
  mandateActive: z.boolean(),
  mandateVersionMatches: z.boolean(),
  ticksExecuted: z.number().int().nonnegative(),
  remainingBudget: UintSchema,
  observedAt: z.number().int().nonnegative(),
  quotedOutputAmount: UintSchema,
  quoteExpiresAt: z.number().int().nonnegative(),
  riskStatus: ReferenceStatusSchema,
  evidenceObservedAt: z.number().int().nonnegative(),
});
export type DcaTickFacts = z.input<typeof DcaTickFactsSchema>;

/** Read-model context the thin tick lacks: the full strategy policy, treasury, execution history and venue state. */
export const DcaTickContextSchema = z.strictObject({
  policy: z.unknown(),
  treasury: TreasuryStateSchema,
  history: DcaHistorySchema,
  market: z.strictObject({
    venue: z.string(),
    assetIn: AssetRefSchema,
    assetOut: AssetRefSchema,
    trailingReferencePrice: UintSchema.optional(),
    change24hBps: z.number().int(),
    venueHealthy: z.boolean(),
    venueHealthReason: z.string().max(200).optional(),
    liquidityMaxInput: UintSchema,
    sourcesConflict: z.boolean(),
  }),
});
export type DcaTickContext = z.input<typeof DcaTickContextSchema>;

export type DcaTickVerdict =
  | {
      decision: 'EXECUTE';
      amount: string;
      reasons: string[];
      decisionId: string;
    }
  | {
      decision: 'SKIP' | 'ESCALATE';
      reasons: string[];
      decisionId: string | null;
    };

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Assembles the full evaluation input from a tick and its read-model context. The thin strategy must agree with
 * the policy, the Kernel's remaining mandate budget caps the free balance, the stricter slippage wins, and the
 * executable price is derived from the tick's quote. Returns a verdict instead of an input when the tick itself
 * already decides.
 */
export function assembleDcaEvaluationInput(
  rawFacts: DcaTickFacts,
  rawContext: DcaTickContext,
): DcaEvaluationInput | DcaTickVerdict {
  const facts = DcaTickFactsSchema.parse(rawFacts);
  const context = DcaTickContextSchema.parse(rawContext);
  const verdict = (
    decision: 'SKIP' | 'ESCALATE',
    reasons: string[],
  ): DcaTickVerdict => ({ decision, reasons, decisionId: null });
  if (!facts.mandateActive) return verdict('ESCALATE', ['MANDATE_INACTIVE']);
  if (!facts.mandateVersionMatches)
    return verdict('ESCALATE', ['MANDATE_VERSION_CHANGED']);
  const policy = DcaPolicySchema.safeParse(context.policy);
  if (!policy.success) return verdict('ESCALATE', ['INVALID_STRATEGY_POLICY']);
  if (
    policy.data.strategyId !== facts.strategyId ||
    policy.data.baseTranche !== facts.inputAmountPerTick
  )
    return verdict('ESCALATE', ['STRATEGY_POLICY_MISMATCH']);
  if (facts.ticksExecuted >= facts.maxTicks)
    return verdict('SKIP', ['MAX_TICKS_REACHED']);
  const now = Math.max(facts.observedAt, facts.evidenceObservedAt);
  if (facts.quoteExpiresAt <= now) return verdict('SKIP', ['QUOTE_EXPIRED']);
  if (facts.quotedOutputAmount <= 0n)
    return verdict('ESCALATE', ['NO_OUTPUT_QUOTED']);
  const { budgetAsset, targetAsset } = policy.data;
  const price =
    (facts.inputAmountPerTick *
      10n ** BigInt(targetAsset.decimals) *
      PRICE_SCALE) /
    (facts.quotedOutputAmount * 10n ** BigInt(budgetAsset.decimals));
  if (price <= 0n) return verdict('ESCALATE', ['NO_OUTPUT_QUOTED']);
  return {
    policy: {
      ...policy.data,
      maxSlippageBps: Math.min(
        policy.data.maxSlippageBps,
        facts.maxSlippageBps,
      ),
    },
    market: {
      asOf: facts.evidenceObservedAt,
      venue: context.market.venue,
      assetIn: context.market.assetIn,
      assetOut: context.market.assetOut,
      price,
      trailingReferencePrice: context.market.trailingReferencePrice ?? price,
      change24hBps: context.market.change24hBps,
      venueHealthy: context.market.venueHealthy,
      ...(context.market.venueHealthReason
        ? { venueHealthReason: context.market.venueHealthReason }
        : {}),
      liquidityMaxInput: context.market.liquidityMaxInput,
      referenceStatus: facts.riskStatus,
      sourcesConflict: context.market.sourcesConflict,
    },
    treasury: {
      ...context.treasury,
      freeBudgetAsset: min(
        context.treasury.freeBudgetAsset,
        facts.remainingBudget,
      ),
    },
    history: context.history,
    now,
  };
}

/** Evaluates one tick with the deterministic engine. Same facts and context, same verdict. */
export function evaluateDcaTick(
  facts: DcaTickFacts,
  context: DcaTickContext,
): DcaTickVerdict {
  const input = assembleDcaEvaluationInput(facts, context);
  if ('decision' in input) return input;
  const decision = evaluateDca(input);
  if (decision.kind === 'EXECUTE' && decision.tranche)
    return {
      decision: 'EXECUTE',
      amount: decision.tranche.amountIn.toString(),
      reasons: decision.reasons,
      decisionId: decision.decisionId,
    };
  return {
    decision: decision.kind === 'EXECUTE' ? 'ESCALATE' : decision.kind,
    reasons:
      decision.kind === 'EXECUTE' ? ['MISSING_TRANCHE'] : decision.reasons,
    decisionId: decision.decisionId,
  };
}
