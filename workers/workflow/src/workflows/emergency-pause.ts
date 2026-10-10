import type { ActivityOptions } from '@temporalio/common';
import { createControlAuthorizer } from './control.js';
import {
  allHandlersFinished,
  condition,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  Hex,
  OperationsActivities,
  ApprovalActivities,
} from '../activities/types.js';
import {
  nextScheduledEventQuery,
  resumeUpdate,
  stateQuery,
  validActor,
  validReason,
  type Actor,
  type ScheduledEvent,
} from './messages.js';
import { NON_RETRYABLE, seconds } from './common.js';

export type EmergencyPauseInput = {
  groupId: string;
  incidentId: string;
  reason: string;
  requestedBy: Actor;
  pollSeconds?: number;
  activityTimeoutSeconds?: number;
};
export type EmergencyPauseState = {
  groupId: string;
  incidentId: string;
  frozen: boolean;
  frozenSince: number | null;
  safePauseTransaction: { safe: Hex; to: Hex; data: Hex } | null;
  onchainPaused: boolean;
  onchainPauseBlock: string | null;
  resumedBy: Actor | null;
  nextEvent: ScheduledEvent;
  outcome: 'RESUMED' | null;
};

/**
 * Freezes Synq-side autonomy immediately (every economic Activity checks the freeze), hands owners the
 * Safe pause transaction (the pause itself is an owner-signed governance action) and tracks the on-chain
 * pause. Autonomy only returns through an explicit resume.
 */
export async function EmergencyPauseWorkflow(
  input: EmergencyPauseInput,
): Promise<EmergencyPauseState> {
  const authorize = createControlAuthorizer(input.groupId);
  const poll = input.pollSeconds ?? 15;
  const options: ActivityOptions = {
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 30),
    retry: {
      initialInterval: '500ms',
      backoffCoefficient: 2,
      maximumInterval: '10s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  };
  const ops = proxyActivities<OperationsActivities>(options);
  const notify = proxyActivities<ApprovalActivities>(options);
  const s: EmergencyPauseState = {
    groupId: input.groupId,
    incidentId: input.incidentId,
    frozen: false,
    frozenSince: null,
    safePauseTransaction: null,
    onchainPaused: false,
    onchainPauseBlock: null,
    resumedBy: null,
    nextEvent: { kind: 'NONE', at: null },
    outcome: null,
  };
  let resume: Actor | null = null;
  setHandler(stateQuery, () => s);
  setHandler(nextScheduledEventQuery, () => s.nextEvent);
  setHandler(
    resumeUpdate,
    async (request) => {
      await authorize('RESUME_EMERGENCY', request);
      resume = request.requestedBy;
      return { accepted: true as const, at: new Date().toISOString() };
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (!s.frozen || s.outcome !== null) throw new Error('NOT_FROZEN');
      },
    },
  );

  const frozen = await ops.freezeAutonomy({
    groupId: input.groupId,
    reason: input.reason,
    incidentId: input.incidentId,
  });
  s.frozen = frozen.frozen;
  s.frozenSince = frozen.since;
  s.safePauseTransaction = await ops.prepareSafePause({
    groupId: input.groupId,
  });
  await notify.notify({
    channel: 'APPROVERS',
    subject: 'emergency.pause.sign-required',
    correlationId: input.incidentId,
    payload: {
      groupId: input.groupId,
      safe: s.safePauseTransaction.safe,
      to: s.safePauseTransaction.to,
      data: s.safePauseTransaction.data,
    },
  });
  while (resume === null) {
    if (!s.onchainPaused) {
      const seen = await ops.observeOnchainPause({ groupId: input.groupId });
      s.onchainPaused = seen.paused;
      if (seen.paused) s.onchainPauseBlock = seen.block;
    }
    s.nextEvent = s.onchainPaused
      ? { kind: 'NONE', at: null }
      : { kind: 'ONCHAIN_PAUSE_POLL', at: Date.now() + poll * 1000 };
    if (s.onchainPaused) await condition(() => resume !== null);
    else await condition(() => resume !== null, seconds(poll));
  }
  const unfrozen = await ops.unfreezeAutonomy({
    groupId: input.groupId,
    incidentId: input.incidentId,
  });
  if (unfrozen.frozen) throw new Error('AUTONOMY_STILL_FROZEN');
  s.frozen = false;
  s.resumedBy = resume;
  s.outcome = 'RESUMED';
  s.nextEvent = { kind: 'NONE', at: null };
  await condition(allHandlersFinished);
  return s;
}
