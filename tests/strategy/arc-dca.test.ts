import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  ARC_SWAP_VENUE,
  DcaPositionBook,
  StrategyError,
  amendDcaSchedule,
  createArcDcaSchedule,
  evaluateArcDca,
  pauseDcaSchedule,
  resumeDcaSchedule,
  stopDcaSchedule,
  widenings,
  type OwnerApprovalPort,
} from '@synq/strategies';

const DAY = 86_400;
const start = 1_792_108_800; // 2026-10-16T00:00:00Z
const usdc = token('arc-testnet', 'USDC');
const eurc = token('arc-testnet', 'EURC');
const schedule = createArcDcaSchedule({
  strategyId: 'arc-usdc-eurc-weekly',
  startAt: start,
  expiresAt: start + 12 * 7 * DAY,
  frequencySeconds: 7 * DAY,
  baseTranche: 20_000n,
  maxTranche: 20_000n,
  minTranche: 10_000n,
  budget: 240_000n,
  maxDeployment: 240_000n,
  maxAllocationBps: 2_000,
  maxSlippageBps: 100,
});
const agent = { kind: 'AGENT', id: 'treasury-agent' } as const;
const approvals = (ok: boolean, seen: Hex[] = []): OwnerApprovalPort => ({
  async verifyScheduleApproval({ digest }) {
    seen.push(digest);
    return ok;
  },
});
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ACCEPTED';
  } catch (e) {
    return (e as StrategyError).code;
  }
};
const market = (asOf: number) => ({
  asOf,
  venue: ARC_SWAP_VENUE,
  assetIn: usdc.address.toLowerCase() as `0x${string}`,
  assetOut: eurc.address.toLowerCase() as `0x${string}`,
  // 0.878 USDC per EURC, 1e18-scaled (from the live quote 0.02 -> 0.022777)
  price: 878_078_763_664_222_680n,
  trailingReferencePrice: 878_078_763_664_222_680n,
  change24hBps: 0,
  venueHealthy: true,
  liquidityMaxInput: 20_000n,
  referenceStatus: 'HEALTHY' as const,
  sourcesConflict: false,
});
const treasury = {
  freeBudgetAsset: 24_000_000n,
  totalValueInBudgetAsset: 24_000_000n,
  targetPositionValueInBudgetAsset: 0n,
};

describe('Arc DCA schedules (P15)', () => {
  it('builds schedules from registry assets on the App Kit venue only', () => {
    expect(schedule.policy.budgetAsset.address).toBe(
      usdc.address.toLowerCase(),
    );
    expect(schedule.policy.targetAsset.address).toBe(
      eurc.address.toLowerCase(),
    );
    expect(schedule.policy.allowedVenues).toEqual([ARC_SWAP_VENUE]);
    expect(schedule.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('P15-05 an agent cannot expand a capped schedule; narrowing is allowed', async () => {
    const widen: Record<
      string,
      Parameters<typeof amendDcaSchedule>[0]['amendment']
    > = {
      budget: { budget: 480_000n },
      maxDeployment: { maxTranche: 40_000n, baseTranche: 40_000n },
      slippage: { maxSlippageBps: 300 },
      longer: { expiresAt: start + 52 * 7 * DAY },
      moreOften: { frequencySeconds: DAY },
      allocation: { maxAllocationBps: 9_000 },
      staleData: { maxMarketDataAgeSeconds: 3_600 },
      newAsset: {
        allowedAssets: [
          ...schedule.policy.allowedAssets,
          `0x${'7'.repeat(40)}`,
        ],
      },
      newVenue: { allowedVenues: [ARC_SWAP_VENUE, 'uniswap-v4'] },
    };
    const results: Record<string, string> = {};
    for (const [name, amendment] of Object.entries(widen))
      results[name] = await code(
        amendDcaSchedule({ schedule, amendment, actor: agent }),
      );
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(widen).map((k) => [k, 'CAP_EXPANSION_REQUIRES_OWNER']),
      ),
    );
    expect(
      await code(
        amendDcaSchedule({
          schedule,
          amendment: { venue: 'uniswap-v4' },
          actor: agent,
        }),
      ),
    ).toBe('IMMUTABLE_FIELD');

    const narrower = await amendDcaSchedule({
      schedule,
      amendment: {
        budget: 120_000n,
        maxDeployment: 120_000n,
        maxSlippageBps: 50,
        frequencySeconds: 14 * DAY,
      },
      actor: agent,
    });
    expect(narrower).toMatchObject({ version: 2 });
    expect(narrower.policy.budget).toBe(120_000n);
    expect(widenings(schedule.policy, narrower.policy)).toEqual([]);
  });

  it('P15-05 an owner may widen only with an approval bound to the exact new schedule', async () => {
    const owner = {
      kind: 'OWNER',
      id: 'owner',
      approval: { sig: '0xabc' },
    } as const;
    expect(
      await code(
        amendDcaSchedule({
          schedule,
          amendment: { budget: 480_000n, maxDeployment: 480_000n },
          actor: owner,
        }),
      ),
    ).toBe('OWNER_APPROVAL_INVALID');
    expect(
      await code(
        amendDcaSchedule({
          schedule,
          amendment: { budget: 480_000n, maxDeployment: 480_000n },
          actor: owner,
          approvals: approvals(false),
        }),
      ),
    ).toBe('OWNER_APPROVAL_INVALID');
    const seen: Hex[] = [];
    const wider = await amendDcaSchedule({
      schedule,
      amendment: { budget: 480_000n, maxDeployment: 480_000n },
      actor: owner,
      approvals: approvals(true, seen),
    });
    expect(seen).toEqual([wider.digest]);
    expect(wider.digest).not.toBe(schedule.digest);
  });

  it('pause and stop are open to the agent; resume needs the owner; stopped never executes', async () => {
    const now = start + 60;
    const run = (s: typeof schedule) =>
      evaluateArcDca(s, {
        market: market(now - 10),
        treasury,
        history: { executions: [], exitedPrincipal: 0n },
        now,
      });
    expect(run(schedule).kind).toBe('EXECUTE');
    const paused = pauseDcaSchedule(schedule);
    expect(run(paused)).toMatchObject({
      kind: 'SKIP',
      reasons: expect.arrayContaining(['PAUSED']),
    });
    expect(
      await code(resumeDcaSchedule({ schedule: paused, actor: agent })),
    ).toBe('RESUME_REQUIRES_OWNER');
    expect(
      await code(
        amendDcaSchedule({
          schedule: paused,
          amendment: { paused: false },
          actor: agent,
        }),
      ),
    ).toBe('CAP_EXPANSION_REQUIRES_OWNER');
    const resumed = await resumeDcaSchedule({
      schedule: paused,
      actor: { kind: 'OWNER', id: 'owner', approval: {} },
      approvals: approvals(true),
    });
    expect(run(resumed).kind).toBe('EXECUTE');
    const stopped = stopDcaSchedule(resumed);
    expect(run(stopped)).toEqual({ kind: 'SKIP', reasons: ['STOPPED'] });
    expect(
      await code(
        amendDcaSchedule({
          schedule: stopped,
          amendment: { budget: 1n },
          actor: agent,
        }),
      ),
    ).toBe('STOPPED');
  });

  it('caps hold in evaluation and the position book reconciles to chain', () => {
    const book = new DcaPositionBook(schedule);
    book.record({
      slot: 0,
      intentId: 'dca-0',
      at: start + 60,
      amountIn: 20_000n,
      amountOut: 22_777n,
      txHash: `0x${'5b'.repeat(32)}`,
    });
    expect(() =>
      book.record({
        slot: 0,
        intentId: 'dca-0b',
        at: start + 61,
        amountIn: 20_000n,
        amountOut: 22_777n,
        txHash: `0x${'5c'.repeat(32)}`,
      }),
    ).toThrow(StrategyError);
    expect(book.averageCost()).toBe((20_000n * 10n ** 18n) / 22_777n);
    expect(book.reconcile(22_777n)).toBe(true);
    expect(() => book.reconcile(22_776n)).toThrow(/book 22777 != chain 22776/);
    // Same slot again: already executed.
    const again = evaluateArcDca(schedule, {
      market: market(start + 100),
      treasury,
      history: book.history(),
      now: start + 120,
    });
    expect(again).toMatchObject({ kind: 'SKIP' });
    // Budget exhausted after the full schedule.
    const spentAll = new DcaPositionBook(schedule);
    for (let i = 0; i < 12; i++)
      spentAll.record({
        slot: i,
        intentId: `dca-${i}`,
        at: start + i * 7 * DAY + 60,
        amountIn: 20_000n,
        amountOut: 22_000n,
        txHash: `0x${(i + 16).toString(16).padStart(2, '0').repeat(32)}`,
      });
    const late = start + 11 * 7 * DAY + 3 * DAY;
    expect(
      evaluateArcDca(schedule, {
        market: market(late - 5),
        treasury,
        history: spentAll.history(),
        now: late,
      }),
    ).toMatchObject({ kind: 'SKIP' });
  });
});
