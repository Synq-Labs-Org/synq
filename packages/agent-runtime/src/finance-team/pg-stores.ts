import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import {
  applyMigrations,
  withTransaction,
  type Migration,
  type SqlPool,
} from '@synq/domain/pg';
import {
  DEFAULT_SESSION_BUDGET,
  type FinanceBudgetLedger,
  type FinanceUsage,
} from './budget.js';
import type { ApprovalNonceFence, ObligationFence } from './kernel-port.js';

/**
 * Durable finance-team state: the per-workspace budget ledger (per window,
 * never negative, shared by every process), the one-grant-per-obligation
 * fence and redeemed owner-approval nonces. Own migrations table:
 * `synq_finance_team_migrations`.
 */
export const FINANCE_TEAM_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_finance_budget_usage (
      workspace_id text NOT NULL,
      window_start bigint NOT NULL,
      tool_calls bigint NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
      tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
      paid_micro_usd bigint NOT NULL DEFAULT 0 CHECK (paid_micro_usd >= 0),
      PRIMARY KEY (workspace_id, window_start));
    CREATE TABLE IF NOT EXISTS synq_finance_budget_reservations (
      reservation_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      window_start bigint NOT NULL,
      run_id text NOT NULL,
      tool_calls bigint NOT NULL CHECK (tool_calls >= 0),
      tokens bigint NOT NULL CHECK (tokens >= 0),
      paid_micro_usd bigint NOT NULL CHECK (paid_micro_usd >= 0),
      created_at bigint NOT NULL,
      settled_at bigint);
    CREATE TABLE IF NOT EXISTS synq_finance_obligations (
      scope text NOT NULL,
      obligation_ref text NOT NULL,
      reserved_at bigint NOT NULL,
      PRIMARY KEY (scope, obligation_ref));
    CREATE TABLE IF NOT EXISTS synq_finance_approval_nonces (
      scope text NOT NULL,
      nonce text NOT NULL,
      redeemed_at bigint NOT NULL,
      PRIMARY KEY (scope, nonce));`,
    down: `DROP TABLE IF EXISTS synq_finance_approval_nonces;
    DROP TABLE IF EXISTS synq_finance_obligations;
    DROP TABLE IF EXISTS synq_finance_budget_reservations;
    DROP TABLE IF EXISTS synq_finance_budget_usage;`,
  },
];

export const migrateFinanceTeam = (pool: SqlPool, target?: number) =>
  applyMigrations(
    pool,
    'synq_finance_team_migrations',
    FINANCE_TEAM_MIGRATIONS,
    target,
  );

const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Only finite, positive, whole amounts are ever added. */
const clamp = (x: number) =>
  Number.isFinite(x) && x > 0 ? Math.min(Math.floor(x), 2 ** 52) : 0;
const usage = (r: Record<string, unknown> | undefined): FinanceUsage => ({
  toolCalls: Number(r?.tool_calls ?? 0),
  tokens: Number(r?.tokens ?? 0),
  paidMicroUsd: Number(r?.paid_micro_usd ?? 0),
});

/**
 * Budget usage that survives restarts and is shared across processes.
 * Usage is counted per fixed window (`windowSeconds`, default one day);
 * `remaining` is the caps minus this window's usage. `reserve` holds a run's
 * share under a row lock, so concurrent runs can never jointly exceed a cap.
 */
export class PostgresFinanceBudgetLedger implements FinanceBudgetLedger {
  readonly windowSeconds: number;
  private readonly now: () => number;
  constructor(
    readonly pool: SqlPool,
    readonly caps: FinanceUsage = DEFAULT_SESSION_BUDGET,
    opts: { windowSeconds?: number; now?: () => number } = {},
  ) {
    this.windowSeconds = opts.windowSeconds ?? 86_400;
    if (!Number.isSafeInteger(this.windowSeconds) || this.windowSeconds < 60)
      throw new Error('budget window must be at least 60 seconds');
    this.now = opts.now ?? nowSeconds;
  }

  async migrate() {
    await migrateFinanceTeam(this.pool);
  }

  private window() {
    const t = this.now();
    return t - (t % this.windowSeconds);
  }

  private left(u: FinanceUsage): FinanceUsage {
    return {
      toolCalls: Math.max(0, this.caps.toolCalls - u.toolCalls),
      tokens: Math.max(0, this.caps.tokens - u.tokens),
      paidMicroUsd: Math.max(0, this.caps.paidMicroUsd - u.paidMicroUsd),
    };
  }

  async used(workspaceId: string): Promise<FinanceUsage> {
    const r = await this.pool.query(
      'SELECT tool_calls, tokens, paid_micro_usd FROM synq_finance_budget_usage WHERE workspace_id=$1 AND window_start=$2',
      [workspaceId, this.window()],
    );
    return usage(r.rows[0]);
  }

  async remaining(workspaceId: string): Promise<FinanceUsage> {
    return this.left(await this.used(workspaceId));
  }

  async record(workspaceId: string, used: FinanceUsage): Promise<void> {
    await this.pool.query(
      `INSERT INTO synq_finance_budget_usage AS u (workspace_id, window_start, tool_calls, tokens, paid_micro_usd)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, window_start) DO UPDATE SET
         tool_calls = u.tool_calls + EXCLUDED.tool_calls,
         tokens = u.tokens + EXCLUDED.tokens,
         paid_micro_usd = u.paid_micro_usd + EXCLUDED.paid_micro_usd`,
      [
        workspaceId,
        this.window(),
        clamp(used.toolCalls),
        clamp(used.tokens),
        clamp(used.paidMicroUsd),
      ],
    );
  }

  async reserve(workspaceId: string, want: FinanceUsage, runId: string) {
    const windowStart = this.window();
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO synq_finance_budget_usage (workspace_id, window_start) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [workspaceId, windowStart],
      );
      const r = await c.query(
        `SELECT tool_calls, tokens, paid_micro_usd FROM synq_finance_budget_usage
         WHERE workspace_id=$1 AND window_start=$2 FOR UPDATE`,
        [workspaceId, windowStart],
      );
      const left = this.left(usage(r.rows[0]));
      const granted: FinanceUsage = {
        toolCalls: Math.min(clamp(want.toolCalls), left.toolCalls),
        tokens: Math.min(clamp(want.tokens), left.tokens),
        paidMicroUsd: Math.min(clamp(want.paidMicroUsd), left.paidMicroUsd),
      };
      await c.query(
        `UPDATE synq_finance_budget_usage SET tool_calls = tool_calls + $3,
           tokens = tokens + $4, paid_micro_usd = paid_micro_usd + $5
         WHERE workspace_id=$1 AND window_start=$2`,
        [
          workspaceId,
          windowStart,
          granted.toolCalls,
          granted.tokens,
          granted.paidMicroUsd,
        ],
      );
      const reservationId = `bud_${randomBytes(12).toString('hex')}`;
      await c.query(
        `INSERT INTO synq_finance_budget_reservations
           (reservation_id, workspace_id, window_start, run_id, tool_calls, tokens, paid_micro_usd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          reservationId,
          workspaceId,
          windowStart,
          runId,
          granted.toolCalls,
          granted.tokens,
          granted.paidMicroUsd,
          this.now(),
        ],
      );
      return { reservationId, granted };
    });
  }

  /**
   * Replaces the held amount with what the run used (never below zero, in the
   * reservation's own window). Settling twice, or a foreign id, is a no-op.
   */
  async settle(workspaceId: string, reservationId: string, used: FinanceUsage) {
    await withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `SELECT window_start, tool_calls, tokens, paid_micro_usd FROM synq_finance_budget_reservations
         WHERE reservation_id=$1 AND workspace_id=$2 AND settled_at IS NULL FOR UPDATE`,
        [reservationId, workspaceId],
      );
      const held = r.rows[0];
      if (!held) return;
      const h = usage(held);
      await c.query(
        `UPDATE synq_finance_budget_usage SET
           tool_calls = GREATEST(0, tool_calls + $3),
           tokens = GREATEST(0, tokens + $4),
           paid_micro_usd = GREATEST(0, paid_micro_usd + $5)
         WHERE workspace_id=$1 AND window_start=$2`,
        [
          workspaceId,
          held.window_start,
          clamp(used.toolCalls) - h.toolCalls,
          clamp(used.tokens) - h.tokens,
          clamp(used.paidMicroUsd) - h.paidMicroUsd,
        ],
      );
      await c.query(
        'UPDATE synq_finance_budget_reservations SET settled_at=$2 WHERE reservation_id=$1',
        [reservationId, this.now()],
      );
    });
  }
}

/** One grant per obligation within `scope` (e.g. the mandate id), across processes. */
export class PostgresObligationFence implements ObligationFence {
  constructor(
    readonly pool: SqlPool,
    readonly scope: string,
    private readonly now: () => number = nowSeconds,
  ) {}
  async migrate() {
    await migrateFinanceTeam(this.pool);
  }
  async reserve(obligationRef: string) {
    const r = await this.pool.query(
      `INSERT INTO synq_finance_obligations (scope, obligation_ref, reserved_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
      [this.scope, obligationRef, this.now()],
    );
    return r.rows.length > 0;
  }
}

/** Owner-approval nonces redeemed once within `scope`, across processes. */
export class PostgresApprovalNonceFence implements ApprovalNonceFence {
  constructor(
    readonly pool: SqlPool,
    readonly scope: string,
    private readonly now: () => number = nowSeconds,
  ) {}
  async migrate() {
    await migrateFinanceTeam(this.pool);
  }
  async redeem(nonce: Hex) {
    const r = await this.pool.query(
      `INSERT INTO synq_finance_approval_nonces (scope, nonce, redeemed_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
      [this.scope, nonce.toLowerCase(), this.now()],
    );
    return r.rows.length > 0;
  }
}
