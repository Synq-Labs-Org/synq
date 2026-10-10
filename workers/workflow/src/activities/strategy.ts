import { existsSync, readFileSync } from 'node:fs';
import { writeDurableJson } from '@synq/execution-worker/persistence';
import type {
  DcaEvaluation,
  DcaFreshState,
  DcaStrategy,
  MarketEvidence,
  StrategyActivities,
} from './types.js';

export const DCA_EVIDENCE_MAX_AGE_SECONDS = 300;

/**
 * Reference deterministic DCA evaluator. Same inputs, same verdict; no model, clock or I/O.
 * Risk gate: HEALTHY allows, DEGRADED escalates, UNKNOWN or STALE fails closed.
 */
export function evaluateDcaDeterministic(input: {
  strategy: DcaStrategy;
  state: DcaFreshState;
  evidence: MarketEvidence;
}): DcaEvaluation {
  const { strategy, state, evidence } = input;
  if (!state.mandateActive)
    return { decision: 'ESCALATE', reasons: ['MANDATE_INACTIVE'] };
  if (state.mandateVersion !== strategy.mandateVersion)
    return { decision: 'ESCALATE', reasons: ['MANDATE_VERSION_CHANGED'] };
  if (evidence.riskStatus === 'DEGRADED')
    return { decision: 'ESCALATE', reasons: ['RISK_DEGRADED'] };
  if (evidence.riskStatus !== 'HEALTHY')
    return { decision: 'SKIP', reasons: [`RISK_${evidence.riskStatus}`] };
  const reasons: string[] = [];
  if (state.ticksExecuted >= strategy.maxTicks)
    reasons.push('MAX_TICKS_REACHED');
  if (evidence.quoteExpiresAt <= evidence.observedAt)
    reasons.push('QUOTE_EXPIRED');
  if (
    Math.abs(evidence.observedAt - state.observedAt) >
    DCA_EVIDENCE_MAX_AGE_SECONDS
  )
    reasons.push('EVIDENCE_STALE');
  if (BigInt(state.remainingBudget) < BigInt(strategy.inputAmountPerTick))
    reasons.push('BUDGET_EXHAUSTED');
  if (BigInt(evidence.quotedOutputAmount) <= 0n)
    reasons.push('NO_OUTPUT_QUOTED');
  if (reasons.length) return { decision: 'SKIP', reasons };
  return {
    decision: 'EXECUTE',
    amount: strategy.inputAmountPerTick,
    reasons: ['WITHIN_POLICY'],
  };
}

type TickRecord = {
  strategyId: string;
  tickKey: string;
  decision: DcaEvaluation['decision'];
  childWorkflowId: string | null;
  recordedAt: string;
  pid: number;
};

/** Durable, idempotent tick ledger keyed by the schedule-assigned tick key. */
export class FileTickStore {
  constructor(private readonly path: string) {}
  all(): TickRecord[] {
    return existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as TickRecord[])
      : [];
  }
  record(entry: Omit<TickRecord, 'recordedAt' | 'pid'>): {
    recorded: boolean;
    ticks: number;
  } {
    const all = this.all();
    if (all.some((t) => t.tickKey === entry.tickKey))
      return {
        recorded: false,
        ticks: all.filter((t) => t.strategyId === entry.strategyId).length,
      };
    all.push({
      ...entry,
      recordedAt: new Date().toISOString(),
      pid: process.pid,
    });
    writeDurableJson(this.path, all);
    return {
      recorded: true,
      ticks: all.filter((t) => t.strategyId === entry.strategyId).length,
    };
  }
}

export type StrategyPorts = {
  freshState(strategy: DcaStrategy): Promise<DcaFreshState>;
  marketEvidence(strategy: DcaStrategy): Promise<MarketEvidence>;
  buildAction: StrategyActivities['buildDcaAction'];
  ticks: { record: FileTickStore['record'] };
  evaluator?: (
    input: Parameters<typeof evaluateDcaDeterministic>[0],
  ) => DcaEvaluation | Promise<DcaEvaluation>;
};

export function createStrategyActivities(
  ports: StrategyPorts,
): StrategyActivities {
  const evaluate = ports.evaluator ?? evaluateDcaDeterministic;
  return {
    dcaFreshState: async ({ strategy }) => ports.freshState(strategy),
    dcaMarketEvidence: async ({ strategy }) => ports.marketEvidence(strategy),
    evaluateDca: async (input) => evaluate(input),
    buildDcaAction: (input) => ports.buildAction(input),
    recordDcaTick: async (input) => ports.ticks.record(input),
  };
}
