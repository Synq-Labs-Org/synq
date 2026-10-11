import type { PerplNetworkConfig } from '@synq/chain-registry';
import { PerplError } from './errors.js';
import type { Market, MarketState, PerplContext } from './schemas.js';

export type MarketSpec = Readonly<{
  id: number;
  base: string;
  name: string;
  open: boolean;
  priceDecimals: number;
  sizeDecimals: number;
  maxLeverageHundredths: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  orderTtlBlocks: number;
  maxMarketSlippageBps: number;
  defaultMaxNegPnlBps: number;
  takerFeeMicros: number;
  makerFeeMicros: number;
}>;

// MarketConfig.initial_margin and maintenance_margin are leverage ceilings in
// hundredths (docs: initial 1000 = 10% margin = 10x; maintenance 2000 = 5%).
export function marginBps(leverageHundredths: number): number {
  if (!Number.isSafeInteger(leverageHundredths) || leverageHundredths <= 0)
    throw new PerplError(
      'INVALID_RESPONSE',
      'margin leverage must be positive',
    );
  return Math.ceil(1_000_000 / leverageHundredths);
}

export function marketSpec(market: Market): MarketSpec {
  const base = market.size_units || market.symbol || market.name;
  if (!base) throw new PerplError('INVALID_RESPONSE', 'market without asset');
  return Object.freeze({
    id: market.id,
    base: base.toUpperCase(),
    name: market.name,
    open: market.config.is_open,
    priceDecimals: market.config.price_decimals,
    sizeDecimals: market.config.size_decimals,
    maxLeverageHundredths: market.config.initial_margin,
    initialMarginBps: marginBps(market.config.initial_margin),
    maintenanceMarginBps: marginBps(market.config.maintenance_margin),
    orderTtlBlocks: market.order_ttl_blocks,
    maxMarketSlippageBps: market.order_max_market_slippage_bps,
    defaultMaxNegPnlBps: market.order_max_neg_pnl_collat_bps,
    takerFeeMicros: market.config.taker_fee,
    makerFeeMicros: market.config.maker_fee,
  });
}

export class MarketCatalog {
  private readonly byId = new Map<number, MarketSpec>();
  constructor(
    readonly network: PerplNetworkConfig,
    context: PerplContext,
    readonly loadedAt: number,
  ) {
    if (context.chain.chain_id !== network.chainId)
      throw new PerplError(
        'PROFILE_MISMATCH',
        `context chain ${context.chain.chain_id} is not the ${network.label} profile`,
      );
    for (const market of context.markets)
      this.byId.set(market.id, marketSpec(market));
  }
  all(): MarketSpec[] {
    return [...this.byId.values()];
  }
  byIdOrThrow(id: number, allowClosed = false): MarketSpec {
    const market = this.byId.get(id);
    if (!market) throw new PerplError('MARKET_UNAVAILABLE', `market ${id}`);
    if (!market.open && !allowClosed)
      throw new PerplError('MARKET_UNAVAILABLE', `${id} closed`);
    return market;
  }
  byBase(base: string): MarketSpec {
    const matches = this.all().filter((m) => m.base === base.toUpperCase());
    if (matches.length !== 1)
      throw new PerplError(
        'MARKET_UNAVAILABLE',
        `${base}: ${matches.length} markets on ${this.network.label}`,
      );
    return this.byIdOrThrow(matches[0]!.id);
  }
}

export type MarketQuote = Readonly<{
  marketId: number;
  mark: bigint;
  oracle: bigint;
  bid: bigint;
  ask: bigint;
  block: bigint;
  at: number;
}>;

export function quoteFrom(
  marketId: number,
  state: MarketState,
  maxAgeMs: number,
  now: number,
): MarketQuote {
  const at = state.at.t;
  if (at === undefined || state.at.b === undefined)
    throw new PerplError('MARKET_STALE', `market ${marketId} has no timestamp`);
  if (now - at > maxAgeMs || at - now > maxAgeMs)
    throw new PerplError(
      'MARKET_STALE',
      `market ${marketId} state is ${now - at}ms old (max ${maxAgeMs})`,
    );
  if (state.mrk <= 0)
    throw new PerplError('MARKET_STALE', `market ${marketId} has no mark`);
  return Object.freeze({
    marketId,
    mark: BigInt(state.mrk),
    oracle: BigInt(state.orl),
    bid: BigInt(state.bid),
    ask: BigInt(state.ask),
    block: BigInt(state.at.b),
    at,
  });
}
