import {
  evaluateDcaTick,
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

/** Read-model port: the policy, treasury, execution history and venue state behind a strategy, or null if unknown. */
export interface DcaContextSource {
  context(input: DcaTickInput): Promise<DcaTickContext | null>;
}

export function toDcaEvaluation(verdict: DcaTickVerdict): DcaEvaluation {
  const reasons = verdict.decisionId
    ? [...verdict.reasons, `DECISION:${verdict.decisionId}`]
    : verdict.reasons;
  return verdict.decision === 'EXECUTE'
    ? { decision: 'EXECUTE', amount: verdict.amount, reasons }
    : { decision: verdict.decision, reasons };
}

/**
 * Binds the deterministic strategy engine to the DCAWorkflow's evaluateDca activity: the activity assembles the
 * full evaluation input from the tick and the read model, then evaluates it with no clock or model. A strategy
 * without a policy, or a context that cannot be read, escalates rather than executing.
 */
export function engineDcaEvaluator(
  source: DcaContextSource,
): (input: DcaTickInput) => Promise<DcaEvaluation> {
  return async ({ strategy, state, evidence }) => {
    const context = await source.context({ strategy, state, evidence });
    if (!context)
      return { decision: 'ESCALATE', reasons: ['NO_STRATEGY_POLICY'] };
    return toDcaEvaluation(
      evaluateDcaTick(
        {
          strategyId: strategy.strategyId,
          inputAmountPerTick: strategy.inputAmountPerTick,
          maxSlippageBps: strategy.maxSlippageBps,
          maxTicks: strategy.maxTicks,
          mandateActive: state.mandateActive,
          mandateVersionMatches:
            state.mandateVersion === strategy.mandateVersion,
          ticksExecuted: state.ticksExecuted,
          remainingBudget: state.remainingBudget,
          observedAt: state.observedAt,
          quotedOutputAmount: evidence.quotedOutputAmount,
          quoteExpiresAt: evidence.quoteExpiresAt,
          riskStatus: evidence.riskStatus,
          evidenceObservedAt: evidence.observedAt,
        },
        context,
      ),
    );
  };
}
