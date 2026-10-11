import { createControlAuthorizer } from './control.js';
import {
  allHandlersFinished,
  condition,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  HedgeActivities,
  HedgeApprovalView,
  HedgeOrderView,
  HedgePlan,
} from '../activities/types.js';
import { hedgeApprovalGate } from './versions.js';
import {
  cancelUpdate,
  nextScheduledEventQuery,
  stateQuery,
  validActor,
  validReason,
  type ScheduledEvent,
} from './messages.js';
import { NON_RETRYABLE, seconds } from './common.js';

export type HedgeInput = {
  groupId: string;
  hedgeId: string;
  pollSeconds?: number;
  maxPolls?: number;
  maxApprovalPolls?: number;
  activityTimeoutSeconds?: number;
};
export type HedgeState = {
  hedgeId: string;
  plan: HedgePlan | null;
  approvals: HedgeApprovalView | null;
  clientOrderId: string | null;
  order: HedgeOrderView | null;
  cancelRequested: boolean;
  reconciled: boolean;
  position: string | null;
  nextEvent: ScheduledEvent;
  outcome:
    | 'NO_ACTION'
    | 'FILLED'
    | 'CANCELLED'
    | 'REJECTED'
    | 'UNRESOLVED'
    | null;
};

const TERMINAL = ['FILLED', 'CANCELLED', 'REJECTED'];

/** Hedge orchestration skeleton: venue specifics live behind HedgeActivities. The client order id is the idempotency key. */
export async function HedgeWorkflow(input: HedgeInput): Promise<HedgeState> {
  const authorize = createControlAuthorizer(input.groupId);
  const poll = input.pollSeconds ?? 10;
  const acts = proxyActivities<HedgeActivities>({
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 30),
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const mutations = proxyActivities<HedgeActivities>({
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 30),
    retry: { maximumAttempts: 1 },
  });
  const s: HedgeState = {
    hedgeId: input.hedgeId,
    plan: null,
    approvals: null,
    clientOrderId: null,
    order: null,
    cancelRequested: false,
    reconciled: false,
    position: null,
    nextEvent: { kind: 'NONE', at: null },
    outcome: null,
  };
  setHandler(stateQuery, () => s);
  setHandler(nextScheduledEventQuery, () => s.nextEvent);
  setHandler(
    cancelUpdate,
    async (request) => {
      await authorize('CANCEL', request);
      s.cancelRequested = true;
      return { accepted: true as const, at: new Date().toISOString() };
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (s.outcome !== null) throw new Error('WORKFLOW_COMPLETE');
      },
    },
  );
  const done = async (outcome: NonNullable<HedgeState['outcome']>) => {
    s.outcome = outcome;
    s.nextEvent = { kind: 'NONE', at: null };
    await condition(allHandlersFinished);
    return s;
  };

  const risk = await acts.hedgeRiskSnapshot({
    groupId: input.groupId,
    hedgeId: input.hedgeId,
  });
  const plan = await acts.planHedge({
    groupId: input.groupId,
    hedgeId: input.hedgeId,
    exposure: risk.exposure,
    riskStatus: risk.riskStatus,
  });
  s.plan = plan;
  if (plan.action === 'NONE' || s.cancelRequested) return done('NO_ACTION');
  s.clientOrderId = `synq.${input.groupId}.${input.hedgeId}.${plan.action.toLowerCase()}`;
  if (hedgeApprovalGate()) {
    for (let i = 0; i < (input.maxApprovalPolls ?? 360); i++) {
      s.approvals = await acts.hedgeApprovals({
        groupId: input.groupId,
        clientOrderId: s.clientOrderId,
      });
      if (s.approvals.rejected) return done('REJECTED');
      if (s.approvals.satisfied || s.cancelRequested) break;
      s.nextEvent = { kind: 'HEDGE_POLL', at: Date.now() + poll * 1000 };
      await condition(() => s.cancelRequested, seconds(poll));
    }
    if (s.cancelRequested) return done('CANCELLED');
    if (!s.approvals?.satisfied) return done('REJECTED');
  }
  try {
    s.order = await mutations.submitHedgeOrder({
      groupId: input.groupId,
      clientOrderId: s.clientOrderId,
      plan,
    });
  } catch {
    s.order = await acts.hedgeOrderStatus({ clientOrderId: s.clientOrderId });
  }
  let cancelSent = false;
  for (
    let i = 0;
    i < (input.maxPolls ?? 360) && !TERMINAL.includes(s.order.status);
    i++
  ) {
    if (s.cancelRequested && !cancelSent) {
      cancelSent = true;
      try {
        s.order = await mutations.cancelHedgeOrder({
          clientOrderId: s.clientOrderId,
        });
      } catch {
        s.order = await acts.hedgeOrderStatus({
          clientOrderId: s.clientOrderId,
        });
      }
      continue;
    }
    s.nextEvent = { kind: 'HEDGE_POLL', at: Date.now() + poll * 1000 };
    await condition(() => s.cancelRequested && !cancelSent, seconds(poll));
    s.order = await acts.hedgeOrderStatus({ clientOrderId: s.clientOrderId });
  }
  const rec = await acts.reconcileHedge({
    groupId: input.groupId,
    clientOrderId: s.clientOrderId,
  });
  s.reconciled = rec.reconciled;
  s.position = rec.position;
  if (!rec.reconciled || !TERMINAL.includes(s.order.status))
    return done('UNRESOLVED');
  return done(s.order.status as 'FILLED' | 'CANCELLED' | 'REJECTED');
}
