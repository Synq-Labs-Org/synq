import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  bootstrapLocalEnvironment,
  type LocalEnvironment,
} from '../../workers/workflow/src/local/bootstrap.js';
import type { DcaStrategy } from '../../workers/workflow/src/activities/types.js';
import type { DcaTickResult } from '../../workers/workflow/src/workflows/dca.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { WorkerProcess } from './harness/worker-process.js';
import { testDatabaseUrl } from '../durable/pg.js';

const DATABASE_URL = testDatabaseUrl(
  'SYNQ_WORKFLOW_DCA_ENGINE_DATABASE_URL',
  'synq_p07_dca_engine',
);
const INTERVAL = 5;
const TRANCHE = 1_000_000n;

type Tick = {
  strategyId: string;
  tickKey: string;
  decision: string;
  childWorkflowId: string | null;
  pid: number;
};

let env: TestWorkflowEnvironment;
let local: LocalEnvironment;
let dataDir: string;
const config = testConfig('dcaengine');

beforeAll(async () => {
  env = await startTemporal();
  dataDir = mkdtempSync(join(tmpdir(), 'synq-dca-engine-'));
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

const ticks = async (strategyId: string): Promise<Tick[]> =>
  existsSync(local.manifest.ticksFile)
    ? (
        JSON.parse(readFileSync(local.manifest.ticksFile, 'utf8')) as Tick[]
      ).filter((t) => t.strategyId === strategyId)
    : [];
const result = (tickKey: string) =>
  env.client.workflow.getHandle(tickKey).result() as Promise<DcaTickResult>;

describe('DCA ticks evaluated by the deterministic strategy engine through Temporal', () => {
  it('the engine sees pending lots from before a worker crash and stops at the policy budget after restart', async () => {
    const strategyId = `dcaengine${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const token = local.manifest.token.toLowerCase();
    const policies = {
      [strategyId]: {
        strategyId,
        startAt: now - 10,
        expiresAt: now + 3_600,
        frequencySeconds: 1,
        budgetAsset: {
          symbol: 'TKN',
          address: token,
          decimals: local.manifest.asset.decimals,
          chainId: local.manifest.asset.chainId,
        },
        targetAsset: {
          symbol: 'MON',
          address: 'native',
          decimals: 18,
          chainId: local.manifest.asset.chainId,
        },
        allowedAssets: [token, 'native'],
        venue: 'local-anvil',
        allowedVenues: ['local-anvil'],
        baseTranche: TRANCHE.toString(),
        maxTranche: TRANCHE.toString(),
        minTranche: TRANCHE.toString(),
        budget: (3n * TRANCHE).toString(),
        maxDeployment: (3n * TRANCHE).toString(),
        maxAllocationBps: 10_000,
        maxSlippageBps: 0,
        spike: { skipIf24hChangeAboveBps: 800 },
        dip: { multiplierBps: 15_000, triggerBelowTrailingBps: 1_000 },
        maxMarketDataAgeSeconds: 300,
        pause: { paused: false },
      },
    };
    const policyFile = join(dataDir, 'dca-policies.json');
    writeFileSync(policyFile, JSON.stringify(policies));
    const strategy: DcaStrategy = {
      strategyId,
      groupId: local.manifest.groupId,
      mandateId: local.manifest.mandate.mandateId,
      mandateVersion: local.manifest.mandate.version,
      inputAmountPerTick: TRANCHE.toString(),
      maxSlippageBps: 0,
      maxTicks: 100,
    };
    const start = () =>
      WorkerProcess.start({
        manifestPath: local.manifestPath,
        address: env.address,
        config,
        extraEnv: { SYNQ_DCA_POLICY_FILE: policyFile },
      });

    let worker = await start();
    const firstPid = worker.pid;
    const { scheduleId } = await runClient({
      action: 'create',
      strategy,
      intervalSeconds: INTERVAL,
    });

    const before = await eventually(
      () => ticks(strategyId),
      (t) => t.some((x) => x.pid === firstPid && x.decision === 'EXECUTE'),
      60_000,
      250,
    );
    const first = await result(before[0]!.tickKey);
    expect(first.decision).toBe('EXECUTE');
    expect(first.reasons).toContain('SCHEDULED');
    expect(
      first.reasons.some((r) => r.startsWith(`DECISION:${strategyId}:`)),
    ).toBe(true);

    await worker.kill9();
    await new Promise((r) => setTimeout(r, (INTERVAL + 2) * 1000));
    worker = await start();

    const all = await eventually(
      () => ticks(strategyId),
      (t) => t.some((x) => x.pid === worker.pid && x.decision === 'SKIP'),
      120_000,
      250,
    );
    const executed = all.filter((x) => x.decision === 'EXECUTE');
    expect(executed).toHaveLength(3);
    expect(executed.some((x) => x.pid === firstPid)).toBe(true);
    expect(executed.some((x) => x.pid === worker.pid)).toBe(true);
    expect(new Set(all.map((x) => x.tickKey)).size).toBe(all.length);
    expect(new Set(executed.map((x) => x.childWorkflowId)).size).toBe(3);
    const stopped = await result(
      all.find((x) => x.pid === worker.pid && x.decision === 'SKIP')!.tickKey,
    );
    expect(stopped.reasons).toContain('BUDGET_EXHAUSTED');
    expect(all.filter((x) => x.decision === 'ESCALATE')).toEqual([]);

    await env.client.schedule.getHandle(String(scheduleId)).delete();
    await worker.stop();
  });
});
