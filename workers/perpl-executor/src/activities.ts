import type { Mandate } from '@synq/domain';
import {
  HedgePolicy,
  type HedgeApproval,
  type HedgeDecision,
  type HedgeFacts,
  type HedgeGrant,
  type HedgeGrantAuthority,
  type HedgeIntent,
  type HedgeMandate,
} from '@synq/kernel';
import {
  evaluatePortfolio,
  proposeHedge,
  type HedgeContext,
  type HedgeMarket,
  type HedgeProposal,
  type PortfolioRisk,
  type RiskInputs,
} from '@synq/risk-engine';
import { DurableHedgeGrantAuthority } from './durable.js';
import type { HedgeExecutionReceipt, PerplHedgeExecutor } from './executor.js';

// Activity ports for the durable HedgeWorkflow. All nondeterminism (clock,
// network, venue) lives behind these calls; the workflow only sequences them
// and waits on approval signals between evaluate and issue.
export interface HedgeActivities {
  assessRisk(input: { inputs: RiskInputs }): Promise<PortfolioRisk>;
  proposeHedge(input: {
    risk: PortfolioRisk;
    hedgeMandate: HedgeMandate;
    market: HedgeMarket;
    context: HedgeContext;
  }): Promise<HedgeProposal>;
  evaluateHedge(input: {
    intent: HedgeIntent;
    hedgeMandate: HedgeMandate;
    mandate: Mandate;
    facts: HedgeFacts;
  }): Promise<HedgeDecision>;
  issueHedgeGrant(input: {
    decision: HedgeDecision;
    intent: HedgeIntent;
    hedgeMandate: HedgeMandate;
    mandate: Mandate;
    approvals: readonly HedgeApproval[];
    now: number;
  }): Promise<HedgeGrant>;
  executeHedge(input: { grant: HedgeGrant }): Promise<HedgeExecutionReceipt>;
}

export function createHedgeActivities(deps: {
  grants: HedgeGrantAuthority | DurableHedgeGrantAuthority;
  executor: () => PerplHedgeExecutor;
}): HedgeActivities {
  const policy = new HedgePolicy();
  return {
    assessRisk: async ({ inputs }) => evaluatePortfolio(inputs),
    proposeHedge: async ({ risk, hedgeMandate, market, context }) =>
      proposeHedge(risk, hedgeMandate, market, context),
    evaluateHedge: async (input) =>
      policy.evaluate(
        deps.grants instanceof DurableHedgeGrantAuthority
          ? await deps.grants.options.loadTrusted(input.intent.intentId)
          : input,
      ),
    issueHedgeGrant: async (input) =>
      deps.grants instanceof DurableHedgeGrantAuthority
        ? deps.grants.issue(input.intent.intentId)
        : deps.grants.issue(input),
    executeHedge: async ({ grant }) => deps.executor().execute(grant),
  };
}
