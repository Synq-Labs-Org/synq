import { createControlAuthorizer } from './control.js';
import {
  allHandlersFinished,
  condition,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  ActionState,
  GrantExecutionObservation,
  StartActionExecution,
  TxState,
  VerifiedApproval,
} from '@synq/schemas';
import type {
  DecisionView,
  EconomicActivities,
  Hex,
  QuorumSummary,
  ReservationView,
  StateStep,
  TxView,
} from '../activities/types.js';
import { ActionLifecycle } from './lifecycle.js';
import { settlementRecheck } from './versions.js';
import {
  approvalRecordedSignal,
  approveUpdate,
  cancelSignal,
  cancelUpdate,
  latestExecutionQuery,
  nextScheduledEventQuery,
  pauseUpdate,
  pendingApprovalsQuery,
  rejectUpdate,
  reservationStatusQuery,
  resolveEscalationUpdate,
  resumeUpdate,
  stateQuery,
  validActor,
  validId,
  validReason,
  type Actor,
  type ControlInput,
  type ControlResult,
  type EscalationResolution,
  type ScheduledEvent,
} from './messages.js';
import {
  NON_RETRYABLE,
  errorMessage,
  failureType,
  isNonRetryable,
  seconds,
} from './common.js';

export type ActionTuning = {
  activityTimeoutSeconds: number;
  heartbeatTimeoutSeconds: number;
  submitTimeoutSeconds: number;
  confirmationTimeoutSeconds: number;
  confirmationPollSeconds: number;
  retryInitialSeconds: number;
  retryMaxSeconds: number;
  releaseMarginSeconds: number;
  maxSubmitReconciliations: number;
};
export const DEFAULT_ACTION_TUNING: ActionTuning = {
  activityTimeoutSeconds: 30,
  heartbeatTimeoutSeconds: 10,
  submitTimeoutSeconds: 60,
  confirmationTimeoutSeconds: 120,
  confirmationPollSeconds: 5,
  retryInitialSeconds: 1,
  retryMaxSeconds: 30,
  releaseMarginSeconds: 15,
  maxSubmitReconciliations: 5,
};

export type WaitingFor =
  | 'APPROVAL'
  | 'RESUME'
  | 'ESCALATION'
  | 'CONFIRMATION'
  | 'RESERVATION_RELEASE'
  | null;

export type ActionOutcome =
  | 'SETTLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ABANDONED';

export type ActionWorkflowState = {
  workflowId: string;
  intentId: string | null;
  proposedIntentId: string;
  correlationId: string;
  executionMode: string;
  actionState: ActionState;
  txState: TxState | null;
  kernelLifecycle: StateStep<ActionState>[];
  journalLifecycle: StateStep<ActionState>[];
  txLifecycle: StateStep<TxState>[];
  waitingFor: WaitingFor;
  paused: boolean;
  pausedBy: Actor | null;
  cancellation: {
    by: Actor | null;
    memberId: string | null;
    reason: string;
  } | null;
  escalation: { reason: string; at: number } | null;
  approval: {
    draftDigest: Hex;
    required: number;
    counted: string[];
    satisfied: boolean;
    deadline: number;
    notifications: number;
  } | null;
  decisionCode: string | null;
  grant: { grantId: Hex; validUntil: number } | null;
  reservation: ReservationView | null;
  execution: {
    transactionHash: Hex;
    state: TxState;
    blockNumber: string | null;
    outcome: 'SUCCESS' | 'REVERTED' | null;
  } | null;
  submitReconciliations: number;
  nextEvent: ScheduledEvent;
  outcome: ActionOutcome | null;
};

export type ActionExecutionResult = {
  outcome: ActionOutcome;
  intentId: string | null;
  grantId: Hex | null;
  transactionHash: Hex | null;
  actionState: ActionState;
  txState: TxState | null;
  approvals: string[];
  reservation: ReservationView | null;
  observation: GrantExecutionObservation | null;
};

class Abort extends Error {
  constructor(readonly outcome: ActionOutcome) {
    super(outcome);
  }
}

export async function ActionExecutionWorkflow(
  input: StartActionExecution,
  tuning: Partial<ActionTuning> = {},
): Promise<ActionExecutionResult> {
  const authorize = createControlAuthorizer(input.intent.groupId);
  const t: ActionTuning = { ...DEFAULT_ACTION_TUNING, ...tuning };
  const retry = {
    initialInterval: seconds(t.retryInitialSeconds),
    backoffCoefficient: 2,
    maximumInterval: seconds(t.retryMaxSeconds),
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  };
  const econ = proxyActivities<EconomicActivities>({
    startToCloseTimeout: seconds(t.activityTimeoutSeconds),
    heartbeatTimeout: seconds(t.heartbeatTimeoutSeconds),
    retry,
  });
  const submitter = proxyActivities<EconomicActivities>({
    startToCloseTimeout: seconds(t.submitTimeoutSeconds),
    heartbeatTimeout: seconds(t.heartbeatTimeoutSeconds),
    retry: { maximumAttempts: 1 },
  });
  const confirmer = proxyActivities<EconomicActivities>({
    startToCloseTimeout: seconds(t.confirmationTimeoutSeconds),
    heartbeatTimeout: seconds(t.heartbeatTimeoutSeconds),
    retry,
  });

  const lifecycle = new ActionLifecycle();
  const intent = input.intent;
  const calldata = input.calldata as Hex;
  const verified = new Map<string, VerifiedApproval>();
  let observation: GrantExecutionObservation | null = null;
  let quorumDirty = false;
  let submissionStarted = false;
  let resolution: EscalationResolution | null = null;

  const s: ActionWorkflowState = {
    workflowId: workflowInfo().workflowId,
    intentId: null,
    proposedIntentId: intent.intentId,
    correlationId: input.correlationId,
    executionMode: input.executionMode,
    actionState: lifecycle.actionState,
    txState: null,
    kernelLifecycle: [],
    journalLifecycle: [],
    txLifecycle: [],
    waitingFor: null,
    paused: false,
    pausedBy: null,
    cancellation: null,
    escalation: null,
    approval: null,
    decisionCode: null,
    grant: null,
    reservation: null,
    execution: null,
    submitReconciliations: 0,
    nextEvent: { kind: 'NONE', at: null },
    outcome: null,
  };
  const refresh = () => {
    s.actionState = lifecycle.actionState;
    s.txState = lifecycle.txState;
    s.kernelLifecycle = lifecycle.kernel.history;
    s.journalLifecycle = lifecycle.journalAction.history;
    s.txLifecycle = lifecycle.tx.history;
  };
  const syncDecision = (decision: DecisionView) => {
    lifecycle.kernel.sync(decision.lifecycle);
    lifecycle.successors = decision.successors;
    if (decision.intentId) s.intentId = decision.intentId;
    s.decisionCode = decision.status === 'AUTHORIZED' ? null : decision.code;
    refresh();
  };
  const syncTx = (tx: TxView) => {
    lifecycle.tx.sync(tx.txHistory);
    lifecycle.journalAction.sync(tx.actionHistory);
    lifecycle.successors = tx.successors;
    s.execution = {
      transactionHash: tx.transactionHash,
      state: tx.state,
      blockNumber: tx.blockNumber,
      outcome: tx.outcome,
    };
    refresh();
  };
  const applyQuorum = (q: QuorumSummary) => {
    if (!s.approval || q.draftDigest !== s.approval.draftDigest) return;
    for (const a of q.counted) verified.set(a.memberId, a);
    s.approval.counted = [...verified.keys()].sort();
    s.approval.satisfied = q.satisfied && q.draftStatus === 'PENDING';
  };
  const now = () => Date.now();
  const at = () => new Date().toISOString();
  const accepted = (): ControlResult => ({ accepted: true, at: at() });

  setHandler(
    approveUpdate,
    async ({ memberId, draftDigest }) => {
      s.approval!.notifications++;
      const q = await econ.readQuorum({ draftDigest: draftDigest as Hex });
      applyQuorum(q);
      void memberId;
      return {
        counted: s.approval!.counted.length,
        required: s.approval!.required,
        satisfied: s.approval!.satisfied,
      };
    },
    {
      validator: ({ memberId, draftDigest }) => {
        validId(memberId, 'MEMBER');
        if (!s.approval || s.waitingFor !== 'APPROVAL')
          throw new Error('NOT_AWAITING_APPROVAL');
        if (draftDigest !== s.approval.draftDigest)
          throw new Error('DRAFT_DIGEST_MISMATCH');
      },
    },
  );
  setHandler(approvalRecordedSignal, ({ draftDigest }) => {
    if (s.approval && draftDigest === s.approval.draftDigest)
      quorumDirty = true;
  });
  setHandler(
    rejectUpdate,
    async (request) => {
      const { memberId, reason } = request;
      await authorize('REJECT', {
        requestedBy: request.requestedBy ?? {
          principalId: memberId,
          kind: 'HUMAN',
        },
        reason,
        authorization: request.authorization,
      });
      s.cancellation = { by: null, memberId, reason };
      return accepted();
    },
    {
      validator: ({ memberId, reason }) => {
        validId(memberId, 'MEMBER');
        validReason(reason);
        if (s.waitingFor !== 'APPROVAL')
          throw new Error('NOT_AWAITING_APPROVAL');
      },
    },
  );
  const cancel = ({ requestedBy, reason }: ControlInput) => {
    if (!s.cancellation)
      s.cancellation = { by: requestedBy, memberId: null, reason };
  };
  const cancellable = () => !submissionStarted && s.outcome === null;
  setHandler(
    cancelUpdate,
    async (request) => {
      await authorize('CANCEL', request);
      if (!cancellable()) throw new Error('CANCEL_AFTER_SUBMISSION_FORBIDDEN');
      cancel(request);
      return accepted();
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (!cancellable())
          throw new Error('CANCEL_AFTER_SUBMISSION_FORBIDDEN');
      },
    },
  );
  setHandler(cancelSignal, async (request) => {
    try {
      await authorize('CANCEL', request);
      if (cancellable()) cancel(request);
    } catch {
      return;
    }
  });
  setHandler(
    pauseUpdate,
    async (request) => {
      await authorize('PAUSE', request);
      s.paused = true;
      s.pausedBy = request.requestedBy;
      return accepted();
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (s.outcome !== null) throw new Error('WORKFLOW_COMPLETE');
      },
    },
  );
  setHandler(
    resumeUpdate,
    async (request) => {
      await authorize('RESUME', request);
      s.paused = false;
      s.pausedBy = null;
      return accepted();
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (!s.paused && s.waitingFor !== 'RESUME')
          throw new Error('NOT_PAUSED');
      },
    },
  );
  setHandler(
    resolveEscalationUpdate,
    async (r) => {
      await authorize(
        r.resolution === 'RETRY' ? 'RESOLVE_RETRY' : 'RESOLVE_ABANDON',
        {
          requestedBy: r.resolvedBy,
          reason: r.note,
          authorization: r.authorization,
        },
      );
      resolution = r;
      return accepted();
    },
    {
      validator: (r) => {
        validActor(r.resolvedBy);
        validReason(r.note);
        if (!['RETRY', 'ABANDON'].includes(r.resolution))
          throw new Error('INVALID_RESOLUTION');
        if (s.waitingFor !== 'ESCALATION') throw new Error('NOT_ESCALATED');
      },
    },
  );
  setHandler(stateQuery, () => s);
  setHandler(pendingApprovalsQuery, () => ({
    draftDigest: s.approval?.draftDigest ?? null,
    required: s.approval?.required ?? null,
    counted: s.approval?.counted ?? [],
    outstanding: s.waitingFor === 'APPROVAL',
  }));
  setHandler(nextScheduledEventQuery, () => s.nextEvent);
  setHandler(reservationStatusQuery, () => ({
    grantId: s.grant?.grantId ?? null,
    state: s.reservation?.state ?? null,
    reservedToken: s.reservation?.reservedToken ?? null,
  }));
  setHandler(latestExecutionQuery, () => ({
    transactionHash: s.execution?.transactionHash ?? null,
    txState: s.execution?.state ?? null,
    blockNumber: s.execution?.blockNumber ?? null,
    outcome: s.execution?.outcome ?? null,
  }));

  const escalate = async (reason: string): Promise<'RETRY'> => {
    s.escalation = { reason, at: now() };
    s.waitingFor = 'ESCALATION';
    resolution = null;
    await condition(() => resolution !== null);
    const decided = resolution!;
    s.waitingFor = null;
    s.escalation = null;
    if (decided.resolution === 'ABANDON') throw new Abort('ABANDONED');
    return 'RETRY';
  };
  /** Waits out a pause or an autonomy freeze before a pre-submission economic step. */
  const gate = async () => {
    for (;;) {
      if (s.cancellation) return;
      if (s.paused) {
        s.waitingFor = 'RESUME';
        await condition(() => !s.paused || s.cancellation !== null);
        s.waitingFor = null;
        continue;
      }
      const status = await econ.autonomyStatus({ groupId: intent.groupId });
      if (status.frozen) {
        s.paused = true;
        s.pausedBy = { principalId: 'emergency-pause', kind: 'SERVICE' };
        continue;
      }
      return;
    }
  };
  /** Runs a pre-submission economic step; a freeze discovered by the Activity becomes a pause. */
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    for (;;) {
      await gate();
      if (s.cancellation) throw new Abort('CANCELLED');
      try {
        return await run();
      } catch (error) {
        const type = failureType(error);
        if (type === 'AUTONOMY_FROZEN') {
          s.paused = true;
          s.pausedBy = { principalId: 'emergency-pause', kind: 'SERVICE' };
          continue;
        }
        if (isNonRetryable(error)) throw error;
        await escalate(`${type ?? 'ACTIVITY_FAILED'}: ${errorMessage(error)}`);
      }
    }
  };

  const releaseReservation = async (): Promise<void> => {
    const grant = s.grant!;
    s.waitingFor = 'RESERVATION_RELEASE';
    for (let attempt = 0; ; attempt++) {
      const releaseAt = grant.validUntil * 1000 + t.releaseMarginSeconds * 1000;
      s.nextEvent = {
        kind: 'RESERVATION_RELEASE',
        at: Math.max(releaseAt, now()),
      };
      if (now() < releaseAt) await sleep(releaseAt - now());
      const view = await econ.releaseExpiredReservation({
        grantId: grant.grantId,
      });
      s.reservation = view;
      if (view.state === 'RELEASED' || view.state === 'RECONCILED') break;
      await sleep(
        seconds(Math.min(60, t.releaseMarginSeconds * (attempt + 1))),
      );
    }
    s.waitingFor = null;
    s.nextEvent = { kind: 'NONE', at: null };
  };

  const submitWithReconciliation = async (grantId: Hex): Promise<TxView> => {
    for (;;) {
      try {
        return await submitter.signAndSubmit({ grantId, intent, calldata });
      } catch (error) {
        if (isNonRetryable(error)) {
          await escalate(`${failureType(error)}: ${errorMessage(error)}`);
          continue;
        }
        s.submitReconciliations++;
        const check = await econ.checkSubmission({ grantId });
        if (check.status === 'JOURNALED') return check.tx;
        if (s.submitReconciliations >= t.maxSubmitReconciliations)
          await escalate(`SUBMISSION_UNRESOLVED: ${errorMessage(error)}`);
      }
    }
  };

  const confirm = async (grantId: Hex): Promise<TxView> => {
    for (;;) {
      s.waitingFor = 'CONFIRMATION';
      try {
        const tx = await confirmer.confirmInclusion({ grantId });
        syncTx(tx);
        if (
          ['CONFIRMED', 'INDEXED', 'RECONCILED', 'SETTLED'].includes(tx.state)
        ) {
          s.waitingFor = null;
          s.nextEvent = { kind: 'NONE', at: null };
          return tx;
        }
      } catch (error) {
        if (isNonRetryable(error))
          await escalate(`${failureType(error)}: ${errorMessage(error)}`);
      }
      s.nextEvent = {
        kind: 'CONFIRMATION_POLL',
        at: now() + t.confirmationPollSeconds * 1000,
      };
      await sleep(seconds(t.confirmationPollSeconds));
    }
  };

  const finish = async (
    outcome: ActionOutcome,
  ): Promise<ActionExecutionResult> => {
    s.outcome = outcome;
    s.waitingFor = null;
    s.nextEvent = { kind: 'NONE', at: null };
    await condition(allHandlersFinished);
    return {
      outcome,
      intentId: s.intentId,
      grantId: s.grant?.grantId ?? null,
      transactionHash: s.execution?.transactionHash ?? null,
      actionState: s.actionState,
      txState: s.txState,
      approvals: s.approval?.counted ?? [],
      reservation: s.reservation,
      observation,
    };
  };
  const closeAs = (to: ActionState) => {
    if (lifecycle.canClose(to)) lifecycle.close(to);
    refresh();
  };

  try {
    const { simulation } = await step(() =>
      econ.attestEvidence({ intent, risk: input.risk, calldata }),
    );
    let decision = await step(() =>
      econ.authorize({
        intent,
        risk: input.risk,
        calldata,
        simulation,
        approvals: [],
      }),
    );
    syncDecision(decision);
    if (decision.status === 'PENDING_APPROVAL') {
      const draft = decision.draft;
      if (!draft) return await finish('REJECTED');
      const { draftDigest } = await step(() => econ.registerDraft({ draft }));
      const deadline = Math.min(
        now() + input.approvalTimeoutSeconds * 1000,
        Number(draft.grant.validUntil) * 1000,
      );
      s.approval = {
        draftDigest,
        required: decision.requiredApprovals ?? draft.requiredApprovals,
        counted: [],
        satisfied: false,
        deadline,
        notifications: 0,
      };
      s.waitingFor = 'APPROVAL';
      s.nextEvent = { kind: 'APPROVAL_DEADLINE', at: deadline };
      for (;;) {
        const woke = await condition(
          () => quorumDirty || s.cancellation !== null || s.approval!.satisfied,
          Math.max(1, deadline - now()),
        );
        if (s.cancellation) {
          closeAs('CANCELLED');
          return await finish('CANCELLED');
        }
        if (!woke) {
          closeAs('EXPIRED');
          return await finish('EXPIRED');
        }
        if (quorumDirty) {
          quorumDirty = false;
          applyQuorum(await econ.readQuorum({ draftDigest }));
        }
        if (!s.approval.satisfied) continue;
        s.waitingFor = null;
        decision = await step(() =>
          econ.authorize({
            intent,
            risk: input.risk,
            calldata,
            simulation,
            approvals: [...verified.values()],
          }),
        );
        syncDecision(decision);
        if (decision.status === 'AUTHORIZED') break;
        if (decision.status !== 'PENDING_APPROVAL')
          return await finish('REJECTED');
        s.approval.satisfied = false;
        s.waitingFor = 'APPROVAL';
      }
      s.nextEvent = { kind: 'NONE', at: null };
    }
    if (decision.status !== 'AUTHORIZED') return await finish('REJECTED');
    const grantId = decision.grantId;
    s.grant = { grantId, validUntil: decision.validUntil };
    s.reservation = await econ.reservationStatus({ grantId });

    try {
      const prepared = await step(() =>
        econ.claimAndPrepare({ grantId, intent, calldata }),
      );
      lifecycle.kernel.sync(prepared.lifecycle);
      lifecycle.successors = prepared.successors;
      s.reservation = prepared.reservation;
      refresh();
      await gate();
      if (s.cancellation) throw new Abort('CANCELLED');
    } catch (error) {
      if (error instanceof Abort && error.outcome === 'CANCELLED') {
        await releaseReservation();
        return await finish('CANCELLED');
      }
      if (isNonRetryable(error)) {
        s.decisionCode = failureType(error);
        await releaseReservation();
        return await finish('REJECTED');
      }
      throw error;
    }

    submissionStarted = true;
    let tx = await submitWithReconciliation(grantId);
    syncTx(tx);
    tx = await confirm(grantId);
    for (;;) {
      try {
        const indexed = await econ.indexObservation({ grantId });
        syncTx(indexed.tx);
        observation = indexed.observation;
        const reconciled = await econ.reconcileGrant({ grantId, observation });
        syncTx(reconciled.tx);
        s.reservation = reconciled.reservation;
        if (indexed.observation.receiptStatus !== 'success') {
          await escalate('EXECUTION_REVERTED');
          continue;
        }
        const settled = await econ.settle({ grantId });
        syncTx(settled.tx);
        s.reservation = settled.reservation;
        if (settlementRecheck()) {
          s.reservation = await econ.reservationStatus({ grantId });
          if (s.reservation.state !== 'RECONCILED') {
            await escalate(`RESERVATION_NOT_SETTLED: ${s.reservation.state}`);
            continue;
          }
        }
        return await finish('SETTLED');
      } catch (error) {
        if (error instanceof Abort) throw error;
        await escalate(
          `${failureType(error) ?? 'RECONCILIATION_FAILED'}: ${errorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    if (error instanceof Abort) {
      if (error.outcome === 'CANCELLED') closeAs('CANCELLED');
      return await finish(error.outcome);
    }
    throw error;
  }
}
