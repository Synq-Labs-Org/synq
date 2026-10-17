import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  bootstrapLocalEnvironment,
  type LocalEnvironment,
} from '../../workers/workflow/src/local/bootstrap.js';
import type { DcaStrategy } from '../../workers/workflow/src/activities/types.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { WorkerProcess } from './harness/worker-process.js';
import { testDatabaseUrl } from '../durable/pg.js';

const DATABASE_URL = testDatabaseUrl(
  'SYNQ_WORKFLOW_DCA_DATABASE_URL',
  'synq_p07_dca',
);
const INTERVAL = 5;

type Tick = {
  strategyId: string;
  tickKey: string;
  decision: string;
  childWorkflowId: string | null;
  recordedAt: string;
  pid: number;
};

let env: TestWorkflowEnvironment;
let local: LocalEnvironment;
let dataDir: string;
const config = testConfig('dca');

beforeAll(async () => {
  env = await startTemporal();
  dataDir = mkdtempSync(join(tmpdir(), 'synq-dca-'));
  local = await bootstrapLocalEnvironment({
    dataDir,
    databaseUrl: DATABASE_URL,
  });
});
afterAll(async () => {
  await WorkerProcess.killAll();
  await local?.close();
  await env?.teardown();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A separate client process per call: nothing about the schedule lives in this test process. */
function runClient(
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('tests/workflow/harness/dca-client.ts')],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TEMPORAL_ADDRESS: env.address,
          SYNQ_TQ_ECONOMIC: config.taskQueues.economic,
          SYNQ_TQ_APPROVAL: config.taskQueues.approval,
          SYNQ_TQ_STRATEGY: config.taskQueues.strategy,
          SYNQ_TQ_OPERATIONS: config.taskQueues.operations,
          SYNQ_DCA_CLIENT_REQUEST: JSON.stringify(request),
        },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (err += String(c)));
    child.once('exit', (code) =>
      code === 0
        ? resolveRun(JSON.parse(out.trim().split('\n').at(-1)!))
        : reject(new Error(`client exited ${code}: ${err}`)),
    );
  });
}

const ticks = async (): Promise<Tick[]> =>
  existsSync(local.manifest.ticksFile)
    ? (JSON.parse(readFileSync(local.manifest.ticksFile, 'utf8')) as Tick[])
    : [];
const scheduledAt = (tickKey: string) =>
  Date.parse(tickKey.slice(tickKey.indexOf('.tick-') + 6));

describe('durable DCA cadence', () => {
  it('a Temporal Schedule keeps ticking across a full restart of the worker and the client processes', async () => {
    const strategy: DcaStrategy = {
      strategyId: `dca${Date.now()}`,
      groupId: local.manifest.groupId,
      mandateId: local.manifest.mandate.mandateId,
      mandateVersion: local.manifest.mandate.version,
      inputAmountPerTick: '1000000',
      maxSlippageBps: 0,
      maxTicks: 100,
    };
    let worker = await WorkerProcess.start({
      manifestPath: local.manifestPath,
      address: env.address,
      config,
    });
    const firstPid = worker.pid;
    const created = await runClient({
      action: 'create',
      strategy,
      intervalSeconds: INTERVAL,
    });
    expect(created.pid).not.toBe(process.pid);
    const scheduleId = String(created.scheduleId);

    const beforeCrash = await eventually(
      ticks,
      (t) => t.some((x) => x.pid === firstPid),
      60_000,
      250,
    );
    expect(beforeCrash[0]).toMatchObject({
      decision: 'EXECUTE',
      strategyId: strategy.strategyId,
    });
    expect(beforeCrash[0]!.childWorkflowId).toMatch(
      /^synq\.action\.intent_[0-9a-f]{64}$/,
    );

    await worker.kill9();
    const downAt = Date.now();
    await new Promise((r) => setTimeout(r, (INTERVAL + 2) * 1000));
    worker = await WorkerProcess.start({
      manifestPath: local.manifestPath,
      address: env.address,
      config,
    });
    const upAt = Date.now();
    const described = await runClient({ action: 'describe', scheduleId });
    expect(described).toMatchObject({ paused: false, overlap: 'SKIP' });

    const afterRestart = await eventually(
      ticks,
      (t) =>
        t.some((x) => x.pid === worker.pid && scheduledAt(x.tickKey) > upAt),
      60_000,
      250,
    );
    const resumed = afterRestart.filter((x) => x.pid === worker.pid);
    expect(
      resumed.some((x) => scheduledAt(x.tickKey) >= downAt - INTERVAL * 1000),
    ).toBe(true);
    expect(new Set(afterRestart.map((x) => x.tickKey)).size).toBe(
      afterRestart.length,
    );
    expect(
      resumed.every(
        (x) =>
          x.decision === 'EXECUTE' &&
          x.childWorkflowId?.startsWith('synq.action.'),
      ),
    ).toBe(true);
    const child = await env.client.workflow
      .getHandle(resumed.at(-1)!.childWorkflowId!)
      .describe();
    expect(child.status.name).toBe('RUNNING');

    await env.client.schedule.getHandle(scheduleId).delete();
    await worker.stop();
  });
});
