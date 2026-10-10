import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  WorkflowUpdateFailedError,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  approvalRecordedSignal,
  approveUpdate,
  cancelUpdate,
  latestExecutionQuery,
  nextScheduledEventQuery,
  pauseUpdate,
  pendingApprovalsQuery,
  rejectUpdate,
  reservationStatusQuery,
  resolveEscalationUpdate,
  resumeUpdate,
  stateQuery,
} from '../../workers/workflow/src/workflows/messages.js';
import type {
  ActionExecutionWorkflow,
  ActionTuning,
  ActionWorkflowState,
} from '../../workers/workflow/src/workflows/action-execution.js';
import { startActionExecution } from '../../workers/workflow/src/client.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { fakeEconomic, type FakeOptions } from './harness/fake-economic.js';
import { startFixture } from './harness/fixtures.js';
import { fixtureControls } from './harness/controls.js';
import type { WorkflowControlRequest } from '../../workers/workflow/src/activities/types.js';
import type { ControlInput } from '../../workers/workflow/src/workflows/messages.js';

const FAST: Partial<ActionTuning> = {
  activityTimeoutSeconds: 5,
  heartbeatTimeoutSeconds: 5,
  submitTimeoutSeconds: 2,
  confirmationTimeoutSeconds: 5,
  confirmationPollSeconds: 1,
  retryInitialSeconds: 0.2,
  retryMaxSeconds: 1,
  releaseMarginSeconds: 1,
};
const human = { principalId: 'member_ops', kind: 'HUMAN' as const };

let env: TestWorkflowEnvironment;
let controlDir: string;
let controls: ReturnType<typeof fixtureControls>;
beforeAll(async () => {
  env = await startTemporal();
  controlDir = mkdtempSync(join(tmpdir(), 'synq-action-controls-'));
  controls = fixtureControls(controlDir, ['wf_group']);
});
afterAll(async () => {
  await env?.teardown();
  if (controlDir) rmSync(controlDir, { recursive: true, force: true });
});

let seq = 0;
async function run(
  options: FakeOptions,
  body: (ctx: {
    handle: WorkflowHandle<typeof ActionExecutionWorkflow>;
    fake: ReturnType<typeof fakeEconomic>;
    state: () => Promise<ActionWorkflowState>;
    control: (
      operation: WorkflowControlRequest['operation'],
      reason: string,
      principalId?: string,
    ) => Promise<ControlInput>;
  }) => Promise<void>,
  input: { approvalTimeoutSeconds?: number } = {},
  tuning: Partial<ActionTuning> = {},
) {
  const config = testConfig('action');
  const fake = fakeEconomic(options);
  await withWorkers(
    env,
    config,
    { ...fake.activities, ...controls.activities },
    async () => {
      seq++;
      const start = { ...startFixture(`${Date.now()}${seq}`), ...input };
      const handle = await env.client.workflow.start<
        typeof ActionExecutionWorkflow
      >('ActionExecutionWorkflow', {
        workflowId: `test.action.${process.pid}.${seq}`,
        taskQueue: config.taskQueues.economic,
        args: [start, { ...FAST, ...tuning }],
      });
      const state = () =>
        handle.query(stateQuery) as Promise<ActionWorkflowState>;
      await body({
        handle,
        fake,
        state,
        control: (operation, reason, principalId) =>
          controls.sign(
            start.intent.groupId,
            handle.workflowId,
            operation,
            reason,
            principalId,
          ),
      });
    },
  );
}
const awaitingApproval = (state: () => Promise<ActionWorkflowState>) =>
  eventually(state, (s) => s.waitingFor === 'APPROVAL');

describe('ActionExecutionWorkflow messages and lifecycle', () => {
  it('counts a duplicate approval update once, settles through the canonical lifecycle and answers every query', async () => {
    await run({}, async ({ handle, fake, state }) => {
      await awaitingApproval(state);
      const pending = await handle.query(pendingApprovalsQuery);
      expect(pending).toMatchObject({
        draftDigest: fake.DIGEST,
        required: 2,
        outstanding: true,
      });
      const deadline = await handle.query(nextScheduledEventQuery);
      expect(deadline.kind).toBe('APPROVAL_DEADLINE');
      expect(deadline.at).toBeGreaterThan(Date.now());

      fake.approve('member_0');
      const first = await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_0', draftDigest: fake.DIGEST }],
      });
      const duplicate = await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_0', draftDigest: fake.DIGEST }],
      });
      await handle.signal(approvalRecordedSignal, {
        memberId: 'member_0',
        draftDigest: fake.DIGEST,
      });
      expect(first).toEqual({ counted: 1, required: 2, satisfied: false });
      expect(duplicate).toEqual({ counted: 1, required: 2, satisfied: false });
      expect((await state()).waitingFor).toBe('APPROVAL');
      expect(fake.count('authorize')).toBe(1);

      fake.approve('member_1');
      const second = await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_1', draftDigest: fake.DIGEST }],
      });
      expect(second).toEqual({ counted: 2, required: 2, satisfied: true });
      const result = await handle.result();
      expect(result.outcome).toBe('SETTLED');
      expect(result.approvals).toEqual(['member_0', 'member_1']);
      expect(result.actionState).toBe('RECONCILED');
      expect(result.txState).toBe('SETTLED');
      const final = await state();
      expect(final.txLifecycle.map((s) => s.to)).toEqual([
        'SIGNED',
        'SUBMITTED',
        'INCLUDED',
        'CONFIRMED',
        'INDEXED',
        'RECONCILED',
        'SETTLED',
      ]);
      expect(final.kernelLifecycle.map((s) => s.to)).toEqual([
        'RISKED',
        'SIMULATED',
        'PENDING_APPROVAL',
        'AUTHORIZED',
        'PREPARED',
      ]);
      expect(final.journalLifecycle.map((s) => s.to)).toEqual([
        'SIGNED',
        'SUBMITTED',
        'CONFIRMED',
        'INDEXED',
        'RECONCILED',
      ]);
      expect(await handle.query(latestExecutionQuery)).toMatchObject({
        txState: 'SETTLED',
        outcome: 'SUCCESS',
      });
      expect(await handle.query(reservationStatusQuery)).toMatchObject({
        state: 'RECONCILED',
        reservedToken: '0',
      });
      expect(fake.count('authorize')).toBe(2);
      expect(fake.count('signAndSubmit')).toBe(1);
      expect(fake.state.broadcasts).toBe(1);
    });
  });

  it('rejects malformed or out-of-phase messages through update validators', async () => {
    await run({}, async ({ handle, fake, state }) => {
      await awaitingApproval(state);
      await expect(
        handle.executeUpdate(approveUpdate, {
          args: [{ memberId: 'member_0', draftDigest: `0x${'00'.repeat(32)}` }],
        }),
      ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      await expect(
        handle.executeUpdate(approveUpdate, {
          args: [{ memberId: 'bad id!', draftDigest: fake.DIGEST }],
        }),
      ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      await expect(
        handle.executeUpdate(resolveEscalationUpdate, {
          args: [
            {
              resolvedBy: human,
              resolution: 'RETRY',
              note: 'nothing to resolve',
            },
          ],
        }),
      ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      await expect(
        handle.executeUpdate(resumeUpdate, {
          args: [{ requestedBy: human, reason: 'not paused' }],
        }),
      ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      await expect(
        handle.executeUpdate(cancelUpdate, {
          args: [
            { requestedBy: { principalId: '', kind: 'HUMAN' }, reason: 'x' },
          ],
        }),
      ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
      expect(fake.count('readQuorum')).toBe(0);
      fake.approve('member_0');
      fake.approve('member_1');
      await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_1', draftDigest: fake.DIGEST }],
      });
      await handle.result();
      await expect(
        handle.executeUpdate(cancelUpdate, {
          args: [{ requestedBy: human, reason: 'too late' }],
        }),
      ).rejects.toThrow();
    });
  });

  it('cancelling while approvals are pending ends the intent with no claim, signature or broadcast', async () => {
    await run({}, async ({ handle, fake, state, control }) => {
      await awaitingApproval(state);
      fake.approve('member_0');
      await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_0', draftDigest: fake.DIGEST }],
      });
      await handle.executeUpdate(cancelUpdate, {
        args: [await control('CANCEL', 'changed our mind')],
      });
      const result = await handle.result();
      expect(result.outcome).toBe('CANCELLED');
      expect(result.actionState).toBe('CANCELLED');
      expect(fake.count('claimAndPrepare') + fake.count('signAndSubmit')).toBe(
        0,
      );
      expect(fake.state.broadcasts).toBe(0);
      expect(fake.state.grant).toBe('NONE');
    });
  });

  it('a member veto (reject) ends the intent before authorization', async () => {
    await run({}, async ({ handle, state, fake, control }) => {
      await awaitingApproval(state);
      await handle.executeUpdate(rejectUpdate, {
        args: [
          {
            memberId: 'member_2',
            ...(await control('REJECT', 'recipient unknown', 'member_2')),
          },
        ],
      });
      const result = await handle.result();
      expect(result.outcome).toBe('CANCELLED');
      expect(fake.count('claimAndPrepare')).toBe(0);
    });
  });

  it('cancelling after authorization never executes and releases the reservation after grant expiry', async () => {
    let release!: () => void;
    const claimLatch = new Promise<void>((r) => (release = r));
    await run(
      { autoAuthorize: true, validUntilSeconds: 2, claimLatch },
      async ({ handle, fake, state, control }) => {
        await eventually(
          async () => fake.count('claimAndPrepare'),
          (n) => n === 1,
        );
        await handle.executeUpdate(cancelUpdate, {
          args: [await control('CANCEL', 'operator stop')],
        });
        release();
        await eventually(state, (s) => s.waitingFor === 'RESERVATION_RELEASE');
        expect((await handle.query(nextScheduledEventQuery)).kind).toBe(
          'RESERVATION_RELEASE',
        );
        const result = await handle.result();
        expect(result.outcome).toBe('CANCELLED');
        expect(result.reservation?.state).toBe('RELEASED');
        expect(result.reservation?.reservedToken).toBe('0');
        expect(fake.count('signAndSubmit')).toBe(0);
        expect(fake.state.broadcasts).toBe(0);
      },
    );
  });

  it('pause holds the economic path until resume', async () => {
    await run({}, async ({ handle, fake, state, control }) => {
      await awaitingApproval(state);
      await handle.executeUpdate(pauseUpdate, {
        args: [await control('PAUSE', 'investigating')],
      });
      fake.approve('member_0');
      fake.approve('member_1');
      await handle.executeUpdate(approveUpdate, {
        args: [{ memberId: 'member_1', draftDigest: fake.DIGEST }],
      });
      await eventually(state, (s) => s.waitingFor === 'RESUME');
      await new Promise((r) => setTimeout(r, 500));
      expect(fake.count('authorize')).toBe(1);
      expect(fake.count('claimAndPrepare')).toBe(0);
      await handle.executeUpdate(resumeUpdate, {
        args: [await control('RESUME', 'clear')],
      });
      expect((await handle.result()).outcome).toBe('SETTLED');
    });
  });

  it('an emergency autonomy freeze parks the intent until an explicit resume', async () => {
    await run(
      { autoAuthorize: true },
      async ({ handle, fake, state, control }) => {
        fake.state.frozen = true;
        await eventually(state, (s) => s.waitingFor === 'RESUME' && s.paused);
        expect(fake.count('attestEvidence')).toBe(0);
        fake.state.frozen = false;
        await handle.executeUpdate(resumeUpdate, {
          args: [await control('RESUME', 'incident closed')],
        });
        expect((await handle.result()).outcome).toBe('SETTLED');
      },
    );
  });

  it('provider 500s on confirmation back off exponentially and retry without resubmitting', async () => {
    await run(
      { autoAuthorize: true, confirmFailures: 3 },
      async ({ handle, fake }) => {
        expect((await handle.result()).outcome).toBe('SETTLED');
        const attempts = fake.calls.confirmInclusion!;
        expect(attempts).toHaveLength(4);
        const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
        expect(gaps[0]!).toBeGreaterThanOrEqual(900);
        expect(gaps[2]!).toBeGreaterThanOrEqual(3500);
        expect(gaps[2]!).toBeGreaterThan(gaps[0]! * 2.5);
        expect(fake.count('signAndSubmit')).toBe(1);
        expect(fake.state.broadcasts).toBe(1);
      },
      {},
      {
        retryInitialSeconds: 1,
        retryMaxSeconds: 8,
        confirmationTimeoutSeconds: 15,
        heartbeatTimeoutSeconds: 15,
      },
    );
  });

  it('a submit timeout after broadcast routes to reconciliation, never to a second submission', async () => {
    await run(
      { autoAuthorize: true, submitHangMs: 4000, journalOnHang: true },
      async ({ handle, fake, state }) => {
        const result = await handle.result();
        expect(result.outcome).toBe('SETTLED');
        expect(fake.count('signAndSubmit')).toBe(1);
        expect(fake.count('checkSubmission')).toBe(1);
        expect(fake.state.broadcasts).toBe(1);
        expect((await state()).submitReconciliations).toBe(1);
      },
    );
  });

  it('a submit timeout before any journal entry is reconciled first, then submitted once', async () => {
    await run(
      { autoAuthorize: true, submitHangMs: 4000, journalOnHang: false },
      async ({ handle, fake }) => {
        expect((await handle.result()).outcome).toBe('SETTLED');
        expect(fake.count('checkSubmission')).toBe(1);
        expect(fake.count('signAndSubmit')).toBe(2);
        const firstCheck = fake.calls.checkSubmission![0]!;
        expect(fake.calls.signAndSubmit![1]!).toBeGreaterThan(firstCheck);
      },
    );
  });

  it('a reverted execution escalates and can be abandoned by a human', async () => {
    await run(
      { autoAuthorize: true, revert: true },
      async ({ handle, state, control }) => {
        await eventually(state, (s) => s.waitingFor === 'ESCALATION');
        expect((await state()).escalation?.reason).toContain(
          'EXECUTION_REVERTED',
        );
        await handle.executeUpdate(resolveEscalationUpdate, {
          args: [
            {
              resolvedBy: human,
              resolution: 'ABANDON',
              note: 'reverted on chain; nothing moved',
              authorization: (
                await control(
                  'RESOLVE_ABANDON',
                  'reverted on chain; nothing moved',
                )
              ).authorization,
            },
          ],
        });
        expect((await handle.result()).outcome).toBe('ABANDONED');
      },
    );
  });

  it('the approval deadline timer expires an unapproved intent', async () => {
    await run(
      {},
      async ({ handle, fake }) => {
        const result = await handle.result();
        expect(result.outcome).toBe('EXPIRED');
        expect(result.actionState).toBe('EXPIRED');
        expect(fake.count('claimAndPrepare')).toBe(0);
      },
      { approvalTimeoutSeconds: 2 },
    );
  });
});

describe('one workflow per intent', () => {
  it('derives the workflow id from the canonical intent id and rejects duplicates while running and after completion', async () => {
    const config = testConfig('dup');
    const fake = fakeEconomic({ autoAuthorize: true });
    await withWorkers(env, config, fake.activities, async () => {
      const nonce = `${Date.now()}`;
      const now = Math.floor(Date.now() / 1000);
      const first = await startActionExecution(
        env.client,
        config,
        startFixture(nonce, { proposedId: 'brain_a', now }),
        FAST,
      );
      const again = await startActionExecution(
        env.client,
        config,
        startFixture(nonce, { proposedId: 'brain_b', now }),
        FAST,
      );
      expect(first.started).toBe(true);
      expect(again).toEqual({
        started: false,
        workflowId: first.workflowId,
        reason: 'DUPLICATE_WORKFLOW_ID',
      });
      expect(first.workflowId).toMatch(/^synq\.action\.intent_[0-9a-f]{64}$/);
      if (!first.started) throw new Error('unreachable');
      await first.handle.result();
      const after = await startActionExecution(
        env.client,
        config,
        startFixture(nonce, { now }),
        FAST,
      );
      expect(after.started).toBe(false);
      expect(fake.state.broadcasts).toBe(1);
    });
  });
});
