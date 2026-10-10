import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, DefaultLogger } from '@temporalio/worker';
import { bundleSynqWorkflows } from '../../../workers/workflow/src/worker.js';
import { loadWorkflowConfig } from '../../../workers/workflow/src/config.js';

export function temporalCli(): string {
  const configured = process.env.TEMPORAL_CLI;
  if (configured && existsSync(configured)) return configured;
  for (const candidate of [
    '/opt/homebrew/bin/temporal',
    '/usr/local/bin/temporal',
  ])
    if (existsSync(candidate)) return candidate;
  return execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim();
}

let runtimeInstalled = false;
export function quietRuntime(): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    Runtime.install({ logger: new DefaultLogger('ERROR') });
  } catch {
    return;
  }
}

export async function startTemporal(): Promise<TestWorkflowEnvironment> {
  quietRuntime();
  return TestWorkflowEnvironment.createLocal({
    server: {
      executable: { type: 'existing-path', path: temporalCli() },
      extraArgs: ['--log-level', 'error'],
    },
  });
}

let bundle: ReturnType<typeof bundleSynqWorkflows> | null = null;
export function sharedBundle() {
  bundle ??= bundleSynqWorkflows();
  return bundle;
}

let queueSeq = 0;
export function testConfig(prefix = 'wf') {
  queueSeq++;
  const tag = `${prefix}-${process.pid}-${queueSeq}`;
  return loadWorkflowConfig({
    SYNQ_TQ_ECONOMIC: `${tag}-economic`,
    SYNQ_TQ_APPROVAL: `${tag}-approval`,
    SYNQ_TQ_STRATEGY: `${tag}-strategy`,
    SYNQ_TQ_OPERATIONS: `${tag}-operations`,
  });
}

export async function eventually<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `condition not met within ${timeoutMs}ms; last=${JSON.stringify(last)} error=${String(lastError)}`,
  );
}
