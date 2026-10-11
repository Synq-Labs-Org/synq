import {
  Client,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  type WorkflowHandle,
} from '@temporalio/client';
import type { Workflow } from '@temporalio/common';
import {
  StartActionExecutionSchema,
  StartMandateApprovalSchema,
  actionExecutionWorkflowId,
  mandateApprovalWorkflowId,
  type StartActionExecution,
  type StartActionExecutionInput,
  type StartMandateApprovalInput,
} from '@synq/schemas';
import { canonicalIntentId } from '@synq/kernel';
import type { WorkflowConfig } from './config.js';
import type {
  ActionExecutionWorkflow,
  ActionTuning,
} from './workflows/action-execution.js';
import type { MandateApprovalWorkflow } from './workflows/mandate-approval.js';
import type { DcaTickInput } from './workflows/dca.js';
import type {
  EmergencyPauseInput,
  EmergencyPauseWorkflow,
} from './workflows/emergency-pause.js';
import type {
  ReconciliationInput,
  ReconciliationWorkflow,
} from './workflows/reconciliation.js';

/** One workflow per economic intent: a duplicate start is rejected while running and after completion. */
export const SINGLE_EXECUTION = {
  workflowIdReusePolicy: 'REJECT_DUPLICATE',
  workflowIdConflictPolicy: 'FAIL',
} as const;

export type StartOutcome<W extends Workflow> =
  | { started: true; workflowId: string; handle: WorkflowHandle<W> }
  | { started: false; workflowId: string; reason: 'DUPLICATE_WORKFLOW_ID' };

export function actionWorkflowIdFor(
  intent: StartActionExecution['intent'],
): string {
  return actionExecutionWorkflowId(canonicalIntentId(intent));
}

export async function startActionExecution(
  client: Client,
  config: WorkflowConfig,
  raw: StartActionExecutionInput,
  tuning: Partial<ActionTuning> = {},
): Promise<StartOutcome<typeof ActionExecutionWorkflow>> {
  const input = StartActionExecutionSchema.parse(raw);
  const workflowId = actionExecutionWorkflowId(canonicalIntentId(input.intent));
  try {
    const handle = await client.workflow.start<typeof ActionExecutionWorkflow>(
      'ActionExecutionWorkflow',
      {
        workflowId,
        taskQueue: config.taskQueues.economic,
        args: [input, tuning],
        memo: {
          synqGroupId: input.intent.groupId,
          synqIntentId: canonicalIntentId(input.intent),
        },
        ...SINGLE_EXECUTION,
      },
    );
    return { started: true, workflowId, handle };
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError)
      return { started: false, workflowId, reason: 'DUPLICATE_WORKFLOW_ID' };
    throw error;
  }
}

export async function startMandateApproval(
  client: Client,
  config: WorkflowConfig,
  raw: StartMandateApprovalInput,
  tuning: { pollSeconds?: number } = {},
): Promise<StartOutcome<typeof MandateApprovalWorkflow>> {
  const input = StartMandateApprovalSchema.parse(raw);
  const workflowId = mandateApprovalWorkflowId(input.proposalId);
  try {
    const handle = await client.workflow.start<typeof MandateApprovalWorkflow>(
      'MandateApprovalWorkflow',
      {
        workflowId,
        taskQueue: config.taskQueues.approval,
        args: [input, tuning],
        memo: { synqGroupId: input.mandateRef.groupId },
        ...SINGLE_EXECUTION,
      },
    );
    return { started: true, workflowId, handle };
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError)
      return { started: false, workflowId, reason: 'DUPLICATE_WORKFLOW_ID' };
    throw error;
  }
}

export function dcaScheduleId(strategyId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(strategyId))
    throw new Error('INVALID_STRATEGY_ID');
  return `synq.dca.${strategyId}`;
}

/** Durable DCA cadence: the Temporal Schedule owns the timer, so no process holds it in memory. */
export async function createDcaSchedule(
  client: Client,
  config: WorkflowConfig,
  input: DcaTickInput & {
    intervalSeconds: number;
    overlap?: 'SKIP' | 'BUFFER_ONE';
    catchupWindowSeconds?: number;
  },
): Promise<string> {
  const scheduleId = dcaScheduleId(input.strategy.strategyId);
  const { intervalSeconds, overlap, catchupWindowSeconds, ...tick } = input;
  await client.schedule.create({
    scheduleId,
    spec: { intervals: [{ every: `${intervalSeconds}s` }] },
    action: {
      type: 'startWorkflow',
      workflowType: 'DCAWorkflow',
      workflowId: `${scheduleId}.tick`,
      taskQueue: config.taskQueues.strategy,
      args: [{ executionTaskQueue: config.taskQueues.economic, ...tick }],
      memo: { synqGroupId: input.strategy.groupId },
    },
    policies: {
      overlap:
        overlap === 'BUFFER_ONE'
          ? ScheduleOverlapPolicy.BUFFER_ONE
          : ScheduleOverlapPolicy.SKIP,
      catchupWindow: `${catchupWindowSeconds ?? 300}s`,
    },
  });
  return scheduleId;
}

export async function startEmergencyPause(
  client: Client,
  config: WorkflowConfig,
  input: EmergencyPauseInput,
): Promise<WorkflowHandle<typeof EmergencyPauseWorkflow>> {
  return client.workflow.start<typeof EmergencyPauseWorkflow>(
    'EmergencyPauseWorkflow',
    {
      workflowId: `synq.emergency-pause.${input.groupId}.${input.incidentId}`,
      taskQueue: config.taskQueues.operations,
      args: [input],
      memo: { synqGroupId: input.groupId },
      ...SINGLE_EXECUTION,
    },
  );
}

export async function startReconciliation(
  client: Client,
  config: WorkflowConfig,
  input: ReconciliationInput,
  workflowId = 'synq.reconciliation',
): Promise<WorkflowHandle<typeof ReconciliationWorkflow>> {
  return client.workflow.start<typeof ReconciliationWorkflow>(
    'ReconciliationWorkflow',
    {
      workflowId,
      taskQueue: config.taskQueues.operations,
      args: [input],
      workflowIdConflictPolicy: 'USE_EXISTING',
    },
  );
}
