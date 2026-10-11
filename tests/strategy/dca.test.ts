import { describe, expect, it } from 'vitest';
import {
  DcaPolicySchema,
  dcaEvaluator,
  evaluateDca,
  evaluateDcaActivity,
  indicativeOutput,
  parseDcaPolicy,
} from '@synq/strategy-engine';
import {
  START,
  UNIT,
  WEEK,
  baseInput,
  execution,
  policy,
  price,
} from './fixtures.js';

describe('DCA strategy evaluator rules', () => {
  it('executes the base tranche on a healthy scheduled slot', () => {
    const d = evaluateDca(baseInput());
    expect(d).toMatchObject({
      kind: 'EXECUTE',
      reasons: ['SCHEDULED'],
      slot: 0,
      decisionId: `${policy.strategyId}:0`,
      terminal: false,
    });
    expect(d.tranche).toMatchObject({
      amountIn: 25n * UNIT,
      maxSlippageBps: 75,
      venue: 'kuru-flow',
      dipApplied: false,
    });
    expect(d.tranche!.indicativeOutput).toBe(1_000n * 10n ** 18n);
    expect(d.tranche!.minOutputFloor).toBe(
      (1_000n * 10n ** 18n * 9_925n) / 10_000n,
    );
    expect(dcaEvaluator.evaluate(baseInput())).toEqual(d);
  });

  it('converts decimals exactly for the indicative output', () => {
    expect(indicativeOutput(25n * UNIT, price(25_000n), 6, 18)).toBe(
      1_000n * 10n ** 18n,
    );
    expect(indicativeOutput(3n, 10n ** 18n, 6, 6)).toBe(3n);
  });

  it('expiry is terminal and not-started skips', () => {
    expect(evaluateDca(baseInput({ now: policy.expiresAt }))).toMatchObject({
      kind: 'SKIP',
      reasons: ['EXPIRED'],
      terminal: true,
    });
    expect(evaluateDca(baseInput({ now: START - 1 }))).toMatchObject({
      kind: 'SKIP',
      reasons: ['NOT_STARTED'],
    });
  });

  it('pause condition skips', () => {
    const paused = { ...policy.pause, paused: true };
    expect(evaluateDca(baseInput({ policy: { pause: paused } }))).toMatchObject(
      { kind: 'SKIP', reasons: ['PAUSED'] },
    );
  });

  it('duplicate slot and not-due skip, failed executions do not block', () => {
    expect(
      evaluateDca(baseInput({ executions: [execution(0, 25n * UNIT)] })),
    ).toMatchObject({ kind: 'SKIP', reasons: ['ALREADY_EXECUTED_IN_SLOT'] });
    expect(
      evaluateDca(
        baseInput({ executions: [execution(0, 25n * UNIT, 'PENDING')] }),
      ).reasons,
    ).toEqual(['ALREADY_EXECUTED_IN_SLOT']);
    expect(
      evaluateDca(
        baseInput({ executions: [execution(0, 25n * UNIT, 'FAILED')] }),
      ).kind,
    ).toBe('EXECUTE');
    const late = { ...execution(0, 25n * UNIT), at: START + WEEK - 60 };
    expect(
      evaluateDca(baseInput({ now: START + WEEK + 60, executions: [late] })),
    ).toMatchObject({ kind: 'SKIP', reasons: ['NOT_DUE'], slot: 1 });
  });

  it('venue or asset outside the allowlist escalates', () => {
    expect(
      evaluateDca(baseInput({ market: { venue: 'other-dex' } })).reasons,
    ).toEqual(['VENUE_NOT_ALLOWED']);
    expect(
      evaluateDca(baseInput({ market: { assetOut: `0x${'1'.repeat(40)}` } })),
    ).toMatchObject({ kind: 'ESCALATE', reasons: ['ASSET_NOT_ALLOWED'] });
    expect(
      evaluateDca(
        baseInput({
          market: {
            assetIn: policy.targetAsset.address,
            assetOut: policy.budgetAsset.address,
          },
        }),
      ).reasons,
    ).toEqual(['MARKET_ROUTE_MISMATCH']);
  });

  it('stale or future market data and conflicting evidence escalate', () => {
    const now = START + 3_600;
    for (const asOf of [now - 301, now + 1])
      expect(evaluateDca(baseInput({ now, market: { asOf } }))).toMatchObject({
        kind: 'ESCALATE',
        reasons: ['STALE_MARKET_DATA'],
      });
    expect(
      evaluateDca(baseInput({ market: { sourcesConflict: true } })).reasons,
    ).toEqual(['CONFLICTING_EVIDENCE']);
  });

  it('plugin/venue unavailable escalates, or skips when the policy pauses on it', () => {
    expect(
      evaluateDca(baseInput({ market: { venueHealthy: false } })),
    ).toMatchObject({ kind: 'ESCALATE', reasons: ['VENUE_UNAVAILABLE'] });
    expect(
      evaluateDca(
        baseInput({
          market: { venueHealthy: false },
          policy: { pause: { ...policy.pause, pauseOnVenueUnhealthy: true } },
        }),
      ),
    ).toMatchObject({ kind: 'SKIP', reasons: ['VENUE_UNHEALTHY_PAUSED'] });
  });

  it('AUSD risk DEGRADED, UNKNOWN or STALE never executes', () => {
    for (const status of ['DEGRADED', 'UNKNOWN', 'STALE'] as const) {
      expect(
        evaluateDca(baseInput({ market: { referenceStatus: status } })),
      ).toMatchObject({ kind: 'ESCALATE', reasons: [`AUSD_RISK_${status}`] });
      const d = evaluateDca(
        baseInput({
          market: { referenceStatus: status },
          policy: {
            pause: { ...policy.pause, pauseOnReferenceStatuses: [status] },
          },
        }),
      );
      expect(d).toMatchObject({
        kind: 'SKIP',
        reasons: [`REFERENCE_${status}_PAUSED`],
      });
      expect(d.tranche).toBeNull();
    }
  });

  it('a 20% move escalates in either direction', () => {
    for (const change24hBps of [2_000, -2_000, 5_000])
      expect(
        evaluateDca(baseInput({ market: { change24hBps } })).reasons,
      ).toEqual(['LARGE_MARKET_MOVE']);
    expect(
      evaluateDca(baseInput({ market: { change24hBps: -1_999 } })).kind,
    ).toBe('EXECUTE');
  });

  it('TRD-004 TRD-012 spike above the 24h threshold skips', () => {
    expect(
      evaluateDca(baseInput({ market: { change24hBps: 801 } })),
    ).toMatchObject({ kind: 'SKIP', reasons: ['SPIKE'] });
    expect(evaluateDca(baseInput({ market: { change24hBps: 800 } })).kind).toBe(
      'EXECUTE',
    );
  });

  it('TRD-005 TRD-013 dip multiplier applies and never exceeds the max tranche', () => {
    const dip = {
      trailingReferencePrice: price(25_000n),
      price: price(22_500n),
    };
    const d = evaluateDca(baseInput({ market: dip }));
    expect(d.tranche).toMatchObject({
      amountIn: 37_500_000n,
      dipApplied: true,
    });
    expect(d.reasons).toEqual(['DIP_MULTIPLIER']);
    const notDip = evaluateDca(
      baseInput({ market: { ...dip, price: price(22_501n) } }),
    );
    expect(notDip.tranche!.amountIn).toBe(25n * UNIT);
    const huge = evaluateDca(
      baseInput({
        market: dip,
        policy: {
          dip: { multiplierBps: 100_000, triggerBelowTrailingBps: 1_000 },
        },
      }),
    );
    expect(huge.tranche!.amountIn).toBe(policy.maxTranche);
  });

  it('TRD-006 TRD-014 allocation cap skips at the cap and caps below it', () => {
    expect(
      evaluateDca(
        baseInput({
          treasury: { targetPositionValueInBudgetAsset: 400n * UNIT },
        }),
      ),
    ).toMatchObject({ kind: 'SKIP', reasons: ['ALLOCATION_CAP'] });
    const capped = evaluateDca(
      baseInput({
        treasury: { targetPositionValueInBudgetAsset: 390n * UNIT },
      }),
    );
    expect(capped.tranche!.amountIn).toBe(10n * UNIT);
    expect(capped.reasons).toEqual(['ALLOCATION_CAP_CAPPED']);
    expect(capped.diagnostics.allocationAfterBps).toBe(4_000);
  });

  it('budget exhaustion counts settled and pending but not failed spends', () => {
    const spent = Array.from({ length: 16 }, (_, i) =>
      execution(i, 25n * UNIT, i === 15 ? 'PENDING' : 'SETTLED'),
    ).map((e) => ({ ...e, at: START - WEEK }));
    const now = START + 16 * WEEK;
    expect(evaluateDca(baseInput({ now, executions: spent }))).toMatchObject({
      kind: 'SKIP',
      reasons: ['BUDGET_EXHAUSTED'],
    });
    const withFailure = spent.map((e, i) =>
      i === 15 ? { ...e, status: 'FAILED' as const } : e,
    );
    const d = evaluateDca(baseInput({ now, executions: withFailure }));
    expect(d.kind).toBe('EXECUTE');
    expect(d.diagnostics.budgetRemaining).toBe(25n * UNIT);
    const partial = withFailure
      .slice(0, 15)
      .map((e, i) => (i === 14 ? { ...e, amountIn: 35n * UNIT } : e));
    const capped = evaluateDca(baseInput({ now, executions: partial }));
    expect(capped.tranche!.amountIn).toBe(15n * UNIT);
    expect(capped.reasons).toEqual(['BUDGET_EXHAUSTED_CAPPED']);
  });

  it('pending spends are never free: max deployment and free balance', () => {
    const p = { maxDeployment: 100n * UNIT };
    const pending = [execution(0, 100n * UNIT, 'PENDING')].map((e) => ({
      ...e,
      at: START - WEEK,
    }));
    const now = START + WEEK + 10;
    expect(
      evaluateDca(baseInput({ now, policy: p, executions: pending })),
    ).toMatchObject({ kind: 'SKIP', reasons: ['MAX_DEPLOYMENT'] });
    expect(
      evaluateDca(
        baseInput({
          now,
          policy: p,
          executions: pending,
          exitedPrincipal: 30n * UNIT,
        }),
      ),
    ).toMatchObject({ kind: 'ESCALATE', reasons: ['INVALID_EXIT_ACCOUNTING'] });
    expect(
      evaluateDca(baseInput({ treasury: { freeBudgetAsset: UNIT - 1n } })),
    ).toMatchObject({ kind: 'SKIP', reasons: ['INSUFFICIENT_FREE_BALANCE'] });
  });

  it('pending lots consume allocation and cannot be released by unproved exits', () => {
    const result = evaluateDca(
      baseInput({
        now: START + WEEK + 10,
        executions: [execution(0, 25n * UNIT, 'PENDING')],
        treasury: {
          totalValueInBudgetAsset: 100n * UNIT,
          freeBudgetAsset: 75n * UNIT,
        },
      }),
    );
    expect(result.tranche?.amountIn).toBe(15n * UNIT);
    expect(result.diagnostics.allocationAfterBps).toBe(4000);
    const settled = evaluateDca(
      baseInput({
        now: START + WEEK + 10,
        executions: [execution(0, 25n * UNIT, 'SETTLED')],
        treasury: {
          totalValueInBudgetAsset: 100n * UNIT,
          freeBudgetAsset: 75n * UNIT,
          targetPositionValueInBudgetAsset: 25n * UNIT,
        },
      }),
    );
    expect(settled.tranche?.amountIn).toBe(15n * UNIT);
    const duplicate = execution(0, 25n * UNIT, 'PENDING');
    expect(
      evaluateDca(
        baseInput({
          now: START + WEEK + 10,
          executions: [duplicate, duplicate],
        }),
      ).reasons,
    ).toContain('DUPLICATE_EXECUTION_HISTORY');
  });

  it('thin liquidity resizes or escalates', () => {
    expect(
      evaluateDca(baseInput({ market: { liquidityMaxInput: 10n * UNIT } })),
    ).toMatchObject({
      kind: 'EXECUTE',
      reasons: ['LIQUIDITY_RESIZED'],
      tranche: { amountIn: 10n * UNIT },
    });
    expect(
      evaluateDca(baseInput({ market: { liquidityMaxInput: UNIT - 1n } })),
    ).toMatchObject({ kind: 'ESCALATE', reasons: ['LOW_LIQUIDITY'] });
  });

  it('policy schema rejects unsafe or inconsistent policies', () => {
    const raw = JSON.parse(
      JSON.stringify(policy, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    expect(parseDcaPolicy(raw)).toEqual(policy);
    for (const patch of [
      { extra: 1 },
      { maxTranche: '1' },
      { maxDeployment: '500000000' },
      { budget: '-1' },
      { budget: '01' },
      { maxSlippageBps: 10_001 },
      { expiresAt: START },
      { venue: 'other' },
      { allowedAssets: [policy.budgetAsset.address] },
      { minTranche: '26000000' },
      { dip: { multiplierBps: 9_999, triggerBelowTrailingBps: 1_000 } },
    ])
      expect(
        DcaPolicySchema.safeParse({ ...raw, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
  });

  it('activity entrypoint accepts JSON and returns JSON-safe output', () => {
    const input = baseInput();
    const json = JSON.parse(
      JSON.stringify(input, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    const out = evaluateDcaActivity(json);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out.kind).toBe('EXECUTE');
    expect(out.tranche!.amountIn).toBe('25000000');
    expect(out.decisionId).toBe(`${policy.strategyId}:0`);
    expect(() => evaluateDcaActivity({ ...json, now: -1 })).toThrow();
    expect(() =>
      evaluateDcaActivity({ ...json, llmOverride: 'EXECUTE' }),
    ).toThrow();
  });
});
