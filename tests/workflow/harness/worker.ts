import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { SynqActivities } from '../../../workers/workflow/src/activities/types.js';
import type { WorkflowConfig } from '../../../workers/workflow/src/config.js';
import { createSynqWorkers } from '../../../workers/workflow/src/worker.js';
import { sharedBundle } from './temporal.js';

/** Runs every family worker while `body` executes, then shuts them down cleanly. */
export async function withWorkers<T>(
  env: TestWorkflowEnvironment,
  config: WorkflowConfig,
  activities: Partial<SynqActivities>,
  body: () => Promise<T>,
): Promise<T> {
  const workers: Worker[] = await createSynqWorkers({
    connection: env.nativeConnection,
    config,
    activities,
    bundle: await sharedBundle(),
    overrides: { shutdownGraceTime: '1s' },
  });
  const running = workers.map((w) => w.run());
  try {
    return await body();
  } finally {
    for (const w of workers) if (w.getState() === 'RUNNING') w.shutdown();
    await Promise.allSettled(running);
  }
}
