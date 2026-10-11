import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import type { StartMandateApproval } from '@synq/schemas';
import {
  createApprovalActivities,
  mandateApprovalDigest,
} from '../../workers/workflow/src/activities/approval.js';
import { approveMandateUpdate } from '../../workers/workflow/src/workflows/mandate-approval.js';
import { FileAutonomyFreeze } from '../../workers/workflow/src/activities/freeze.js';
import type {
  FundingActivities,
  HedgeActivities,
  OperationsActivities,
  ApprovalActivities,
} from '../../workers/workflow/src/activities/types.js';
import {
  resumeUpdate,
  stateQuery,
  cancelSignal,
  cancelUpdate,
} from '../../workers/workflow/src/workflows/messages.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { fakeEconomic } from './harness/fake-economic.js';
import { startFixture } from './harness/fixtures.js';
import { fixtureControls } from './harness/controls.js';

let env: TestWorkflowEnvironment;
let dir: string;
let controls: ReturnType<typeof fixtureControls>;
beforeAll(async () => {
  env = await startTemporal();
  dir = mkdtempSync(join(tmpdir(), 'synq-independent-critic-'));
  controls = fixtureControls(join(dir, 'controls'), [
    'victim_group',
    'wf_group',
  ]);
});
afterAll(async () => {
  await env?.teardown();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function proposal(proposalId = 'proposal'): StartMandateApproval {
  return {
    schemaVersion: 1,
    proposalId,
    kind: 'SUPERSEDE',
    mandateRef: {
      groupId: 'victim_group' as never,
      mandateId: 'mandate' as never,
      version: 2,
    },
    mandateHash: keccak256(toHex('mandate version two')),
    securitySensitive: true,
    approvers: ['owner' as never],
    requiredApprovals: 1,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    requestedBy: { principalId: 'owner' as never, kind: 'HUMAN' },
    correlationId: 'corr' as never,
  };
}

describe('SIMULATION corrected independent critic regressions', () => {
  it('reports UNRESOLVED when the Kernel application returns applied=false and an older version', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const stored = {
      proposal: proposal(),
      membershipEpoch: 4,
      requiredApprovals: 1,
    };
    const acts = createApprovalActivities({
      resolveProposal: async (id) =>
        id === stored.proposal.proposalId ? stored : null,
      members: async () => [{ memberId: 'owner', signer: owner.address }],
      observeMandate: async () => ({ observed: true, block: '1' }),
      applyMandate: async () => ({ applied: false, version: 1 }),
      notify: async () => ({ delivered: true }),
    });
    const config = testConfig('critic-mandate-application');
    await withWorkers(env, config, acts, async () => {
      const handle = await env.client.workflow.start(
        'MandateApprovalWorkflow',
        {
          workflowId: `critic.mandate.${process.pid}`,
          taskQueue: config.taskQueues.approval,
          args: [stored.proposal],
        },
      );
      const signature = await owner.signMessage({
        message: { raw: mandateApprovalDigest(stored) },
      });
      await handle.executeUpdate(approveMandateUpdate, {
        args: [{ memberId: 'owner', signature }],
      });
      expect(await handle.result()).toMatchObject({
        outcome: 'UNRESOLVED',
        onchainBlock: '1',
      });
    });
  });
  it('refuses a claimed AGENT outsider and leaves the persistent emergency freeze intact', async () => {
    const freeze = new FileAutonomyFreeze(join(dir, 'freeze.json'));
    let unfreezes = 0;
    const acts: Partial<OperationsActivities & ApprovalActivities> = {
      freezeAutonomy: async ({ groupId, reason, incidentId }) => ({
        frozen: true,
        since: (await freeze.freeze(groupId, reason, incidentId)).since,
      }),
      unfreezeAutonomy: async ({ groupId, incidentId }) => {
        unfreezes++;
        await freeze.unfreeze(groupId, incidentId);
        return { frozen: (await freeze.status(groupId)).frozen };
      },
      prepareSafePause: async () => ({
        safe: `0x${'aa'.repeat(20)}`,
        to: `0x${'bb'.repeat(20)}`,
        data: '0x',
      }),
      observeOnchainPause: async () => ({ paused: false, block: '1' }),
      notify: async () => ({ delivered: true }),
    };
    const config = testConfig('critic-freeze');
    await withWorkers(
      env,
      config,
      { ...acts, ...controls.activities },
      async () => {
        const handle = await env.client.workflow.start(
          'EmergencyPauseWorkflow',
          {
            workflowId: `critic.freeze.${process.pid}`,
            taskQueue: config.taskQueues.operations,
            args: [
              {
                groupId: 'victim_group',
                incidentId: 'incident',
                reason: 'risk alert',
                requestedBy: { principalId: 'owner', kind: 'HUMAN' },
                pollSeconds: 1,
              },
            ],
          },
        );
        await eventually(
          () => handle.query(stateQuery) as Promise<{ frozen: boolean }>,
          (s) => s.frozen,
        );
        await expect(
          handle.executeUpdate(resumeUpdate, {
            args: [
              {
                requestedBy: { principalId: 'outsider', kind: 'AGENT' },
                reason: 'attacker resume',
              },
            ],
          }),
        ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
        expect((await freeze.status('victim_group')).frozen).toBe(true);
        expect(unfreezes).toBe(0);
        await handle.executeUpdate(resumeUpdate, {
          args: [
            await controls.sign(
              'victim_group',
              handle.workflowId,
              'RESUME_EMERGENCY',
              'owner resolved incident',
              'owner',
            ),
          ],
        });
        expect(await handle.result()).toMatchObject({
          outcome: 'RESUMED',
          resumedBy: { principalId: 'owner', kind: 'HUMAN' },
        });
        expect(unfreezes).toBe(1);
      },
    );
  });
  it('ignores a fabricated cancel signal and keeps the action pending until an authenticated cancel', async () => {
    const fake = fakeEconomic();
    const config = testConfig('critic-signal');
    await withWorkers(
      env,
      config,
      { ...fake.activities, ...controls.activities },
      async () => {
        const handle = await env.client.workflow.start(
          'ActionExecutionWorkflow',
          {
            workflowId: `critic.cancel.${process.pid}`,
            taskQueue: config.taskQueues.economic,
            args: [startFixture('991')],
          },
        );
        await eventually(
          () => handle.query(stateQuery) as Promise<{ waitingFor: string }>,
          (s) => s.waitingFor === 'APPROVAL',
        );
        await handle.signal(cancelSignal, {
          requestedBy: {
            principalId: 'outsider',
            kind: 'FABRICATED_KIND' as never,
          },
          reason: '',
        });
        // A subsequent update is processed after the preceding signal in this workflow history.
        await expect(
          handle.executeUpdate(cancelUpdate, {
            args: [
              {
                requestedBy: { principalId: 'outsider', kind: 'HUMAN' },
                reason: 'unsigned',
              },
            ],
          }),
        ).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
        expect(await handle.query(stateQuery)).toMatchObject({
          waitingFor: 'APPROVAL',
          outcome: null,
        });
        expect(fake.state.broadcasts).toBe(0);
        await handle.executeUpdate(cancelUpdate, {
          args: [
            await controls.sign(
              'wf_group',
              handle.workflowId,
              'CANCEL',
              'authorized cleanup',
            ),
          ],
        });
        expect(await handle.result()).toMatchObject({ outcome: 'CANCELLED' });
      },
    );
  });
  it('rejects reuse of a full proposal signature across proposal, group, version and operation', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const base = {
      proposal: proposal('configure_group_a'),
      membershipEpoch: 4,
      requiredApprovals: 1,
    };
    let stored = base;
    const acts = createApprovalActivities({
      resolveProposal: async (id) =>
        id === stored.proposal.proposalId ? stored : null,
      members: async () => [{ memberId: 'owner', signer: owner.address }],
      observeMandate: async () => ({ observed: true, block: '1' }),
      applyMandate: async () => ({ applied: true, version: 2 }),
      notify: async () => ({ delivered: true }),
    });
    const signature = await owner.signMessage({
      message: { raw: mandateApprovalDigest(base) },
    });
    const verify = () =>
      acts.verifyMandateApproval({
        proposalId: stored.proposal.proposalId,
        mandateHash: stored.proposal.mandateHash,
        memberId: 'owner',
        signature,
      });
    expect(await verify()).toMatchObject({ valid: true });
    for (const changed of [
      { ...base.proposal, proposalId: 'revoke_group_b' },
      { ...base.proposal, kind: 'REVOKE' as const },
      {
        ...base.proposal,
        mandateRef: {
          ...base.proposal.mandateRef,
          groupId: 'other_group' as never,
        },
      },
      {
        ...base.proposal,
        mandateRef: { ...base.proposal.mandateRef, version: 3 },
      },
    ]) {
      stored = { ...base, proposal: changed };
      expect(await verify()).toMatchObject({ valid: false });
    }
    stored = { ...base, membershipEpoch: 5 };
    expect(await verify()).toMatchObject({ valid: false });
  });
  it('reconciles ambiguous funding mutation response loss before doing anything else and never repeats it', async () => {
    let mutations = 0;
    const calls: string[] = [];
    const config = testConfig('critic-funding');
    const acts: FundingActivities = {
      quoteFundingRoutes: async () => [
        {
          routeId: 'route',
          route: 'DIRECT_MONAD_AUSD',
          available: true,
          inputAmount: '1',
          expectedOutput: '1',
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          reason: null,
        },
      ],
      executeFundingRoute: async () => {
        calls.push('execute');
        mutations++;
        throw ApplicationFailure.retryable(
          'provider accepted transfer but response lost',
          'TRANSPORT_LOST',
        );
      },
      fundingStatus: async ({ transferKey }) => {
        calls.push('reconcile');
        return { transferKey, status: 'SETTLED', settledAmount: '1' };
      },
      creditFunding: async () => {
        calls.push('credit');
        return { credited: true };
      },
    };
    await withWorkers(env, config, acts, async () => {
      const result = await env.client.workflow.execute('FundingWorkflow', {
        workflowId: `critic.funding.${process.pid}`,
        taskQueue: config.taskQueues.strategy,
        args: [{ groupId: 'victim_group', fundingId: 'funding', amount: '1' }],
      });
      expect(result).toMatchObject({
        outcome: 'CREDITED',
        transferKey: 'synq.funding.victim_group.funding',
      });
      expect(mutations).toBe(1);
      expect(calls).toEqual(['execute', 'reconcile', 'credit']);
    });
  });
  it('reconciles ambiguous hedge mutation response loss once using the group-bound order key', async () => {
    const calls: string[] = [];
    const config = testConfig('critic-hedge');
    const acts: HedgeActivities = {
      hedgeRiskSnapshot: async () => ({
        exposure: '5',
        riskStatus: 'HEALTHY',
        observedAt: 1,
      }),
      hedgeApprovals: async () => ({
        rejected: false,
        required: 2,
        satisfied: true,
        draftDigest: null,
      }),
      planHedge: async () => ({
        action: 'OPEN',
        market: 'MON-PERP',
        side: 'SHORT',
        size: '5',
        maxSlippageBps: 30,
        reasons: ['EXPOSURE'],
      }),
      submitHedgeOrder: async () => {
        calls.push('submit');
        throw ApplicationFailure.retryable(
          'accepted but response lost',
          'TRANSPORT_LOST',
        );
      },
      hedgeOrderStatus: async ({ clientOrderId }) => {
        calls.push('status');
        return { clientOrderId, status: 'FILLED', filledSize: '5' };
      },
      cancelHedgeOrder: async () => {
        throw new Error('UNEXPECTED_CANCEL');
      },
      reconcileHedge: async () => {
        calls.push('reconcile');
        return { reconciled: true, position: '5' };
      },
    };
    await withWorkers(env, config, acts, async () => {
      expect(
        await env.client.workflow.execute('HedgeWorkflow', {
          workflowId: `critic.hedge.${process.pid}`,
          taskQueue: config.taskQueues.strategy,
          args: [{ groupId: 'victim_group', hedgeId: 'h1' }],
        }),
      ).toMatchObject({
        outcome: 'FILLED',
        reconciled: true,
        clientOrderId: 'synq.victim_group.h1.open',
      });
      expect(calls).toEqual(['submit', 'status', 'reconcile']);
    });
  });
});
