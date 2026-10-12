import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import {
  ParentClosePolicy,
  patched,
  WorkflowIdReusePolicy,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  DcaEvaluation,
  DcaFreshState,
  DcaStrategy,
  MarketEvidence,
  StrategyActivities,
} from '../activities/types.js';
import {
  ActionExecutionWorkflow,
  type ActionTuning,
} from './action-execution.js';
import { stateQuery, nextScheduledEventQuery } from './messages.js';
import { WORKFLOW_ID_PREFIX } from '@synq/schemas';
import { NON_RETRYABLE, seconds } from './common.js';

export type DcaTickInput = {
  strategy: DcaStrategy;
  executionTaskQueue?: string;
  actionTuning?: Partial<ActionTuning>;
  activityTimeoutSeconds?: number;
};

export type DcaTickResult = {
  tickKey: string;
  decision: DcaEvaluation['decision'];
  reasons: string[];
  state: DcaFreshState | null;
  evidence: MarketEvidence | null;
  childWorkflowId: string | null;
  childAlreadyStarted: boolean;
  ticksRecorded: number;
};

/**
 * One DCA tick, started by a Temporal Schedule. The tick refreshes state, checks the mandate version,
 * gathers risk and market evidence, asks the deterministic evaluator, and only on EXECUTE starts an
 * ActionExecution child whose workflow id derives from the canonical intent id.
 */
export async function DCAWorkflow(input: DcaTickInput): Promise<DcaTickResult> {
  const acts = proxyActivities<StrategyActivities>({
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 30),
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const tickKey = workflowInfo().workflowId;
  const result: DcaTickResult = {
    tickKey,
    decision: 'SKIP',
    reasons: [],
    state: null,
    evidence: null,
    childWorkflowId: null,
    childAlreadyStarted: false,
    ticksRecorded: 0,
  };
  setHandler(stateQuery, () => result);
  setHandler(nextScheduledEventQuery, () => ({ kind: 'NONE', at: null }));
  const record = async (evaluation: DcaEvaluation) => {
    result.decision = evaluation.decision;
    result.reasons = evaluation.reasons;
    const recorded = await acts.recordDcaTick({
      strategyId: input.strategy.strategyId,
      tickKey,
      decision: evaluation.decision,
      childWorkflowId: result.childWorkflowId,
    });
    result.ticksRecorded = recorded.ticks;
    return result;
  };

  const state = await acts.dcaFreshState({ strategy: input.strategy });
  result.state = state;
  if (
    !state.mandateActive ||
    state.mandateVersion !== input.strategy.mandateVersion
  )
    return record({
      decision: 'ESCALATE',
      reasons: [
        state.mandateActive
          ? `MANDATE_VERSION_CHANGED:${input.strategy.mandateVersion}->${state.mandateVersion}`
          : 'MANDATE_INACTIVE',
      ],
    });
  if (state.ticksExecuted >= input.strategy.maxTicks)
    return record({ decision: 'SKIP', reasons: ['MAX_TICKS_REACHED'] });
  const evidence = await acts.dcaMarketEvidence({ strategy: input.strategy });
  result.evidence = evidence;
  const evaluation = await acts.evaluateDca({
    strategy: input.strategy,
    state,
    evidence,
  });
  if (evaluation.decision !== 'EXECUTE') return record(evaluation);
  result.evidence = evaluation.evidence ?? evidence;

  const built = await acts.buildDcaAction({
    strategy: input.strategy,
    tickKey,
    amount: evaluation.amount,
    evidence: evaluation.evidence ?? evidence,
  });
  result.childWorkflowId = built.workflowId;
  const withMetadata = patched('dca-child-world-metadata-v1');
  const prefix = `${WORKFLOW_ID_PREFIX.actionExecution}.`;
  const canonicalId = built.workflowId.slice(prefix.length);
  if (
    withMetadata &&
    (!built.workflowId.startsWith(prefix) ||
      !/^intent_[0-9a-f]{64}$/.test(canonicalId))
  )
    throw new Error('INVALID_CANONICAL_CHILD_WORKFLOW_ID');
  try {
    await startChild(ActionExecutionWorkflow, {
      workflowId: built.workflowId,
      args: [built.start, input.actionTuning ?? {}],
      ...(withMetadata
        ? {
            memo: {
              synqGroupId: built.start.intent.groupId,
              synqIntentId: canonicalId,
            },
          }
        : {}),
      ...(input.executionTaskQueue
        ? { taskQueue: input.executionTaskQueue }
        : {}),
      parentClosePolicy: ParentClosePolicy.ABANDON,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    result.childAlreadyStarted = true;
  }
  return record(evaluation);
}
