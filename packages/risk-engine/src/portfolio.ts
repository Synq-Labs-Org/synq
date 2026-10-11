import { artifactHash, canonicalJson } from '@synq/kernel';
import {
  BPS,
  abs,
  bpsOf,
  ceilDiv,
  floorDiv,
  max,
  pow10,
  valueOf,
} from './math.js';

export type PriceObservation = Readonly<{
  asset: string;
  price: bigint;
  decimals: number;
  at: number;
  source: string;
}>;
export type SpotHolding = Readonly<{
  asset: string;
  canonicalAssetId: string;
  amount: bigint;
  decimals: number;
  bucket: string;
  // Stable treasury assets are valued 1:1 in value units (accounting target,
  // Bible 96); they carry no price exposure in this engine.
  stable?: boolean;
}>;
export type PerpPositionInput = Readonly<{
  marketId: number;
  asset: string;
  side: 'LONG' | 'SHORT';
  size: bigint;
  sizeDecimals: number;
  entryPrice: bigint;
  priceDecimals: number;
  collateral: bigint;
  maintenanceMarginBps: number;
}>;
export type PerpAccountInput = Readonly<{
  balance: bigint;
  lockedBalance: bigint;
}>;
export type Scenario = Readonly<{
  id: string;
  shocksBps: Readonly<Record<string, number>>;
}>;
export type RiskInputs = Readonly<{
  asOf: number;
  valueDecimals: number;
  spot: readonly SpotHolding[];
  perpAccount: PerpAccountInput | null;
  perpPositions: readonly PerpPositionInput[];
  prices: readonly PriceObservation[];
  maxPriceAgeMs: number;
  scenarios: readonly Scenario[];
}>;

export type PositionRisk = {
  marketId: number;
  asset: string;
  side: 'LONG' | 'SHORT';
  size: string;
  notional: string;
  unrealizedPnl: string;
  collateral: string;
  maintenanceRequirement: string;
  liquidationPrice: string;
  liquidationDistanceBps: number;
};
export type AssetRisk = {
  asset: string;
  spotValue: string;
  perpNotional: string;
  netExposure: string;
  grossExposure: string;
  hedgeRatioBps: number | null;
  price: string;
  priceDecimals: number;
  priceAt: number;
  priceSource: string;
};
export type ScenarioResult = {
  id: string;
  pnl: string;
  loss: string;
  lossBpsOfEquity: number | null;
  liquidatedPositions: number;
};
export type PortfolioRisk = {
  schemaVersion: 1;
  asOf: number;
  valueDecimals: number;
  inputsHash: `0x${string}`;
  assets: AssetRisk[];
  positions: PositionRisk[];
  treasuryValue: string;
  stableValue: string;
  perpAccountBalance: string;
  perpFreeCollateral: string;
  perpEquity: string;
  equity: string;
  unrealizedPnl: string;
  grossExposure: string;
  netExposure: string;
  perpGrossNotional: string;
  leverageBps: number | null;
  portfolioLeverageBps: number | null;
  marginUtilizationBps: number | null;
  minLiquidationDistanceBps: number | null;
  concentrationBps: number | null;
  scenarios: ScenarioResult[];
  worstScenarioLoss: string;
  blocked: boolean;
  blockReasons: string[];
  assumptions: string[];
};

function inputsView(inputs: RiskInputs): unknown {
  return JSON.parse(
    JSON.stringify(inputs, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  );
}

export function liquidationPrice(
  p: PerpPositionInput,
  valueDecimals: number,
): bigint {
  const s = p.size;
  if (s <= 0n) return 0n;
  const V = pow10(valueDecimals);
  const D = pow10(p.sizeDecimals + p.priceDecimals);
  const m = BigInt(p.maintenanceMarginBps);
  if (p.side === 'LONG') {
    const n = (s * V * p.entryPrice - p.collateral * D) * BPS;
    return n <= 0n ? 0n : ceilDiv(n, s * V * (BPS - m));
  }
  return floorDiv(
    (s * V * p.entryPrice + p.collateral * D) * BPS,
    s * V * (BPS + m),
  );
}

function distanceBps(
  side: 'LONG' | 'SHORT',
  mark: bigint,
  liq: bigint,
): number {
  if (mark <= 0n) return 0;
  if (side === 'LONG' && liq === 0n) return 10_000;
  const d = side === 'LONG' ? mark - liq : liq - mark;
  return d <= 0n ? 0 : Number(floorDiv(d * BPS, mark));
}

export function evaluatePortfolio(inputs: RiskInputs): PortfolioRisk {
  const vd = inputs.valueDecimals;
  const blockReasons: string[] = [];
  const prices = new Map<string, PriceObservation>();
  for (const p of inputs.prices) {
    if (prices.has(p.asset)) blockReasons.push(`duplicate price ${p.asset}`);
    prices.set(p.asset, p);
    if (p.price <= 0n) blockReasons.push(`non-positive price ${p.asset}`);
    if (
      inputs.asOf - p.at > inputs.maxPriceAgeMs ||
      p.at - inputs.asOf > inputs.maxPriceAgeMs
    )
      blockReasons.push(`stale price ${p.asset} (${inputs.asOf - p.at}ms)`);
  }
  const priceOf = (asset: string): PriceObservation | null => {
    const p = prices.get(asset);
    if (!p) blockReasons.push(`missing price ${asset}`);
    return p ?? null;
  };
  const spotByAsset = new Map<string, bigint>();
  let stableValue = 0n;
  for (const h of inputs.spot) {
    if (h.amount < 0n) blockReasons.push(`negative holding ${h.asset}`);
    if (h.stable) {
      stableValue += valueOf(h.amount, h.decimals, 1n, 0, vd);
      continue;
    }
    const p = priceOf(h.asset);
    if (!p) continue;
    spotByAsset.set(
      h.asset,
      (spotByAsset.get(h.asset) ?? 0n) +
        valueOf(h.amount, h.decimals, p.price, p.decimals, vd),
    );
  }
  const perpByAsset = new Map<string, bigint>();
  const positions: PositionRisk[] = [];
  let upnlTotal = 0n;
  let positionEquity = 0n;
  let grossNotional = 0n;
  let maintenance = 0n;
  let minDistance: number | null = null;
  for (const pos of inputs.perpPositions) {
    const p = priceOf(pos.asset);
    if (!p) continue;
    if (p.decimals !== pos.priceDecimals)
      blockReasons.push(`price decimals mismatch ${pos.asset}`);
    const notional = valueOf(
      pos.size,
      pos.sizeDecimals,
      p.price,
      pos.priceDecimals,
      vd,
    );
    const entry = valueOf(
      pos.size,
      pos.sizeDecimals,
      pos.entryPrice,
      pos.priceDecimals,
      vd,
    );
    const upnl = pos.side === 'LONG' ? notional - entry : entry - notional;
    const req = ceilDiv(notional * BigInt(pos.maintenanceMarginBps), BPS);
    const liq = liquidationPrice(pos, vd);
    const dist = distanceBps(pos.side, p.price, liq);
    minDistance = minDistance === null ? dist : Math.min(minDistance, dist);
    upnlTotal += upnl;
    positionEquity += pos.collateral + upnl;
    grossNotional += notional;
    maintenance += req;
    perpByAsset.set(
      pos.asset,
      (perpByAsset.get(pos.asset) ?? 0n) +
        (pos.side === 'LONG' ? notional : -notional),
    );
    positions.push({
      marketId: pos.marketId,
      asset: pos.asset,
      side: pos.side,
      size: pos.size.toString(),
      notional: notional.toString(),
      unrealizedPnl: upnl.toString(),
      collateral: pos.collateral.toString(),
      maintenanceRequirement: req.toString(),
      liquidationPrice: liq.toString(),
      liquidationDistanceBps: dist,
    });
  }
  const balance = inputs.perpAccount?.balance ?? 0n;
  const free = max(0n, balance - (inputs.perpAccount?.lockedBalance ?? 0n));
  const perpEquity = balance + positionEquity;
  let treasuryValue = stableValue;
  for (const v of spotByAsset.values()) treasuryValue += v;
  const equity = treasuryValue + perpEquity;
  const assetNames = [
    ...new Set([...spotByAsset.keys(), ...perpByAsset.keys()]),
  ].sort();
  let gross = 0n;
  let net = 0n;
  let concentration: number | null = null;
  const assets: AssetRisk[] = [];
  for (const asset of assetNames) {
    const spot = spotByAsset.get(asset) ?? 0n;
    const perp = perpByAsset.get(asset) ?? 0n;
    const assetGross = abs(spot) + abs(perp);
    gross += assetGross;
    net += spot + perp;
    const c = bpsOf(abs(spot + perp), equity);
    if (c !== null) concentration = Math.max(concentration ?? 0, c);
    const p = prices.get(asset)!;
    assets.push({
      asset,
      spotValue: spot.toString(),
      perpNotional: perp.toString(),
      netExposure: (spot + perp).toString(),
      grossExposure: assetGross.toString(),
      hedgeRatioBps: spot > 0n ? bpsOf(max(0n, -perp), spot) : null,
      price: p.price.toString(),
      priceDecimals: p.decimals,
      priceAt: p.at,
      priceSource: p.source,
    });
  }
  const scenarios: ScenarioResult[] = inputs.scenarios.map((s) => {
    let pnl = 0n;
    for (const a of assets)
      pnl += floorDiv(
        BigInt(a.netExposure) * BigInt(s.shocksBps[a.asset] ?? 0),
        BPS,
      );
    let liquidated = 0;
    for (const pos of positions) {
      const p = prices.get(pos.asset);
      if (!p) continue;
      const shocked = floorDiv(
        p.price * (BPS + BigInt(s.shocksBps[pos.asset] ?? 0)),
        BPS,
      );
      const liq = BigInt(pos.liquidationPrice);
      if (pos.side === 'LONG' ? shocked <= liq : shocked >= liq) liquidated++;
    }
    const loss = pnl < 0n ? -pnl : 0n;
    return {
      id: s.id,
      pnl: pnl.toString(),
      loss: loss.toString(),
      lossBpsOfEquity: bpsOf(loss, equity),
      liquidatedPositions: liquidated,
    };
  });
  const worst = scenarios.reduce((m, s) => max(m, BigInt(s.loss)), 0n);
  if (equity <= 0n) blockReasons.push('non-positive equity');
  return {
    schemaVersion: 1,
    asOf: inputs.asOf,
    valueDecimals: vd,
    inputsHash: artifactHash(inputsView(inputs)),
    assets,
    positions,
    treasuryValue: treasuryValue.toString(),
    stableValue: stableValue.toString(),
    perpAccountBalance: balance.toString(),
    perpFreeCollateral: free.toString(),
    perpEquity: perpEquity.toString(),
    equity: equity.toString(),
    unrealizedPnl: upnlTotal.toString(),
    grossExposure: gross.toString(),
    netExposure: net.toString(),
    perpGrossNotional: grossNotional.toString(),
    leverageBps: bpsOf(grossNotional, perpEquity),
    portfolioLeverageBps: bpsOf(gross, equity),
    marginUtilizationBps: bpsOf(maintenance, perpEquity),
    minLiquidationDistanceBps: minDistance,
    concentrationBps: concentration,
    scenarios,
    worstScenarioLoss: worst.toString(),
    blocked: blockReasons.length > 0,
    blockReasons: [...new Set(blockReasons)],
    assumptions: [
      'stable treasury assets valued 1:1 in collateral units (accounting target, not an oracle)',
      'liquidation prices are estimates from isolated position collateral and maintenance margin; fees and funding excluded',
      'scenario PnL is linear in the shock; liquidation counts use estimated liquidation prices',
    ],
  };
}

export function portfolioRiskHash(risk: PortfolioRisk): `0x${string}` {
  return artifactHash(risk);
}

export function canonicalPortfolioRisk(risk: PortfolioRisk): string {
  return canonicalJson(risk);
}
