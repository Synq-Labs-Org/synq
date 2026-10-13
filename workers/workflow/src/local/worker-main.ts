import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { DefaultLogger, NativeConnection, Runtime } from '@temporalio/worker';
import { loadWorkflowConfig, type WorkflowFamily } from '../config.js';
import {
  bundleSynqWorkflows,
  createSynqWorkers,
  runSynqWorkers,
} from '../worker.js';
import {
  CRASH_POINTS,
  NO_FAULTS,
  parkingFaults,
  type CrashPoint,
} from '../activities/faults.js';
import { readLocalManifest } from './manifest.js';
import { openLocalRuntime } from './runtime.js';

/**
 * Worker process for the local-anvil runtime: `node --import tsx worker-main.ts <manifest.json>`
 * (or the path in SYNQ_WORKFLOW_MANIFEST, as the container image runs it).
 * SYNQ_WORKFLOW_CRASH_AT arms one instrumented point (crash harness only). SYNQ_DCA_POLICY_FILE (JSON map of
 * strategyId to DCA policy) binds the deterministic strategy engine as the DCA evaluator.
 */
async function main(): Promise<void> {
  const manifestPath = process.argv[2] ?? process.env.SYNQ_WORKFLOW_MANIFEST;
  if (!manifestPath)
    throw new Error(
      'usage: worker-main.ts <manifest.json> (or SYNQ_WORKFLOW_MANIFEST)',
    );
  Runtime.install({
    logger: new DefaultLogger(
      (process.env.SYNQ_WORKFLOW_LOG_LEVEL as 'WARN') ?? 'WARN',
    ),
  });
  const config = loadWorkflowConfig();
  const manifest = readLocalManifest(resolve(manifestPath));
  const armed = process.env.SYNQ_WORKFLOW_CRASH_AT ?? null;
  if (armed !== null && !(CRASH_POINTS as readonly string[]).includes(armed))
    throw new Error(`unknown crash point ${armed}`);
  const faults =
    armed && process.env.SYNQ_WORKFLOW_FAULT_DIR
      ? parkingFaults(process.env.SYNQ_WORKFLOW_FAULT_DIR, armed as CrashPoint)
      : NO_FAULTS;
  const families = (
    process.env.SYNQ_WORKFLOW_FAMILIES ??
    'economic,approval,strategy,operations'
  )
    .split(',')
    .filter(Boolean) as WorkflowFamily[];
  const runtime = await openLocalRuntime(manifest, {
    faults,
    allowMainnetBroadcast: config.allowMainnetBroadcast,
    workerId: process.env.SYNQ_WORKFLOW_WORKER_ID ?? 'local-workflow-worker',
    ...(process.env.SYNQ_DCA_POLICY_FILE
      ? {
          dcaPolicies: JSON.parse(
            readFileSync(resolve(process.env.SYNQ_DCA_POLICY_FILE), 'utf8'),
          ) as Record<string, unknown>,
        }
      : {}),
  });
  const connection = await NativeConnection.connect({
    address: config.address,
  });
  const workers = await createSynqWorkers({
    connection,
    config,
    activities: runtime.activities,
    bundle: await bundleSynqWorkflows(),
    families,
    overrides: { shutdownGraceTime: '2s' },
  });
  const stop = () => {
    for (const w of workers) if (w.getState() === 'RUNNING') w.shutdown();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const health = healthServer(() =>
    workers.every((w) => w.getState() === 'RUNNING'),
  );
  const running = runSynqWorkers(workers);
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      pid: process.pid,
      armed,
      commerce: runtime.commerce.status,
      delegation: runtime.delegation.planner
        ? 'READY'
        : `UNAVAILABLE: ${runtime.delegation.reason}`,
    })}\n`,
  );
  try {
    await running;
  } finally {
    health?.close();
    await runtime.close();
    await connection.close();
  }
}

/**
 * SYNQ_WORKFLOW_HEALTH_PORT opens GET /health (200 while every worker is
 * RUNNING, else 503) for container health checks. It reports state only.
 */
function healthServer(ready: () => boolean): Server | null {
  const port = Number(process.env.SYNQ_WORKFLOW_HEALTH_PORT ?? '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const server = createServer((request, response) => {
    const ok = request.method === 'GET' && request.url === '/health';
    const up = ok && ready();
    response
      .writeHead(!ok ? 404 : up ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify({ status: !ok ? 'not_found' : up ? 'ok' : 'down' }));
  });
  server.listen(port, process.env.SYNQ_WORKFLOW_HEALTH_HOST ?? '127.0.0.1');
  return server;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
