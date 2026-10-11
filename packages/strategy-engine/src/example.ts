import { parseDcaPolicy, type DcaAsset, type DcaPolicy } from './schema.js';

const DAY = 86_400;

export function bibleSection23Example(input: {
  ausd: DcaAsset;
  mon: DcaAsset;
  startAt: number;
  strategyId?: string;
  venue?: string;
}): DcaPolicy {
  const unit = 10n ** BigInt(input.ausd.decimals);
  const venue = input.venue ?? 'kuru-flow';
  return parseDcaPolicy({
    strategyId: input.strategyId ?? 'dca-mon-ausd',
    startAt: input.startAt,
    expiresAt: input.startAt + 26 * 7 * DAY,
    frequencySeconds: 7 * DAY,
    budgetAsset: input.ausd,
    targetAsset: input.mon,
    allowedAssets: [input.ausd.address, input.mon.address],
    venue,
    allowedVenues: [venue],
    baseTranche: 25n * unit,
    maxTranche: 50n * unit,
    minTranche: 1n * unit,
    budget: 400n * unit,
    maxDeployment: 400n * unit,
    maxAllocationBps: 4_000,
    maxSlippageBps: 75,
    spike: { skipIf24hChangeAboveBps: 800 },
    dip: { multiplierBps: 15_000, triggerBelowTrailingBps: 1_000 },
    escalateIfAbsMoveAboveBps: 2_000,
    maxMarketDataAgeSeconds: 300,
    pause: {
      paused: false,
      pauseOnReferenceStatuses: [],
      pauseOnVenueUnhealthy: false,
    },
  });
}
