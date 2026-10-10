import { encodeFunctionData, keccak256, type PublicClient } from 'viem';
import {
  BrainActionProposalSchema,
  BrainMandateProposalSchema,
  MandateSchema,
  MarketQuoteSchema,
  NetworkProfileSchema,
  RiskStateSchema,
  type NetworkProfile,
  ProposalDecisionSchema,
  PublicApprovalSchema,
  evidenceArtifactHash,
  type BoundActionIntent,
  type BrainActionProposal,
  type BrainMandateProposal,
  type ExecutionMode,
  type GrantDraft,
  type Mandate,
  type MarketQuote,
  type ProposalDecision,
  type RiskPacket,
  type Simulation,
} from '@synq/schemas';
import {
  KernelError,
  MandateResolver,
  artifactHash,
  economicIntentHash,
  intentHash,
  narrowedFields,
  type AuthorizationDecision,
  type Clock,
  type Kernel,
} from '@synq/kernel';
import type { IdentityStore, PgPoolLike } from '@synq/identity';
import type {
  DraftSummary,
  IdentityDirectoryReader,
  IdentityGroupView,
  MarketDataSource,
  RiskStateSource,
} from '@synq/world-model';

export type ProposalPortLike = {
  readonly executionMode: ExecutionMode;
  proposeAction(proposal: BrainActionProposal): Promise<ProposalDecision>;
  proposeMandate(proposal: BrainMandateProposal): Promise<ProposalDecision>;
};

export interface SimulationSource {
  simulate(intent: BoundActionIntent): Promise<Simulation>;
}
export interface KernelAuthorizer {
  authorize(request: unknown): Promise<AuthorizationDecision>;
  attestEvidence: Kernel['attestEvidence'];
  listMandates(): Mandate[];
}

export type GatewayOptions = {
  kernel: KernelAuthorizer;
  market: MarketDataSource;
  risk?: RiskStateSource;
  network: NetworkProfile;
  mainnetBroadcastAllowed?: boolean;
  simulations: SimulationSource;
  clock: Clock;
  executionMode?: ExecutionMode;
  onPendingDraft?: (draft: GrantDraft) => Promise<void>;
};

/**
 * The only path from a Brain proposal to the Kernel. Risk evidence is built
 * here from the trusted market source, never from model output, and no
 * approvals are ever forwarded.
 */
export class KernelProposalGateway implements ProposalPortLike {
  readonly executionMode: ExecutionMode;
  private readonly simulate: SimulationSource['simulate'];
  constructor(private readonly options: GatewayOptions) {
    const registered = simulationSources.get(options.simulations);
    if (!registered)
      throw new KernelError('INVALID_REQUEST', [
        { path: 'simulations', message: 'unregistered simulation source' },
      ]);
    this.options = {
      ...options,
      network: Object.freeze(NetworkProfileSchema.parse(options.network)),
    };
    if (
      registered.declared &&
      options.network.profile === 'proof/monad-mainnet'
    )
      throw new KernelError('INVALID_REQUEST', [
        {
          path: 'simulations',
          message: 'declared outcomes cannot attest mainnet simulation',
        },
      ]);
    this.simulate = registered.simulate;
    this.executionMode =
      options.network.profile === 'proof/monad-mainnet'
        ? options.mainnetBroadcastAllowed
          ? 'CANARY_READY'
          : 'MAINNET_SIMULATION'
        : options.network.profile === 'local/anvil' || registered.declared
          ? 'SIMULATION'
          : 'REAL_TESTNET';
    if (
      options.executionMode !== undefined &&
      options.executionMode !== this.executionMode
    )
      throw new KernelError('INVALID_REQUEST', [
        {
          path: 'executionMode',
          message: 'mode does not match trusted network and simulation source',
        },
      ]);
  }

  private decision(
    proposalId: string,
    kind: 'ACTION' | 'MANDATE',
    status: ProposalDecision['status'],
    code: string | null,
    extra: Partial<ProposalDecision> = {},
  ): ProposalDecision {
    return ProposalDecisionSchema.parse({
      proposalId,
      kind,
      status,
      code,
      intentId: null,
      draftDigest: null,
      riskPacketHash: null,
      evidenceHash: null,
      mandateHash: null,
      narrowedFields: [],
      executionMode: this.executionMode,
      ...extra,
    });
  }

  async proposeAction(raw: BrainActionProposal): Promise<ProposalDecision> {
    const parsed = BrainActionProposalSchema.safeParse(raw);
    if (!parsed.success)
      return this.decision(
        typeof raw?.proposalId === 'string' ? raw.proposalId : 'invalid',
        'ACTION',
        'REJECTED',
        'INVALID_PROPOSAL',
      );
    const p = parsed.data;
    if (p.evidenceArtifact.executionMode !== this.executionMode)
      return this.decision(
        p.proposalId,
        p.kind,
        'REJECTED',
        'EXECUTION_MODE_MISMATCH',
      );
    if (
      evidenceArtifactHash(p.evidenceArtifact) !== p.evidenceArtifactHash ||
      p.evidenceArtifact.proposalId !== p.proposalId ||
      p.evidenceArtifact.groupId !== p.intent.groupId ||
      p.groupId !== p.intent.groupId
    )
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'EVIDENCE_MISMATCH',
      );
    if (p.intent.action !== 'TRANSFER' || p.intent.outputToken !== undefined)
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'PREPARE_REQUIRED',
      );
    const mandate = this.options.kernel
      .listMandates()
      .find(
        (m) =>
          m.groupId === p.intent.groupId && m.mandateId === p.intent.mandateId,
      );
    if (!mandate)
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'MANDATE_NOT_FOUND',
      );
    const network = mandate.network;
    if (
      network.profile !== this.options.network.profile ||
      network.chainId !== this.options.network.chainId ||
      p.intent.chainId !== this.options.network.chainId
    )
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'NETWORK_MISMATCH',
      );
    let quote: MarketQuote | undefined;
    try {
      quote = (await this.options.market.quotes(network)).find(
        (q) => q.pair === `${mandate.inputAsset.symbol}/USD`,
      );
    } catch {
      quote = undefined;
    }
    if (!quote)
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'NO_TRUSTED_MARKET_DATA',
      );
    const now = this.options.clock.now();
    const parsedQuote = MarketQuoteSchema.safeParse(quote);
    if (
      !parsedQuote.success ||
      quote.chainId !== network.chainId ||
      quote.observedAt > now
    )
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'STALE_MARKET_DATA',
      );
    let riskObservation;
    try {
      riskObservation = await this.options.risk?.current(p.groupId);
    } catch {
      riskObservation = undefined;
    }
    const state = RiskStateSchema.safeParse(riskObservation?.state);
    if (
      !riskObservation ||
      !state.success ||
      state.data.status !== 'HEALTHY' ||
      state.data.referenceDeviationBps === null ||
      !Number.isFinite(riskObservation.observedAt) ||
      !Number.isFinite(riskObservation.maxAgeSeconds) ||
      riskObservation.maxAgeSeconds <= 0 ||
      riskObservation.observedAt > now ||
      now - riskObservation.observedAt > riskObservation.maxAgeSeconds
    )
      return this.decision(
        p.proposalId,
        'ACTION',
        'RISK_REJECTED',
        'RISK_UNKNOWN_OR_STALE',
      );
    const evidence = [
      {
        source: 'trusted-risk-state',
        retrievedAt: riskObservation.observedAt,
        chainId: network.chainId,
        artifactHash: artifactHash(riskObservation),
        untrusted: false,
      },
      {
        source: quote.source,
        retrievedAt: quote.observedAt,
        chainId: network.chainId,
        artifactHash: artifactHash(quote),
        untrusted: false,
      },
      {
        source: 'synq-brain-evidence-artifact',
        retrievedAt: p.evidenceArtifact.createdAt,
        chainId: network.chainId,
        artifactHash: p.evidenceArtifactHash,
        untrusted: false,
      },
    ];
    const risk: RiskPacket = {
      schemaVersion: 1,
      intentHash: economicIntentHash(p.intent),
      evaluatedAt: now,
      quoteAt: quote.observedAt,
      quoteExpiresAt: quote.observedAt + quote.maxAgeSeconds,
      slippageBps: 0,
      referenceDeviationBps: state.data.referenceDeviationBps,
      maxReferenceDeviationBps: mandate.maxReferenceDeviationBps,
      blocked:
        state.data.referenceDeviationBps > mandate.maxReferenceDeviationBps,
      evidence,
    };
    const intent: BoundActionIntent = {
      ...p.intent,
      evidenceHash: artifactHash(risk.evidence),
      riskPacketHash: artifactHash(risk),
    };
    let simulation: Simulation;
    try {
      simulation = await this.simulate(intent);
    } catch {
      return this.decision(
        p.proposalId,
        'ACTION',
        'REJECTED',
        'SIMULATION_UNAVAILABLE',
        {
          riskPacketHash: intent.riskPacketHash,
          evidenceHash: intent.evidenceHash,
        },
      );
    }
    this.options.kernel.attestEvidence({
      riskPacketHashes: [artifactHash(risk)],
      simulationHashes: [artifactHash(simulation)],
    });
    const decision = await this.options.kernel.authorize({
      intent,
      risk,
      simulation,
      approvals: [],
    });
    const draft =
      decision.status === 'AUTHORIZED'
        ? decision.draft
        : decision.status === 'PENDING_APPROVAL'
          ? decision.draft
          : null;
    if (
      decision.status === 'PENDING_APPROVAL' &&
      draft &&
      this.options.onPendingDraft
    )
      await this.options.onPendingDraft(draft);
    return this.decision(
      p.proposalId,
      'ACTION',
      decision.status,
      decision.status === 'AUTHORIZED' ? null : decision.code,
      {
        intentId: decision.intentId,
        draftDigest: draft?.digest ?? null,
        riskPacketHash: intent.riskPacketHash,
        evidenceHash: intent.evidenceHash,
      },
    );
  }

  async proposeMandate(raw: BrainMandateProposal): Promise<ProposalDecision> {
    const parsed = BrainMandateProposalSchema.safeParse(raw);
    if (!parsed.success)
      return this.decision(
        'invalid',
        'MANDATE',
        'REJECTED',
        'INVALID_PROPOSAL',
      );
    const p = parsed.data;
    if (p.evidenceArtifact.executionMode !== this.executionMode)
      return this.decision(
        p.proposalId,
        p.kind,
        'REJECTED',
        'EXECUTION_MODE_MISMATCH',
      );
    if (
      evidenceArtifactHash(p.evidenceArtifact) !== p.evidenceArtifactHash ||
      p.evidenceArtifact.proposalId !== p.proposalId
    )
      return this.decision(
        p.proposalId,
        'MANDATE',
        'REJECTED',
        'EVIDENCE_MISMATCH',
      );
    const mandate = MandateSchema.safeParse(p.mandate);
    if (!mandate.success || mandate.data.groupId !== p.groupId)
      return this.decision(
        p.proposalId,
        'MANDATE',
        'REJECTED',
        'INVALID_MANDATE',
      );
    const next = mandate.data;
    if (
      next.network.profile !== this.options.network.profile ||
      next.network.chainId !== this.options.network.chainId
    )
      return this.decision(
        p.proposalId,
        'MANDATE',
        'REJECTED',
        'NETWORK_MISMATCH',
      );
    const mandateHash = artifactHash(next);
    const current = this.options.kernel
      .listMandates()
      .find(
        (m) => m.groupId === next.groupId && m.mandateId === next.mandateId,
      );
    try {
      if (p.change === 'NEW') {
        if (current)
          return this.decision(
            p.proposalId,
            'MANDATE',
            'REJECTED',
            'MANDATE_CONFLICT',
            {
              mandateHash,
            },
          );
        new MandateResolver().configure(next);
        return this.decision(
          p.proposalId,
          'MANDATE',
          'REQUIRES_HUMAN_APPROVAL',
          'NEW_MANDATE',
          {
            mandateHash,
          },
        );
      }
      if (!current)
        return this.decision(
          p.proposalId,
          'MANDATE',
          'REJECTED',
          'MANDATE_NOT_FOUND',
          {
            mandateHash,
          },
        );
      const narrowed = narrowedFields(current, next);
      new MandateResolver([current]).supersede(next, {
        securitySensitive: narrowed.length > 0,
      });
      return this.decision(
        p.proposalId,
        'MANDATE',
        'REQUIRES_HUMAN_APPROVAL',
        narrowed.length ? 'SECURITY_SENSITIVE_SUPERSEDE' : 'WIDENING_SUPERSEDE',
        { mandateHash, narrowedFields: narrowed },
      );
    } catch (error) {
      return this.decision(
        p.proposalId,
        'MANDATE',
        'REJECTED',
        error instanceof KernelError ? error.code : 'INVALID_MANDATE',
        { mandateHash },
      );
    }
  }
}

const simulationSources = new WeakMap<
  SimulationSource,
  { declared: boolean; simulate: SimulationSource['simulate'] }
>();

export class DeclaredSimulation implements SimulationSource {
  constructor(clock: Clock, label: string) {
    const simulate = async (
      intent: BoundActionIntent,
    ): Promise<Simulation> => ({
      intentHash: intentHash(intent),
      calldataHash: intent.calldataHash,
      chainId: intent.chainId,
      account: intent.account,
      target: intent.target,
      succeeded: true,
      simulatedAt: clock.now(),
      blockNumber: '0',
      artifactHash: artifactHash({
        simulator: label,
        intent: intentHash(intent),
      }),
    });
    simulationSources.set(this, { declared: true, simulate });
  }
  simulate(intent: BoundActionIntent): Promise<Simulation> {
    return simulationSources.get(this)!.simulate(intent);
  }
}

export class ChainSimulation implements SimulationSource {
  constructor(client: PublicClient, clock: Clock, network: NetworkProfile) {
    const simulate = async (intent: BoundActionIntent): Promise<Simulation> => {
      if (
        intent.chainId !== network.chainId ||
        (await client.getChainId()) !== network.chainId
      )
        throw new Error('SIMULATION_CHAIN_MISMATCH');
      const blockNumber = await client.getBlockNumber();
      if (intent.action !== 'TRANSFER')
        throw new Error('SIMULATION_PREPARE_REQUIRED');
      const data = encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'transfer',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ],
        functionName: 'transfer',
        args: [
          intent.recipient as `0x${string}`,
          BigInt(intent.maxInputAmount),
        ],
      });
      if (
        keccak256(data) !== intent.calldataHash ||
        data.slice(0, 10) !== intent.selector
      )
        throw new Error('SIMULATION_CALLDATA_MISMATCH');
      const response = await client.call({
        account: intent.account as `0x${string}`,
        to: intent.target as `0x${string}`,
        data,
        value: BigInt(intent.nativeValue),
        blockNumber,
      });
      return {
        intentHash: intentHash(intent),
        calldataHash: intent.calldataHash,
        chainId: intent.chainId,
        account: intent.account,
        target: intent.target,
        succeeded: response.data === `0x${'0'.repeat(63)}1`,
        simulatedAt: clock.now(),
        blockNumber: blockNumber.toString(),
        artifactHash: artifactHash({
          source: 'eth_call',
          blockNumber: blockNumber.toString(),
          response: response.data ?? '0x',
        }),
      };
    };
    simulationSources.set(this, { declared: false, simulate });
  }
  simulate(intent: BoundActionIntent): Promise<Simulation> {
    return simulationSources.get(this)!.simulate(intent);
  }
}

export class StoreIdentityDirectoryReader implements IdentityDirectoryReader {
  constructor(
    private readonly store: IdentityStore,
    private readonly pool?: PgPoolLike,
  ) {}
  async group(groupId: string): Promise<IdentityGroupView | null> {
    return this.store.transaction(async (tx) => {
      const group = await tx.getGroup(groupId);
      if (!group) return null;
      const memberships = await tx.listMemberships(groupId);
      return {
        groupId: group.groupId,
        chainGroupId: group.chainGroupId,
        chainId: group.chainId,
        account: group.account,
        owners: group.owners,
        threshold: group.threshold,
        membershipEpoch: group.membershipEpoch,
        memberships: memberships.map((m) => ({
          memberId: m.memberId,
          principalId: m.principalId,
          principalKind: m.principalKind,
          role: m.role,
          signer: m.signer,
          status: m.status,
        })),
      };
    });
  }
  private async rows(sql: string, values: unknown[]) {
    if (!this.pool) return [];
    const client = await this.pool.connect();
    try {
      return (await client.query(sql, values)).rows;
    } finally {
      client.release();
    }
  }
  async drafts(groupId: string): Promise<DraftSummary[]> {
    const rows = await this.rows(
      'SELECT draft_digest, intent_hash, status, created_at FROM identity_grant_draft WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50',
      [groupId],
    );
    return rows.map((r) => ({
      draftDigest: String(r.draft_digest),
      intentHash: String(r.intent_hash),
      status: r.status === 'INVALIDATED' ? 'INVALIDATED' : 'PENDING',
      createdAt: Number(r.created_at),
    }));
  }
  async approvals(groupId: string) {
    const rows = await this.rows(
      'SELECT a.approval_json FROM identity_verified_approval a JOIN identity_grant_draft d ON d.draft_digest=a.draft_digest WHERE d.group_id=$1 ORDER BY a.verified_at, a.approval_id LIMIT 200',
      [groupId],
    );
    return rows.map((r) => {
      const { signature: _signature, ...rest } = r.approval_json as Record<
        string,
        unknown
      >;
      return PublicApprovalSchema.parse(rest);
    });
  }
}
