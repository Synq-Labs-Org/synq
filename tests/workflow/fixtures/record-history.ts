/**
 * Records an ActionExecutionWorkflow history with the workflow code checked out at the time.
 * `node --import tsx tests/workflow/fixtures/record-history.ts <out.json>`; the committed fixtures
 * are the histories of earlier workflow versions that replay tests run against current code.
 */
import { writeFileSync } from 'node:fs';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { ActionExecutionWorkflow } from '../../../workers/workflow/src/workflows/action-execution.js';
import {
  approveUpdate,
  stateQuery,
} from '../../../workers/workflow/src/workflows/messages.js';
import { eventually, startTemporal, testConfig } from '../harness/temporal.js';
import { withWorkers } from '../harness/worker.js';
import { fakeEconomic } from '../harness/fake-economic.js';
import { startFixture } from '../harness/fixtures.js';

const out = process.argv[2];
if (!out) throw new Error('usage: record-history.ts <out.json>');
const env = await startTemporal();
try {
  const config = testConfig('record');
  const fake = fakeEconomic();
  await withWorkers(env, config, fake.activities, async () => {
    const handle = await env.client.workflow.start<
      typeof ActionExecutionWorkflow
    >('ActionExecutionWorkflow', {
      workflowId: 'fixture.action-execution',
      taskQueue: config.taskQueues.economic,
      args: [
        startFixture('1', { now: 1_790_000_000 }),
        {
          retryInitialSeconds: 0.2,
          retryMaxSeconds: 1,
          confirmationPollSeconds: 1,
        },
      ],
    });
    await eventually(
      () => handle.query(stateQuery) as Promise<{ waitingFor: string | null }>,
      (s) => s.waitingFor === 'APPROVAL',
    );
    for (const memberId of ['member_0', 'member_1']) {
      fake.approve(memberId);
      await handle.executeUpdate(approveUpdate, {
        args: [{ memberId, draftDigest: fake.DIGEST }],
      });
    }
    const result = await handle.result();
    if (result.outcome !== 'SETTLED')
      throw new Error(`unexpected ${result.outcome}`);
    writeFileSync(out, historyToJSON(await handle.fetchHistory()) + '\n');
  });
} finally {
  await env.teardown();
}
