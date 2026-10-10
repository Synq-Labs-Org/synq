import type { Actor, ControlAuthorization } from '../workflows/messages.js';
import type {
  ActionState,
  BoundActionIntent,
  ExecutionGrant,
  GrantDraft,
  GrantExecutionObservation,
  RiskPacket,
  Simulation,
  StartActionExecution,
  StartMandateApproval,
  TxState,
  VerifiedApproval,
} from '@synq/schemas';

export type Hex = `0x${string}`;
export type StateStep<S extends string> = { from: S; to: S };

export type DecisionView =
  | {
      status: 'AUTHORIZED';
      intentId: string;
      intentHash: Hex;
      grantId: Hex;
      validUntil: number;
      draft: GrantDraft;
      grant: ExecutionGrant;
      requiredApprovals: number;
      lifecycle: StateStep<ActionState>[];
      successors: ActionState[];
    }
  | {
      status: 'PENDING_APPROVAL';
      code: string;
      intentId: string | null;
      intentHash: Hex | null;
      draft: GrantDraft | null;
      requiredApprovals: number | null;
      lifecycle: StateStep<ActionState>[];
      successors: ActionState[];
    }
  | {
      status: 'POLICY_REJECTED' | 'RISK_REJECTED' | 'EXPIRED';
      code: string;
      intentId: string | null;
      intentHash: Hex | null;
      lifecycle: StateStep<ActionState>[];
      successors: ActionState[];
    };

export type QuorumSummary = {
  draftDigest: Hex;
  draftStatus: 'PENDING' | 'INVALIDATED';
  required: number;
  satisfied: boolean;
  counted: VerifiedApproval[];
};

export type ReservationView = {
  grantId: Hex;
  state:
    | 'RESERVED'
    | 'CONSUMED'
    | 'PREPARED'
    | 'REVERTED'
    | 'RELEASED'
    | 'RECONCILED';
  reservedToken: string;
  spentToken: string;
  validUntil: number;
};

export type PreparedView = {
  grantId: Hex;
  preparedCallHash: Hex;
  reservation: ReservationView;
  lifecycle: StateStep<ActionState>[];
  successors: ActionState[];
};

export type TxView = {
  grantId: Hex;
  transactionHash: Hex;
  state: TxState;
  blockNumber: string | null;
  outcome: 'SUCCESS' | 'REVERTED' | null;
  txHistory: StateStep<TxState>[];
  actionHistory: StateStep<ActionState>[];
  successors: ActionState[];
};

export type SubmissionCheck =
  | { status: 'NOT_SUBMITTED'; grantId: Hex }
  | { status: 'JOURNALED'; tx: TxView };

export type SettlementView = {
  tx: TxView;
  reservation: ReservationView;
  observation: GrantExecutionObservation;
};

export type ActionInputs = {
  intent: BoundActionIntent;
  risk: RiskPacket;
  calldata: Hex;
};

/** Economic path Activities. Every one is idempotent on its execution identity (intent id, grant id, journal entry). */
export interface EconomicActivities {
  attestEvidence(input: ActionInputs): Promise<{ simulation: Simulation }>;
  authorize(
    input: ActionInputs & {
      simulation: Simulation;
      approvals: VerifiedApproval[];
    },
  ): Promise<DecisionView>;
  registerDraft(input: { draft: GrantDraft }): Promise<{ draftDigest: Hex }>;
  readQuorum(input: { draftDigest: Hex }): Promise<QuorumSummary>;
  claimAndPrepare(input: {
    grantId: Hex;
    intent: BoundActionIntent;
    calldata: Hex;
  }): Promise<PreparedView>;
  signAndSubmit(input: {
    grantId: Hex;
    intent: BoundActionIntent;
    calldata: Hex;
  }): Promise<TxView>;
  checkSubmission(input: { grantId: Hex }): Promise<SubmissionCheck>;
  confirmInclusion(input: { grantId: Hex }): Promise<TxView>;
  indexObservation(input: {
    grantId: Hex;
  }): Promise<{ tx: TxView; observation: GrantExecutionObservation }>;
  reconcileGrant(input: {
    grantId: Hex;
    observation: GrantExecutionObservation;
  }): Promise<{ tx: TxView; reservation: ReservationView }>;
  settle(input: { grantId: Hex }): Promise<SettlementView>;
  reservationStatus(input: { grantId: Hex }): Promise<ReservationView>;
  releaseExpiredReservation(input: { grantId: Hex }): Promise<ReservationView>;
  autonomyStatus(input: {
    groupId: string;
  }): Promise<{ frozen: boolean; reason: string | null }>;
}

export type MandateApprovalSubmission = {
  memberId: string;
  signature: Hex;
};

export interface ApprovalActivities {
  loadMandateProposal(input: {
    proposalId: string;
  }): Promise<{ proposal: StartMandateApproval; digest: Hex } | null>;
  verifyMandateApproval(input: {
    proposalId: string;
    mandateHash: Hex;
    memberId: string;
    signature: Hex;
  }): Promise<{ valid: boolean; signer: Hex | null; reason: string | null }>;
  observeMandateOnchain(input: {
    groupId: string;
    mandateId: string;
    version: number;
    mandateHash: Hex;
    kind: 'CONFIGURE' | 'SUPERSEDE' | 'REVOKE';
  }): Promise<{ observed: boolean; block: string | null }>;
  applyMandateToKernel(input: {
    groupId: string;
    mandateId: string;
    version: number;
    mandateHash: Hex;
    kind: 'CONFIGURE' | 'SUPERSEDE' | 'REVOKE';
    securitySensitive: boolean;
  }): Promise<{ applied: boolean; version: number }>;
  notify(input: {
    channel: 'APPROVERS' | 'REQUESTER' | 'OPERATIONS';
    subject: string;
    correlationId: string;
    payload: Record<string, string | number | boolean | null>;
  }): Promise<{ delivered: boolean }>;
}

export type DcaStrategy = {
  strategyId: string;
  groupId: string;
  mandateId: string;
  mandateVersion: number;
  inputAmountPerTick: string;
  maxSlippageBps: number;
  maxTicks: number;
};

export type DcaFreshState = {
  mandateVersion: number;
  mandateActive: boolean;
  ticksExecuted: number;
  remainingBudget: string;
  observedAt: number;
};

export type MarketEvidence = {
  evidenceHash: Hex;
  referencePrice: string;
  quotedOutputAmount: string;
  quoteExpiresAt: number;
  riskStatus: 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'STALE';
  observedAt: number;
};

export type DcaEvaluation =
  | { decision: 'EXECUTE'; amount: string; reasons: string[] }
  | { decision: 'SKIP'; reasons: string[] }
  | { decision: 'ESCALATE'; reasons: string[] };

export interface StrategyActivities {
  dcaFreshState(input: { strategy: DcaStrategy }): Promise<DcaFreshState>;
  dcaMarketEvidence(input: { strategy: DcaStrategy }): Promise<MarketEvidence>;
  /** Deterministic evaluator port; strategy engines plug in here. */
  evaluateDca(input: {
    strategy: DcaStrategy;
    state: DcaFreshState;
    evidence: MarketEvidence;
  }): Promise<DcaEvaluation>;
  buildDcaAction(input: {
    strategy: DcaStrategy;
    tickKey: string;
    amount: string;
    evidence: MarketEvidence;
  }): Promise<{ start: StartActionExecution; workflowId: string }>;
  recordDcaTick(input: {
    strategyId: string;
    tickKey: string;
    decision: DcaEvaluation['decision'];
    childWorkflowId: string | null;
  }): Promise<{ recorded: boolean; ticks: number }>;
}

export type HedgePlan =
  | {
      action: 'OPEN' | 'ADJUST' | 'CLOSE';
      market: string;
      side: 'LONG' | 'SHORT';
      size: string;
      maxSlippageBps: number;
      reasons: string[];
    }
  | { action: 'NONE'; reasons: string[] };

export type HedgeOrderView = {
  clientOrderId: string;
  status:
    | 'ACCEPTED'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'REJECTED'
    | 'UNKNOWN';
  filledSize: string;
};

/** Hedge execution ports; the venue client fills these in. */
export interface HedgeActivities {
  hedgeRiskSnapshot(input: { groupId: string; hedgeId: string }): Promise<{
    exposure: string;
    riskStatus: MarketEvidence['riskStatus'];
    observedAt: number;
  }>;
  planHedge(input: {
    groupId: string;
    hedgeId: string;
    exposure: string;
    riskStatus: MarketEvidence['riskStatus'];
  }): Promise<HedgePlan>;
  submitHedgeOrder(input: {
    groupId: string;
    clientOrderId: string;
    plan: Exclude<HedgePlan, { action: 'NONE' }>;
  }): Promise<HedgeOrderView>;
  hedgeOrderStatus(input: { clientOrderId: string }): Promise<HedgeOrderView>;
  cancelHedgeOrder(input: { clientOrderId: string }): Promise<HedgeOrderView>;
  reconcileHedge(input: {
    groupId: string;
    clientOrderId: string;
  }): Promise<{ reconciled: boolean; position: string }>;
}

export type FundingQuote = {
  routeId: string;
  route:
    | 'DIRECT_MONAD_AUSD'
    | 'AUSD_OFT'
    | 'AURORA_INTENTS'
    | 'BRIDGE_TO_USDC_THEN_CONVERT';
  available: boolean;
  inputAmount: string;
  expectedOutput: string;
  expiresAt: number;
  reason: string | null;
};

export type FundingTransferView = {
  transferKey: string;
  status: 'PENDING' | 'SETTLED' | 'FAILED' | 'UNKNOWN';
  settledAmount: string | null;
};

/** Funding route ports; the treasury router fills these in. */
export interface FundingActivities {
  quoteFundingRoutes(input: {
    groupId: string;
    fundingId: string;
    amount: string;
  }): Promise<FundingQuote[]>;
  executeFundingRoute(input: {
    groupId: string;
    transferKey: string;
    quote: FundingQuote;
  }): Promise<FundingTransferView>;
  fundingStatus(input: { transferKey: string }): Promise<FundingTransferView>;
  creditFunding(input: {
    groupId: string;
    transferKey: string;
    amount: string;
  }): Promise<{ credited: boolean }>;
}

export type ReconciliationSweep = {
  checked: number;
  confirmed: Hex[];
  unresolved: Hex[];
  released: number;
};

export interface OperationsActivities {
  sweepJournal(input: Record<string, never>): Promise<ReconciliationSweep>;
  freezeAutonomy(input: {
    groupId: string;
    reason: string;
    incidentId: string;
  }): Promise<{ frozen: boolean; since: number }>;
  unfreezeAutonomy(input: {
    groupId: string;
    incidentId: string;
  }): Promise<{ frozen: boolean }>;
  prepareSafePause(input: { groupId: string }): Promise<{
    to: Hex;
    data: Hex;
    safe: Hex;
  }>;
  observeOnchainPause(input: {
    groupId: string;
  }): Promise<{ paused: boolean; block: string }>;
}

export type WorkflowControlRequest = {
  groupId: string;
  workflowId: string;
  operation:
    | 'CANCEL'
    | 'REJECT'
    | 'PAUSE'
    | 'RESUME'
    | 'RESOLVE_RETRY'
    | 'RESOLVE_ABANDON'
    | 'RESUME_EMERGENCY';
  requestedBy: Actor;
  reason: string;
  authorization?: ControlAuthorization;
};
export interface ControlActivities {
  authorizeWorkflowControl(
    input: WorkflowControlRequest,
  ): Promise<{ authorized: boolean }>;
}

export type SynqActivities = ControlActivities &
  EconomicActivities &
  ApprovalActivities &
  StrategyActivities &
  HedgeActivities &
  FundingActivities &
  OperationsActivities;
