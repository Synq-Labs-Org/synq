import type { z } from 'zod';
import type { AgentFinding } from '@synq/schemas';
import { MastraRoleHarness } from '../mastra.js';
import {
  jsonSchemaOf,
  strictParse,
  type StrictParse,
} from '../pipeline/model-output.js';
import {
  ReasonerError,
  type ReasonerResult,
  type StructuredReasoner,
} from '../ports.js';
import {
  AgentRuntimeError,
  SubagentManager,
  type AgentHandle,
  type BudgetLimits,
} from '../subagents.js';
import {
  FINANCE_TEAM_BUDGET,
  FINANCE_TOOLS,
  SUPERVISOR_MANIFEST,
  intersectCapabilities,
  manifestOf,
  type AgentManifest,
  type FinanceCapability,
  type FinanceRole,
  type FinanceTool,
  type SpecialistRole,
} from './manifests.js';

export type FinanceAgent = Readonly<{
  handle: AgentHandle;
  role: FinanceRole;
  manifest: AgentManifest;
  /** parent ∩ manifest, fixed at spawn. */
  capabilities: readonly FinanceCapability[];
}>;

export type ModelCallRecord = Readonly<{
  agentId: string;
  role: FinanceRole;
  fixtureKey: string;
  provider: string;
  model: string;
  mode: ReasonerResult['mode'] | 'NONE';
  fixtureLabel: ReasonerResult['fixtureLabel'];
  inputTokens: number;
  outputTokens: number;
  outcome: 'ACCEPTED' | 'PARSE_REJECTED' | 'BLOCKED' | 'PROVIDER_ERROR';
}>;

/** Reservation charged before each model call; trued up with real usage after. */
export const MODEL_CALL_TOKEN_RESERVATION = 4_000;
/** Conservative paid-API estimate used for the per-run budget. */
export const MODEL_MICRO_USD_PER_1K_TOKENS = 5_000;

/**
 * Runtime for one Supervisor run: spawns specialists through the existing
 * SubagentManager (depth 3, fanout 5, 50 tool calls, 12 minutes, token and
 * paid budgets) and fences every tool call against the agent's manifest
 * allowlist and its intersected capabilities.
 */
export class FinanceTeam {
  readonly manager: SubagentManager;
  readonly supervisor: FinanceAgent;
  readonly toolLog: { agentId: string; tool: FinanceTool }[] = [];
  readonly modelCalls: ModelCallRecord[] = [];
  private readonly harness = new MastraRoleHarness();
  private readonly agents = new Map<string, FinanceAgent>();

  constructor(
    readonly runId: string,
    limits: BudgetLimits = FINANCE_TEAM_BUDGET,
    clock?: () => number,
  ) {
    this.manager = new SubagentManager(
      runId,
      SUPERVISOR_MANIFEST.runtimeCapabilities,
      limits,
      clock,
    );
    this.supervisor = Object.freeze({
      handle: this.manager.rootHandle,
      role: 'SUPERVISOR',
      manifest: SUPERVISOR_MANIFEST,
      capabilities: [...SUPERVISOR_MANIFEST.capabilities],
    });
    this.agents.set(this.supervisor.handle.agentId, this.supervisor);
  }

  get findings(): readonly AgentFinding[] {
    return this.manager.findings;
  }

  /**
   * Spawns `role` under `parent`. Capabilities are the intersection of the
   * parent's and the child's manifest at both layers, so a child (including a
   * Mastra-style forked one) can never hold more than its parent.
   */
  spawn(parent: FinanceAgent, role: SpecialistRole): FinanceAgent {
    const manifest = manifestOf(role);
    const runtime = intersectCapabilities(
      parent.handle.capabilities,
      manifest.runtimeCapabilities,
    );
    const handle = this.manager.spawn(parent.handle.agentId, role, runtime, {
      ...manifest.budget,
    });
    const agent: FinanceAgent = Object.freeze({
      handle,
      role,
      manifest,
      capabilities: intersectCapabilities(
        parent.capabilities,
        manifest.capabilities,
      ),
    });
    this.agents.set(handle.agentId, agent);
    return agent;
  }

  /** Deterministic tool invocation: allowlist, capability, then budget. */
  tool<T>(agent: FinanceAgent, tool: FinanceTool, run: () => T): T {
    const spec = FINANCE_TOOLS[tool];
    if (!agent.manifest.tools.includes(tool))
      this.forbid(agent, `${agent.role} has no ${tool} in its allowlist`);
    if (!agent.capabilities.includes(spec.capability))
      this.forbid(
        agent,
        `${agent.role} lacks ${spec.capability} for ${tool} (capability intersection)`,
      );
    this.manager.charge(agent.handle.agentId, { toolCalls: 1 }, tool);
    this.toolLog.push({ agentId: agent.handle.agentId, tool });
    return run();
  }

  private forbid(agent: FinanceAgent, detail: string): never {
    this.manager.finding('FORBIDDEN_TOOL_CALL', detail, agent.handle, 'HIGH');
    throw new AgentRuntimeError('FORBIDDEN_TOOL_CALL', detail);
  }

  /**
   * One structured model call through the Mastra role harness. The output is
   * untrusted: it is parsed against `schema` and returned as a typed draft
   * that deterministic code then validates. Tool calls the model emits outside
   * the manifest allowlist are refused by the harness.
   */
  async model<S extends z.ZodType>(input: {
    agent: FinanceAgent;
    reasoner: StructuredReasoner;
    fixtureKey: string;
    userMessage: string;
    schema: S;
    schemaName: string;
    maxOutputTokens?: number;
  }): Promise<{
    parsed: StrictParse<z.output<S>> | null;
    record: ModelCallRecord;
  }> {
    const { agent } = input;
    const base = {
      agentId: agent.handle.agentId,
      role: agent.role,
      fixtureKey: input.fixtureKey,
      provider: input.reasoner.provider,
      model: input.reasoner.model,
    };
    const done = (
      outcome: ModelCallRecord['outcome'],
      result: ReasonerResult | null,
    ) => {
      const record: ModelCallRecord = {
        ...base,
        mode: result?.mode ?? 'NONE',
        fixtureLabel: result?.fixtureLabel ?? null,
        inputTokens: result?.inputTokens ?? 0,
        outputTokens: result?.outputTokens ?? 0,
        outcome,
      };
      this.modelCalls.push(record);
      return record;
    };
    const reservation = {
      tokens: MODEL_CALL_TOKEN_RESERVATION,
      paidMicroUsd: Math.ceil(
        (MODEL_CALL_TOKEN_RESERVATION * MODEL_MICRO_USD_PER_1K_TOKENS) / 1000,
      ),
      toolCalls: 1,
    };
    try {
      this.manager.charge(
        agent.handle.agentId,
        reservation,
        `${agent.role} model call`,
      );
    } catch (error) {
      if (error instanceof AgentRuntimeError)
        return { parsed: null, record: done('BLOCKED', null) };
      throw error;
    }
    let result: ReasonerResult;
    try {
      const run = await this.harness.run({
        handle: agent.handle,
        instructions: agent.manifest.instructions,
        userMessage: input.userMessage,
        toolAllowlist: agent.manifest.tools,
        call: ({ messages, signal }) =>
          input.reasoner.complete({
            role: agent.handle.role,
            agentId: agent.handle.agentId,
            fixtureKey: input.fixtureKey,
            messages,
            responseSchema: {
              name: input.schemaName,
              schema: jsonSchemaOf(input.schema),
            },
            maxOutputTokens: input.maxOutputTokens ?? 800,
            ...(signal ? { signal } : {}),
          }),
      });
      result = run.result;
    } catch (error) {
      if (error instanceof AgentRuntimeError) {
        this.manager.finding(error.kind, error.message, agent.handle, 'HIGH');
        return { parsed: null, record: done('BLOCKED', null) };
      }
      const code =
        error instanceof ReasonerError ? error.code : 'PROVIDER_ERROR';
      this.manager.finding(
        'PROVIDER_UNAVAILABLE',
        `${agent.role}: ${code}`,
        agent.handle,
        'MEDIUM',
      );
      return { parsed: null, record: done('PROVIDER_ERROR', null) };
    }
    const used = result.inputTokens + result.outputTokens;
    try {
      this.manager.record(agent.handle.agentId, {
        tokens: used - reservation.tokens,
        paidMicroUsd:
          Math.ceil((used * MODEL_MICRO_USD_PER_1K_TOKENS) / 1000) -
          reservation.paidMicroUsd,
      });
    } catch (error) {
      if (error instanceof AgentRuntimeError)
        return { parsed: null, record: done('BLOCKED', result) };
      throw error;
    }
    const parsed = strictParse(input.schema, result.text);
    if (!parsed.ok)
      this.manager.finding(
        'VALIDATION_REJECTED',
        `${agent.role} output rejected: ${parsed.code} ${parsed.issues.join('; ').slice(0, 300)}`,
        agent.handle,
        'MEDIUM',
      );
    return {
      parsed,
      record: done(parsed.ok ? 'ACCEPTED' : 'PARSE_REJECTED', result),
    };
  }

  complete(agent: FinanceAgent): void {
    this.manager.complete(agent.handle.agentId);
  }

  close(): void {
    this.manager.close();
  }
}
