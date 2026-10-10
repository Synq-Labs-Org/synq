import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './config.js';
import { bootstrapLocalEnvironment } from './local/bootstrap.js';

/**
 * `pnpm workflow:dev`: a persistent `temporal server start-dev` (SQLite under .synq-dev/), a local
 * anvil Synq environment (or SYNQ_WORKFLOW_MANIFEST) and a worker process for every family queue.
 */
const config = loadWorkflowConfig();
const dataDir = resolve(
  process.env.SYNQ_WORKFLOW_DEV_DIR ?? '.synq-dev/workflow',
);
mkdirSync(dataDir, { recursive: true });
const [host, port] = config.address.split(':') as [string, string];
const children: ChildProcess[] = [];
const stop = () => {
  for (const c of children.reverse())
    if (c.exitCode === null) c.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function reachable(): Promise<boolean> {
  return new Promise((r) => {
    const socket = createConnection({ host, port: Number(port) }, () => {
      socket.end();
      r(true);
    });
    socket.once('error', () => r(false));
  });
}

if (!(await reachable())) {
  const server = spawn(
    process.env.TEMPORAL_CLI ?? 'temporal',
    [
      'server',
      'start-dev',
      '--ip',
      host,
      '--port',
      port,
      '--db-filename',
      join(dataDir, 'temporal.db'),
      '--namespace',
      config.namespace,
      '--log-level',
      'warn',
    ],
    { stdio: 'inherit' },
  );
  children.push(server);
  const deadline = Date.now() + 30_000;
  while (!(await reachable())) {
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error('temporal dev server did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
}

let manifestPath = process.env.SYNQ_WORKFLOW_MANIFEST;
if (!manifestPath) {
  const local = await bootstrapLocalEnvironment({
    dataDir: join(dataDir, `local-${Date.now()}`),
    databaseUrl:
      process.env.SYNQ_WORKFLOW_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p07_dev',
    mandateTtlSeconds: 24 * 3600,
  });
  manifestPath = local.manifestPath;
  process.once('exit', () => void local.close());
  process.stdout.write(
    `local anvil environment: ${local.manifest.rpcUrl} manifest ${manifestPath}\n`,
  );
}
const worker = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    fileURLToPath(new URL('./local/worker-main.ts', import.meta.url)),
    manifestPath,
  ],
  { stdio: 'inherit', env: process.env },
);
children.push(worker);
process.stdout.write(
  `workflow worker on ${config.address} (${Object.values(config.taskQueues).join(', ')}); UI http://${host}:${Number(port) + 1000}\n`,
);
await new Promise((r) => worker.once('exit', r));
stop();
