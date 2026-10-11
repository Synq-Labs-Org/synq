import {
  HedgeIntentSchema,
  HedgeMandateSchema,
  type HedgeIntent,
  type HedgeMandate,
} from '@synq/kernel';
import { BPS, bpsOf, ceilDiv, floorDiv, max, min, pow10 } from './math.js';
import {
  liquidationPrice,
  portfolioRiskHash,
  type PortfolioRisk,
} from './portfolio.js';

export type HedgeMarket = Readonly<{
  marketId: number;
  base: string;
  priceDecimals: number;
  sizeDecimals: number;
  maxLeverageHundredths: number;
  maintenanceMarginBps: number;
  mark: bigint;
  bid: bigint;
  ask: bigint;
  at: number;
}>;

export type HedgeTrigger = HedgeIntent['trigger'];

export type HedgeProposal =
  | { action: 'NONE'; reason: string; riskPacketHash: `0x${string}` }
  | { action: 'BLOCKED'; reason: string; riskPacketHash: `0x${string}` }
  | { action: 'PROPOSE'; intent: HedgeIntent; riskPacketHash: `0x${string}` };

export type HedgeContext = Readonly<{
  intentId: string;
  now: number;
  ttlSeconds: number;
  trigger: HedgeTrigger;
  leverageHundredths: number;
}>;

// The only input the Brain can contribute is the trigger; sizes, prices,
// leverage and collateral are derived here from the risk packet and mandate.
export function proposeHedge(
  risk: PortfolioRisk,
  rawMandate: HedgeMandate,
  market: HedgeMarket,
  ctx: HedgeContext,
): HedgeProposal {
  const mandate = HedgeMandateSchema.parse(rawMandate);
  const riskPacketHash = portfolioRiskHash(risk);
  if (risk.blocked)
    return {
      action: 'BLOCKED',
      reason: risk.blockReasons.join('; '),
      riskPacketHash,
    };
  if (market.base !== mandate.hedgedAsset)
    return {
      action: 'BLOCKED',
      reason: 'market does not hedge the mandated asset',
      riskPacketHash,
    };
  const asset = risk.assets.find((a) => a.asset === mandate.hedgedAsset);
  const spot = asset ? BigInt(asset.spotValue) : 0n;
  const perp = asset ? BigInt(asset.perpNotional) : 0n;
  const currentShort = max(0n, -perp);
  if (perp > 0n)
    return {
      action: 'BLOCKED',
      reason: 'existing long perp exposure on hedged asset',
      riskPacketHash,
    };
  const desired =
    spot <= 0n ? 0n : floorDiv(spot * BigInt(mandate.targetHedgeRatioBps), BPS);
  const delta = desired - currentShort;
  const minAdjust = BigInt(mandate.minAdjustNotional);
  if ((delta >= 0n ? delta : -delta) < minAdjust || delta === 0n)
    return { action: 'NONE', reason: 'hedge within tolerance', riskPacketHash };
  const vd = risk.valueDecimals;
  const unit = pow10(market.sizeDecimals + market.priceDecimals);
  const notionalToSize = (n: bigint, px: bigint) =>
    floorDiv(n * unit, px * pow10(vd));
  const sizeToNotional = (s: bigint, px: bigint) =>
    floorDiv(s * px * pow10(vd), unit);
  const slip = BigInt(mandate.maxSlippageBps);
  const createdAt = Math.floor(ctx.now / 1000);
  const base = {
    schemaVersion: 1 as const,
    intentId: ctx.intentId,
    groupId: mandate.groupId,
    hedgeMandateId: mandate.hedgeMandateId,
    hedgeMandateVersion: mandate.version,
    chainId: mandate.chainId,
    venue: 'perpl' as const,
    perplAccountId: mandate.perplAccountId,
    side: 'SHORT' as const,
    marketId: market.marketId,
    base: market.base,
    riskPacketHash,
    marketDataAt: market.at,
    createdAt,
    expiresAt: createdAt + Math.min(ctx.ttlSeconds, mandate.grantTtlSeconds),
    trigger: ctx.trigger,
  };
  if (delta < 0n) {
    const position = risk.positions.find(
      (p) => p.marketId === market.marketId && p.side === 'SHORT',
    );
    if (!position)
      return {
        action: 'BLOCKED',
        reason: 'short exposure without a position on the mandated market',
        riskPacketHash,
      };
    const size = min(
      BigInt(position.size),
      notionalToSize(-delta, market.mark),
    );
    if (size <= 0n)
      return {
        action: 'NONE',
        reason: 'reduction below one lot',
        riskPacketHash,
      };
    const closing = size === BigInt(position.size);
    const limitPrice = ceilDiv(market.ask * (BPS + slip), BPS);
    const after = currentShort - sizeToNotional(size, market.mark);
    return {
      action: 'PROPOSE',
      riskPacketHash,
      intent: HedgeIntentSchema.parse({
        ...base,
        kind: closing ? 'CLOSE' : 'REDUCE',
        size: size.toString(),
        limitPrice: limitPrice.toString(),
        leverageHundredths: 0,
        notional: sizeToNotional(size, market.mark).toString(),
        collateral: '0',
        postTradeHedgeRatioBps:
          spot > 0n ? (bpsOf(max(0n, after), spot) ?? 0) : 0,
        postTradeLiquidationBufferBps: null,
      }),
    };
  }
  const lv = Math.min(
    ctx.leverageHundredths,
    mandate.maxLeverageHundredths,
    market.maxLeverageHundredths,
  );
  if (lv < 100)
    return { action: 'BLOCKED', reason: 'leverage below 1x', riskPacketHash };
  const cap = min(
    BigInt(mandate.maxNotional) - currentShort,
    floorDiv(spot * BigInt(mandate.maxHedgeRatioBps), BPS) - currentShort,
  );
  const collateralCap = BigInt(mandate.maxCollateral);
  const byCollateral = floorDiv(collateralCap * BigInt(lv), 100n);
  const notionalTarget = min(min(delta, cap), byCollateral);
  if (notionalTarget <= 0n)
    return {
      action: 'NONE',
      reason: 'no headroom under hedge caps',
      riskPacketHash,
    };
  // Sell at no worse than bid minus slippage.
  const limitPrice = floorDiv(market.bid * (BPS - slip), BPS);
  if (limitPrice <= 0n)
    return { action: 'BLOCKED', reason: 'no bid', riskPacketHash };
  const size = notionalToSize(notionalTarget, market.mark);
  if (size <= 0n)
    return { action: 'NONE', reason: 'hedge below one lot', riskPacketHash };
  const notional = sizeToNotional(size, market.mark);
  const collateral = ceilDiv(notional * 100n, BigInt(lv));
  const liq = liquidationPrice(
    {
      marketId: market.marketId,
      asset: market.base,
      side: 'SHORT',
      size,
      sizeDecimals: market.sizeDecimals,
      entryPrice: market.mark,
      priceDecimals: market.priceDecimals,
      collateral,
      maintenanceMarginBps: market.maintenanceMarginBps,
    },
    vd,
  );
  const buffer =
    liq > market.mark
      ? Number(floorDiv((liq - market.mark) * BPS, market.mark))
      : 0;
  return {
    action: 'PROPOSE',
    riskPacketHash,
    intent: HedgeIntentSchema.parse({
      ...base,
      kind: currentShort > 0n ? 'INCREASE' : 'OPEN',
      size: size.toString(),
      limitPrice: limitPrice.toString(),
      leverageHundredths: lv,
      notional: notional.toString(),
      collateral: collateral.toString(),
      postTradeHedgeRatioBps:
        spot > 0n ? (bpsOf(currentShort + notional, spot) ?? 0) : 0,
      postTradeLiquidationBufferBps: buffer,
    }),
  };
}
