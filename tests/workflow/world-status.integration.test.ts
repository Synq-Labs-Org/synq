import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { canonicalIntentId } from '@synq/kernel';
import { TemporalWorkflowStatusSource } from '../../apps/api/src/world-sources.js';
import { bootstrapLocalEnvironment } from '../../workers/workflow/src/local/bootstrap.js';
import { openLocalRuntime } from '../../workers/workflow/src/local/runtime.js';
import { evaluateDcaDeterministic } from '../../workers/workflow/src/activities/strategy.js';
import type { DcaTickResult } from '../../workers/workflow/src/workflows/dca.js';
import type { ActionWorkflowState } from '../../workers/workflow/src/workflows/action-execution.js';
import { startTemporal, testConfig, eventually } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { testDatabaseUrl } from '../durable/pg.js';

it('I-02/I-03 real running DCA and its abandoned approval child remain visible to the production World source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synq-world-workflows-'));
  const local = await bootstrapLocalEnvironment({
    dataDir: dir,
    databaseUrl: testDatabaseUrl(
      'SYNQ_UNUSED_TEST_DATABASE_URL',
      'synq_p07_world_status_demo',
    ),
  });
  const runtime = await openLocalRuntime(local.manifest);
  const env = await startTemporal();
  const config = testConfig('world-status');
  const groupId = local.manifest.groupId;
  const source = new TemporalWorkflowStatusSource(
    {
      list: () => env.client.workflow.list(),
      nextEvent: (id) =>
        env.client.workflow
          .getHandle(id)
          .query<{ at: number | null }>('nextScheduledEvent'),
    },
    () => Math.floor(Date.now() / 1000),
  );
  const strategy = {
    strategyId: 'world-visible-dca',
    groupId,
    mandateId: local.manifest.mandate.mandateId,
    mandateVersion: 1,
    inputAmountPerTick: '1000000',
    maxSlippageBps: 0,
    maxTicks: 1,
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  let builtIntent: Parameters<typeof canonicalIntentId>[0] | null = null;
  try {
    await withWorkers(
      env,
      config,
      {
        ...runtime.activities,
        dcaFreshState: async (input) => {
          entered = true;
          await held;
          return runtime.activities.dcaFreshState(input);
        },
        evaluateDca: async (input) => evaluateDcaDeterministic(input),
        buildDcaAction: async (input) => {
          const built = await runtime.activities.buildDcaAction(input);
          builtIntent = built.start.intent;
          return built;
        },
      },
      async () => {
        const handle = await env.client.workflow.start('DCAWorkflow', {
          workflowId: 'world-dca-parent',
          taskQueue: config.taskQueues.strategy,
          args: [{ strategy, executionTaskQueue: config.taskQueues.economic }],
          memo: { synqGroupId: groupId },
        });
        await eventually(
          async () => entered,
          (yes) => yes,
        );
        expect(await handle.query('nextScheduledEvent')).toEqual({
          kind: 'NONE',
          at: null,
        });
        const running = await eventually(
          () => source.list(groupId),
          (view) =>
            view.workflows.some(
              (w) =>
                w.workflowId === 'world-dca-parent' && w.status === 'RUNNING',
            ),
        );
        expect(
          running.workflows.find((w) => w.workflowId === 'world-dca-parent')
            ?.nextEventAt,
        ).toBe(null);
        release();
        const tick = (await handle.result()) as DcaTickResult;
        expect(tick.decision).toBe('EXECUTE');
        expect(tick.childWorkflowId).not.toBeNull();
        const child = env.client.workflow.getHandle(tick.childWorkflowId!);
        await eventually(
          () => child.query<ActionWorkflowState>('state'),
          (state) => state.waitingFor === 'APPROVAL',
        );
        const visible = await eventually(
          () => source.list(groupId),
          (view) =>
            view.workflows.some(
              (w) =>
                w.workflowId === tick.childWorkflowId && w.status === 'RUNNING',
            ),
        );
        expect(builtIntent).not.toBeNull();
        const entry = visible.workflows.find(
          (w) => w.workflowId === tick.childWorkflowId,
        )!;
        expect(entry.intentId).toBe(canonicalIntentId(builtIntent!));
        expect(entry.nextEventAt).not.toBeNull();
        expect((await source.list('different-group')).workflows).toEqual([]);
        expect(runtime.kernel.kernel.stateView().grants).toEqual([]);
        await child.terminate(
          'Visibility regression complete; no economic authority issued',
        );
      },
    );
  } finally {
    release();
    await runtime.close();
    await env.teardown();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
