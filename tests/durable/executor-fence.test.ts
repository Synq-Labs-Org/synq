import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ExecutorFenceError,
  executorFenceMode,
} from '../../scripts/lib/executor-fence.js';

describe('critic C-05: the executor refuses to pay without a durable grant fence', () => {
  it('no database URL and no dev flag: refuse', () => {
    expect(() => executorFenceMode([], {})).toThrow(ExecutorFenceError);
    expect(() => executorFenceMode([], {})).toThrow(
      /SYNQ_EXECUTION_DATABASE_URL/,
    );
  });

  it('a database URL selects the Postgres fence; the dev flag is explicit and carries a warning', () => {
    expect(
      executorFenceMode([], {
        SYNQ_EXECUTION_DATABASE_URL: 'postgresql://x/y',
      }),
    ).toEqual({ mode: 'POSTGRES', url: 'postgresql://x/y' });
    const dev = executorFenceMode(['--dev-memory-fence'], {});
    expect(dev.mode).toBe('DEV_MEMORY');
    expect((dev as { warning: string }).warning).toMatch(
      /Never use for real payouts/,
    );
    expect(
      executorFenceMode([], { SYNQ_EXECUTOR_DEV_MEMORY_FENCE: '1' }).mode,
    ).toBe('DEV_MEMORY');
  });

  it('the executor child process exits before reading any key when no durable fence is configured', () => {
    const child = fileURLToPath(
      new URL('../../scripts/lib/arc-executor-child.ts', import.meta.url),
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: '/nonexistent-home-for-test',
    };
    delete env.SYNQ_EXECUTION_DATABASE_URL;
    delete env.SYNQ_EXECUTOR_DEV_MEMORY_FENCE;
    const r = spawnSync(process.execPath, ['--import', 'tsx', child], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/refuses to start/);
    expect(r.stderr).not.toMatch(/arc-agent\.key|ENOENT/);
  });
});
