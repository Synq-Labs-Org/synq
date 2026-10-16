import pg from 'pg';
import { executorFenceMode } from './executor-fence.js';
import { MemoryNonceFence, type NonceFence } from '@synq/kernel/arc';
import {
  MemoryObligationFence,
  PostgresApprovalNonceFence,
  PostgresObligationFence,
  migrateFinanceTeam,
  type ApprovalNonceFence,
  type ObligationFence,
} from '@synq/agent-runtime';
import { PostgresGrantFence } from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';

/**
 * Grant, obligation and owner-approval fences for proof scripts: Postgres
 * when `SYNQ_EXECUTION_DATABASE_URL` is set, otherwise in-memory with a loud
 * notice (and `durable: false` in the evidence), never silently.
 */
export async function scriptFences(label: string, scope: string) {
  const mode = executorFenceMode();
  if (mode.mode === 'DEV_MEMORY') {
    console.warn(
      `[${label}] SYNQ_EXECUTION_DATABASE_URL not set: grant/obligation fences are IN-MEMORY for this run (not durable across restarts).`,
    );
    return {
      durable: false as const,
      grants: new MemoryNonceFence() as NonceFence,
      obligations: new MemoryObligationFence() as ObligationFence,
      approvals: null as ApprovalNonceFence | null,
      close: async () => undefined,
    };
  }
  const pool = new pg.Pool({ connectionString: mode.url, max: 2 });
  await migrateExecution(pool);
  await migrateFinanceTeam(pool);
  return {
    durable: true as const,
    grants: new PostgresGrantFence(pool) as NonceFence,
    obligations: new PostgresObligationFence(pool, scope) as ObligationFence,
    approvals: new PostgresApprovalNonceFence(
      pool,
      scope,
    ) as ApprovalNonceFence | null,
    close: () => pool.end(),
  };
}
