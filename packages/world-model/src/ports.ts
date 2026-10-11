import type {
  ActionState,
  IdentityPrincipalKind,
  Mandate,
  MarketQuote,
  NetworkProfile,
  ProviderHealthEntry,
  RiskState,
  VerifiedApproval,
  WorkflowStatus,
} from '@synq/schemas';

export type KernelBudgetView = {
  spentToken: string;
  spentNative: string;
  reservedToken: string;
  reservedNative: string;
  issued: number;
};
export type KernelStateSnapshot = {
  network: NetworkProfile;
  mandates: { mandate: Mandate; budget: KernelBudgetView }[];
  grants: {
    grantId: string;
    intentId: string;
    groupId: string;
    mandateId: string;
    state: string;
    maxInputAmount: string;
    nativeValue: string;
    validUntil: number;
  }[];
  intents: { intentId: string; state: ActionState; updatedAt: string }[];
  observedAt: number | null;
};
export interface KernelStateReader {
  stateView(): KernelStateSnapshot | Promise<KernelStateSnapshot>;
}

export type IdentityGroupView = {
  groupId: string;
  chainGroupId: string;
  chainId: number;
  account: string;
  owners: string[];
  threshold: number;
  membershipEpoch: number;
  memberships: {
    memberId: string;
    principalId: string;
    principalKind: IdentityPrincipalKind;
    role: 'APPROVER' | 'OPERATOR';
    signer: string;
    status: 'ACTIVE' | 'REVOKED';
  }[];
};
export type DraftSummary = {
  intentHash: string;
  draftDigest: string;
  status: 'PENDING' | 'INVALIDATED' | 'APPROVED';
  createdAt: number;
};
export interface IdentityDirectoryReader {
  group(groupId: string): Promise<IdentityGroupView | null>;
  drafts(groupId: string): Promise<DraftSummary[]>;
  approvals(groupId: string): Promise<Omit<VerifiedApproval, 'signature'>[]>;
}

export interface WorkflowStatusReader {
  list(
    groupId: string,
  ): Promise<{ workflows: WorkflowStatus[]; observedAt: number }>;
}
export class InMemoryWorkflowStatusReader implements WorkflowStatusReader {
  constructor(
    private workflows: WorkflowStatus[] = [],
    private observedAt = 0,
  ) {}
  set(workflows: WorkflowStatus[], observedAt: number): void {
    this.workflows = structuredClone(workflows);
    this.observedAt = observedAt;
  }
  async list(): Promise<{ workflows: WorkflowStatus[]; observedAt: number }> {
    return {
      workflows: structuredClone(this.workflows),
      observedAt: this.observedAt,
    };
  }
}

export interface MarketDataSource {
  quotes(network: NetworkProfile): Promise<MarketQuote[]>;
}
export class InMemoryMarketDataSource implements MarketDataSource {
  constructor(private entries: MarketQuote[] = []) {}
  set(entries: MarketQuote[]): void {
    this.entries = structuredClone(entries);
  }
  async quotes(network: NetworkProfile): Promise<MarketQuote[]> {
    return structuredClone(
      this.entries.filter((q) => q.chainId === network.chainId),
    );
  }
}

export type RiskObservation = {
  state: RiskState;
  observedAt: number;
  maxAgeSeconds: number;
};
export interface RiskStateSource {
  current(groupId: string): Promise<RiskObservation>;
}
export class InMemoryRiskStateSource implements RiskStateSource {
  constructor(private observation: RiskObservation | null = null) {}
  set(observation: RiskObservation): void {
    this.observation = structuredClone(observation);
  }
  async current(): Promise<RiskObservation> {
    if (!this.observation) throw new Error('RISK_SOURCE_EMPTY');
    return structuredClone(this.observation);
  }
}

export type ProviderHealthView = {
  providerId: string;
  status: ProviderHealthEntry['status'];
  environment: ProviderHealthEntry['environment'];
  authState: ProviderHealthEntry['authState'];
  circuit: ProviderHealthEntry['circuit'];
  verbs: readonly string[];
  latencyMs: number | null;
  lastSuccessfulAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
};
/** Web2/x402 provider capability graph (Offer Exchange) health feed. */
export interface ProviderHealthReader {
  health(now: number): readonly ProviderHealthView[];
}
