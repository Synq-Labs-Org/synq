import { z } from 'zod';
import {
  AddressSchema,
  MandateSchema,
  NetworkProfileSchema,
  PluginManifestSchema,
  RiskPacketSchema,
  SimulationSchema,
  TreasuryBalanceSchema,
  type ActionState,
  type ApprovalLedger,
  type ExecutionGrant,
  type Mandate,
  type NetworkProfile,
  type PluginManifest,
  type Tier,
  type TransitionRecord,
  type TreasuryBalance,
} from '@synq/domain';
import { ApprovalCalculator } from './approvals.js';
import {
  AuditRecorder,
  type AuditKind,
  type AuditRecord,
  type AuditSink,
} from './audit.js';
import { IntentCanonicalizer, artifactHash, type Hash } from './canonical.js';
import {
  DelegationUsage,
  NO_DELEGATIONS,
  type DelegationEvaluator,
  type MembershipDirectory,
} from './delegation.js';
import { KernelError, asKernelError, parseAs, requireRule } from './errors.js';
import { FreshnessGate, type FreshnessConfig } from './freshness.js';
import { GrantIssuer, GrantVerifier } from './grants.js';
import {
  Ledger,
  nativeAssetFor,
  type Budget,
  type ChainUsageObservation,
  type GrantClaim,
} from './ledger.js';
import { ActionLifecycles, plannedPath } from './lifecycle.js';
import { MandateResolver, onchainMandateId } from './mandates.js';
import { PolicyEngine } from './policy.js';
import {
  RequestSchema,
  refusalDecision,
  refusalPayload,
  type AuthorizationDecision,
  type Clock,
  type DecisionContext,
  type PendingDecision,
  type RejectedDecision,
  type TrustedEvidence,
} from './decisions.js';
import { readNonceStatus, type NonceStatusReader } from './nonce-status.js';
import { RiskGate, SimulationGate } from './risk.js';
import {
  restoreState,
  snapshotState,
  stateHash,
  type KernelSnapshot,
} from './snapshot.js';

export type KernelDependencies = {
  clock: Clock;
  approvalLedger: ApprovalLedger;
  membershipDirectory: MembershipDirectory;
  delegations?: DelegationEvaluator;
  nonceStatus?: NonceStatusReader;
  freshness: FreshnessConfig;
  plugins: readonly unknown[];
  auditSink?: AuditSink;
  auditKey?: Uint8Array;
};
export type KernelOptions = KernelDependencies & {
  network: NetworkProfile;
  executionModule: `0x${string}`;
  mandates: readonly unknown[];
  balances?: readonly TreasuryBalance[];
  balanceBlock?: string;
  trustedEvidence?: TrustedEvidence;
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
  private readonly nonceStatus: NonceStatusReader | undefined;
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
    this.nonceStatus = options.nonceStatus;
    this.freshness = new FreshnessGate(options.freshness);
    requireRule(
      this.network.profile === 'local/anvil' || options.auditKey !== undefined,
      'AUDIT_UNAVAILABLE',
    );
    this.audit = new AuditRecorder(options.auditSink, options.auditKey);
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

  private commit<T>(
    kind: AuditKind,
    now: number,
    apply: () => { result: T; payload: unknown },
  ): { result: T; audit: AuditRecord } {
    const saved = {
      ledger: this.ledger.clone(),
      lifecycles: this.lifecycles.clone(),
      usage: this.delegationUsage.clone(),
      mandates: this.mandates.clone(),
      claimSequence: this.claimSequence,
    };
    try {
      const { result, payload } = apply();
      return { result, audit: this.audit.append(kind, payload, now) };
    } catch (error) {
      this.ledger = saved.ledger;
      this.lifecycles = saved.lifecycles;
      this.delegationUsage = saved.usage;
      this.mandates = saved.mandates;
      this.claimSequence = saved.claimSequence;
      throw error;
    }
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
    const ctx: DecisionContext = {};
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
      requireRule(
        !this.ledger.intentUsedOnChain(canonical.intentHash),
        'NONCE_REPLAY',
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
        accountThreshold: mandate.approvalPolicy.accountThreshold,
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
        accountOwners: freshness.owners,
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
      const { result: transitions, audit } = this.commit(
        'AUTHORIZATION',
        now,
        () => {
          this.ledger.reserve(grant, now);
          for (const use of outcome.delegated)
            this.delegationUsage.record(use.policyId, {
              amount: intent.maxInputAmount,
              at: now,
            });
          const advanced = this.lifecycles.advance(
            canonical.intentId,
            plannedPath(this.lifecycles.state(canonical.intentId), {
              kind: 'AUTHORIZED',
              viaApproval: required > 0,
            }),
            artifactHash(policy),
            now,
          );
          return {
            result: advanced,
            payload: {
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
              freshness: {
                mode: freshness.mode,
                lagBlocks: freshness.lagBlocks,
              },
              transitions: advanced.map((t) => t.to),
            },
          };
        },
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
    ctx: DecisionContext,
    error: KernelError,
    now: number,
  ): PendingDecision | RejectedDecision {
    const code = error.code;
    const canonical = ctx.canonical;
    let transitions: TransitionRecord<ActionState>[] = [];
    let audit: AuditRecord | null = null;
    try {
      ({ result: transitions, audit } = this.commit(
        'AUTHORIZATION',
        now,
        () => {
          const advanced =
            canonical && code !== 'CLOCK_REGRESSION'
              ? this.lifecycles.advance(
                  canonical.intentId,
                  plannedPath(this.lifecycles.state(canonical.intentId), {
                    kind: 'FAILED',
                    code,
                  }),
                  artifactHash({ code, policy: ctx.policy ?? null }),
                  now,
                )
              : [];
          return {
            result: advanced,
            payload: refusalPayload(ctx, error, advanced),
          };
        },
      ));
    } catch {
      transitions = [];
      audit = null;
    }
    return refusalDecision(ctx, error, {
      state: canonical ? this.lifecycles.state(canonical.intentId) : null,
      transitions,
      audit,
    });
  }

  /** Reads durable authorization evidence without issuing another grant or reservation. */
  recoverAuthorization(request: {
    intent: unknown;
    risk: unknown;
    simulation: unknown;
  }): import('./decisions.js').AuthorizationRecovery {
    try {
      const canonical = this.canonicalizer.canonicalize(request.intent);
      const hash = canonical.intentHash;
      const saved = this.state([]);
      const issued = structuredClone(
        [...this.ledger.grants.values()].find(
          (r) => r.grant.intentHash === hash,
        ),
      );
      const audit = [...this.audit.records()]
        .reverse()
        .find(
          (a) =>
            a.kind === 'AUTHORIZATION' &&
            (a.payload as { intentHash?: string }).intentHash === hash,
        );
      const history = this.lifecycles.history(canonical.intentId);
      if (issued) {
        if (
          issued.grant.simulationHash !== artifactHash(request.simulation) ||
          issued.grant.riskPacketHash !== artifactHash(request.risk)
        )
          return { status: 'UNKNOWN' };
        return {
          status: 'RECOVERED',
          decision: {
            status: 'AUTHORIZED',
            intentId: canonical.intentId,
            intentHash: hash,
            state: history.at(-1)?.to ?? null,
            tier: issued.grant.tier,
            policy: null,
            requiredApprovals: issued.grant.requiredApprovals,
            draft: issued.grant.draft,
            grant: issued.grant,
            transitions: [],
            audit: audit
              ? { sequence: audit.sequence, hash: audit.hash }
              : null,
          },
        };
      }
      if (!audit)
        return { status: history.length === 0 ? 'ABSENT' : 'UNKNOWN' };
      const payload = audit.payload as unknown as {
        status: AuthorizationDecision['status'];
        code: import('./errors.js').Failure;
        tier: import('@synq/schemas').Tier | null;
        policy: import('./policy.js').PolicyResult | null;
        draftDigest: string | null;
        issues: import('./errors.js').Issue[];
      };
      const common = {
        intentId: canonical.intentId,
        intentHash: hash,
        state: history.at(-1)?.to ?? null,
        tier: payload.tier,
        policy: payload.policy,
        transitions: [],
        audit: { sequence: audit.sequence, hash: audit.hash },
        code: payload.code,
        issues: payload.issues,
      };
      if (payload.status === 'PENDING_APPROVAL') {
        const mandate = saved.mandates
          .flatMap((m) => m.versions)
          .find(
            (m) =>
              m.groupId === canonical.intent.groupId &&
              m.mandateId === canonical.intent.mandateId &&
              m.version === canonical.intent.mandateVersion,
          );
        const manifest = this.plugins.get(canonical.intent.pluginId);
        if (!mandate || !manifest || !payload.policy || !payload.draftDigest)
          return { status: 'UNKNOWN' };
        const required = Math.max(
          payload.policy.requiredApprovals,
          mandate.approvalPolicy.accountThreshold,
        );
        const draft = this.issuer.draft({
          canonical,
          mandate: MandateSchema.parse(mandate),
          network: this.network,
          executionModule: this.executionModule,
          manifest,
          risk: RiskPacketSchema.parse(request.risk),
          simulation: SimulationSchema.parse(request.simulation),
          requiredApprovals: required,
        });
        if (draft.digest !== payload.draftDigest) return { status: 'UNKNOWN' };
        return {
          status: 'RECOVERED',
          decision: {
            ...common,
            status: 'PENDING_APPROVAL',
            draft,
            requiredApprovals: required,
            countedApprovals: 0,
            rejectedApprovals: [],
          },
        };
      }
      if (
        payload.status === 'POLICY_REJECTED' ||
        payload.status === 'RISK_REJECTED' ||
        payload.status === 'EXPIRED'
      )
        return {
          status: 'RECOVERED',
          decision: { ...common, status: payload.status },
        };
      return { status: 'UNKNOWN' };
    } catch {
      return { status: 'UNKNOWN' };
    }
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
    return this.commit('CLAIM', now, () => {
      const claim = this.ledger.claim(
        verified.grantId,
        workerId,
        now,
        this.claimSequence++,
      );
      return { result: claim, payload: claim };
    }).result;
  }
  prepare(claim: GrantClaim, preparedCallHash: Hash): ExecutionGrant {
    const now = this.tick();
    const record = this.ledger.record(claim.grantId);
    this.mandates.assertGrantable(
      record.grant.groupId,
      record.grant.mandateId,
      record.grant.mandateVersion,
    );
    return this.commit('PREPARE', now, () => {
      const grant = this.ledger.prepare(claim, preparedCallHash, now);
      const transitions = this.lifecycles.advance(
        grant.intentId,
        ['PREPARED'],
        preparedCallHash,
        now,
      );
      return {
        result: grant,
        payload: {
          grantId: grant.grantId,
          claimId: claim.claimId,
          preparedCallHash,
          transitions: transitions.map((t) => t.to),
        },
      };
    }).result;
  }
  recordSubmission(claim: GrantClaim, transactionHash: Hash): void {
    const now = this.tick();
    this.commit('PREPARE', now, () => {
      this.ledger.recordSubmission(claim, transactionHash);
      return {
        result: undefined,
        payload: { grantId: claim.grantId, transactionHash },
      };
    });
  }
  reconcile(grantId: string, observation: unknown) {
    const now = this.tick();
    return this.commit('RECONCILE', now, () => {
      const record = this.ledger.reconcile(grantId, observation);
      return {
        result: record,
        payload: {
          grantId,
          state: record.state,
          execution: record.execution,
        },
      };
    }).result;
  }
  async releaseUnexecuted(grantId: string): Promise<void> {
    const now = this.tick();
    const status = await readNonceStatus(
      this.nonceStatus,
      this.ledger.record(grantId).grant,
    );
    requireRule(status !== null, 'RECONCILIATION_INVALID');
    this.commit('RELEASE', now, () => ({
      result: this.ledger.release(grantId, status),
      payload: { grantId, status, reason: 'UNEXECUTED' },
    }));
  }
  async releaseExpired(): Promise<number> {
    const now = this.tick();
    let released = 0;
    for (const grant of this.ledger.expiredOutstanding(now)) {
      const status = await readNonceStatus(this.nonceStatus, grant);
      if (!status || !this.ledger.releasable(grant.grantId, status)) continue;
      this.commit('RELEASE', now, () => {
        const freed = this.ledger.release(grant.grantId, status);
        if (this.lifecycles.state(grant.intentId) === 'AUTHORIZED')
          this.lifecycles.advance(
            grant.intentId,
            ['EXPIRED'],
            grant.grantId,
            now,
          );
        return {
          result: freed,
          payload: { grantId: grant.grantId, status, reason: 'EXPIRED' },
        };
      });
      released++;
    }
    return released;
  }
  observeBalance(balance: TreasuryBalance, blockNumber: string): void {
    const parsed = parseAs(TreasuryBalanceSchema, balance, 'INVALID_REQUEST');
    requireRule(/^(0|[1-9][0-9]*)$/.test(blockNumber), 'INVALID_REQUEST');
    this.ledger.observeBalance(parsed, blockNumber);
  }

  observeChainUsage(usage: ChainUsageObservation): void {
    const now = this.tick();
    requireRule(
      Number.isSafeInteger(usage.executed) &&
        usage.executed >= 0 &&
        /^(0|[1-9][0-9]*)$/.test(usage.spentToken) &&
        /^(0|[1-9][0-9]*)$/.test(usage.spentNative) &&
        usage.nonces.every((n) => /^(0|[1-9][0-9]*)$/.test(n)) &&
        usage.intentHashes.every((h) => /^0x[0-9a-fA-F]{64}$/.test(h)),
      'INVALID_REQUEST',
    );
    this.mandates.current(usage.groupId, usage.mandateId);
    this.ledger.observeChainUsage(usage, now);
  }

  configureMandate(mandate: unknown): Mandate {
    const now = this.tick();
    return this.commit('GOVERNANCE', now, () => {
      const configured = this.mandates.configure(mandate);
      return {
        result: configured,
        payload: { action: 'CONFIGURE', mandateHash: artifactHash(configured) },
      };
    }).result;
  }
  supersedeMandate(
    mandate: unknown,
    options: { securitySensitive: boolean },
  ): Mandate {
    const now = this.tick();
    return this.commit('GOVERNANCE', now, () => {
      const next = this.mandates.supersede(mandate, options);
      return {
        result: next,
        payload: {
          action: 'SUPERSEDE',
          mandateHash: artifactHash(next),
          securitySensitive: options.securitySensitive,
        },
      };
    }).result;
  }
  revokeMandate(groupId: string, mandateId: string): Mandate {
    const now = this.tick();
    return this.commit('GOVERNANCE', now, () => ({
      result: this.mandates.revoke(groupId, mandateId),
      payload: { action: 'REVOKE', groupId, mandateId },
    })).result;
  }
  listMandates(): Mandate[] {
    return this.mandates.values();
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

  private state(audit: AuditRecord[]): KernelSnapshot {
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
      audit,
    });
  }
  snapshot(): KernelSnapshot {
    const now = this.tick();
    this.audit.append(
      'SNAPSHOT',
      { stateHash: stateHash(this.state([])) },
      now,
    );
    return this.state(this.audit.records());
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
    kernel.audit = AuditRecorder.restore(
      state.audit,
      dependencies.auditSink,
      dependencies.auditKey,
    );
    kernel.lastNow = state.lastNow;
    kernel.claimSequence = state.claimSequence;
    return kernel;
  }
}
