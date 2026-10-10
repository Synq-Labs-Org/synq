import { describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { loadWorkflowConfig } from '../../workers/workflow/src/config.js';
import {
  assertBroadcastAllowed,
  isMainnetChain,
} from '../../workers/workflow/src/activities/guard.js';
import { createEconomicActivities } from '../../workers/workflow/src/activities/economic.js';
import {
  DCA_EVIDENCE_MAX_AGE_SECONDS,
  evaluateDcaDeterministic,
} from '../../workers/workflow/src/activities/strategy.js';
import type {
  DcaFreshState,
  DcaStrategy,
  MarketEvidence,
} from '../../workers/workflow/src/activities/types.js';
import {
  ActionLifecycle,
  MirroredHistory,
} from '../../workers/workflow/src/workflows/lifecycle.js';
import {
  StartActionExecutionSchema,
  actionExecutionWorkflowId,
} from '../../packages/schemas/src/index.js';
import { canonicalIntentId } from '../../packages/kernel/src/index.js';
import {
  monadMainnetProfile,
  monadTestnetProfile,
  localProfile,
} from '../../packages/chain-registry/src/index.js';
import { startFixture } from './harness/fixtures.js';

describe('workflow configuration', () => {
  it('defaults to refusing mainnet broadcasts and distinct task queues per family', () => {
    const config = loadWorkflowConfig({});
    expect(config.allowMainnetBroadcast).toBe(false);
    expect(config.address).toBe('127.0.0.1:7233');
    expect(new Set(Object.values(config.taskQueues)).size).toBe(4);
    expect(config.deployment.buildId).toBeNull();
  });
  it('only the exact string true enables mainnet broadcasts', () => {
    expect(
      loadWorkflowConfig({ SYNQ_ALLOW_MAINNET_BROADCAST: 'true' })
        .allowMainnetBroadcast,
    ).toBe(true);
    for (const value of ['TRUE', '1', 'yes', ''])
      expect(() =>
        loadWorkflowConfig({ SYNQ_ALLOW_MAINNET_BROADCAST: value }),
      ).toThrow();
  });
  it('rejects malformed addresses and colliding task queues', () => {
    expect(() =>
      loadWorkflowConfig({ TEMPORAL_ADDRESS: 'http://x' }),
    ).toThrow();
    expect(() =>
      loadWorkflowConfig({
        SYNQ_TQ_ECONOMIC: 'same-queue',
        SYNQ_TQ_STRATEGY: 'same-queue',
      }),
    ).toThrow(/distinct/);
  });
});

describe('mainnet broadcast guard', () => {
  it('classifies only the local and testnet profiles as non-mainnet', () => {
    expect(isMainnetChain(localProfile.network.chainId)).toBe(false);
    expect(isMainnetChain(monadTestnetProfile.network.chainId)).toBe(false);
    expect(isMainnetChain(monadMainnetProfile.network.chainId)).toBe(true);
    expect(isMainnetChain(424242)).toBe(true);
  });
  it('refuses mainnet value movement unless explicitly allowed', () => {
    const mainnet = monadMainnetProfile.network.chainId;
    let refused: unknown;
    try {
      assertBroadcastAllowed(mainnet, false);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApplicationFailure);
    expect((refused as ApplicationFailure).type).toBe(
      'MAINNET_BROADCAST_DISABLED',
    );
    expect((refused as ApplicationFailure).nonRetryable).toBe(true);
    expect(() => assertBroadcastAllowed(mainnet, true)).not.toThrow();
    expect(() =>
      assertBroadcastAllowed(monadTestnetProfile.network.chainId, false),
    ).not.toThrow();
  });
  it('every value-moving economic Activity refuses on mainnet before touching the Kernel, journal or chain', async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error('dependency touched');
        },
      },
    );
    const activities = createEconomicActivities({
      chainId: monadMainnetProfile.network.chainId,
      allowMainnetBroadcast: false,
      kernel: untouchable as never,
      approvals: untouchable as never,
      simulator: untouchable as never,
      index: untouchable as never,
      chain: untouchable as never,
      broadcaster: { journal: untouchable } as never,
      executor: untouchable as never,
      module: '0x0000000000000000000000000000000000000001',
      localAssets: [],
      workerId: 'w',
      freeze: untouchable as never,
    });
    const grant = { grantId: `0x${'11'.repeat(32)}` as const };
    const fixture = startFixture('1');
    for (const run of [
      () =>
        activities.claimAndPrepare({
          ...grant,
          intent: fixture.intent,
          calldata: fixture.calldata,
        }),
      () =>
        activities.signAndSubmit({
          ...grant,
          intent: fixture.intent,
          calldata: fixture.calldata,
        }),
      () => activities.confirmInclusion(grant),
    ])
      await expect(run()).rejects.toMatchObject({
        type: 'MAINNET_BROADCAST_DISABLED',
        nonRetryable: true,
      });
  });
});

describe('deterministic DCA evaluator', () => {
  const strategy: DcaStrategy = {
    strategyId: 's1',
    groupId: 'g',
    mandateId: 'm',
    mandateVersion: 3,
    inputAmountPerTick: '100',
    maxSlippageBps: 50,
    maxTicks: 5,
  };
  const state: DcaFreshState = {
    mandateVersion: 3,
    mandateActive: true,
    ticksExecuted: 1,
    remainingBudget: '1000',
    observedAt: 1_000,
  };
  const evidence: MarketEvidence = {
    evidenceHash: `0x${'aa'.repeat(32)}`,
    referencePrice: '1',
    quotedOutputAmount: '99',
    quoteExpiresAt: 1_300,
    riskStatus: 'HEALTHY',
    observedAt: 1_010,
  };
  const evaluate = (
    s: Partial<DcaFreshState> = {},
    e: Partial<MarketEvidence> = {},
  ) =>
    evaluateDcaDeterministic({
      strategy,
      state: { ...state, ...s },
      evidence: { ...evidence, ...e },
    });

  it('executes within policy and is a pure function of its inputs', () => {
    expect(evaluate()).toEqual({
      decision: 'EXECUTE',
      amount: '100',
      reasons: ['WITHIN_POLICY'],
    });
    expect(evaluate()).toEqual(evaluate());
  });
  it('fails closed on unknown or stale risk and escalates on degraded risk or a mandate change', () => {
    expect(evaluate({}, { riskStatus: 'UNKNOWN' }).decision).toBe('SKIP');
    expect(evaluate({}, { riskStatus: 'STALE' }).decision).toBe('SKIP');
    expect(evaluate({}, { riskStatus: 'DEGRADED' }).decision).toBe('ESCALATE');
    expect(evaluate({ mandateVersion: 4 }).decision).toBe('ESCALATE');
    expect(evaluate({ mandateActive: false }).decision).toBe('ESCALATE');
  });
  it('skips on budget, tick cap, expired quote, stale evidence or zero output', () => {
    expect(evaluate({ remainingBudget: '99' })).toMatchObject({
      decision: 'SKIP',
      reasons: ['BUDGET_EXHAUSTED'],
    });
    expect(evaluate({ ticksExecuted: 5 }).reasons).toContain(
      'MAX_TICKS_REACHED',
    );
    expect(evaluate({}, { quoteExpiresAt: 1_010 }).reasons).toContain(
      'QUOTE_EXPIRED',
    );
    expect(
      evaluate(
        {},
        {
          observedAt: 1_000 + DCA_EVIDENCE_MAX_AGE_SECONDS + 1,
          quoteExpiresAt: 9_999,
        },
      ).reasons,
    ).toContain('EVIDENCE_STALE');
    expect(evaluate({}, { quotedOutputAmount: '0' }).reasons).toContain(
      'NO_OUTPUT_QUOTED',
    );
  });
});

describe('workflow lifecycle mirror', () => {
  it('accepts an extending history and refuses regressions, divergence and gaps', () => {
    const mirror = new MirroredHistory<string>('ACTION', 'PROPOSED');
    mirror.sync([{ from: 'PROPOSED', to: 'RISKED' }]);
    mirror.sync([
      { from: 'PROPOSED', to: 'RISKED' },
      { from: 'RISKED', to: 'SIMULATED' },
    ]);
    expect(mirror.state).toBe('SIMULATED');
    expect(() => mirror.sync([{ from: 'PROPOSED', to: 'RISKED' }])).toThrow(
      'ACTION_HISTORY_REGRESSED',
    );
    expect(() =>
      mirror.sync([
        { from: 'PROPOSED', to: 'POLICY_REJECTED' },
        { from: 'RISKED', to: 'SIMULATED' },
      ]),
    ).toThrow('ACTION_HISTORY_DIVERGED');
    expect(() =>
      new MirroredHistory<string>('ACTION', 'PROPOSED').sync([
        { from: 'RISKED', to: 'SIMULATED' },
      ]),
    ).toThrow('ACTION_HISTORY_GAP');
  });
  it('closes only along an edge the canonical machine offered', () => {
    const life = new ActionLifecycle();
    expect(life.close('CANCELLED')).toBe(false);
    life.successors = ['AUTHORIZED', 'CANCELLED', 'EXPIRED', 'POLICY_REJECTED'];
    expect(life.close('SETTLED' as never)).toBe(false);
    expect(life.close('CANCELLED')).toBe(true);
    expect(life.actionState).toBe('CANCELLED');
    expect(life.close('EXPIRED')).toBe(false);
  });
});

describe('workflow start contract', () => {
  it('derives one workflow id per canonical intent regardless of the proposer id', () => {
    const now = 1_790_000_000;
    const a = startFixture('7', { proposedId: 'brain_a', now });
    const b = startFixture('7', { proposedId: 'brain_b', now });
    expect(actionExecutionWorkflowId(canonicalIntentId(a.intent))).toBe(
      actionExecutionWorkflowId(canonicalIntentId(b.intent)),
    );
    expect(
      actionExecutionWorkflowId(
        canonicalIntentId(startFixture('8', { now }).intent),
      ),
    ).not.toBe(actionExecutionWorkflowId(canonicalIntentId(a.intent)));
  });
  it('binds the mandate reference, evidence hash and calldata to the intent', () => {
    const base = startFixture('9');
    expect(StartActionExecutionSchema.safeParse(base).success).toBe(true);
    for (const broken of [
      { ...base, mandateRef: { ...base.mandateRef, version: 2 } },
      { ...base, evidenceHash: `0x${'00'.repeat(32)}` },
      { ...base, calldata: '0xdeadbeef' },
      { ...base, approvalTimeoutSeconds: 10 },
      { ...base, executionMode: 'MAINNET_BROADCAST' },
    ])
      expect(StartActionExecutionSchema.safeParse(broken).success).toBe(false);
  });
});
