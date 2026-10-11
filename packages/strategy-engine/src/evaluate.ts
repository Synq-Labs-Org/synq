import {
  parseDcaEvaluationInput,
  type DcaEvaluationInput,
  type DcaPolicy,
} from './schema.js';

export const PRICE_SCALE = 10n ** 18n;
const BPS = 10_000n;

export type DcaDecisionKind = 'EXECUTE' | 'SKIP' | 'ESCALATE';
export type DcaTranche = {
  amountIn: bigint;
  maxSlippageBps: number;
  venue: string;
  assetIn: string;
  assetOut: string;
  indicativeOutput: bigint;
  minOutputFloor: bigint;
  dipApplied: boolean;
};
export type DcaDiagnostics = {
  spent: bigint;
  pending: bigint;
  budgetRemaining: bigint;
  deployed: bigint;
  deploymentCapacity: bigint;
  allocationCap: bigint;
  allocationHeadroom: bigint;
  allocationAfterBps: number | null;
  candidateTranche: bigint | null;
  dipApplied: boolean;
  lastExecutionAt: number | null;
};
export type DcaDecision = {
  kind: DcaDecisionKind;
  reasons: string[];
  strategyId: string;
  slot: number;
  decisionId: string;
  evaluatedAt: number;
  terminal: boolean;
  tranche: DcaTranche | null;
  diagnostics: DcaDiagnostics;
};

export interface StrategyEvaluator {
  evaluate(input: DcaEvaluationInput): DcaDecision;
}

const minBig = (...values: bigint[]) =>
  values.reduce((a, b) => (b < a ? b : a));
const clampZero = (v: bigint) => (v < 0n ? 0n : v);

export function slotOf(policy: DcaPolicy, now: number): number {
  if (now < policy.startAt) return 0;
  return Math.floor((now - policy.startAt) / policy.frequencySeconds);
}

export function indicativeOutput(
  amountIn: bigint,
  price: bigint,
  budgetDecimals: number,
  targetDecimals: number,
): bigint {
  return (
    (amountIn * 10n ** BigInt(targetDecimals) * PRICE_SCALE) /
    (price * 10n ** BigInt(budgetDecimals))
  );
}

function accounting(input: DcaEvaluationInput) {
  const { policy, treasury, history } = input;
  let settled = 0n;
  let pending = 0n;
  let lastExecutionAt: number | null = null;
  for (const e of history.executions) {
    if (e.status === 'FAILED') continue;
    if (e.status === 'SETTLED') settled += e.amountIn;
    else pending += e.amountIn;
    if (lastExecutionAt === null || e.at > lastExecutionAt)
      lastExecutionAt = e.at;
  }
  const spent = settled + pending;
  const deployed = clampZero(spent - history.exitedPrincipal);
  const allocationCap =
    (BigInt(policy.maxAllocationBps) * treasury.totalValueInBudgetAsset) / BPS;
  return {
    spent,
    pending,
    budgetRemaining: clampZero(policy.budget - spent),
    deployed,
    deploymentCapacity: clampZero(policy.maxDeployment - deployed),
    allocationCap,
    allocationHeadroom:
      allocationCap - treasury.targetPositionValueInBudgetAsset - pending,
    lastExecutionAt,
  };
}

export function evaluateDca(raw: DcaEvaluationInput): DcaDecision {
  const input = parseDcaEvaluationInput(raw);
  const { policy, market, treasury, history, now } = input;
  const slot = slotOf(policy, now);
  const acct = accounting(input);
  const diagnostics: DcaDiagnostics = {
    spent: acct.spent,
    pending: acct.pending,
    budgetRemaining: acct.budgetRemaining,
    deployed: acct.deployed,
    deploymentCapacity: acct.deploymentCapacity,
    allocationCap: acct.allocationCap,
    allocationHeadroom: acct.allocationHeadroom,
    allocationAfterBps: null,
    candidateTranche: null,
    dipApplied: false,
    lastExecutionAt: acct.lastExecutionAt,
  };
  const decide = (
    kind: DcaDecisionKind,
    reasons: string[],
    extra: { terminal?: boolean; tranche?: DcaTranche } = {},
  ): DcaDecision => ({
    kind,
    reasons,
    strategyId: policy.strategyId,
    slot,
    decisionId: `${policy.strategyId}:${slot}`,
    evaluatedAt: now,
    terminal: extra.terminal ?? false,
    tranche: extra.tranche ?? null,
    diagnostics,
  });

  const settledPrincipal = history.executions
    .filter((e) => e.status === 'SETTLED')
    .reduce((total, e) => total + e.amountIn, 0n);
  if (history.exitedPrincipal > settledPrincipal)
    return decide('ESCALATE', ['INVALID_EXIT_ACCOUNTING']);
  if (
    new Set(history.executions.map((e) => e.intentId)).size !==
      history.executions.length ||
    new Set(history.executions.map((e) => e.slot)).size !==
      history.executions.length
  )
    return decide('ESCALATE', ['DUPLICATE_EXECUTION_HISTORY']);
  if (now >= policy.expiresAt)
    return decide('SKIP', ['EXPIRED'], { terminal: true });
  if (now < policy.startAt) return decide('SKIP', ['NOT_STARTED']);
  if (policy.pause.paused) return decide('SKIP', ['PAUSED']);
  if (history.executions.some((e) => e.slot === slot && e.status !== 'FAILED'))
    return decide('SKIP', ['ALREADY_EXECUTED_IN_SLOT']);
  if (
    acct.lastExecutionAt !== null &&
    acct.lastExecutionAt > now - policy.frequencySeconds
  )
    return decide('SKIP', ['NOT_DUE']);

  if (!policy.allowedVenues.includes(market.venue))
    return decide('ESCALATE', ['VENUE_NOT_ALLOWED']);
  if (
    !policy.allowedAssets.includes(market.assetIn) ||
    !policy.allowedAssets.includes(market.assetOut)
  )
    return decide('ESCALATE', ['ASSET_NOT_ALLOWED']);
  if (
    market.venue !== policy.venue ||
    market.assetIn !== policy.budgetAsset.address ||
    market.assetOut !== policy.targetAsset.address
  )
    return decide('ESCALATE', ['MARKET_ROUTE_MISMATCH']);

  if (market.asOf > now || now - market.asOf > policy.maxMarketDataAgeSeconds)
    return decide('ESCALATE', ['STALE_MARKET_DATA']);
  if (market.sourcesConflict)
    return decide('ESCALATE', ['CONFLICTING_EVIDENCE']);

  if (!market.venueHealthy)
    return policy.pause.pauseOnVenueUnhealthy
      ? decide('SKIP', ['VENUE_UNHEALTHY_PAUSED'])
      : decide('ESCALATE', ['VENUE_UNAVAILABLE']);

  if (market.referenceStatus !== 'HEALTHY') {
    const status = market.referenceStatus;
    return policy.pause.pauseOnReferenceStatuses.includes(status)
      ? decide('SKIP', [`REFERENCE_${status}_PAUSED`])
      : decide('ESCALATE', [`AUSD_RISK_${status}`]);
  }

  if (Math.abs(market.change24hBps) >= policy.escalateIfAbsMoveAboveBps)
    return decide('ESCALATE', ['LARGE_MARKET_MOVE']);
  if (market.change24hBps > policy.spike.skipIf24hChangeAboveBps)
    return decide('SKIP', ['SPIKE']);

  const reasons: string[] = [];
  let tranche = policy.baseTranche;
  const dip =
    market.price * BPS <=
    market.trailingReferencePrice *
      (BPS - BigInt(policy.dip.triggerBelowTrailingBps));
  if (dip) {
    tranche = minBig(
      (policy.baseTranche * BigInt(policy.dip.multiplierBps)) / BPS,
      policy.maxTranche,
    );
    diagnostics.dipApplied = true;
    reasons.push('DIP_MULTIPLIER');
  }
  diagnostics.candidateTranche = tranche;

  const caps: [bigint, string][] = [
    [acct.budgetRemaining, 'BUDGET_EXHAUSTED'],
    [acct.deploymentCapacity, 'MAX_DEPLOYMENT'],
    [clampZero(acct.allocationHeadroom), 'ALLOCATION_CAP'],
    [treasury.freeBudgetAsset, 'INSUFFICIENT_FREE_BALANCE'],
  ];
  for (const [limit, reason] of caps) {
    if (limit < policy.minTranche) return decide('SKIP', [...reasons, reason]);
    if (limit < tranche) {
      tranche = limit;
      reasons.push(`${reason}_CAPPED`);
    }
  }

  if (tranche > market.liquidityMaxInput) {
    if (market.liquidityMaxInput < policy.minTranche)
      return decide('ESCALATE', [...reasons, 'LOW_LIQUIDITY']);
    tranche = market.liquidityMaxInput;
    reasons.push('LIQUIDITY_RESIZED');
  }

  const total = treasury.totalValueInBudgetAsset;
  diagnostics.allocationAfterBps = Number(
    ((treasury.targetPositionValueInBudgetAsset + acct.pending + tranche) *
      BPS) /
      total,
  );
  const output = indicativeOutput(
    tranche,
    market.price,
    policy.budgetAsset.decimals,
    policy.targetAsset.decimals,
  );
  return decide('EXECUTE', reasons.length ? reasons : ['SCHEDULED'], {
    tranche: {
      amountIn: tranche,
      maxSlippageBps: policy.maxSlippageBps,
      venue: policy.venue,
      assetIn: policy.budgetAsset.address,
      assetOut: policy.targetAsset.address,
      indicativeOutput: output,
      minOutputFloor: (output * (BPS - BigInt(policy.maxSlippageBps))) / BPS,
      dipApplied: dip,
    },
  });
}

export const dcaEvaluator: StrategyEvaluator = Object.freeze({
  evaluate: evaluateDca,
});
