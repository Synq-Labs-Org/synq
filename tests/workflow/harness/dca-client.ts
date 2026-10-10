/** Short-lived client process: creates or describes a DCA schedule, prints JSON, exits. */
import { Client, Connection } from '@temporalio/client';
import { loadWorkflowConfig } from '../../../workers/workflow/src/config.js';
import { createDcaSchedule } from '../../../workers/workflow/src/client.js';
import type { DcaStrategy } from '../../../workers/workflow/src/activities/types.js';

const request = JSON.parse(process.env.SYNQ_DCA_CLIENT_REQUEST ?? '{}') as {
  action: 'create' | 'describe';
  scheduleId?: string;
  strategy?: DcaStrategy;
  intervalSeconds?: number;
};
const config = loadWorkflowConfig();
const connection = await Connection.connect({ address: config.address });
try {
  const client = new Client({ connection, namespace: config.namespace });
  if (request.action === 'create') {
    const scheduleId = await createDcaSchedule(client, config, {
      strategy: request.strategy!,
      intervalSeconds: request.intervalSeconds!,
      overlap: 'SKIP',
      catchupWindowSeconds: 60,
    });
    process.stdout.write(
      `${JSON.stringify({ pid: process.pid, scheduleId })}\n`,
    );
  } else {
    const described = await client.schedule
      .getHandle(request.scheduleId!)
      .describe();
    process.stdout.write(
      `${JSON.stringify({
        pid: process.pid,
        paused: described.state.paused,
        overlap: described.policies.overlap,
        catchupWindow: described.policies.catchupWindow,
        recentActions: described.info.recentActions.map((a) => ({
          scheduledAt: a.scheduledAt.toISOString(),
          workflowId:
            a.action.type === 'startWorkflow'
              ? a.action.workflow.workflowId
              : null,
        })),
        nextActionTimes: described.info.nextActionTimes.map((d) =>
          d.toISOString(),
        ),
      })}\n`,
    );
  }
} finally {
  await connection.close();
}
