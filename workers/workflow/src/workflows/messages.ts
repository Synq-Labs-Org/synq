import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';

export type Actor = {
  principalId: string;
  kind: 'HUMAN' | 'AGENT' | 'SERVICE' | 'SMART_ACCOUNT';
};

export type ApproveInput = { memberId: string; draftDigest: string };
export type ApproveResult = {
  counted: number;
  required: number;
  satisfied: boolean;
};
export type RejectInput = { memberId: string; reason: string };
export type ControlInput = { requestedBy: Actor; reason: string };
export type EscalationResolution = {
  resolvedBy: Actor;
  resolution: 'RETRY' | 'ABANDON';
  note: string;
};
export type ControlResult = { accepted: true; at: string };

export const approveUpdate = defineUpdate<ApproveResult, [ApproveInput]>(
  'approve',
);
export const rejectUpdate = defineUpdate<ControlResult, [RejectInput]>(
  'reject',
);
export const cancelUpdate = defineUpdate<ControlResult, [ControlInput]>(
  'cancel',
);
export const pauseUpdate = defineUpdate<ControlResult, [ControlInput]>('pause');
export const resumeUpdate = defineUpdate<ControlResult, [ControlInput]>(
  'resume',
);
export const resolveEscalationUpdate = defineUpdate<
  ControlResult,
  [EscalationResolution]
>('resolveEscalation');

/** Fire-and-forget variant for webhook-style approval notifications; the ledger is re-read either way. */
export const approvalRecordedSignal =
  defineSignal<[ApproveInput]>('approvalRecorded');
export const cancelSignal = defineSignal<[ControlInput]>('cancelRequested');

export type ScheduledEvent = {
  kind:
    | 'APPROVAL_DEADLINE'
    | 'RESERVATION_RELEASE'
    | 'CONFIRMATION_POLL'
    | 'ONCHAIN_PAUSE_POLL'
    | 'MANDATE_EXPIRY'
    | 'HEDGE_POLL'
    | 'FUNDING_POLL'
    | 'NONE';
  at: number | null;
};

export const stateQuery = defineQuery<unknown>('state');
export const pendingApprovalsQuery = defineQuery<{
  draftDigest: string | null;
  required: number | null;
  counted: string[];
  outstanding: boolean;
}>('pendingApprovals');
export const nextScheduledEventQuery =
  defineQuery<ScheduledEvent>('nextScheduledEvent');
export const reservationStatusQuery = defineQuery<{
  grantId: string | null;
  state: string | null;
  reservedToken: string | null;
}>('reservationStatus');
export const latestExecutionQuery = defineQuery<{
  transactionHash: string | null;
  txState: string | null;
  blockNumber: string | null;
  outcome: string | null;
}>('latestExecution');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const KINDS = ['HUMAN', 'AGENT', 'SERVICE', 'SMART_ACCOUNT'];
export function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new Error(`INVALID_${label}`);
  return value;
}
export function validActor(actor: unknown): Actor {
  const a = actor as Partial<Actor> | null;
  if (!a || typeof a !== 'object') throw new Error('INVALID_ACTOR');
  validId(a.principalId, 'ACTOR');
  if (!KINDS.includes(String(a.kind))) throw new Error('INVALID_ACTOR');
  return a as Actor;
}
export function validReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 500)
    throw new Error('INVALID_REASON');
  return reason;
}
