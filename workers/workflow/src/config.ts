import { z } from 'zod';

const queue = z.string().regex(/^[a-z][a-z0-9.-]{1,62}$/);
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const WorkflowEnvSchema = z.object({
  TEMPORAL_ADDRESS: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:[0-9]{1,5}$/)
    .default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default('default'),
  SYNQ_TQ_ECONOMIC: queue.default('synq-economic'),
  SYNQ_TQ_APPROVAL: queue.default('synq-approval'),
  SYNQ_TQ_STRATEGY: queue.default('synq-strategy'),
  SYNQ_TQ_OPERATIONS: queue.default('synq-operations'),
  SYNQ_ALLOW_MAINNET_BROADCAST: flag,
  SYNQ_WORKFLOW_DEPLOYMENT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,62}$/)
    .default('synq-workflows'),
  SYNQ_WORKFLOW_BUILD_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
});

export type WorkflowFamily =
  | 'economic'
  | 'approval'
  | 'strategy'
  | 'operations';

export type WorkflowConfig = Readonly<{
  address: string;
  namespace: string;
  taskQueues: Readonly<Record<WorkflowFamily, string>>;
  allowMainnetBroadcast: boolean;
  deployment: Readonly<{ name: string; buildId: string | null }>;
}>;

export function loadWorkflowConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowConfig {
  const parsed = WorkflowEnvSchema.parse(env);
  const taskQueues = {
    economic: parsed.SYNQ_TQ_ECONOMIC,
    approval: parsed.SYNQ_TQ_APPROVAL,
    strategy: parsed.SYNQ_TQ_STRATEGY,
    operations: parsed.SYNQ_TQ_OPERATIONS,
  };
  if (new Set(Object.values(taskQueues)).size !== 4)
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['SYNQ_TQ_*'],
        message: 'task queues per workflow family must be distinct',
        input: taskQueues,
      },
    ]);
  return Object.freeze({
    address: parsed.TEMPORAL_ADDRESS,
    namespace: parsed.TEMPORAL_NAMESPACE,
    taskQueues: Object.freeze(taskQueues),
    allowMainnetBroadcast: parsed.SYNQ_ALLOW_MAINNET_BROADCAST,
    deployment: Object.freeze({
      name: parsed.SYNQ_WORKFLOW_DEPLOYMENT,
      buildId: parsed.SYNQ_WORKFLOW_BUILD_ID ?? null,
    }),
  });
}

export const WORKFLOW_FAMILIES: Readonly<Record<string, WorkflowFamily>> = {
  ActionExecutionWorkflow: 'economic',
  MandateApprovalWorkflow: 'approval',
  DCAWorkflow: 'strategy',
  HedgeWorkflow: 'strategy',
  FundingWorkflow: 'strategy',
  ReconciliationWorkflow: 'operations',
  EmergencyPauseWorkflow: 'operations',
  BookingWorkflow: 'economic',
};
