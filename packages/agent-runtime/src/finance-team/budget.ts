import type { BudgetLimits } from '../subagents.js';
import { FINANCE_TEAM_BUDGET } from './manifests.js';

export type FinanceUsage = Readonly<{
  toolCalls: number;
  tokens: number;
  paidMicroUsd: number;
}>;

/**
 * Budget that outlives one Supervisor run: per workspace (or session), so a
 * caller cannot reset token, paid-API or tool budgets by sending another
 * message. Inject a durable implementation through `FinanceDesk.budget`.
 */
export interface FinanceBudgetLedger {
  remaining(workspaceId: string): FinanceUsage;
  record(workspaceId: string, used: FinanceUsage): void;
}

/** Default session caps: ten full runs' worth of the per-run budget. */
export const DEFAULT_SESSION_BUDGET: FinanceUsage = Object.freeze({
  toolCalls: FINANCE_TEAM_BUDGET.maxToolCalls * 10,
  tokens: FINANCE_TEAM_BUDGET.maxLlmTokens * 10,
  paidMicroUsd: FINANCE_TEAM_BUDGET.maxPaidMicroUsd * 10,
});

export class MemoryFinanceBudgetLedger implements FinanceBudgetLedger {
  private readonly used = new Map<string, FinanceUsage>();
  constructor(readonly caps: FinanceUsage = DEFAULT_SESSION_BUDGET) {}
  remaining(workspaceId: string): FinanceUsage {
    const u = this.used.get(workspaceId) ?? {
      toolCalls: 0,
      tokens: 0,
      paidMicroUsd: 0,
    };
    return {
      toolCalls: Math.max(0, this.caps.toolCalls - u.toolCalls),
      tokens: Math.max(0, this.caps.tokens - u.tokens),
      paidMicroUsd: Math.max(0, this.caps.paidMicroUsd - u.paidMicroUsd),
    };
  }
  record(workspaceId: string, used: FinanceUsage): void {
    const u = this.used.get(workspaceId) ?? {
      toolCalls: 0,
      tokens: 0,
      paidMicroUsd: 0,
    };
    const add = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
    this.used.set(workspaceId, {
      toolCalls: u.toolCalls + add(used.toolCalls),
      tokens: u.tokens + add(used.tokens),
      paidMicroUsd: u.paidMicroUsd + add(used.paidMicroUsd),
    });
  }
}

/**
 * Effective limits for one run: caller overrides can only tighten the
 * defaults, and the session ledger's remaining budget caps them further.
 */
export function effectiveLimits(
  requested: Partial<BudgetLimits> | undefined,
  remaining: FinanceUsage | null,
): BudgetLimits {
  const out = { ...FINANCE_TEAM_BUDGET };
  for (const key of Object.keys(out) as (keyof BudgetLimits)[]) {
    const v = requested?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
      out[key] = Math.min(out[key], Math.floor(v));
  }
  if (remaining) {
    out.maxToolCalls = Math.min(out.maxToolCalls, remaining.toolCalls);
    out.maxLlmTokens = Math.min(out.maxLlmTokens, remaining.tokens);
    out.maxPaidMicroUsd = Math.min(out.maxPaidMicroUsd, remaining.paidMicroUsd);
  }
  return out;
}
