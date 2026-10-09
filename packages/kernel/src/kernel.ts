import { z } from 'zod';
import {
  AddressSchema,
  NetworkProfileSchema,
  PluginManifestSchema,
  RiskPacketSchema,
  SimulationSchema,
  TreasuryBalanceSchema,
  type ActionState,
  type ApprovalLedger,
  type ExecutionGrant,
  type GrantDraft,
  type Mandate,
  type NetworkProfile,
  type PluginManifest,
  type Tier,
  type TransitionRecord,
  type TreasuryBalance,
} from '@synq/domain';
import { ApprovalCalculator, type RejectedApproval } from './approvals.js';
import { AuditRecorder, type AuditRecord, type AuditSink } from './audit.js';
import {
  IntentCanonicalizer,
  artifactHash,
  type CanonicalIntent,
  type Hash,
} from './canonical.js';
import {
  DelegationUsage,
  NO_DELEGATIONS,
  type DelegationEvaluator,
  type MembershipDirectory,
} from './delegation.js';
import {
  KernelError,
  asKernelError,
  decisionStatus,
  parseAs,
  requireRule,
  type Failure,
  type Issue,
} from './errors.js';
import { FreshnessGate, type FreshnessConfig } from './freshness.js';
import { GrantIssuer, GrantVerifier } from './grants.js';
import {
  Ledger,
  nativeAssetFor,
  type Budget,
  type GrantClaim,
} from './ledger.js';
import { ActionLifecycles, plannedPath } from './lifecycle.js';
import { MandateResolver, onchainMandateId } from './mandates.js';
import { PolicyEngine, type PolicyResult } from './policy.js';
import { RiskGate, SimulationGate } from './risk.js';
import {
  restoreState,
  snapshotState,
  type KernelSnapshot,
} from './snapshot.js';

export interface Clock {
  now(): number;
}
export type TrustedEvidence = {
  riskPacketHashes: readonly string[];
  simulationHashes: readonly string[];
};
export type KernelDependencies = {
  clock: Clock;
  approvalLedger: ApprovalLedger;
  membershipDirectory: MembershipDirectory;
  delegations?: DelegationEvaluator;
  freshness: FreshnessConfig;
  plugins: readonly unknown[];
  auditSink?: AuditSink;
};
export type KernelOptions = KernelDependencies & {
  network: NetworkProfile;
  executionModule: `0x${string}`;
  mandates: readonly unknown[];
  balances?: readonly TreasuryBalance[];
  balanceBlock?: string;
  trustedEvidence?: TrustedEvidence;
};
export type AuthorizationRequest = {
  intent: unknown;
  risk: unknown;
  simulation: unknown;
  approvals: readonly unknown[];
};
type DecisionCommon = {
  intentId: string | null;
  intentHash: Hash | null;
  state: ActionState | null;
  tier: Tier | null;
  policy: PolicyResult | null;
  transitions: TransitionRecord<ActionState>[];
  audit: { sequence: number; hash: Hash };
};
export type AuthorizedDecision = DecisionCommon & {
  status: 'AUTHORIZED';
  tier: Exclude<Tier, 'BLOCKED'>;
  requiredApprovals: number;
  draft: GrantDraft;
  grant: ExecutionGrant;
};
export type PendingDecision = DecisionCommon & {
  status: 'PENDING_APPROVAL';
  code: Failure;
  issues: Issue[];
  draft: GrantDraft | null;
  requiredApprovals: number | null;
  countedApprovals: number;
  rejectedApprovals: RejectedApproval[];
};
export type RejectedDecision = DecisionCommon & {
  status: 'POLICY_REJECTED' | 'RISK_REJECTED' | 'EXPIRED';
  code: Failure;
  issues: Issue[];
};
export type AuthorizationDecision =
  | AuthorizedDecision
  | PendingDecision
  | RejectedDecision;

const RequestSchema = z.strictObject({
  intent: z.unknown(),
  risk: z.unknown(),
  simulation: z.unknown(),
  approvals: z.array(z.unknown()),
});

type Context = {
  canonical?: CanonicalIntent;
  policy?: PolicyResult;
  draft?: GrantDraft;
  counted?: number;
  rejected?: RejectedApproval[];
  required?: number;
};

export class Kernel {
  readonly network: NetworkProfile;
  readonly executionModule: `0x${string}`;
  private mandates: MandateResolver;
  private ledger = new Ledger();
  private delegationUsage = new DelegationUsage();
  private lifecycles = new ActionLifecycles();
  private audit: AuditRecorder;
  private readonly trustedRisk = new Set<string>();
  private readonly trustedSimulation = new Set<string>();
  private readonly plugins = new Map<string, PluginManifest>();
  private readonly canonicalizer = new IntentCanonicalizer();
  private readonly policyEngine = new PolicyEngine();
  private readonly riskGate = new RiskGate();
  private readonly simulationGate = new SimulationGate();
  private readonly calculator = new ApprovalCalculator();
  private readonly issuer = new GrantIssuer();
  private readonly verifier = new GrantVerifier();
  private readonly freshness: FreshnessGate;
  private readonly clock: Clock;
  private readonly approvalLedger: ApprovalLedger;
  private readonly directory: MembershipDirectory;
  private readonly delegationEvaluator: DelegationEvaluator;
  private lastNow: number | null = null;
  private claimSequence = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: KernelOptions) {
    this.network = parseAs(
      NetworkProfileSchema,
      options.network,
      'INVALID_REQUEST',
    );
    this.executionModule = parseAs(
      AddressSchema,
      options.executionModule,
      'INVALID_REQUEST',
    );
    this.clock = options.clock;
    this.approvalLedger = options.approvalLedger;
    this.directory = options.membershipDirectory;
    this.delegationEvaluator = options.delegations ?? NO_DELEGATIONS;
    this.freshness = new FreshnessGate(options.freshness);
    this.audit = new AuditRecorder(options.auditSink);
    for (const raw of options.plugins) {
      const manifest = parseAs(PluginManifestSchema, raw, 'INVALID_REQUEST');
      requireRule(!this.plugins.has(manifest.id), 'INVALID_REQUEST');
      this.plugins.set(manifest.id, manifest);
    }
    this.mandates = new MandateResolver(options.mandates);
    for (const raw of options.balances ?? []) {
      const balance = parseAs(TreasuryBalanceSchema, raw, 'INVALID_REQUEST');
      requireRule(
        this.ledger.available(balance.account, balance.asset) === null,
        'INVALID_REQUEST',
      );
      this.ledger.setBalance(balance, options.balanceBlock ?? '0');
    }
    this.attestEvidence(
      options.trustedEvidence ?? { riskPacketHashes: [], simulationHashes: [] },
    );
  }

  private tick(): number {
    const now = this.clock.now();
    requireRule(Number.isSafeInteger(now) && now >= 0, 'CLOCK_REGRESSION');
    requireRule(
      this.lastNow === null || now >= this.lastNow,
      'CLOCK_REGRESSION',
    );
    this.lastNow = now;
    return now;
  }
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  attestEvidence(evidence: TrustedEvidence): void {
    for (const hash of evidence.riskPacketHashes) this.trustedRisk.add(hash);
    for (const hash of evidence.simulationHashes)
      this.trustedSimulation.add(hash);
  }

  authorize(request: unknown): Promise<AuthorizationDecision> {
    let copy: unknown;
    try {
      copy = structuredClone(request);
    } catch {
      copy = Symbol.for('uncloneable');
    }
    return this.serialize(() => this.decide(copy));
  }

  private async decide(request: unknown): Promise<AuthorizationDecision> {
    const ctx: Context = {};
    let now = this.lastNow ?? 0;
    try {
      now = this.tick();
      const req = parseAs(RequestSchema, request, 'INVALID_REQUEST');
      const canonical = this.canonicalizer.canonicalize(req.intent);
      ctx.canonical = canonical;
      const risk = parseAs(RiskPacketSchema, req.risk, 'INVALID_RISK_PACKET');
      const simulation = parseAs(
        SimulationSchema,
        req.simulation,
        'INVALID_SIMULATION',
      );
      const intent = canonical.intent;
      requireRule(
        !this.lifecycles.isAuthorizedOrLater(canonical.intentId),
        'NONCE_REPLAY',
      );
      requireRule(
        this.lifecycles.isOpen(canonical.intentId),
        'INTENT_TERMINAL',
      );
      const mandate = this.mandates.current(intent.groupId, intent.mandateId);
      const fingerprint = this.mandates.fingerprint(
        intent.groupId,
        intent.mandateId,
      );
      const policy = this.policyEngine.evaluate({
        canonical,
        mandate,
        network: this.network,
        now,
      });
      ctx.policy = policy;
      if (policy.rejection) throw new KernelError(policy.rejection.code);
      const manifest = this.plugins.get(intent.pluginId);
      requireRule(
        manifest !== undefined &&
          manifest.chains.includes(this.network.chainId) &&
          manifest.environments.includes(this.network.profile),
        'PLUGIN_FORBIDDEN',
      );
      this.ledger.gate({ intent, mandate, now, verifiedBalances: null });
      const assets = [
        ...(BigInt(intent.maxInputAmount) > 0n ? [mandate.inputAsset] : []),
        ...(BigInt(intent.nativeValue) > 0n
          ? [nativeAssetFor(intent.chainId)]
          : []),
      ];
      const freshness = await this.freshness.check({
        chainId: intent.chainId,
        account: intent.account,
        mandateId: onchainMandateId(mandate),
        mandateVersion: mandate.version,
        assets,
      });
      const verifiedBalances = freshness.verifiedBalances;
      this.ledger.gate({ intent, mandate, now, verifiedBalances });
      this.riskGate.verify({
        canonical,
        mandate,
        risk,
        trusted: this.trustedRisk,
        now,
      });
      this.simulationGate.verify({
        canonical,
        mandate,
        simulation,
        trusted: this.trustedSimulation,
        now,
      });
      const required = Math.max(
        policy.requiredApprovals,
        mandate.approvalPolicy.accountThreshold,
      );
      ctx.required = required;
      const draft = this.issuer.draft({
        canonical,
        mandate,
        network: this.network,
        executionModule: this.executionModule,
        manifest,
        risk,
        simulation,
        requiredApprovals: required,
      });
      ctx.draft = draft;
      requireRule(
        now >= Number(draft.grant.validAfter) &&
          now < Number(draft.grant.validUntil),
        'DRAFT_EXPIRED',
      );
      const outcome = await this.calculator.evaluate({
        draft,
        intent,
        mandate,
        network: this.network,
        approvals: req.approvals,
        requiredByPolicy: policy.requiredApprovals,
        ports: {
          ledger: this.approvalLedger,
          directory: this.directory,
          delegations: this.delegationEvaluator,
          usage: this.delegationUsage,
        },
        now,
      });
      ctx.counted = outcome.counted.length;
      ctx.rejected = outcome.rejected;
      if (!outcome.satisfied)
        throw new KernelError(outcome.rejected[0]?.code ?? outcome.shortfall!);
      now = this.tick();
      requireRule(
        this.mandates.fingerprint(intent.groupId, intent.mandateId) ===
          fingerprint,
        'MANDATE_VERSION',
      );
      requireRule(now < Number(draft.grant.validUntil), 'DRAFT_EXPIRED');
      this.ledger.gate({ intent, mandate, now, verifiedBalances });
      for (const use of outcome.delegated)
        requireRule(
          this.delegationUsage.withinScope(mandate, intent, use.policyId, now),
          'DELEGATION_SCOPE',
        );
      const tier = policy.tier as Exclude<Tier, 'BLOCKED'>;
      const grant = this.issuer.issue({
        canonical,
        mandate,
        draft,
        policy,
        simulation,
        approvals: outcome.counted,
        tier,
        requiredApprovals: required,
        now,
      });
      this.ledger.reserve(grant, now);
      for (const use of outcome.delegated)
        this.delegationUsage.record(use.policyId, {
          amount: intent.maxInputAmount,
          at: now,
        });
      const transitions = this.lifecycles.advance(
        canonical.intentId,
        plannedPath(this.lifecycles.state(canonical.intentId), {
          kind: 'AUTHORIZED',
          viaApproval: required > 0,
        }),
        artifactHash(policy),
        now,
      );
      const audit = this.audit.append(
        'AUTHORIZATION',
        {
          status: 'AUTHORIZED',
          intentId: canonical.intentId,
          proposedIntentId: canonical.proposedIntentId,
          intentHash: canonical.intentHash,
          tier,
          requiredApprovals: required,
          policyResultHash: artifactHash(policy),
          policy,
          draftDigest: draft.digest,
          grantId: grant.grantId,
          approvalIds: outcome.counted.map((a) => a.approvalId),
          freshness: { mode: freshness.mode, lagBlocks: freshness.lagBlocks },
          transitions: transitions.map((t) => t.to),
        },
        now,
      );
      return {
        status: 'AUTHORIZED',
        intentId: canonical.intentId,
        intentHash: canonical.intentHash,
        state: this.lifecycles.state(canonical.intentId),
        tier,
        policy,
        requiredApprovals: required,
        draft,
        grant: structuredClone(grant),
        transitions,
        audit: { sequence: audit.sequence, hash: audit.hash },
      };
    } catch (error) {
      return this.refuse(ctx, asKernelError(error), now);
    }
  }

  private refuse(
    ctx: Context,
    error: KernelError,
    now: number,
  ): PendingDecision | RejectedDecision {
    const code = error.code;
    const canonical = ctx.canonical;
    let transitions: TransitionRecord<ActionState>[] = [];
    if (canonical && code !== 'CLOCK_REGRESSION')
      transitions = this.lifecycles.advance(
        canonical.intentId,
        plannedPath(this.lifecycles.state(canonical.intentId), {
          kind: 'FAILED',
          code,
        }),
        artifactHash({ code, policy: ctx.policy ?? null }),
        now,
      );
    const status = decisionStatus(code);
    const audit = this.audit.append(
      'AUTHORIZATION',
      {
        status,
        code,
        issues: [...error.issues],
        intentId: canonical?.intentId ?? null,
        proposedIntentId: canonical?.proposedIntentId ?? null,
        intentHash: canonical?.intentHash ?? null,
        tier: ctx.policy?.tier ?? null,
        policyResultHash: ctx.policy ? artifactHash(ctx.policy) : null,
        policy: ctx.policy ?? null,
        draftDigest: ctx.draft?.digest ?? null,
        rejectedApprovals: ctx.rejected ?? [],
        transitions: transitions.map((t) => t.to),
      },
      now,
    );
    const common = {
      intentId: canonical?.intentId ?? null,
      intentHash: canonical?.intentHash ?? null,
      state: canonical ? this.lifecycles.state(canonical.intentId) : null,
      tier: ctx.policy?.tier ?? null,
      policy: ctx.policy ?? null,
      transitions,
      audit: { sequence: audit.sequence, hash: audit.hash },
      code,
      issues: [...error.issues],
    };
    if (status === 'PENDING_APPROVAL')
      return {
        ...common,
        status,
        draft: ctx.draft ?? null,
        requiredApprovals: ctx.required ?? null,
        countedApprovals: ctx.counted ?? 0,
        rejectedApprovals: ctx.rejected ?? [],
      };
    return { ...common, status };
  }

  verify(grant: unknown, intent: unknown): ExecutionGrant {
    const now = this.tick();
    const canonical = this.canonicalizer.canonicalize(intent);
    const presented = parseAs(
      z.object({ grantId: z.string() }).loose(),
      grant,
      'GRANT_MISMATCH',
    );
    const verified = this.verifier.verify({
      presented: grant,
      issued: this.ledger.grants.get(presented.grantId),
      canonical,
      now,
    });
    this.mandates.assertGrantable(
      verified.groupId,
      verified.mandateId,
      verified.mandateVersion,
    );
    return verified;
  }
  claimForExecution(
    grant: unknown,
    intent: unknown,
    workerId: string,
  ): GrantClaim {
    const verified = this.verify(grant, intent);
    const now = this.lastNow!;
    const claim = this.ledger.claim(
      verified.grantId,
      workerId,
      now,
      this.claimSequence++,
    );
    this.audit.append('CLAIM', claim, now);
    return claim;
  }
  prepare(claim: GrantClaim, preparedCallHash: Hash): ExecutionGrant {
    const now = this.tick();
    const record = this.ledger.record(claim.grantId);
    this.mandates.assertGrantable(
      record.grant.groupId,
      record.grant.mandateId,
      record.grant.mandateVersion,
    );
    const grant = this.ledger.prepare(claim, preparedCallHash, now);
    const transitions = this.lifecycles.advance(
      grant.intentId,
      ['PREPARED'],
      preparedCallHash,
      now,
    );
    this.audit.append(
      'PREPARE',
      {
        grantId: grant.grantId,
        claimId: claim.claimId,
        preparedCallHash,
        transitions: transitions.map((t) => t.to),
      },
      now,
    );
    return grant;
  }
  reconcile(grantId: string, observation: unknown) {
    const now = this.tick();
    const record = this.ledger.reconcile(grantId, observation);
    this.audit.append(
      'RECONCILE',
      { grantId, state: record.state, execution: record.execution },
      now,
    );
    return record;
  }
  releaseUnexecuted(
    grantId: string,
    proof: { nonceUsed: boolean; intentUsed: boolean; blockTimestamp: number },
  ): void {
    const now = this.tick();
    this.ledger.releaseUnexecuted(grantId, proof);
    this.audit.append('RELEASE', { grantId, proof, reason: 'UNEXECUTED' }, now);
  }
  releaseExpired(): number {
    const now = this.tick();
    const released = this.ledger.releaseExpired(now);
    for (const grant of released) {
      if (this.lifecycles.state(grant.intentId) === 'AUTHORIZED')
        this.lifecycles.advance(
          grant.intentId,
          ['EXPIRED'],
          grant.grantId,
          now,
        );
      this.audit.append(
        'RELEASE',
        { grantId: grant.grantId, reason: 'EXPIRED' },
        now,
      );
    }
    return released.length;
  }
  observeBalance(balance: TreasuryBalance, blockNumber: string): void {
    const parsed = parseAs(TreasuryBalanceSchema, balance, 'INVALID_REQUEST');
    requireRule(/^(0|[1-9][0-9]*)$/.test(blockNumber), 'INVALID_REQUEST');
    this.ledger.observeBalance(parsed, blockNumber);
  }

  configureMandate(mandate: unknown): Mandate {
    const now = this.tick();
    const configured = this.mandates.configure(mandate);
    this.audit.append(
      'GOVERNANCE',
      { action: 'CONFIGURE', mandateHash: artifactHash(configured) },
      now,
    );
    return configured;
  }
  supersedeMandate(
    mandate: unknown,
    options: { securitySensitive: boolean },
  ): Mandate {
    const now = this.tick();
    const next = this.mandates.supersede(mandate, options);
    this.audit.append(
      'GOVERNANCE',
      {
        action: 'SUPERSEDE',
        mandateHash: artifactHash(next),
        securitySensitive: options.securitySensitive,
      },
      now,
    );
    return next;
  }
  revokeMandate(groupId: string, mandateId: string): Mandate {
    const now = this.tick();
    const revoked = this.mandates.revoke(groupId, mandateId);
    this.audit.append(
      'GOVERNANCE',
      { action: 'REVOKE', groupId, mandateId },
      now,
    );
    return revoked;
  }
  mandate(groupId: string, mandateId: string): Mandate {
    return this.mandates.current(groupId, mandateId);
  }
  accounting(groupId: string, mandateId: string): Budget {
    return this.ledger.budget({ groupId, mandateId });
  }
  grantState(grantId: string) {
    return structuredClone(this.ledger.record(grantId));
  }
  lifecycle(intentId: string): TransitionRecord<ActionState>[] {
    return this.lifecycles.history(intentId);
  }
  auditLog(): AuditRecord[] {
    return this.audit.records();
  }

  snapshot(): KernelSnapshot {
    return snapshotState({
      network: this.network,
      executionModule: this.executionModule,
      lastNow: this.lastNow,
      claimSequence: this.claimSequence,
      mandates: this.mandates.exportRecords(),
      ledger: this.ledger,
      trustedEvidence: {
        riskPacketHashes: [...this.trustedRisk],
        simulationHashes: [...this.trustedSimulation],
      },
      delegations: this.delegationUsage.export(),
      lifecycles: this.lifecycles.export(),
      audit: this.audit.records(),
    });
  }
  static restore(snapshot: unknown, dependencies: KernelDependencies): Kernel {
    const state = restoreState(snapshot);
    const kernel = new Kernel({
      ...dependencies,
      network: state.network,
      executionModule: state.executionModule,
      mandates: [],
      trustedEvidence: state.trustedEvidence,
    });
    kernel.mandates = state.mandates;
    kernel.ledger = state.ledger;
    kernel.delegationUsage = state.delegations;
    kernel.lifecycles = state.lifecycles;
    kernel.audit = AuditRecorder.restore(state.audit, dependencies.auditSink);
    kernel.lastNow = state.lastNow;
    kernel.claimSequence = state.claimSequence;
    return kernel;
  }
}
