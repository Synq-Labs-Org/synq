import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { PublicClient } from 'viem';
import { startActionExecution } from '../../workers/workflow/src/client.js';
import type { CrashPoint } from '../../workers/workflow/src/activities/faults.js';
import type {
  ActionExecutionWorkflow,
  ActionTuning,
  ActionWorkflowState,
} from '../../workers/workflow/src/workflows/action-execution.js';
import {
  approvalRecordedSignal,
  approveUpdate,
  nextScheduledEventQuery,
  stateQuery,
} from '../../workers/workflow/src/workflows/messages.js';
import {
  bootstrapLocalEnvironment,
  type LocalEnvironment,
} from '../../workers/workflow/src/local/bootstrap.js';
import { localTransferStart } from '../../workers/workflow/src/local/proposal.js';
import {
  ExecutionJournal,
  readIntegrityKey,
} from '../../workers/execution/src/index.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { WorkerProcess, waitForMarker } from './harness/worker-process.js';
import {
  balanceOf,
  chainSpent,
  grantExecutions,
  memberApproves,
  persistedKernel,
} from './harness/local-checks.js';
import type { WorkflowHandle } from '@temporalio/client';

const DATABASE_URL =
  process.env.SYNQ_WORKFLOW_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p07_gauntlet';
const TUNING: Partial<ActionTuning> = {
  activityTimeoutSeconds: 30,
  heartbeatTimeoutSeconds: 3,
  submitTimeoutSeconds: 15,
  confirmationTimeoutSeconds: 20,
  confirmationPollSeconds: 1,
  retryInitialSeconds: 0.5,
  retryMaxSeconds: 2,
};

type Row = {
  killPoint: string;
  outcome: string;
  onchainExecutions: number;
  ledgerSpentEqualsChain: boolean;
  reservedToken: string;
  outstandingReservations: number;
  approvals: string;
  timer: string;
  submitReconciliations: number;
  kernelSubmissions: number;
};
const rows: Row[] = [];

let env: TestWorkflowEnvironment;
let local: LocalEnvironment;
let dataDir: string;
const config = testConfig('gauntlet');
let nonce = 1000;

beforeAll(async () => {
  env = await startTemporal();
  dataDir = mkdtempSync(join(tmpdir(), 'synq-gauntlet-'));
  local = await bootstrapLocalEnvironment({
    dataDir,
    databaseUrl: DATABASE_URL,
  });
});
afterAll(async () => {
  await WorkerProcess.killAll();
  await local?.close();
  await env?.teardown();
  if (rows.length) {
    const dir = resolve('reports/workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'crash-gauntlet.json'),
      JSON.stringify(rows, null, 2) + '\n',
    );
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const client = () => local.chain.client as unknown as PublicClient;
const spawnWorker = (crashAt?: CrashPoint, faultDir?: string) =>
  WorkerProcess.start({
    manifestPath: local.manifestPath,
    address: env.address,
    config,
    ...(crashAt ? { crashAt } : {}),
    ...(faultDir ? { faultDir } : {}),
  });

async function startIntent(amount: bigint, approvalTimeoutSeconds?: number) {
  nonce++;
  const start = await localTransferStart(local.manifest, client(), {
    nonce: String(nonce),
    amount,
  });
  if (approvalTimeoutSeconds !== undefined) {
    const handle = await env.client.workflow.start<
      typeof ActionExecutionWorkflow
    >('ActionExecutionWorkflow', {
      workflowId: `gauntlet.timer.${nonce}`,
      taskQueue: config.taskQueues.economic,
      args: [{ ...start, approvalTimeoutSeconds }, TUNING],
    });
    return { start, handle };
  }
  const outcome = await startActionExecution(env.client, config, start, TUNING);
  if (!outcome.started) throw new Error('duplicate start');
  return { start, handle: outcome.handle };
}

const stateOf = (handle: WorkflowHandle<typeof ActionExecutionWorkflow>) =>
  handle.query(stateQuery) as Promise<ActionWorkflowState>;
async function awaitingApproval(
  handle: WorkflowHandle<typeof ActionExecutionWorkflow>,
) {
  const s = await eventually(
    () => stateOf(handle),
    (x) => x.waitingFor === 'APPROVAL',
    60_000,
  );
  return s.approval!.draftDigest;
}
async function approve(
  handle: WorkflowHandle<typeof ActionExecutionWorkflow>,
  digest: string,
  index: number,
) {
  await memberApproves(local, digest, index);
  return handle.executeUpdate(approveUpdate, {
    args: [{ memberId: `member_${index}`, draftDigest: digest }],
  });
}

async function verify(
  killPoint: string,
  handle: WorkflowHandle<typeof ActionExecutionWorkflow>,
  amount: bigint,
  recipientBefore: bigint,
  timer = 'n/a',
) {
  const result = await handle.result();
  const final = await stateOf(handle);
  const executions = (await grantExecutions(local)).filter(
    (e) => e.grantHash === result.grantId,
  );
  const kernel = await persistedKernel(local);
  const spent = await chainSpent(local);
  const outstanding = kernel.grants.filter((g) =>
    ['RESERVED', 'CONSUMED', 'PREPARED', 'REVERTED'].includes(g.state),
  );
  const journal = new ExecutionJournal(
    local.manifest.journalDirectory,
    undefined,
    undefined,
    {
      bytes: readIntegrityKey(local.manifest.journalKeyFile, [
        local.manifest.journalDirectory,
      ]),
      path: local.manifest.journalKeyFile,
      source: 'FILE',
    },
  );
  const entry = journal.get(result.grantId!);
  const row: Row = {
    killPoint,
    outcome: result.outcome,
    onchainExecutions: executions.length,
    ledgerSpentEqualsChain: BigInt(kernel.budget?.spentToken ?? -1) === spent,
    reservedToken: String(kernel.budget?.reservedToken ?? 'missing'),
    outstandingReservations: outstanding.length,
    approvals: result.approvals.join('+'),
    timer,
    submitReconciliations: final.submitReconciliations,
    kernelSubmissions:
      kernel.grants.find((g) => g.grantId === result.grantId)?.submissions
        .length ?? 0,
  };
  rows.push(row);
  expect(result.outcome).toBe('SETTLED');
  expect(result.txState).toBe('SETTLED');
  expect(result.actionState).toBe('RECONCILED');
  expect(executions).toHaveLength(1);
  expect(executions[0]!.tokenAmount).toBe(amount);
  expect(await balanceOf(local, local.manifest.recipient)).toBe(
    recipientBefore + amount,
  );
  expect(row.ledgerSpentEqualsChain).toBe(true);
  expect(row.reservedToken).toBe('0');
  expect(outstanding).toEqual([]);
  expect(result.approvals).toEqual(['member_0', 'member_1']);
  expect(row.kernelSubmissions).toBe(1);
  const grant = kernel.grants.find((g) => g.grantId === result.grantId)!;
  expect(grant.state).toBe('RECONCILED');
  expect(grant.execution?.transactionHash).toBe(entry?.transactionHash);
  expect(entry?.state).toBe('SETTLED');
  expect(
    journal
      .history(result.grantId!)
      .map((t) => t.to)
      .at(-1),
  ).toBe('SETTLED');
  expect(final.txLifecycle.at(-1)?.to).toBe('SETTLED');
  const all = await grantExecutions(local);
  expect(new Set(all.map((e) => e.grantHash)).size).toBe(all.length);
  return { result, final };
}

describe('crash gauntlet: SIGKILL the worker process at every economic boundary', () => {
  it('kill while waiting for approval: approvals and the approval timer survive', async () => {
    const amount = 1_000_001n;
    const before = await balanceOf(local, local.manifest.recipient);
    let worker = await spawnWorker();
    try {
      const { handle } = await startIntent(amount);
      const digest = await awaitingApproval(handle);
      expect(await approve(handle, digest, 0)).toMatchObject({
        counted: 1,
        satisfied: false,
      });
      const deadline = (await handle.query(nextScheduledEventQuery)).at;
      await worker.kill9();
      await memberApproves(local, digest, 1);
      await handle.signal(approvalRecordedSignal, {
        memberId: 'member_1',
        draftDigest: digest,
      });
      worker = await spawnWorker();
      const { final } = await verify(
        'approval-wait',
        handle,
        amount,
        before,
        'deadline unchanged',
      );
      expect(final.approval?.deadline).toBe(deadline);
    } finally {
      await worker.stop();
    }
  });

  const points: [CrashPoint, bigint][] = [
    ['before-activity', 1_000_002n],
    ['during-activity', 1_000_003n],
    ['after-submit-before-response', 1_000_004n],
    ['after-confirm-before-db', 1_000_005n],
    ['before-reconciliation', 1_000_006n],
    ['after-reconciliation-before-completion', 1_000_007n],
  ];
  it.each(points)(
    'kill at %s: exactly one execution, ledger equals chain, no orphaned reservation',
    async (point, amount) => {
      const faultDir = mkdtempSync(join(dataDir, `fault-${point}-`));
      const before = await balanceOf(local, local.manifest.recipient);
      let worker = await spawnWorker(point, faultDir);
      try {
        const { handle } = await startIntent(amount);
        const digest = await awaitingApproval(handle);
        await approve(handle, digest, 0);
        expect(
          await handle.executeUpdate(approveUpdate, {
            args: [{ memberId: 'member_0', draftDigest: digest }],
          }),
        ).toMatchObject({ counted: 1 });
        await approve(handle, digest, 1);
        await waitForMarker(faultDir, point, worker);
        await worker.kill9();
        worker = await spawnWorker();
        const { final } = await verify(point, handle, amount, before);
        if (['during-activity', 'after-submit-before-response'].includes(point))
          expect(final.submitReconciliations).toBe(1);
      } finally {
        await worker.stop();
      }
    },
  );

  it('kill during the approval wait and stay down past the deadline: the durable timer still expires the intent', async () => {
    let worker = await spawnWorker();
    try {
      const { handle } = await startIntent(1_000_008n, 8);
      await awaitingApproval(handle);
      const deadline = (await handle.query(nextScheduledEventQuery)).at!;
      await worker.kill9();
      await new Promise((r) =>
        setTimeout(r, Math.max(0, deadline - Date.now()) + 1000),
      );
      worker = await spawnWorker();
      const result = await handle.result();
      expect(result.outcome).toBe('EXPIRED');
      expect(result.grantId).toBeNull();
      const kernel = await persistedKernel(local);
      expect(
        kernel.grants.filter((g) =>
          ['RESERVED', 'CONSUMED', 'PREPARED'].includes(g.state),
        ),
      ).toEqual([]);
      rows.push({
        killPoint: 'approval-timer (down past deadline)',
        outcome: result.outcome,
        onchainExecutions: 0,
        ledgerSpentEqualsChain:
          BigInt(kernel.budget?.spentToken ?? -1) === (await chainSpent(local)),
        reservedToken: String(kernel.budget?.reservedToken ?? 'missing'),
        outstandingReservations: 0,
        approvals: 'none',
        timer: 'fired after restart',
        submitReconciliations: 0,
        kernelSubmissions: 0,
      });
    } finally {
      await worker.stop();
    }
  });
});
