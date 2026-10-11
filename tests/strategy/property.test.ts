import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decisionToJson,
  evaluateDca,
  evaluateDcaActivity,
  type DcaEvaluationInput,
  type DcaExecution,
} from '@synq/strategy-engine';
import { START, UNIT, WEEK, policy } from './fixtures.js';

const RUNS = {
  numRuns: 400,
  interruptAfterTimeLimit: 60_000,
  markInterruptAsFailure: true,
};
const amount = (max: bigint) => fc.bigInt({ min: 1n, max });
const mostly = <T>(usual: T, rare: T) =>
  fc.oneof({ weight: 5, arbitrary: fc.constant(usual) }, fc.constant(rare));

const policyArb = fc
  .record({
    base: amount(100n * UNIT),
    extra: fc.bigInt({ min: 0n, max: 100n * UNIT }),
    minDiv: fc.bigInt({ min: 1n, max: 10n }),
    budget: amount(2_000n * UNIT),
    deployFrac: fc.integer({ min: 1, max: 10_000 }),
    maxAllocationBps: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 4_000, max: 10_000 }) },
      fc.integer({ min: 0, max: 10_000 }),
    ),
    maxSlippageBps: fc.integer({ min: 0, max: 10_000 }),
    spike: fc.oneof(
      { weight: 3, arbitrary: fc.constant(800) },
      fc.integer({ min: 1, max: 5_000 }),
    ),
    escalate: fc.oneof(
      { weight: 3, arbitrary: fc.constant(2_000) },
      fc.integer({ min: 1, max: 10_000 }),
    ),
    multiplierBps: fc.integer({ min: 10_000, max: 100_000 }),
    trigger: fc.integer({ min: 1, max: 9_999 }),
    paused: mostly(false, true),
    pauseOnVenueUnhealthy: mostly(false, true),
    pauseOn: fc.subarray(['DEGRADED', 'UNKNOWN', 'STALE'] as const),
  })
  .map((p) => {
    const budget = p.budget;
    return {
      ...policy,
      baseTranche: p.base,
      maxTranche: p.base + p.extra,
      minTranche: p.base / p.minDiv > 0n ? p.base / p.minDiv : 1n,
      budget,
      maxDeployment:
        (budget * BigInt(p.deployFrac)) / 10_000n > 0n
          ? (budget * BigInt(p.deployFrac)) / 10_000n
          : 1n,
      maxAllocationBps: p.maxAllocationBps,
      maxSlippageBps: p.maxSlippageBps,
      spike: { skipIf24hChangeAboveBps: p.spike },
      escalateIfAbsMoveAboveBps: p.escalate,
      dip: {
        multiplierBps: p.multiplierBps,
        triggerBelowTrailingBps: p.trigger,
      },
      pause: {
        paused: p.paused,
        pauseOnReferenceStatuses: [...p.pauseOn],
        pauseOnVenueUnhealthy: p.pauseOnVenueUnhealthy,
      },
    };
  });

const executionArb = fc.record({
  slot: fc.integer({ min: 0, max: 60 }),
  amountIn: amount(200n * UNIT),
  status: fc.constantFrom('PENDING', 'SETTLED', 'FAILED' as const),
  age: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: WEEK, max: 40 * WEEK }) },
    fc.integer({ min: 0, max: WEEK }),
  ),
});

const inputArb = fc
  .record({
    policy: policyArb,
    offset: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 25 * WEEK }) },
      fc.integer({ min: -WEEK, max: 30 * WEEK }),
    ),
    staleness: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 300 }) },
      fc.integer({ min: -5, max: 600 }),
    ),
    price: fc.bigInt({ min: 1n, max: 10n ** 21n }),
    trailing: fc.bigInt({ min: 1n, max: 10n ** 21n }),
    change24hBps: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: -500, max: 500 }) },
      fc.integer({ min: -10_000, max: 30_000 }),
    ),
    venueHealthy: mostly(true, false),
    liquidity: fc.oneof(
      { weight: 3, arbitrary: fc.constant(10_000n * UNIT) },
      fc.bigInt({ min: 0n, max: 500n * UNIT }),
    ),
    referenceStatus: fc.oneof(
      { weight: 6, arbitrary: fc.constant('HEALTHY' as const) },
      fc.constantFrom('DEGRADED', 'UNKNOWN', 'STALE' as const),
    ),
    sourcesConflict: mostly(false, true),
    free: fc.bigInt({ min: 0n, max: 3_000n * UNIT }),
    total: fc.bigInt({ min: 0n, max: 5_000n * UNIT }),
    position: fc.bigInt({ min: 0n, max: 1_000n * UNIT }),
    executions: fc.array(executionArb, { maxLength: 6 }),
    exited: fc.bigInt({ min: 0n, max: 500n * UNIT }),
  })
  .map((r): DcaEvaluationInput => {
    const now = START + r.offset;
    return {
      policy: r.policy,
      market: {
        asOf: now - r.staleness,
        venue: policy.venue,
        assetIn: policy.budgetAsset.address,
        assetOut: policy.targetAsset.address,
        price: r.price,
        trailingReferencePrice: r.trailing,
        change24hBps: r.change24hBps,
        venueHealthy: r.venueHealthy,
        liquidityMaxInput: r.liquidity,
        referenceStatus: r.referenceStatus,
        sourcesConflict: r.sourcesConflict,
      },
      treasury: {
        freeBudgetAsset: r.free,
        totalValueInBudgetAsset: r.total,
        targetPositionValueInBudgetAsset: r.position,
      },
      history: {
        executions: r.executions.map(
          (e, i): DcaExecution => ({
            slot: e.slot,
            intentId: `x-${i}`,
            at: Math.max(0, now - e.age),
            amountIn: e.amountIn,
            status: e.status,
          }),
        ),
        exitedPrincipal: (() => {
          const settled = r.executions
            .filter((e) => e.status === 'SETTLED')
            .reduce((sum, e) => sum + e.amountIn, 0n);
          return r.exited < settled ? r.exited : settled;
        })(),
      },
      now,
    };
  });

const executableArb = inputArb.map(
  (input): DcaEvaluationInput => ({
    ...input,
    now: START,
    policy: {
      ...input.policy,
      budget: input.policy.maxTranche * 100n,
      maxDeployment: input.policy.maxTranche * 100n,
      maxAllocationBps: 10_000,
      pause: { ...input.policy.pause, paused: false },
    },
    market: {
      ...input.market,
      asOf: START,
      referenceStatus: 'HEALTHY',
      sourcesConflict: false,
      venueHealthy: true,
      liquidityMaxInput: input.policy.maxTranche * 100n,
      change24hBps: 0,
    },
    treasury: {
      freeBudgetAsset: input.policy.maxTranche * 100n,
      totalValueInBudgetAsset: input.policy.maxTranche * 100n,
      targetPositionValueInBudgetAsset: 0n,
    },
    history: { executions: [], exitedPrincipal: 0n },
  }),
);

const spentOf = (input: DcaEvaluationInput) =>
  input.history.executions
    .filter((e) => e.status !== 'FAILED')
    .reduce((s, e) => s + e.amountIn, 0n);
const tranche = (input: DcaEvaluationInput) =>
  evaluateDca(input).tranche?.amountIn ?? 0n;
const jsonOf = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)),
  );

describe('DCA evaluator properties', () => {
  it('every EXECUTE respects tranche, budget, deployment, balance, allocation and liquidity bounds', () => {
    let executed = 0;
    fc.assert(
      fc.property(
        fc.oneof({ weight: 4, arbitrary: inputArb }, executableArb),
        (input) => {
          const d = evaluateDca(input);
          if (d.kind !== 'EXECUTE') return;
          executed++;
          const { policy: p, treasury: t, market: m } = input;
          const amt = d.tranche!.amountIn;
          const spent = spentOf(input);
          const deployed = spent - input.history.exitedPrincipal;
          expect(amt).toBeGreaterThanOrEqual(p.minTranche);
          expect(amt).toBeLessThanOrEqual(p.maxTranche);
          expect(amt).toBeLessThanOrEqual(p.budget - spent);
          expect(amt).toBeLessThanOrEqual(
            p.maxDeployment - (deployed > 0n ? deployed : 0n),
          );
          expect(amt).toBeLessThanOrEqual(t.freeBudgetAsset);
          expect(amt).toBeLessThanOrEqual(m.liquidityMaxInput);
          expect(
            (t.targetPositionValueInBudgetAsset +
              input.history.executions
                .filter((e) => e.status === 'PENDING')
                .reduce((total, e) => total + e.amountIn, 0n) +
              amt) *
              10_000n,
          ).toBeLessThanOrEqual(
            BigInt(p.maxAllocationBps) * t.totalValueInBudgetAsset,
          );
          expect(d.diagnostics.allocationAfterBps!).toBeLessThanOrEqual(
            p.maxAllocationBps,
          );
          expect(d.tranche!.maxSlippageBps).toBe(p.maxSlippageBps);
          expect(d.tranche!.minOutputFloor).toBeLessThanOrEqual(
            d.tranche!.indicativeOutput,
          );
        },
      ),
      RUNS,
    );
    expect(executed).toBeGreaterThan(RUNS.numRuns / 20);
  });

  it('never executes when paused, expired, stale, spiking, unhealthy or the AUSD reference is not HEALTHY', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = evaluateDca(input);
        const { policy: p, market: m, now } = input;
        const blocked =
          p.pause.paused ||
          now >= p.expiresAt ||
          now < p.startAt ||
          m.referenceStatus !== 'HEALTHY' ||
          !m.venueHealthy ||
          m.sourcesConflict ||
          m.asOf > now ||
          now - m.asOf > p.maxMarketDataAgeSeconds ||
          m.change24hBps > p.spike.skipIf24hChangeAboveBps ||
          Math.abs(m.change24hBps) >= p.escalateIfAbsMoveAboveBps;
        if (blocked) {
          expect(d.kind).not.toBe('EXECUTE');
          expect(d.tranche).toBeNull();
        }
        expect(d.decisionId).toBe(`${p.strategyId}:${d.slot}`);
      }),
      RUNS,
    );
  });

  it('dip multiplier never produces a tranche above maxTranche', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = evaluateDca(input);
        if (d.diagnostics.candidateTranche !== null)
          expect(d.diagnostics.candidateTranche).toBeLessThanOrEqual(
            input.policy.maxTranche,
          );
      }),
      RUNS,
    );
  });

  it('is deterministic and JSON round-trips through the activity entrypoint', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const a = evaluateDca(input);
        expect(evaluateDca(structuredClone(input))).toEqual(a);
        expect(evaluateDcaActivity(jsonOf(input))).toEqual(decisionToJson(a));
      }),
      RUNS,
    );
  });

  it('adding past spend never increases the next tranche', () => {
    fc.assert(
      fc.property(inputArb, amount(300n * UNIT), (input, extra) => {
        const slot = evaluateDca(input).slot;
        const more: DcaEvaluationInput = {
          ...input,
          history: {
            ...input.history,
            executions: [
              ...input.history.executions,
              {
                slot: slot + 1_000,
                intentId: 'extra',
                at: 0,
                amountIn: extra,
                status: 'SETTLED',
              },
            ],
          },
        };
        expect(tranche(more)).toBeLessThanOrEqual(tranche(input));
      }),
      RUNS,
    );
  });
});
