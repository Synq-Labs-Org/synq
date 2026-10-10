import {
  ApplicationFailure,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  ControlActivities,
  WorkflowControlRequest,
} from '../activities/types.js';
import { validActor, validReason, type ControlInput } from './messages.js';

export async function authorizeControl(
  groupId: string,
  operation: WorkflowControlRequest['operation'],
  input: ControlInput,
): Promise<void> {
  const refuse = () =>
    ApplicationFailure.nonRetryable(
      'Control requires a current member signature bound to this workflow.',
      'CONTROL_UNAUTHORIZED',
    );
  try {
    validActor(input.requestedBy);
    validReason(input.reason);
  } catch {
    throw refuse();
  }
  if (!input.authorization) throw refuse();
  const activities = proxyActivities<ControlActivities>({
    startToCloseTimeout: '30s',
    retry: { maximumAttempts: 1 },
  });
  const result = await activities.authorizeWorkflowControl({
    ...input,
    groupId,
    workflowId: workflowInfo().workflowId,
    operation,
  });
  if (!result.authorized) throw refuse();
}

export function createControlAuthorizer(groupId: string) {
  const used = new Set<string>();
  const inFlight = new Set<string>();
  return async (
    operation: WorkflowControlRequest['operation'],
    input: ControlInput,
  ) => {
    const commandId = input.authorization?.commandId;
    if (!commandId || used.has(commandId) || inFlight.has(commandId))
      throw ApplicationFailure.nonRetryable(
        'Control command has already been used.',
        'CONTROL_REPLAY',
      );
    inFlight.add(commandId);
    try {
      await authorizeControl(groupId, operation, input);
      used.add(commandId);
    } finally {
      inFlight.delete(commandId);
    }
  };
}
