import {
  availableLiquidity,
  canDeployToYield,
  forecastCash,
  SCENARIOS,
} from '@synq/allocations';
import type { Money } from '@synq/domain';
import type { YieldReservePort } from './index.js';

export type YieldAllocationSnapshot = Readonly<{
  asset: Money['asset'];
  cash: Omit<Parameters<typeof forecastCash>[0], 'scenario' | 'asOf'>;
  obligationsImported: boolean;
  builtAt: number;
  maxAgeSeconds: number;
  operatingFloor: bigint;
  stressBuffer: bigint;
  lockDays: number;
  activeDisputes: number;
  productEligible: boolean;
}>;

/** Load from the treasury's trusted books on every decision, never from a model. */
export function allocationYieldReserves(
  load: () => Promise<YieldAllocationSnapshot>,
): YieldReservePort {
  return {
    async canDeployToYield({ amount, at }) {
      const s = await load();
      const now = Math.floor(at / 1000);
      if (
        s.asset.assetId !== amount.asset.assetId ||
        s.asset.chainId !== amount.asset.chainId ||
        s.asset.address.toLowerCase() !== amount.asset.address.toLowerCase() ||
        s.asset.decimals !== amount.asset.decimals
      )
        throw new Error('allocation asset differs from deposit');
      if (
        !Number.isSafeInteger(now) ||
        !Number.isSafeInteger(s.builtAt) ||
        s.builtAt > now ||
        !Number.isSafeInteger(s.maxAgeSeconds) ||
        s.maxAgeSeconds < 0 ||
        !Number.isSafeInteger(s.lockDays) ||
        s.lockDays < 0 ||
        !Number.isSafeInteger(s.activeDisputes) ||
        s.activeDisputes < 0 ||
        s.operatingFloor < 0n ||
        s.stressBuffer < 0n ||
        s.cash.heldForTax < 0n ||
        s.cash.position.observedAt > now ||
        now - s.cash.position.observedAt > s.maxAgeSeconds
      )
        throw new Error('invalid or stale allocation context');
      const gate = canDeployToYield({
        amount: amount.baseUnits,
        now,
        lockDays: s.lockDays,
        operatingFloor: s.operatingFloor,
        stressBuffer: s.stressBuffer,
        forecasts: SCENARIOS.map((scenario) =>
          forecastCash({ ...s.cash, asOf: now, scenario }),
        ),
        obligationsImported: s.obligationsImported,
        forecastBuiltAt: s.builtAt,
        maxForecastAgeSeconds: s.maxAgeSeconds,
        activeDisputes: s.activeDisputes,
        productEligible: s.productEligible,
      });
      // Forecasting projects obligations instead of subtracting their holds.
      // This separate spot check also protects any holds absent from that feed.
      const free = availableLiquidity(s.cash.position) - s.cash.heldForTax;
      if (free - amount.baseUnits < s.operatingFloor + s.stressBuffer)
        gate.reasons.push(
          'active reservations or restricted cash block deposit',
        );
      return gate.allowed && gate.reasons.length === 0
        ? {
            allowed: true,
            freeAfter: {
              asset: amount.asset,
              baseUnits: free - amount.baseUnits,
            },
          }
        : { allowed: false, reason: gate.reasons.join('; ') };
    },
  };
}
