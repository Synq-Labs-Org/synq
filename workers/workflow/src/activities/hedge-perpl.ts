import { ApplicationFailure } from '@temporalio/common';
import {
  workflowAction,
  type HedgeExecutionReceipt,
  type HedgeTrigger,
  type PerplHedgeService,
} from '@synq/perpl-executor';
import type { HedgeActivities, HedgeOrderView, HedgePlan } from './types.js';

const refuse = (message: string, type: string) =>
  ApplicationFailure.nonRetryable(message, type);

export function orderView(
  clientOrderId: string,
  r: HedgeExecutionReceipt | null,
): HedgeOrderView {
  const filled = r ? BigInt(r.filledSize) : 0n;
  const status: HedgeOrderView['status'] = !r
    ? 'REJECTED'
    : r.reconciliation === 'SETTLED'
      ? filled > 0n
        ? 'FILLED'
        : 'CANCELLED'
      : r.reconciliation === 'FAILED' || r.reconciliation === 'NO_ORDER'
        ? 'REJECTED'
        : r.reconciliation === 'OPEN'
          ? filled > 0n
            ? 'PARTIALLY_FILLED'
            : 'ACCEPTED'
          : 'UNKNOWN';
  return { clientOrderId, status, filledSize: filled.toString() };
}

// HedgeWorkflow ports over the Perpl service. The workflow passes identifiers
// only; size, price, leverage and collateral come from the persisted proposal
// sized by the risk engine from reader evidence, and the Kernel authority
// re-derives and authorizes them with verified approvals before any order.
export function perplHedgeActivities(deps: {
  service: PerplHedgeService;
  trigger?: HedgeTrigger;
}): HedgeActivities {
  const { service } = deps;
  const proposalFor = async (clientOrderId: string) => {
    const p = await service.proposalByClientOrderId(clientOrderId);
    if (!p?.intent) throw refuse('unknown hedge order', 'HEDGE_UNKNOWN');
    return p;
  };
  return {
    hedgeRiskSnapshot: async ({ groupId }) => {
      const s = await service.snapshot(groupId);
      return {
        exposure: s.exposure,
        riskStatus: s.riskStatus,
        observedAt: s.observedAt,
      };
    },
    planHedge: async ({ groupId, hedgeId }): Promise<HedgePlan> => {
      const { proposal, maxSlippageBps } = await service.plan({
        groupId,
        hedgeId,
        trigger: deps.trigger ?? 'SCHEDULED_REVIEW',
      });
      const reasons = [
        proposal.reason,
        `intent:${proposal.intentId}`,
        `riskPacket:${proposal.evidence.riskPacketHash}`,
        `evidence:${proposal.evidence.executionMode}`,
      ];
      if (!proposal.intent) return { action: 'NONE', reasons };
      return {
        action: workflowAction(proposal.intent.kind),
        market: String(proposal.intent.marketId),
        side: proposal.intent.side,
        size: proposal.intent.size,
        maxSlippageBps,
        reasons,
      };
    },
    hedgeApprovals: async ({ groupId, clientOrderId }) => {
      const p = await proposalFor(clientOrderId);
      if (p.groupId !== groupId) throw refuse('group', 'HEDGE_PLAN');
      return service.approvals(p.intentId);
    },
    submitHedgeOrder: async ({ groupId, clientOrderId, plan }) => {
      const p = await proposalFor(clientOrderId);
      const intent = p.intent!;
      if (
        p.groupId !== groupId ||
        plan.size !== intent.size ||
        plan.side !== intent.side ||
        plan.market !== String(intent.marketId) ||
        plan.action !== workflowAction(intent.kind)
      )
        throw refuse('plan differs from the persisted proposal', 'HEDGE_PLAN');
      return orderView(clientOrderId, await service.submit(intent.intentId));
    },
    hedgeOrderStatus: async ({ clientOrderId }) => {
      const p = await proposalFor(clientOrderId);
      return orderView(clientOrderId, await service.status(p.intentId));
    },
    // Hedge orders are immediate-or-cancel; nothing rests to cancel, so this
    // reports the reconciled venue outcome.
    cancelHedgeOrder: async ({ clientOrderId }) => {
      const p = await proposalFor(clientOrderId);
      return orderView(clientOrderId, await service.status(p.intentId));
    },
    reconcileHedge: async ({ groupId, clientOrderId }) => {
      const p = await proposalFor(clientOrderId);
      if (p.groupId !== groupId) throw refuse('group', 'HEDGE_PLAN');
      const r = await service.reconcile(p.intentId);
      return { reconciled: r.reconciled, position: r.position };
    },
  };
}
