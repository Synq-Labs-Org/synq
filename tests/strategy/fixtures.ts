import { officialAssets } from '@synq/chain-registry';
import {
  bibleSection23Example,
  type DcaAsset,
  type DcaEvaluationInput,
  type DcaExecution,
} from '@synq/strategy-engine';

export const AUSD: DcaAsset = {
  symbol: 'AUSD',
  address: officialAssets.mainnetAUSD.address,
  decimals: officialAssets.mainnetAUSD.decimals,
  chainId: officialAssets.mainnetAUSD.chainId,
};
export const WMON: DcaAsset = {
  symbol: 'WMON',
  address: officialAssets.mainnetWMON.address,
  decimals: officialAssets.mainnetWMON.decimals,
  chainId: officialAssets.mainnetWMON.chainId,
};
export const UNIT = 1_000_000n;
export const WEEK = 7 * 86_400;
export const START = 1_790_000_000;
export const policy = bibleSection23Example({
  ausd: AUSD,
  mon: WMON,
  startAt: START,
});
export const price = (micro: bigint) => micro * 10n ** 12n;

export function baseInput(
  overrides: {
    policy?: Partial<DcaEvaluationInput['policy']>;
    market?: Partial<DcaEvaluationInput['market']>;
    treasury?: Partial<DcaEvaluationInput['treasury']>;
    executions?: DcaExecution[];
    exitedPrincipal?: bigint;
    now?: number;
  } = {},
): DcaEvaluationInput {
  const now = overrides.now ?? START + 3_600;
  return {
    policy: { ...policy, ...overrides.policy },
    market: {
      asOf: now - 10,
      venue: 'kuru-flow',
      assetIn: AUSD.address,
      assetOut: WMON.address,
      price: price(25_000n),
      trailingReferencePrice: price(25_000n),
      change24hBps: 100,
      venueHealthy: true,
      liquidityMaxInput: 1_000n * UNIT,
      referenceStatus: 'HEALTHY',
      sourcesConflict: false,
      ...overrides.market,
    },
    treasury: {
      freeBudgetAsset: 1_000n * UNIT,
      totalValueInBudgetAsset: 1_000n * UNIT,
      targetPositionValueInBudgetAsset: 0n,
      ...overrides.treasury,
    },
    history: {
      executions: overrides.executions ?? [],
      exitedPrincipal: overrides.exitedPrincipal ?? 0n,
    },
    now,
  };
}

export function execution(
  slot: number,
  amountIn: bigint,
  status: DcaExecution['status'] = 'SETTLED',
): DcaExecution {
  return {
    slot,
    intentId: `${policy.strategyId}:${slot}`,
    at: START + slot * WEEK,
    amountIn,
    status,
  };
}
