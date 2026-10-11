import type { Asset } from '@synq/schemas';
import {
  bindConversionQuote,
  contentHash,
  conversionIntent,
  type ConversionIntent,
  type ConversionQuote,
  type ConversionVenue,
} from '@synq/funding';
import {
  rescale,
  type EvidenceLabel,
  type Money,
  type SettlementRail,
  type SettlementRequirement,
} from '@synq/offer-exchange';

export const RAIL_LADDER: readonly SettlementRail[] = [
  'AUSD_ONCHAIN',
  'USDC_ONCHAIN',
  'X402_USDC',
  'PROVIDER_BALANCE',
  'STABLECOIN_CHECKOUT',
  'SCOPED_CARD',
  'HUMAN_HANDOFF',
];
const USDC_RAILS: readonly SettlementRail[] = [
  'USDC_ONCHAIN',
  'X402_USDC',
  'STABLECOIN_CHECKOUT',
  'SCOPED_CARD',
];

export type RailDescriptor = {
  railId: string;
  rail: SettlementRail;
  chainId: number | null;
  assetId: string | null;
  currency: string;
  auth: 'KERNEL_GRANT' | 'PROVIDER_API_KEY' | 'CARDHOLDER_STEP_UP' | 'HUMAN';
  kycRequired: boolean;
  kycSatisfied: boolean;
  environment: 'SANDBOX' | 'TESTNET' | 'MAINNET' | 'MAINNET_READ_ONLY';
  status: 'READY' | 'MISSING_CREDENTIALS' | 'PARTNER_GATED' | 'DOWN';
};

export type SettlementPolicy = {
  allowedRails: readonly SettlementRail[];
  allowedSourceAssets: readonly string[];
  fxBufferBps: number;
  conversion: {
    maxSlippageBps: number;
    maxDepegBps: number;
    maxReferenceAgeSeconds: number;
    perConversionCap: bigint;
    autoApproveMax: bigint;
    verifiedVenues: readonly string[];
  };
  quoteTtlSeconds: number;
};

export type TreasuryView = {
  account: `0x${string}`;
  core: { asset: Asset; free: bigint };
  edge: { asset: Asset; free: bigint };
};

/** AUSD/USD reference (8 decimals) from an independent feed, e.g. Chainlink. */
export type ReferencePrice = {
  source: string;
  priceE8: bigint;
  observedAt: number;
};

export type ConversionPlan = {
  intent: ConversionIntent;
  shortfall: string;
  approval: 'AUTO' | 'GROUP_APPROVAL';
  reference: { source: string; deviationBps: number; observedAt: number };
};

export type SettlementPlan = {
  status: 'PLANNED';
  planHash: `0x${string}`;
  intentId: string;
  rail: RailDescriptor;
  sourceAsset: string;
  /** Core-asset amount to reserve before any external quote or booking. */
  coreReservation: string;
  /** Edge (USDC) amount already held in the buffer and bound to this intent. */
  edgeReservation: string;
  requiredEdgeAmount: string;
  maxPayable: string;
  conversion: ConversionPlan | null;
  refundDestination: `0x${string}`;
  expiresAt: number;
  skipped: { rail: SettlementRail; reason: string }[];
};
export type SettlementRefusal = {
  status: 'REFUSED';
  code:
    | 'NO_RAIL'
    | 'UNSUPPORTED_CURRENCY'
    | 'UNSUPPORTED_SOURCE_ASSET'
    | 'OVER_APPROVED_CAP'
    | 'INSUFFICIENT_FREE_BALANCE'
    | 'CONVERSION_CAP_EXCEEDED'
    | 'REFERENCE_STALE'
    | 'DEPEG_GUARD';
  reason: string;
  skipped: { rail: SettlementRail; reason: string }[];
};

const ceilBps = (v: bigint, bps: number) =>
  (v * BigInt(10_000 + bps) + 9_999n) / 10_000n;

function toUnits(m: Money, decimals: number): bigint | null {
  if (!['USD', 'USDC', 'AUSD'].includes(m.currency)) return null;
  return rescale(BigInt(m.amount), m.decimals, decimals, 'up');
}

/**
 * AUSD-core / USDC-edge router (Bible §85). Converts only the bounded edge
 * shortfall, never the treasury, and refuses rather than widening any bound.
 */
export function planSettlement(input: {
  intentId: string;
  payable: Money;
  approvedMax: Money;
  requirement: SettlementRequirement;
  treasury: TreasuryView;
  rails: readonly RailDescriptor[];
  policy: SettlementPolicy;
  reference: ReferencePrice | null;
  now: number;
}): SettlementPlan | SettlementRefusal {
  const { treasury, policy, now } = input;
  const skipped: { rail: SettlementRail; reason: string }[] = [];
  const refuse = (
    code: SettlementRefusal['code'],
    reason: string,
  ): SettlementRefusal => ({ status: 'REFUSED', code, reason, skipped });
  if (
    !policy.allowedSourceAssets.includes(treasury.core.asset.canonicalAssetId)
  )
    return refuse('UNSUPPORTED_SOURCE_ASSET', treasury.core.asset.symbol);
  const accepted = [...input.requirement.accepts].sort(
    (a, b) => RAIL_LADDER.indexOf(a.rail) - RAIL_LADDER.indexOf(b.rail),
  );
  let chosen: RailDescriptor | null = null;
  for (const a of accepted) {
    if (!policy.allowedRails.includes(a.rail)) {
      skipped.push({ rail: a.rail, reason: 'not allowed by mandate' });
      continue;
    }
    const rail = input.rails.find((r) => r.rail === a.rail);
    if (!rail) {
      skipped.push({ rail: a.rail, reason: 'no rail configured' });
      continue;
    }
    if (rail.status !== 'READY') {
      skipped.push({ rail: a.rail, reason: rail.status });
      continue;
    }
    if (rail.kycRequired && !rail.kycSatisfied) {
      skipped.push({ rail: a.rail, reason: 'KYC not satisfied' });
      continue;
    }
    if (
      rail.environment === 'MAINNET' ||
      rail.environment === 'MAINNET_READ_ONLY'
    ) {
      skipped.push({ rail: a.rail, reason: 'mainnet rail is not executable' });
      continue;
    }
    chosen = rail;
    break;
  }
  if (!chosen)
    return refuse('NO_RAIL', 'no allowed, healthy rail accepts this offer');

  const edgeDecimals = treasury.edge.asset.decimals;
  const coreDecimals = treasury.core.asset.decimals;
  const required = toUnits(input.payable, edgeDecimals);
  const cap = toUnits(input.approvedMax, edgeDecimals);
  if (required === null || cap === null)
    return refuse('UNSUPPORTED_CURRENCY', input.payable.currency);
  if (required > cap)
    return refuse('OVER_APPROVED_CAP', `${required} > ${cap}`);
  const maxPayable = (() => {
    const buffered = ceilBps(required, policy.fxBufferBps);
    return buffered > cap ? cap : buffered;
  })();
  const base = {
    status: 'PLANNED' as const,
    intentId: input.intentId,
    rail: chosen,
    refundDestination: treasury.account,
    expiresAt: now + policy.quoteTtlSeconds,
    requiredEdgeAmount: String(required),
    maxPayable: String(maxPayable),
    skipped,
  };
  const finish = (p: Omit<SettlementPlan, 'planHash'>): SettlementPlan => ({
    ...p,
    planHash: contentHash({
      ...p,
      conversion: p.conversion
        ? { ...p.conversion, intent: p.conversion.intent.conversionId }
        : null,
    }),
  });

  if (chosen.rail === 'HUMAN_HANDOFF')
    return finish({
      ...base,
      sourceAsset: treasury.core.asset.canonicalAssetId,
      coreReservation: '0',
      edgeReservation: '0',
      conversion: null,
    });

  if (!USDC_RAILS.includes(chosen.rail)) {
    const coreAmount = rescale(maxPayable, edgeDecimals, coreDecimals, 'up');
    if (coreAmount > treasury.core.free)
      return refuse('INSUFFICIENT_FREE_BALANCE', 'core AUSD');
    return finish({
      ...base,
      sourceAsset: treasury.core.asset.canonicalAssetId,
      coreReservation: String(coreAmount),
      edgeReservation: '0',
      conversion: null,
    });
  }

  if (treasury.edge.free >= maxPayable)
    return finish({
      ...base,
      sourceAsset: treasury.edge.asset.canonicalAssetId,
      coreReservation: '0',
      edgeReservation: String(maxPayable),
      conversion: null,
    });

  const shortfall = maxPayable - treasury.edge.free;
  const ref = input.reference;
  if (!ref || now - ref.observedAt > policy.conversion.maxReferenceAgeSeconds)
    return refuse('REFERENCE_STALE', 'AUSD reference price missing or stale');
  const par = 100_000_000n;
  const deviation = Number(
    ((ref.priceE8 > par ? ref.priceE8 - par : par - ref.priceE8) * 10_000n) /
      par,
  );
  if (deviation > policy.conversion.maxDepegBps)
    return refuse('DEPEG_GUARD', `AUSD deviates ${deviation} bps from par`);
  const keep = BigInt(10_000 - policy.conversion.maxSlippageBps);
  const amountIn = rescale(
    (shortfall * 10_000n + keep - 1n) / keep,
    edgeDecimals,
    coreDecimals,
    'up',
  );
  if (amountIn > policy.conversion.perConversionCap)
    return refuse('CONVERSION_CAP_EXCEEDED', `${amountIn} > cap`);
  if (amountIn > treasury.core.free)
    return refuse('INSUFFICIENT_FREE_BALANCE', 'core AUSD for conversion');
  const intent = conversionIntent({
    fromAsset: treasury.core.asset,
    toAsset: treasury.edge.asset,
    amountIn,
    maxSlippageBps: policy.conversion.maxSlippageBps,
    reference: `${input.intentId}:${chosen.railId}`,
  });
  if (BigInt(intent.minAmountOut) < shortfall)
    return refuse('CONVERSION_CAP_EXCEEDED', 'minimum output below shortfall');
  return finish({
    ...base,
    sourceAsset: treasury.core.asset.canonicalAssetId,
    coreReservation: String(amountIn),
    edgeReservation: String(treasury.edge.free),
    conversion: {
      intent,
      shortfall: String(shortfall),
      approval:
        amountIn <= policy.conversion.autoApproveMax
          ? 'AUTO'
          : 'GROUP_APPROVAL',
      reference: {
        source: ref.source,
        deviationBps: deviation,
        observedAt: ref.observedAt,
      },
    },
  });
}

export type ConversionRoute = ConversionVenue & {
  readonly label: EvidenceLabel;
  readonly executable: boolean;
  execute?(intent: ConversionIntent, now: number): Promise<ConversionReceipt>;
};

export type ConversionReceipt = {
  conversionId: string;
  venue: string;
  label: EvidenceLabel;
  amountIn: string;
  amountOut: string;
  transactionHash: `0x${string}` | null;
  note: string;
  at: number;
};

export class ConversionError extends Error {
  constructor(
    readonly code:
      | 'ROUTE_UNVERIFIED'
      | 'ROUTE_NOT_EXECUTABLE'
      | 'SLIPPAGE_EXCEEDED'
      | 'QUOTE_EXPIRED'
      | 'BELOW_SHORTFALL',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ConversionError';
  }
}

export async function quoteConversion(input: {
  plan: ConversionPlan;
  route: ConversionRoute;
  policy: SettlementPolicy;
  now: number;
}): Promise<{
  intent: ConversionIntent;
  quote: ConversionQuote;
  label: EvidenceLabel;
}> {
  const { plan, route } = input;
  if (!input.policy.conversion.verifiedVenues.includes(route.venue))
    throw new ConversionError('ROUTE_UNVERIFIED', route.venue);
  const quote = await route.quote({
    fromAsset: plan.intent.fromAsset,
    toAsset: plan.intent.toAsset,
    amountIn: BigInt(plan.intent.amountIn),
    now: input.now,
  });
  let bound: ConversionIntent;
  try {
    bound = bindConversionQuote(plan.intent, quote, input.now);
  } catch (e) {
    throw new ConversionError(
      'QUOTE_EXPIRED',
      e instanceof Error ? e.message : '',
    );
  }
  if (bound.status === 'REJECTED')
    throw new ConversionError('SLIPPAGE_EXCEEDED', bound.reason ?? '');
  if (BigInt(quote.amountOut) < BigInt(plan.shortfall))
    throw new ConversionError('BELOW_SHORTFALL');
  return { intent: bound, quote, label: route.label };
}

/**
 * Explicitly labelled deterministic testnet settlement fixture. It never
 * claims an on-chain swap; its receipt carries no transaction hash.
 */
export class TestnetSettlementFixture implements ConversionRoute {
  readonly venue = 'testnet-deterministic-settlement-fixture';
  readonly label = 'SIMULATED' as const;
  readonly executable = true;
  constructor(private readonly feeBps = 5) {}
  async quote(input: {
    fromAsset: Asset;
    toAsset: Asset;
    amountIn: bigint;
    now: number;
  }) {
    const par = rescale(
      input.amountIn,
      input.fromAsset.decimals,
      input.toAsset.decimals,
      'down',
    );
    const out = (par * BigInt(10_000 - this.feeBps)) / 10_000n;
    const body = {
      venue: this.venue,
      amountIn: String(input.amountIn),
      amountOut: String(out),
      at: input.now,
    };
    return {
      venue: this.venue,
      quoteId: `fixture-${input.now}`,
      amountIn: String(input.amountIn),
      amountOut: String(out),
      expiresAt: input.now + 30,
      artifactHash: contentHash(body),
    };
  }
  async execute(
    intent: ConversionIntent,
    now: number,
  ): Promise<ConversionReceipt> {
    if (intent.status !== 'QUOTED' || !intent.quote)
      throw new ConversionError('ROUTE_NOT_EXECUTABLE', 'unquoted');
    return {
      conversionId: intent.conversionId,
      venue: this.venue,
      label: this.label,
      amountIn: intent.amountIn,
      amountOut: intent.quote.amountOut,
      transactionHash: null,
      note: 'TESTNET_DETERMINISTIC_SETTLEMENT_FIXTURE: no swap was broadcast',
      at: now,
    };
  }
}

/** Production route quoted read-only on mainnet; execution is refused. */
export class MainnetReadOnlyRoute implements ConversionRoute {
  readonly label = 'MAINNET_READ_ONLY' as const;
  readonly executable = false;
  constructor(private readonly inner: ConversionVenue) {}
  get venue() {
    return this.inner.venue;
  }
  quote(input: Parameters<ConversionVenue['quote']>[0]) {
    return this.inner.quote(input);
  }
  async execute(): Promise<ConversionReceipt> {
    throw new ConversionError(
      'ROUTE_NOT_EXECUTABLE',
      'MAINNET_BROADCAST_DISABLED',
    );
  }
}

export function verifyRefundDestination(
  plan: Pick<SettlementPlan, 'refundDestination'>,
  destination: string,
): void {
  if (destination.toLowerCase() !== plan.refundDestination.toLowerCase())
    throw new Error('REFUND_DESTINATION_MISMATCH');
}
