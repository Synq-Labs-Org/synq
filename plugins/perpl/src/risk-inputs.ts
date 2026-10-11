import type {
  HedgeMarket,
  PerpAccountInput,
  PerpPositionInput,
  PriceObservation,
} from '@synq/risk-engine';
import { PerplError } from './errors.js';
import type { MarketCatalog, MarketQuote, MarketSpec } from './markets.js';
import type { PerplAccount, PerplPosition } from './schemas.js';

const OPEN_POSITION = 1;

export function positionInputs(
  catalog: MarketCatalog,
  positions: readonly PerplPosition[],
  accountId: number,
): PerpPositionInput[] {
  return positions
    .filter((p) => p.acc === accountId && p.st === OPEN_POSITION && p.s > 0)
    .map((p) => {
      const market = catalog.all().find((m) => m.id === p.mkt);
      if (!market)
        throw new PerplError('MARKET_UNAVAILABLE', `position market ${p.mkt}`);
      return {
        marketId: p.mkt,
        asset: market.base,
        side: p.sd === 1 ? ('LONG' as const) : ('SHORT' as const),
        size: BigInt(p.s),
        sizeDecimals: market.sizeDecimals,
        entryPrice: BigInt(p.ep),
        priceDecimals: market.priceDecimals,
        collateral: BigInt(p.c),
        maintenanceMarginBps: market.maintenanceMarginBps,
      };
    });
}

export function accountInput(
  account: PerplAccount | null,
): PerpAccountInput | null {
  if (!account) return null;
  return { balance: BigInt(account.b), lockedBalance: BigInt(account.lb) };
}

export function markObservation(
  market: MarketSpec,
  quote: MarketQuote,
  label: string,
): PriceObservation {
  return {
    asset: market.base,
    price: quote.mark,
    decimals: market.priceDecimals,
    at: quote.at,
    source: `perpl-${label.toLowerCase()}:mark:${market.id}:${quote.block}`,
  };
}

export function hedgeMarket(
  market: MarketSpec,
  quote: MarketQuote,
): HedgeMarket {
  return {
    marketId: market.id,
    base: market.base,
    priceDecimals: market.priceDecimals,
    sizeDecimals: market.sizeDecimals,
    maxLeverageHundredths: market.maxLeverageHundredths,
    maintenanceMarginBps: market.maintenanceMarginBps,
    mark: quote.mark,
    bid: quote.bid,
    ask: quote.ask,
    at: quote.at,
  };
}
