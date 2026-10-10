import {
  allHandlersFinished,
  condition,
  defineUpdate,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { StartMandateApproval } from '@synq/schemas';
import type { ApprovalActivities, Hex } from '../activities/types.js';
import {
  cancelUpdate,
  nextScheduledEventQuery,
  pendingApprovalsQuery,
  rejectUpdate,
  stateQuery,
  validActor,
  validId,
  validReason,
  type ControlResult,
  type ScheduledEvent,
} from './messages.js';
import { NON_RETRYABLE, seconds } from './common.js';

export type MandateApprovalInput = { memberId: string; signature: string };
export const approveMandateUpdate = defineUpdate<
  { counted: number; required: number; satisfied: boolean },
  [MandateApprovalInput]
>('approve');

export type MandateApprovalOutcome =
  | 'APPLIED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';
export type MandateApprovalState = {
  proposalId: string;
  kind: StartMandateApproval['kind'];
  mandateHash: Hex;
  required: number;
  approvals: { memberId: string; signer: Hex }[];
  refused: { memberId: string; reason: string }[];
  waitingFor: 'APPROVAL' | 'ONCHAIN_GOVERNANCE' | null;
  onchainBlock: string | null;
  nextEvent: ScheduledEvent;
  outcome: MandateApprovalOutcome | null;
};

export async function MandateApprovalWorkflow(
  input: StartMandateApproval,
  tuning: { pollSeconds?: number; activityTimeoutSeconds?: number } = {},
): Promise<MandateApprovalState> {
  const poll = tuning.pollSeconds ?? 30;
  const acts = proxyActivities<ApprovalActivities>({
    startToCloseTimeout: seconds(tuning.activityTimeoutSeconds ?? 30),
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const deadline = input.expiresAt * 1000;
  const s: MandateApprovalState = {
    proposalId: input.proposalId,
    kind: input.kind,
    mandateHash: input.mandateHash as Hex,
    required: input.requiredApprovals,
    approvals: [],
    refused: [],
    waitingFor: 'APPROVAL',
    onchainBlock: null,
    nextEvent: { kind: 'MANDATE_EXPIRY', at: deadline },
    outcome: null,
  };
  let stopped: 'REJECTED' | 'CANCELLED' | null = null;
  const accepted = (): ControlResult => ({
    accepted: true,
    at: new Date().toISOString(),
  });
  const satisfied = () => s.approvals.length >= s.required;
  const summary = () => ({
    counted: s.approvals.length,
    required: s.required,
    satisfied: satisfied(),
  });

  setHandler(
    approveMandateUpdate,
    async ({ memberId, signature }) => {
      if (s.approvals.some((a) => a.memberId === memberId)) return summary();
      const verdict = await acts.verifyMandateApproval({
        proposalId: input.proposalId,
        mandateHash: s.mandateHash,
        memberId,
        signature: signature as Hex,
      });
      if (s.approvals.some((a) => a.memberId === memberId)) return summary();
      if (verdict.valid && verdict.signer)
        s.approvals.push({ memberId, signer: verdict.signer });
      else
        s.refused.push({
          memberId,
          reason: verdict.reason ?? 'INVALID_APPROVAL',
        });
      return summary();
    },
    {
      validator: ({ memberId, signature }) => {
        validId(memberId, 'MEMBER');
        if (!input.approvers.includes(memberId as never))
          throw new Error('NOT_AN_APPROVER');
        if (
          typeof signature !== 'string' ||
          !/^0x[0-9a-fA-F]{130}$/.test(signature)
        )
          throw new Error('INVALID_SIGNATURE_FORMAT');
        if (s.waitingFor !== 'APPROVAL')
          throw new Error('NOT_AWAITING_APPROVAL');
      },
    },
  );
  setHandler(
    rejectUpdate,
    () => {
      stopped = 'REJECTED';
      return accepted();
    },
    {
      validator: ({ memberId, reason }) => {
        validId(memberId, 'MEMBER');
        validReason(reason);
        if (!input.approvers.includes(memberId as never))
          throw new Error('NOT_AN_APPROVER');
        if (s.waitingFor !== 'APPROVAL')
          throw new Error('NOT_AWAITING_APPROVAL');
      },
    },
  );
  setHandler(
    cancelUpdate,
    () => {
      stopped = 'CANCELLED';
      return accepted();
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (s.outcome !== null || s.waitingFor !== 'APPROVAL')
          throw new Error('NOT_CANCELLABLE');
      },
    },
  );
  setHandler(stateQuery, () => s);
  setHandler(pendingApprovalsQuery, () => ({
    draftDigest: s.mandateHash,
    required: s.required,
    counted: s.approvals.map((a) => a.memberId),
    outstanding: s.waitingFor === 'APPROVAL',
  }));
  setHandler(nextScheduledEventQuery, () => s.nextEvent);

  const done = async (outcome: MandateApprovalOutcome) => {
    s.outcome = outcome;
    s.waitingFor = null;
    s.nextEvent = { kind: 'NONE', at: null };
    await condition(allHandlersFinished);
    return s;
  };

  await acts.notify({
    channel: 'APPROVERS',
    subject: 'mandate.approval.requested',
    correlationId: input.correlationId,
    payload: {
      proposalId: input.proposalId,
      kind: input.kind,
      required: s.required,
    },
  });
  const decided = await condition(
    () => satisfied() || stopped !== null,
    Math.max(1, deadline - Date.now()),
  );
  if (stopped) return done(stopped);
  if (!decided) return done('EXPIRED');

  s.waitingFor = 'ONCHAIN_GOVERNANCE';
  for (;;) {
    const seen = await acts.observeMandateOnchain({
      groupId: input.mandateRef.groupId,
      mandateId: input.mandateRef.mandateId,
      version: input.mandateRef.version,
      mandateHash: s.mandateHash,
      kind: input.kind,
    });
    if (seen.observed) {
      s.onchainBlock = seen.block;
      break;
    }
    if (Date.now() >= deadline) return done('EXPIRED');
    s.nextEvent = {
      kind: 'MANDATE_EXPIRY',
      at: Math.min(deadline, Date.now() + poll * 1000),
    };
    await sleep(seconds(poll));
  }
  await acts.applyMandateToKernel({
    groupId: input.mandateRef.groupId,
    mandateId: input.mandateRef.mandateId,
    version: input.mandateRef.version,
    mandateHash: s.mandateHash,
    kind: input.kind,
    securitySensitive: input.securitySensitive,
  });
  return done('APPLIED');
}
