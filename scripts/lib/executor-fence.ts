/**
 * Which grant fence a key-holding executor may run with. Production needs
 * the durable Postgres fence (a consumed grant must stay consumed across
 * restarts), so without `SYNQ_EXECUTION_DATABASE_URL` the executor refuses to
 * start, unless the operator explicitly opts into an in-process fence with
 * `--dev-memory-fence` (or `SYNQ_EXECUTOR_DEV_MEMORY_FENCE=1`, which a parent
 * process passes to its forked child). The opt-in is always logged.
 */
export type ExecutorFenceMode =
  | Readonly<{ mode: 'POSTGRES'; url: string }>
  | Readonly<{ mode: 'DEV_MEMORY'; warning: string }>;

export class ExecutorFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorFenceError';
  }
}

export const DEV_MEMORY_FENCE_FLAG = '--dev-memory-fence';

export function devMemoryFenceRequested(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    argv.includes(DEV_MEMORY_FENCE_FLAG) ||
    env.SYNQ_EXECUTOR_DEV_MEMORY_FENCE === '1'
  );
}

export function executorFenceMode(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): ExecutorFenceMode {
  const url = env.SYNQ_EXECUTION_DATABASE_URL;
  if (url) return { mode: 'POSTGRES', url };
  if (devMemoryFenceRequested(argv, env))
    return {
      mode: 'DEV_MEMORY',
      warning:
        'executor: DEV MEMORY FENCE. Consumed grants live only in this process; a restart can re-admit an unexpired grant. Never use for real payouts.',
    };
  throw new ExecutorFenceError(
    `executor refuses to start: SYNQ_EXECUTION_DATABASE_URL is not set (durable grant fence required). Pass ${DEV_MEMORY_FENCE_FLAG} only for local development.`,
  );
}
