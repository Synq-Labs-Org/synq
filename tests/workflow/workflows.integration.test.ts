import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { ApplicationFailure } from '@temporalio/common';
import type {
  ApprovalActivities,
  DcaStrategy,
  FundingActivities,
  FundingQuote,
  HedgeActivities,
  HedgeOrderView,
  OperationsActivities,
  StrategyActivities,
} from '../../workers/workflow/src/activities/types.js';
import {
  mandateApprovalDigest,
  createApprovalActivities,
} from '../../workers/workflow/src/activities/approval.js';
import { FileAutonomyFreeze } from '../../workers/workflow/src/activities/freeze.js';
import {
  createStrategyActivities,
  FileTickStore,
} from '../../workers/workflow/src/activities/strategy.js';
import { assertBroadcastAllowed } from '../../workers/workflow/src/activities/guard.js';
import { actionWorkflowIdFor } from '../../workers/workflow/src/client.js';
import {
  approveMandateUpdate,
  type MandateApprovalState,
} from '../../workers/workflow/src/workflows/mandate-approval.js';
import {
  cancelUpdate,
  resumeUpdate,
  stateQuery,
} from '../../workers/workflow/src/workflows/messages.js';
import type { StartMandateApproval } from '../../packages/schemas/src/index.js';
import { monadMainnetProfile } from '../../packages/chain-registry/src/index.js';
import { eventually, startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { fakeEconomic } from './harness/fake-economic.js';
import { startFixture } from './harness/fixtures.js';
import { fixtureControls } from './harness/controls.js';

const ops = { principalId: 'member_ops', kind: 'HUMAN' as const };
let env: TestWorkflowEnvironment;
let dir: string;
let controls: ReturnType<typeof fixtureControls>;
beforeAll(async () => {
  env = await startTemporal();
  dir = mkdtempSync(join(tmpdir(), 'synq-wf-units-'));
  controls = fixtureControls(join(dir, 'controls'), ['g']);
});
afterAll(async () => {
  await env?.teardown();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
let seq = 0;
const id = (p: string) => `${p}.${process.pid}.${++seq}`;

describe('MandateApprovalWorkflow', () => {
  it('counts each approver once, refuses forged signatures, waits for the on-chain change and applies it', async () => {
    const owners = [0, 1, 2].map(() =>
      privateKeyToAccount(generatePrivateKey()),
    );
    const members = owners.map((o, i) => ({
      memberId: `member_${i}`,
      signer: o.address.toLowerCase() as `0x${string}`,
    }));
    const mandateHash = keccak256(toHex('mandate v2'));
    let observed = 0;
    const notes: string[] = [];
    const applied: number[] = [];
    let proposal: StartMandateApproval;
    const approval: ApprovalActivities = createApprovalActivities({
      resolveProposal: async (proposalId) =>
        proposal?.proposalId === proposalId
          ? { proposal, membershipEpoch: 4, requiredApprovals: 2 }
          : null,
      members: async () => members,
      observeMandate: async () => ({
        observed: ++observed >= 3,
        block: observed >= 3 ? '77' : null,
      }),
      applyMandate: async ({ version }) => {
        applied.push(version);
        return { applied: true, version };
      },
      notify: async ({ subject }) => {
        notes.push(subject);
        return { delivered: true };
      },
    });
    const config = testConfig('mandate');
    await withWorkers(env, config, approval, async () => {
      const input: StartMandateApproval = (proposal = {
        schemaVersion: 1,
        proposalId: id('proposal'),
        kind: 'SUPERSEDE',
        mandateRef: {
          groupId: 'g' as never,
          mandateId: 'm' as never,
          version: 2,
        },
        mandateHash,
        securitySensitive: true,
        approvers: ['member_0', 'member_1', 'member_2'] as never,
        requiredApprovals: 2,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        requestedBy: { principalId: 'brain' as never, kind: 'AGENT' },
        correlationId: 'corr_mandate' as never,
      });
      const handle = await env.client.workflow.start(
        'MandateApprovalWorkflow',
        {
          workflowId: id('mandate'),
          taskQueue: config.taskQueues.approval,
          args: [input, { pollSeconds: 1 }],
        },
      );
      const sign = (i: number) =>
        owners[i]!.signMessage({
          message: {
            raw: mandateApprovalDigest({
              proposal,
              membershipEpoch: 4,
              requiredApprovals: 2,
            }),
          },
        });
      const approve = async (memberId: string, signature: string) =>
        handle.executeUpdate(approveMandateUpdate, {
          args: [{ memberId, signature }],
        });
      expect(await approve('member_0', await sign(0))).toMatchObject({
        counted: 1,
        satisfied: false,
      });
      expect(await approve('member_0', await sign(0))).toMatchObject({
        counted: 1,
      });
      expect(await approve('member_2', await sign(1))).toMatchObject({
        counted: 1,
      });
      await expect(approve('member_9', await sign(0))).rejects.toBeInstanceOf(
        WorkflowUpdateFailedError,
      );
      await expect(approve('member_1', '0x1234')).rejects.toBeInstanceOf(
        WorkflowUpdateFailedError,
      );
      expect(await approve('member_1', await sign(1))).toMatchObject({
        counted: 2,
        satisfied: true,
      });
      const result = (await handle.result()) as MandateApprovalState;
      expect(result.outcome).toBe('APPLIED');
      expect(result.approvals.map((a) => a.memberId)).toEqual([
        'member_0',
        'member_1',
      ]);
      expect(result.refused).toEqual([
        { memberId: 'member_2', reason: 'SIGNER_MISMATCH' },
      ]);
      expect(result.onchainBlock).toBe('77');
      expect(observed).toBe(3);
      expect(applied).toEqual([2]);
      expect(notes).toEqual(['mandate.approval.requested']);
    });
  });
});

describe('DCAWorkflow tick', () => {
  const strategy: DcaStrategy = {
    strategyId: 'dca_unit',
    groupId: 'wf_group',
    mandateId: 'wf_mandate',
    mandateVersion: 1,
    inputAmountPerTick: '1000000',
    maxSlippageBps: 0,
    maxTicks: 10,
  };
  function strategyActivities(
    version: number,
    risk: 'HEALTHY' | 'DEGRADED' = 'HEALTHY',
  ) {
    const ticks = new FileTickStore(join(dir, `ticks-${seq}-${version}.json`));
    const start = startFixture('424242', {
      now: Math.floor(Date.now() / 1000),
    });
    const built: string[] = [];
    const acts: StrategyActivities = createStrategyActivities({
      freshState: async () => ({
        mandateVersion: version,
        mandateActive: true,
        ticksExecuted: 0,
        remainingBudget: '100000000',
        observedAt: 1000,
      }),
      marketEvidence: async () => ({
        evidenceHash: `0x${'aa'.repeat(32)}`,
        referencePrice: '1',
        quotedOutputAmount: '1000000',
        quoteExpiresAt: 1300,
        riskStatus: risk,
        observedAt: 1000,
      }),
      buildAction: async ({ tickKey }) => {
        built.push(tickKey);
        return { start, workflowId: actionWorkflowIdFor(start.intent) };
      },
      ticks,
    });
    return { acts, ticks, built, start };
  }

  it('executes through an ActionExecution child keyed by the canonical intent, and a re-delivered tick cannot start a second one', async () => {
    const config = testConfig('dca-unit');
    const { acts, ticks, start } = strategyActivities(1);
    const economic = fakeEconomic();
    await withWorkers(
      env,
      config,
      { ...acts, ...economic.activities },
      async () => {
        const run = (workflowId: string) =>
          env.client.workflow.execute('DCAWorkflow', {
            workflowId,
            taskQueue: config.taskQueues.strategy,
            args: [
              { strategy, executionTaskQueue: config.taskQueues.economic },
            ],
          });
        const first = await run(id('synq.dca.unit.tick'));
        expect(first).toMatchObject({
          decision: 'EXECUTE',
          childAlreadyStarted: false,
        });
        expect(first.childWorkflowId).toBe(actionWorkflowIdFor(start.intent));
        const child = env.client.workflow.getHandle(first.childWorkflowId!);
        await eventually(
          () =>
            child.query(stateQuery) as Promise<{ waitingFor: string | null }>,
          (s) => s.waitingFor === 'APPROVAL',
        );
        const second = await run(id('synq.dca.unit.tick'));
        expect(second).toMatchObject({
          decision: 'EXECUTE',
          childAlreadyStarted: true,
        });
        expect(ticks.all()).toHaveLength(2);
        await child.terminate('test cleanup');
      },
    );
  });

  it('a mandate version change or degraded risk escalates without starting an execution', async () => {
    const config = testConfig('dca-escalate');
    for (const [version, risk, reason] of [
      [2, 'HEALTHY', 'MANDATE_VERSION_CHANGED:1->2'],
      [1, 'DEGRADED', 'RISK_DEGRADED'],
    ] as const) {
      const { acts, built } = strategyActivities(version, risk);
      await withWorkers(
        env,
        config,
        { ...acts, ...controls.activities },
        async () => {
          const result = await env.client.workflow.execute('DCAWorkflow', {
            workflowId: id('synq.dca.unit.tick'),
            taskQueue: config.taskQueues.strategy,
            args: [{ strategy }],
          });
          expect(result).toMatchObject({
            decision: 'ESCALATE',
            childWorkflowId: null,
            reasons: [reason],
          });
          expect(built).toEqual([]);
        },
      );
    }
  });
});

describe('HedgeWorkflow and FundingWorkflow skeletons', () => {
  function hedge(statuses: HedgeOrderView['status'][]) {
    const calls: string[] = [];
    let i = 0;
    const view = (status: HedgeOrderView['status']): HedgeOrderView => ({
      clientOrderId: 'synq.g.h1.open',
      status,
      filledSize: status === 'FILLED' ? '5' : '0',
    });
    const acts: HedgeActivities = {
      hedgeRiskSnapshot: async () => ({
        exposure: '5',
        riskStatus: 'HEALTHY',
        observedAt: 1,
      }),
      planHedge: async () => ({
        action: 'OPEN',
        market: 'MON-PERP',
        side: 'SHORT',
        size: '5',
        maxSlippageBps: 30,
        reasons: ['EXPOSURE'],
      }),
      submitHedgeOrder: async ({ clientOrderId }) => {
        calls.push(`submit:${clientOrderId}`);
        return view('ACCEPTED');
      },
      hedgeOrderStatus: async () =>
        view(statuses[Math.min(i++, statuses.length - 1)]!),
      cancelHedgeOrder: async () => {
        calls.push('cancel');
        return view('CANCELLED');
      },
      reconcileHedge: async () => ({ reconciled: true, position: '5' }),
    };
    return { acts, calls };
  }

  it('submits one idempotent order, polls to a fill and reconciles', async () => {
    const config = testConfig('hedge');
    const { acts, calls } = hedge(['PARTIALLY_FILLED', 'FILLED']);
    await withWorkers(
      env,
      config,
      { ...acts, ...controls.activities },
      async () => {
        const result = await env.client.workflow.execute('HedgeWorkflow', {
          workflowId: id('hedge'),
          taskQueue: config.taskQueues.strategy,
          args: [{ groupId: 'g', hedgeId: 'h1', pollSeconds: 1 }],
        });
        expect(result).toMatchObject({
          outcome: 'FILLED',
          reconciled: true,
          clientOrderId: 'synq.g.h1.open',
        });
        expect(calls).toEqual(['submit:synq.g.h1.open']);
      },
    );
  });

  it('a cancel update cancels the resting order once', async () => {
    const config = testConfig('hedge-cancel');
    const { acts, calls } = hedge(['ACCEPTED']);
    await withWorkers(
      env,
      config,
      { ...acts, ...controls.activities },
      async () => {
        const handle = await env.client.workflow.start('HedgeWorkflow', {
          workflowId: id('hedge'),
          taskQueue: config.taskQueues.strategy,
          args: [{ groupId: 'g', hedgeId: 'h1', pollSeconds: 1 }],
        });
        await eventually(
          () => handle.query(stateQuery) as Promise<{ order: unknown }>,
          (s) => s.order !== null,
        );
        await handle.executeUpdate(cancelUpdate, {
          args: [
            await controls.sign('g', handle.workflowId, 'CANCEL', 'risk off'),
          ],
        });
        expect(await handle.result()).toMatchObject({ outcome: 'CANCELLED' });
        expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);
      },
    );
  });

  it('funding picks the best available live quote, waits for settlement and credits once; no route means no movement', async () => {
    const config = testConfig('funding');
    const now = Math.floor(Date.now() / 1000);
    const quote = (
      route: FundingQuote['route'],
      available: boolean,
      expectedOutput: string,
    ): FundingQuote => ({
      routeId: route.toLowerCase(),
      route,
      available,
      inputAmount: '100',
      expectedOutput,
      expiresAt: now + 600,
      reason: available ? null : 'NO_TESTNET_ROUTE',
    });
    const executed: string[] = [];
    let polls = 0;
    const acts = (quotes: FundingQuote[]): FundingActivities => ({
      quoteFundingRoutes: async () => quotes,
      executeFundingRoute: async ({ transferKey, quote: q }) => {
        executed.push(`${transferKey}:${q.route}`);
        return { transferKey, status: 'PENDING', settledAmount: null };
      },
      fundingStatus: async ({ transferKey }) =>
        ++polls >= 2
          ? { transferKey, status: 'SETTLED', settledAmount: '98' }
          : { transferKey, status: 'PENDING', settledAmount: null },
      creditFunding: async () => ({ credited: true }),
    });
    await withWorkers(
      env,
      config,
      acts([
        quote('AURORA_INTENTS', false, '200'),
        quote('AUSD_OFT', true, '98'),
        quote('DIRECT_MONAD_AUSD', true, '97'),
      ]),
      async () => {
        const result = await env.client.workflow.execute('FundingWorkflow', {
          workflowId: id('funding'),
          taskQueue: config.taskQueues.strategy,
          args: [
            { groupId: 'g', fundingId: 'f1', amount: '100', pollSeconds: 1 },
          ],
        });
        expect(result).toMatchObject({
          outcome: 'CREDITED',
          credited: true,
          selected: { route: 'AUSD_OFT' },
        });
        expect(executed).toEqual(['synq.funding.g.f1:AUSD_OFT']);
      },
    );
    await withWorkers(
      env,
      config,
      acts([quote('AURORA_INTENTS', false, '200')]),
      async () => {
        const result = await env.client.workflow.execute('FundingWorkflow', {
          workflowId: id('funding'),
          taskQueue: config.taskQueues.strategy,
          args: [{ groupId: 'g', fundingId: 'f2', amount: '100' }],
        });
        expect(result).toMatchObject({ outcome: 'NO_ROUTE', transfer: null });
        expect(executed).toHaveLength(1);
      },
    );
  });
});

describe('ReconciliationWorkflow and EmergencyPauseWorkflow', () => {
  it('sweeps on a durable cadence and bounds history with continue-as-new', async () => {
    const config = testConfig('recon');
    let sweeps = 0;
    const acts: Partial<OperationsActivities> = {
      sweepJournal: async () => {
        sweeps++;
        return {
          checked: 1,
          confirmed: sweeps === 1 ? [`0x${'01'.repeat(32)}`] : [],
          unresolved: [],
          released: 1,
        };
      },
    };
    await withWorkers(
      env,
      config,
      { ...acts, ...controls.activities },
      async () => {
        const handle = await env.client.workflow.start(
          'ReconciliationWorkflow',
          {
            workflowId: id('recon'),
            taskQueue: config.taskQueues.operations,
            args: [{ intervalSeconds: 1, sweeps: 3, sweepsPerRun: 2 }],
          },
        );
        const result = await handle.result();
        expect(sweeps).toBe(3);
        expect(result).toMatchObject({
          totals: { confirmed: 1, released: 3, unresolved: 0 },
        });
        const first = await env.client.workflow
          .getHandle(handle.workflowId, handle.firstExecutionRunId)
          .describe();
        expect(first.status.name).toBe('CONTINUED_AS_NEW');
      },
    );
  });

  it('freezes Synq autonomy immediately, hands owners the Safe pause and only an explicit resume unfreezes', async () => {
    const config = testConfig('pause');
    const freeze = new FileAutonomyFreeze(join(dir, 'freeze.json'));
    let polls = 0;
    const notified: string[] = [];
    const acts: Partial<OperationsActivities & ApprovalActivities> = {
      freezeAutonomy: async ({ groupId, reason, incidentId }) => ({
        frozen: true,
        since: (await freeze.freeze(groupId, reason, incidentId)).since,
      }),
      unfreezeAutonomy: async ({ groupId, incidentId }) => {
        await freeze.unfreeze(groupId, incidentId);
        return { frozen: (await freeze.status(groupId)).frozen };
      },
      prepareSafePause: async () => ({
        safe: `0x${'aa'.repeat(20)}`,
        to: `0x${'bb'.repeat(20)}`,
        data: '0x8456cb59',
      }),
      observeOnchainPause: async () => ({
        paused: ++polls >= 2,
        block: String(100 + polls),
      }),
      notify: async ({ subject }) => {
        notified.push(subject);
        return { delivered: true };
      },
    };
    await withWorkers(
      env,
      config,
      { ...acts, ...controls.activities },
      async () => {
        const handle = await env.client.workflow.start(
          'EmergencyPauseWorkflow',
          {
            workflowId: id('pause'),
            taskQueue: config.taskQueues.operations,
            args: [
              {
                groupId: 'g',
                incidentId: 'inc1',
                reason: 'oracle anomaly',
                requestedBy: ops,
                pollSeconds: 1,
              },
            ],
          },
        );
        await eventually(
          () => freeze.status('g'),
          (s) => s.frozen,
        );
        const paused = await eventually(
          () =>
            handle.query(stateQuery) as Promise<{
              onchainPaused: boolean;
              safePauseTransaction: unknown;
            }>,
          (s) => s.onchainPaused,
        );
        expect(paused.safePauseTransaction).toMatchObject({
          data: '0x8456cb59',
        });
        expect(notified).toEqual(['emergency.pause.sign-required']);
        expect((await freeze.status('g')).frozen).toBe(true);
        await handle.executeUpdate(resumeUpdate, {
          args: [
            await controls.sign(
              'g',
              handle.workflowId,
              'RESUME_EMERGENCY',
              'incident closed',
            ),
          ],
        });
        expect(await handle.result()).toMatchObject({
          outcome: 'RESUMED',
          frozen: false,
        });
        expect((await freeze.status('g')).frozen).toBe(false);
      },
    );
  });
});

describe('mainnet guard inside the economic path', () => {
  it('an authorized mainnet action is refused before claim, never broadcast, and its reservation released', async () => {
    const config = testConfig('mainnet');
    const fake = fakeEconomic({ autoAuthorize: true, validUntilSeconds: 2 });
    const activities = {
      ...fake.activities,
      claimAndPrepare: async () => {
        assertBroadcastAllowed(monadMainnetProfile.network.chainId, false);
        throw ApplicationFailure.nonRetryable('unreachable', 'INVALID_INPUT');
      },
    };
    await withWorkers(env, config, activities, async () => {
      const result = await env.client.workflow.execute(
        'ActionExecutionWorkflow',
        {
          workflowId: id('mainnet'),
          taskQueue: config.taskQueues.economic,
          args: [
            startFixture(String(Date.now())),
            { retryInitialSeconds: 0.2, releaseMarginSeconds: 1 },
          ],
        },
      );
      expect(result).toMatchObject({
        outcome: 'REJECTED',
        transactionHash: null,
      });
      expect(result.reservation?.state).toBe('RELEASED');
      expect(fake.count('signAndSubmit')).toBe(0);
      expect(fake.state.broadcasts).toBe(0);
    });
  });
});
