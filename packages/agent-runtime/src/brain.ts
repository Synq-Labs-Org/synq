import {
  EvidenceArtifactSchema,
  ProposalIdSchema,
  canonicalArtifactHash,
  evidenceArtifactHash,
  type AgentFinding,
  type Contradiction,
  type CriticResult,
  type EvidenceArtifact,
  type ExecutionMode,
  type FieldFreshness,
  type ModelCallRecord,
  type ModelRole,
  type ProposalDecision,
  type RunCosts,
  type UntrustedEvidence,
  type WorldModelSnapshot,
} from '@synq/schemas';
import { worstFreshness } from '@synq/world-model';
import { MastraRoleHarness } from './mastra.js';
import {
  CriticOutputSchema,
  IntentOutputSchema,
  ResearchOutputSchema,
  jsonSchemaOf,
  strictParse,
  type CriticOutput,
  type IntentItem,
  type ResearchOutput,
  type StrictParse,
} from './pipeline/model-output.js';
import {
  SemanticValidator,
  type Normalized,
  type ValidationIssue,
} from './pipeline/validator.js';
import { SpanRecorder } from './observability.js';
import {
  ReasonerError,
  type CriticReasoner,
  type PaidToolBudget,
  type ProposalPort,
  type ReasonerResult,
  type ResearchReasoner,
  type ResearchResult,
  type StructuredReasoner,
} from './ports.js';
import { ROLE_SPECS, ROOT_CAPABILITIES } from './roles.js';
import {
  AgentRuntimeError,
  DEFAULT_BUDGET,
  SubagentManager,
  type AgentHandle,
  type BudgetLimits,
} from './subagents.js';
import { renderUntrusted, wrapUntrusted } from './untrusted.js';

export type MemberMessage = { memberId: string; text: string };
export type ExternalContent = {
  kind: UntrustedEvidence['kind'];
  origin: string;
  content: string;
};
export type BrainRunInput = {
  runId: string;
  groupId: string;
  world: WorldModelSnapshot;
  messages: readonly MemberMessage[];
  external?: readonly ExternalContent[];
  researchQueries?: readonly string[];
  fixtureKey: string;
  signal?: AbortSignal;
};
export type BrainDependencies = {
  structured: StructuredReasoner;
  research?: ResearchReasoner;
  critic?: CriticReasoner;
  proposals: ProposalPort;
  executionMode: ExecutionMode;
  limits?: Partial<BudgetLimits>;
  uncertaintyThreshold?: number;
  nowSeconds?: () => number;
  clockMs?: () => number;
  spanSink?: ConstructorParameters<typeof SpanRecorder>[2];
};
export type ItemOutcome = {
  proposalId: string;
  kind: IntentItem['kind'];
  status: 'SUBMITTED' | 'ESCALATED' | 'REJECTED';
  issues: ValidationIssue[];
  normalized: Normalized | null;
  decision: ProposalDecision | null;
  evidenceArtifact: EvidenceArtifact;
  evidenceArtifactHash: `0x${string}`;
};
export type BrainRunResult = {
  runId: string;
  executionMode: ExecutionMode;
  status: 'COMPLETED' | 'ESCALATED' | 'FAILED';
  items: ItemOutcome[];
  findings: AgentFinding[];
  costs: RunCosts;
  modelCalls: ModelCallRecord[];
  spans: SpanRecorder['spans'];
  research: ResearchOutput | null;
  critic: CriticResult;
  roles: ModelRole[];
};

const CALL_TOKEN_RESERVATION = 8_000;
const RISKY_SIGNALS = new Set([
  'IGNORE_INSTRUCTIONS',
  'SEND_FUNDS',
  'SYSTEM_PROMPT',
  'SECRET_PROBE',
  'TOOL_COERCION',
]);
const risky = (signals: readonly string[]) =>
  signals.filter((s) => RISKY_SIGNALS.has(s));
const BLOCKING_FINDINGS = new Set<AgentFinding['kind']>([
  'BUDGET_EXCEEDED',
  'FORBIDDEN_TOOL_CALL',
  'CAPABILITY_ESCALATION',
  'SPAWN_LOOP',
  'SPAWN_DEPTH_EXCEEDED',
  'CONCURRENCY_EXCEEDED',
  'PROMPT_INJECTION_SUSPECTED',
  'CANCELLED',
]);
const PARSE_FAILURE: AgentFinding['kind'] = 'VALIDATION_REJECTED';

function worldBrief(world: WorldModelSnapshot) {
  const network = world.network.value.profile;
  return {
    network,
    chainId: world.network.value.chainId,
    group: world.group.value
      ? {
          account: world.group.value.account,
          threshold: world.group.value.threshold,
        }
      : null,
    members: world.members.value.map((m) => ({
      memberId: m.memberId,
      role: m.role,
      signer: m.signer,
    })),
    mandates: world.mandates.value.map((m) => ({
      mandateId: m.mandateId,
      version: m.version,
      status: m.status,
      inputAsset: m.inputAsset,
      perActionCap: m.perActionCap,
      cumulativeBudget: m.cumulativeBudget,
      spentToken: m.spentToken,
      recipients: m.recipients,
      plugins: m.pluginIds,
    })),
    treasury: world.treasury.value,
    capabilities: world.capabilities.value.nodes.map((n) => ({
      providerId: n.providerId,
      status: n.status,
      actions: n.facts.map((f) => `${f.action}@${f.networks.join('|')}`),
    })),
    freshness: world.sourceFreshness.map((s) => `${s.source}:${s.freshness}`),
  };
}

export class SynqBrain {
  constructor(private readonly deps: BrainDependencies) {}

  async run(input: BrainRunInput): Promise<BrainRunResult> {
    const deps = this.deps;
    const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    const clock = deps.clockMs ?? Date.now;
    const started = clock();
    const now = nowSeconds();
    const manager = new SubagentManager(
      input.runId,
      ROOT_CAPABILITIES,
      { ...DEFAULT_BUDGET, ...deps.limits },
      clock,
      nowSeconds,
      input.signal,
    );
    const spans = new SpanRecorder(input.runId, clock, deps.spanSink);
    const harness = new MastraRoleHarness();
    const modelCalls: ModelCallRecord[] = [];
    const roles = new Set<ModelRole>(['SUPERVISOR']);
    let externalCalls = 0;
    let paidToolCalls = 0;
    const root = manager.rootHandle;

    const evidence: UntrustedEvidence[] = [];
    const memberIds = new Set(input.world.members.value.map((m) => m.memberId));
    input.messages.forEach((m, i) => {
      const known = memberIds.has(m.memberId);
      const wrapped = wrapUntrusted({
        evidenceId: `${input.runId}.msg.${i}`,
        kind: 'MEMBER_MESSAGE',
        origin: known ? `member:${m.memberId}` : 'member:unknown',
        retrievedAt: now,
        content: m.text,
      });
      evidence.push(wrapped);
      if (!known)
        manager.finding(
          'MEMBER_POLICY_OVERRIDE',
          'message from a principal that is not an active member',
          root,
          'LOW',
        );
      if (wrapped.injectionSignals.includes('IGNORE_INSTRUCTIONS'))
        manager.finding(
          'MEMBER_POLICY_OVERRIDE',
          `member message asks to bypass policy (${wrapped.injectionSignals.join(',')}); the request carries no authority`,
          root,
          'LOW',
        );
    });
    (input.external ?? []).forEach((c, i) => {
      const wrapped = wrapUntrusted({
        evidenceId: `${input.runId}.ext.${i}`,
        kind: c.kind,
        origin: c.origin,
        retrievedAt: now,
        content: c.content,
      });
      evidence.push(wrapped);
      if (risky(wrapped.injectionSignals).length)
        manager.finding(
          'PROMPT_INJECTION_SUSPECTED',
          `${c.origin}: ${risky(wrapped.injectionSignals).join(',')}`,
          root,
          'MEDIUM',
        );
    });

    const record = (
      handle: AgentHandle,
      result: ReasonerResult | null,
      outcome: ModelCallRecord['outcome'],
      requestHash: `0x${string}`,
    ) => {
      roles.add(handle.role);
      modelCalls.push({
        role: handle.role,
        agentId: handle.agentId,
        provider: result?.provider ?? 'deterministic',
        model: result?.model ?? 'none',
        mode: result?.mode ?? 'NONE',
        fixtureLabel: result?.fixtureLabel ?? null,
        requestHash: result?.requestHash ?? requestHash,
        responseHash: result?.responseHash ?? null,
        inputTokens: result?.inputTokens ?? 0,
        outputTokens: result?.outputTokens ?? 0,
        outcome,
      });
    };

    const brief = JSON.stringify(worldBrief(input.world));
    const untrustedBlock = renderUntrusted(evidence);

    const runRole = async <T>(
      role: ModelRole,
      userMessage: string,
      call: (
        handle: AgentHandle,
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
        signal: AbortSignal | undefined,
      ) => Promise<ReasonerResult>,
      parse: (text: string) => StrictParse<T>,
    ): Promise<{
      value: T | null;
      handle: AgentHandle | null;
      result: ReasonerResult | null;
    }> => {
      let handle: AgentHandle | null = null;
      try {
        handle = manager.spawn(
          root.agentId,
          role,
          ROLE_SPECS[role].capabilities,
        );
        const h = handle;
        return await spans.span(
          `brain.role.${role.toLowerCase()}`,
          { agentId: h.agentId, role },
          { provider: role === 'INTENT' ? 'structured' : role.toLowerCase() },
          async (set) => {
            manager.charge(
              h.agentId,
              { tokens: CALL_TOKEN_RESERVATION, toolCalls: 1 },
              `${role} model call reservation`,
            );
            let result: ReasonerResult | null = null;
            try {
              const run = await harness.run({
                handle: h,
                instructions: ROLE_SPECS[role].instructions,
                userMessage,
                toolAllowlist: ROLE_SPECS[role].tools,
                call: ({ messages, signal }) => call(h, messages, signal),
              });
              result = run.result;
            } catch (error) {
              if (error instanceof AgentRuntimeError) {
                manager.finding(error.kind, error.message, h, 'HIGH');
                record(h, null, 'BLOCKED', canonicalArtifactHash(userMessage));
              } else {
                const code =
                  error instanceof ReasonerError
                    ? error.code
                    : 'PROVIDER_ERROR';
                manager.finding(
                  'PROVIDER_UNAVAILABLE',
                  `${role}: ${code}`,
                  h,
                  'MEDIUM',
                );
                record(
                  h,
                  null,
                  'PROVIDER_ERROR',
                  canonicalArtifactHash(userMessage),
                );
              }
              return { value: null, handle: h, result: null };
            }
            manager.record(h.agentId, {
              tokens:
                result.inputTokens +
                result.outputTokens -
                CALL_TOKEN_RESERVATION,
            });
            set({
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              mode: result.mode,
              fixtureLabel: result.fixtureLabel ?? 'none',
            });
            const parsed = parse(result.text);
            if (!parsed.ok) {
              manager.finding(
                PARSE_FAILURE,
                `${role} output rejected: ${parsed.code} ${parsed.issues.join('; ').slice(0, 300)}`,
                h,
                'MEDIUM',
              );
              record(h, result, 'PARSE_REJECTED', result.requestHash);
              return { value: null, handle: h, result };
            }
            record(h, result, 'OK', result.requestHash);
            return { value: parsed.value, handle: h, result };
          },
        );
      } catch (error) {
        if (error instanceof AgentRuntimeError)
          return { value: null, handle, result: null };
        throw error;
      } finally {
        if (handle) manager.complete(handle.agentId);
      }
    };

    let research: ResearchOutput | null = null;
    let researchEvidence: UntrustedEvidence[] = [];
    if (deps.research && (input.researchQueries?.length ?? 0) > 0) {
      const reasoner = deps.research;
      const out = await runRole(
        'RESEARCH',
        `WORLD:\n${brief}\n\nQUESTION CONTEXT:\n${untrustedBlock}\n\nReturn JSON matching the ResearchOutput schema.`,
        async (h, messages, signal) => {
          const budget: PaidToolBudget = {
            tryCharge: (microUsd, label) => {
              if (!manager.canCharge(h.agentId, { paidMicroUsd: microUsd })) {
                manager.finding(
                  'BUDGET_EXCEEDED',
                  `paid tool ${label} denied: ${microUsd} micro-USD over budget`,
                  h,
                  'MEDIUM',
                );
                return false;
              }
              manager.charge(h.agentId, { paidMicroUsd: microUsd }, label);
              return true;
            },
            chargeToolCall: (label) => {
              if (!manager.canCharge(h.agentId, { toolCalls: 1 })) {
                manager.finding(
                  'BUDGET_EXCEEDED',
                  `${label} tool call denied`,
                  h,
                  'MEDIUM',
                );
                return false;
              }
              manager.charge(h.agentId, { toolCalls: 1 }, label);
              return true;
            },
          };
          const result: ResearchResult = await reasoner.research({
            role: 'RESEARCH',
            agentId: h.agentId,
            fixtureKey: `${input.fixtureKey}:research`,
            messages,
            responseSchema: {
              name: 'ResearchOutput',
              schema: jsonSchemaOf(ResearchOutputSchema),
            },
            maxOutputTokens: 3_000,
            queries: [...(input.researchQueries ?? [])],
            maxResultsPerQuery: 5,
            maxFetches: 2,
            budget,
            ...(signal ? { signal } : {}),
          });
          researchEvidence = result.evidence;
          externalCalls += result.externalCalls;
          paidToolCalls += result.paidToolCalls;
          for (const e of result.evidence)
            if (risky(e.injectionSignals).length)
              manager.finding(
                'PROMPT_INJECTION_SUSPECTED',
                `${e.origin}: ${risky(e.injectionSignals).join(',')}`,
                h,
                'MEDIUM',
              );
          return result;
        },
        (text) => strictParse(ResearchOutputSchema, text),
      );
      research = out.value;
    }
    evidence.push(...researchEvidence);

    const intentPrompt = `WORLD:\n${brief}\n\nRESEARCH SUMMARY (untrusted model output):\n${JSON.stringify(research)}\n\nGROUP CONVERSATION AND EVIDENCE:\n${renderUntrusted(evidence)}\n\nReturn JSON matching the IntentOutput schema.`;
    const intent = await runRole(
      'INTENT',
      intentPrompt,
      (h, messages, signal) =>
        deps.structured.complete({
          role: 'INTENT',
          agentId: h.agentId,
          fixtureKey: `${input.fixtureKey}:intent`,
          messages,
          responseSchema: {
            name: 'IntentOutput',
            schema: jsonSchemaOf(IntentOutputSchema),
          },
          maxOutputTokens: 4_000,
          ...(signal ? { signal } : {}),
        }),
      (text) => strictParse(IntentOutputSchema, text),
    );

    let criticOut: CriticOutput | null = null;
    if (deps.critic && intent.value) {
      const reasoner = deps.critic;
      const out = await runRole(
        'CRITIC',
        `WORLD:\n${brief}\n\nINTENT DRAFTS (untrusted model output):\n${JSON.stringify(intent.value)}\n\nRESEARCH (untrusted):\n${JSON.stringify(research)}\n\n${renderUntrusted(researchEvidence)}\n\nReturn JSON matching the CriticOutput schema.`,
        (h, messages, signal) =>
          reasoner.critique({
            role: 'CRITIC',
            agentId: h.agentId,
            fixtureKey: `${input.fixtureKey}:critic`,
            messages,
            responseSchema: {
              name: 'CriticOutput',
              schema: jsonSchemaOf(CriticOutputSchema),
            },
            maxOutputTokens: 3_000,
            ...(signal ? { signal } : {}),
          }),
        (text) => strictParse(CriticOutputSchema, text),
      );
      criticOut = out.value;
    }
    const critic: CriticResult = criticOut
      ? {
          verdict: criticOut.verdict,
          issues: criticOut.issues,
          uncertainty: criticOut.uncertainty,
        }
      : { verdict: 'NOT_RUN', issues: [], uncertainty: 1 };

    const contradictions: Contradiction[] = (
      criticOut?.disagreements ?? []
    ).map((d) => ({
      topic: d.topic,
      positions: [
        { role: 'INTENT', position: 'as drafted' },
        { role: 'CRITIC', position: d.position },
      ],
      material: criticOut?.verdict === 'OBJECT',
    }));
    if (research && research.recommendation === 'OPPOSE')
      contradictions.push({
        topic: 'research recommendation',
        positions: [
          { role: 'INTENT', position: 'proposes action' },
          { role: 'RESEARCH', position: research.summary.slice(0, 500) },
        ],
        material: true,
      });
    if (contradictions.some((c) => c.material))
      manager.finding(
        'CONTRADICTION',
        `${contradictions.filter((c) => c.material).length} material contradiction(s) between roles`,
        root,
        'MEDIUM',
      );
    const threshold = deps.uncertaintyThreshold ?? 0.35;
    const uncertainties = [
      ...(intent.value?.items ?? []).map((item) => ({
        role: 'INTENT' as const,
        topic: item.kind.toLowerCase(),
        level: item.uncertainty,
        note: item.ambiguities.join('; ').slice(0, 500),
      })),
      ...(research
        ? [
            {
              role: 'RESEARCH' as const,
              topic: 'research',
              level: research.uncertainty,
              note: research.recommendation,
            },
          ]
        : []),
      ...(criticOut
        ? [
            {
              role: 'CRITIC' as const,
              topic: 'critique',
              level: criticOut.uncertainty,
              note: criticOut.verdict,
            },
          ]
        : []),
    ];
    const maxUncertainty = Math.max(0, ...uncertainties.map((u) => u.level));
    const blocking = manager.findings.filter((f) =>
      BLOCKING_FINDINGS.has(f.kind),
    );
    const escalateAll =
      contradictions.some((c) => c.material) ||
      maxUncertainty > threshold ||
      blocking.length > 0;
    if (maxUncertainty > threshold)
      manager.finding(
        'UNCERTAINTY_ESCALATION',
        `uncertainty ${maxUncertainty} exceeds ${threshold}`,
        root,
        'MEDIUM',
      );

    const validator = new SemanticValidator(input.world, now);
    const relevant: FieldFreshness[] = [
      input.world.group.meta.freshness,
      input.world.treasury.meta.freshness,
      input.world.mandates.meta.freshness,
      input.world.marketSnapshots.meta.freshness,
    ];
    const decisiveFreshness = worstFreshness(relevant);
    const items: ItemOutcome[] = [];
    const drafts: IntentItem[] = intent.value?.items ?? [];
    const pending: {
      proposalId: string;
      item: IntentItem | null;
      issues: ValidationIssue[];
      normalized: Normalized | null;
      status: ItemOutcome['status'];
    }[] = drafts.map((item, i) => {
      const proposalId = ProposalIdSchema.parse(`${input.runId}.p${i}`);
      if (item.kind === 'CLARIFICATION' || item.kind === 'NO_ACTION')
        return {
          proposalId,
          item,
          issues: [],
          normalized: null,
          status: 'ESCALATED',
        };
      const validated = validator.validate(item);
      if (!validated.ok) {
        manager.finding(
          'VALIDATION_REJECTED',
          `${proposalId}: ${validated.issues.map((x) => x.code).join(',')}`,
          intent.handle,
          'MEDIUM',
        );
        return {
          proposalId,
          item,
          issues: validated.issues,
          normalized: null,
          status: 'REJECTED',
        };
      }
      return {
        proposalId,
        item,
        issues: [],
        normalized: validated.value,
        status: escalateAll ? 'ESCALATED' : 'SUBMITTED',
      };
    });
    if (pending.length === 0)
      pending.push({
        proposalId: ProposalIdSchema.parse(`${input.runId}.p0`),
        item: null,
        issues: [],
        normalized: null,
        status: 'REJECTED',
      });

    const costs = (): RunCosts => {
      const used = manager.usage();
      const calls = modelCalls.filter((c) => c.mode !== 'NONE');
      return {
        inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
        outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
        modelCalls: calls.length,
        paidToolCalls,
        paidToolMicroUsd: used.paidMicroUsd,
        externalCalls:
          externalCalls + calls.filter((c) => c.mode === 'LIVE').length,
        subagentsSpawned: manager.spawnCount,
        maxDepthReached: manager.depthReached,
        toolCalls: used.toolCalls,
        wallClockMs: Math.max(0, clock() - started),
      };
    };
    const claims = (research?.claims ?? []).map((c, i) => ({
      claimId: `${input.runId}.claim.${i}`,
      role: 'RESEARCH' as const,
      text: c.text,
      evidenceRefs: c.evidenceIds.filter((id) =>
        /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id),
      ),
      derivedFromUntrusted: true,
    }));

    for (const p of pending) {
      const artifact = (outcome: EvidenceArtifact['outcome']) =>
        EvidenceArtifactSchema.parse({
          schemaVersion: 1,
          artifactId: `${p.proposalId}.evidence`,
          runId: input.runId,
          proposalId: p.proposalId,
          groupId: input.groupId,
          snapshotId: input.world.snapshotId,
          createdAt: now,
          executionMode: deps.executionMode,
          sources: input.world.sourceFreshness,
          decisiveFreshness,
          modelCalls,
          roles: [...roles],
          claims,
          uncertainties,
          contradictions,
          critic,
          untrustedEvidence: evidence,
          costs: costs(),
          findings: manager.findings,
          outcome,
        });
      let decision: ProposalDecision | null = null;
      let status = p.status;
      let evidenceArtifact = artifact(
        status === 'SUBMITTED' ? 'PROPOSED' : status,
      );
      let hash = evidenceArtifactHash(evidenceArtifact);
      if (status === 'SUBMITTED' && p.normalized) {
        const normalized = p.normalized;
        try {
          decision = await spans.span(
            normalized.kind === 'ACTION'
              ? 'brain.propose_action'
              : 'brain.propose_mandate',
            { agentId: root.agentId, role: 'SUPERVISOR' },
            { proposalId: p.proposalId },
            async (set) => {
              const d =
                normalized.kind === 'ACTION'
                  ? await deps.proposals.proposeAction({
                      kind: 'ACTION',
                      proposalId: ProposalIdSchema.parse(p.proposalId),
                      groupId: evidenceArtifact.groupId,
                      snapshotId: input.world.snapshotId,
                      intent: normalized.intent,
                      evidenceArtifact,
                      evidenceArtifactHash: hash,
                      market: marketRef(input.world, normalized),
                    })
                  : await deps.proposals.proposeMandate({
                      kind: 'MANDATE',
                      proposalId: ProposalIdSchema.parse(p.proposalId),
                      groupId: evidenceArtifact.groupId,
                      snapshotId: input.world.snapshotId,
                      change: normalized.change,
                      mandate: normalized.mandate,
                      evidenceArtifact,
                      evidenceArtifactHash: hash,
                    });
              set({ status: d.status, code: d.code ?? 'none' });
              return d;
            },
          );
        } catch (error) {
          status = 'REJECTED';
          manager.finding(
            'PROVIDER_UNAVAILABLE',
            `proposal port failed: ${error instanceof Error ? error.name : 'ERROR'}`,
            root,
            'HIGH',
          );
          evidenceArtifact = artifact('REJECTED');
          hash = evidenceArtifactHash(evidenceArtifact);
        }
      }
      items.push({
        proposalId: p.proposalId,
        kind: p.item?.kind ?? 'NO_ACTION',
        status,
        issues: p.issues,
        normalized: p.normalized,
        decision,
        evidenceArtifact,
        evidenceArtifactHash: hash,
      });
    }
    manager.close();
    const status = items.some((i) => i.status === 'SUBMITTED')
      ? 'COMPLETED'
      : items.some((i) => i.status === 'ESCALATED')
        ? 'ESCALATED'
        : 'FAILED';
    return {
      runId: input.runId,
      executionMode: deps.executionMode,
      status,
      items,
      findings: manager.findings,
      costs: costs(),
      modelCalls,
      spans: spans.spans,
      research,
      critic,
      roles: [...roles],
    };
  }
}

function marketRef(world: WorldModelSnapshot, normalized: Normalized) {
  if (normalized.kind !== 'ACTION') return null;
  const symbol = normalized.mandate.inputAsset.symbol;
  const quote = world.marketSnapshots.value.find(
    (q) => q.pair === `${symbol}/USD`,
  );
  if (!quote) return null;
  return {
    pair: quote.pair,
    provenance: 'MARKET' as const,
    observedAt: quote.observedAt,
    freshness:
      world.generatedAt - quote.observedAt <= quote.maxAgeSeconds
        ? ('FRESH' as const)
        : ('STALE' as const),
  };
}
