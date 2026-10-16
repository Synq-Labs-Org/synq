import type { FinanceTeam } from '../finance-team/team.js';
import type { CapabilityGuard, GuardEvent } from './guard.js';
import { NEVER_TOOLS, TEAM_TOOLS } from './manifests.js';

/**
 * Cost and evidence metrics for one council run, plus the runtime half of
 * the zero-model-signing proof (the static half is `scripts/architecture.mjs`:
 * no planner package can import a signer).
 */
export type RunMetrics = Readonly<{
  runId: string;
  latencyMs: number;
  model: string | null;
  provider: string | null;
  modelMode: string | null;
  modelCalls: number;
  modelCallsAccepted: number;
  inputTokens: number;
  outputTokens: number;
  /** Tool calls charged to the run budget (SubagentManager). */
  toolCalls: number;
  /** Calls the external guard allowed, flagged or refused. */
  guard: Readonly<{
    allowed: number;
    flagged: number;
    refused: number;
    delegations: number;
    revocations: number;
  }>;
  perAgent: readonly { agentId: string; role: string; toolCalls: number }[];
  signing: ZeroSigningReport;
}>;

export type ZeroSigningReport = Readonly<{
  /** Always 0: no tool in the team vocabulary signs or broadcasts. */
  modelSignatures: 0;
  /** Tools any agent invoked, all READ / PROPOSE / HOLD / PAID_READ. */
  effectsUsed: readonly string[];
  /** Attempts (by a model or injected text) to reach a signer that were refused. */
  refusedSigningAttempts: number;
  assertion: 'PASS';
}>;

const SIGNING_NAMES = /sign|send|broadcast|execut|grant|transfer|pay$/i;

/**
 * Throws unless the run used only non-signing effects: every allowed call
 * names a registered tool whose effect is READ, PROPOSE, HOLD or PAID_READ.
 */
export function assertZeroModelSigning(
  log: readonly GuardEvent[],
): ZeroSigningReport {
  const effects = new Set<string>();
  let refused = 0;
  for (const e of log) {
    if (e.action === 'ALLOWED' || e.action === 'FLAGGED') {
      const spec = (
        TEAM_TOOLS as Record<string, { effect: string } | undefined>
      )[e.subject];
      if (!spec)
        throw new Error(
          `zero-signing assertion failed: ${e.subject} ran but is not a registered tool`,
        );
      if (!['READ', 'PROPOSE', 'HOLD', 'PAID_READ'].includes(spec.effect))
        throw new Error(
          `zero-signing assertion failed: ${e.subject} has effect ${spec.effect}`,
        );
      effects.add(spec.effect);
    }
    if (
      e.action === 'REFUSED' &&
      ((NEVER_TOOLS as readonly string[]).includes(e.subject) ||
        SIGNING_NAMES.test(e.subject))
    )
      refused++;
  }
  return {
    modelSignatures: 0,
    effectsUsed: [...effects].sort(),
    refusedSigningAttempts: refused,
    assertion: 'PASS',
  };
}

export function runMetrics(input: {
  runId: string;
  team: FinanceTeam;
  guard: CapabilityGuard;
  startedMs: number;
  endedMs: number;
}): RunMetrics {
  const calls = input.team.modelCalls;
  const perAgent = new Map<string, { role: string; toolCalls: number }>();
  for (const t of input.team.toolLog) {
    const row = perAgent.get(t.agentId) ?? {
      role: t.agentId.split('.').at(-2)?.toUpperCase() ?? '?',
      toolCalls: 0,
    };
    row.toolCalls++;
    perAgent.set(t.agentId, row);
  }
  const g = input.guard.log;
  const harnessRefusals = input.team.findings.filter(
    (f) => f.kind === 'FORBIDDEN_TOOL_CALL' && SIGNING_NAMES.test(f.detail),
  ).length;
  const signing = assertZeroModelSigning(g);
  return {
    runId: input.runId,
    latencyMs: Math.max(0, input.endedMs - input.startedMs),
    model: calls[0]?.model ?? null,
    provider: calls[0]?.provider ?? null,
    modelMode: calls[0]?.mode ?? null,
    modelCalls: calls.length,
    modelCallsAccepted: calls.filter((c) => c.outcome === 'ACCEPTED').length,
    inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
    outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
    toolCalls: input.team.manager.usage().toolCalls,
    guard: {
      allowed: g.filter((e) => e.action === 'ALLOWED').length,
      flagged: g.filter((e) => e.action === 'FLAGGED').length,
      refused: g.filter((e) => e.action === 'REFUSED').length,
      delegations: g.filter((e) => e.action === 'DELEGATED').length,
      revocations: g.filter((e) => e.action === 'REVOKED').length,
    },
    perAgent: [...perAgent.entries()].map(([agentId, r]) => ({
      agentId,
      ...r,
    })),
    signing: {
      ...signing,
      refusedSigningAttempts: signing.refusedSigningAttempts + harnessRefusals,
    },
  };
}
