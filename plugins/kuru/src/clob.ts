import {
  encodeFunctionData,
  parseAbi,
  type Hex,
  type PublicClient,
} from 'viem';
import { z } from 'zod';
import type { ProfileName } from '@synq/domain';
import {
  NATIVE_TOKEN,
  kuruDeployment,
  type Address,
  type KuruMarket,
} from './deployment.js';
import { KuruError, requireKuru } from './errors.js';
import type { HttpFetch } from './flow-client.js';
import { exactApproval, type PreparedApproval } from './flow.js';

export const KURU_EXCHANGE_INFO_URL =
  'https://exchange.kuru.io/api/v3/exchangeInfo';
/** OrderBook ABI as deployed (implementation selectors checked on 2026-10-10: minOut is uint256). */
export const orderBookAbi = parseAbi([
  'function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseAssetDecimals, address quoteAsset, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
  'function bestBidAsk() view returns (uint256 bestBid, uint256 bestAsk)',
  'function getL2Book() view returns (bytes)',
  'function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
  'function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)',
]);
const UINT256_MAX = (1n << 256n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;

export type MarketParams = {
  pricePrecision: bigint;
  sizePrecision: bigint;
  baseAsset: Address;
  baseDecimals: number;
  quoteAsset: Address;
  quoteDecimals: number;
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
  takerFeeBps: bigint;
  makerFeeBps: bigint;
};
export type BookLevel = { price: bigint; size: bigint };
export type L2Book = {
  blockNumber: bigint;
  bids: BookLevel[];
  asks: BookLevel[];
};
export type MarketHealth =
  | { status: 'HEALTHY'; bestBid: bigint; bestAsk: bigint }
  | {
      status: 'UNHEALTHY';
      reason: 'EMPTY_BOOK' | 'NO_BIDS' | 'NO_ASKS' | 'CROSSED';
      bestBid: bigint;
      bestAsk: bigint;
    };
export type PreparedMarketOrder = {
  venue: 'kuru-clob';
  chainId: number;
  market: Address;
  side: 'BUY' | 'SELL';
  inputAmount: bigint;
  minOutput: bigint;
  approval: PreparedApproval | null;
  call: { target: Address; calldata: Hex; value: bigint };
};

/** Decodes `getL2Book()`: block number, bid (price, size) words until a zero price, then ask pairs. */
export function decodeL2Book(data: Hex): L2Book {
  const hex = data.slice(2);
  requireKuru(
    hex.length % 64 === 0 && hex.length >= 64,
    'MARKET_MISMATCH',
    'l2 book length',
  );
  const words: bigint[] = [];
  for (let i = 0; i < hex.length; i += 64)
    words.push(BigInt(`0x${hex.slice(i, i + 64)}`));
  const [blockNumber, ...rest] = words as [bigint, ...bigint[]];
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  let i = 0;
  while (i < rest.length && rest[i] !== 0n) {
    requireKuru(i + 1 < rest.length, 'MARKET_MISMATCH', 'dangling bid');
    bids.push({ price: rest[i]!, size: rest[i + 1]! });
    i += 2;
  }
  i += 1;
  while (i + 1 < rest.length && rest[i] !== 0n) {
    asks.push({ price: rest[i]!, size: rest[i + 1]! });
    i += 2;
  }
  return { blockNumber, bids, asks };
}

export function marketHealth(bestBid: bigint, bestAsk: bigint): MarketHealth {
  const noBids = bestBid === UINT256_MAX || bestBid === 0n;
  const noAsks = bestAsk === 0n || bestAsk === UINT256_MAX;
  if (noBids && noAsks)
    return { status: 'UNHEALTHY', reason: 'EMPTY_BOOK', bestBid, bestAsk };
  if (noBids)
    return { status: 'UNHEALTHY', reason: 'NO_BIDS', bestBid, bestAsk };
  if (noAsks)
    return { status: 'UNHEALTHY', reason: 'NO_ASKS', bestBid, bestAsk };
  if (bestBid >= bestAsk)
    return { status: 'UNHEALTHY', reason: 'CROSSED', bestBid, bestAsk };
  return { status: 'HEALTHY', bestBid, bestAsk };
}

const ExchangeSymbolSchema = z
  .object({
    symbol: z.string(),
    status: z.string(),
    marketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .loose();
const ExchangeInfoSchema = z
  .object({ symbols: z.array(ExchangeSymbolSchema) })
  .loose();
export type ExchangeSymbol = {
  symbol: string;
  status: string;
  marketAddress: Address;
};

type ChainReader = Pick<PublicClient, 'readContract' | 'getChainId'>;

/** Kuru CLOB adapter over viem: registry markets, on-chain market params/book reads and market-order calldata. */
export class KuruClobAdapter {
  constructor(
    private readonly clientFor: (profile: ProfileName) => ChainReader,
    private readonly fetchImpl?: HttpFetch,
  ) {}

  market(profile: ProfileName, pair: string): KuruMarket {
    const market = kuruDeployment(profile).markets.find((m) => m.pair === pair);
    if (!market) throw new KuruError('MARKET_MISSING', `${pair} on ${profile}`);
    return market;
  }

  private async client(profile: ProfileName): Promise<ChainReader> {
    const client = this.clientFor(profile);
    requireKuru(
      (await client.getChainId()) === kuruDeployment(profile).chainId,
      'WRONG_CHAIN',
    );
    return client;
  }

  async marketParams(
    profile: ProfileName,
    pair: string,
  ): Promise<MarketParams> {
    const market = this.market(profile, pair);
    const client = await this.client(profile);
    const p = await client.readContract({
      address: market.address,
      abi: orderBookAbi,
      functionName: 'getMarketParams',
    });
    const params: MarketParams = {
      pricePrecision: BigInt(p[0]),
      sizePrecision: p[1],
      baseAsset: p[2].toLowerCase() as Address,
      baseDecimals: Number(p[3]),
      quoteAsset: p[4].toLowerCase() as Address,
      quoteDecimals: Number(p[5]),
      tickSize: BigInt(p[6]),
      minSize: p[7],
      maxSize: p[8],
      takerFeeBps: p[9],
      makerFeeBps: p[10],
    };
    requireKuru(
      params.baseAsset === market.base.address &&
        params.quoteAsset === market.quote.address &&
        params.baseDecimals === market.base.decimals &&
        params.quoteDecimals === market.quote.decimals,
      'MARKET_MISMATCH',
      pair,
    );
    return params;
  }

  async health(profile: ProfileName, pair: string): Promise<MarketHealth> {
    const market = this.market(profile, pair);
    const client = await this.client(profile);
    const [bid, ask] = await client.readContract({
      address: market.address,
      abi: orderBookAbi,
      functionName: 'bestBidAsk',
    });
    return marketHealth(bid, ask);
  }

  async l2Book(profile: ProfileName, pair: string): Promise<L2Book> {
    const market = this.market(profile, pair);
    const client = await this.client(profile);
    const data = await client.readContract({
      address: market.address,
      abi: orderBookAbi,
      functionName: 'getL2Book',
    });
    return decodeL2Book(data);
  }

  async exchangeInfo(): Promise<ExchangeSymbol[]> {
    requireKuru(
      this.fetchImpl !== undefined,
      'PROVIDER_UNAVAILABLE',
      'no fetch',
    );
    const response = await this.fetchImpl(KURU_EXCHANGE_INFO_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    requireKuru(response.ok, 'PROVIDER_UNAVAILABLE', `HTTP ${response.status}`);
    const parsed = ExchangeInfoSchema.safeParse(await response.json());
    requireKuru(parsed.success, 'QUOTE_SCHEMA_CHANGED', 'exchangeInfo');
    return parsed.data.symbols.map((s) => ({
      symbol: s.symbol,
      status: s.status,
      marketAddress: s.marketAddress.toLowerCase() as Address,
    }));
  }

  /** Registry markets of a profile that exchangeInfo lists at a different address (drift) or not at all. */
  static exchangeDrift(
    profile: ProfileName,
    symbols: readonly ExchangeSymbol[],
  ): string[] {
    return kuruDeployment(profile).markets.flatMap((m) => {
      const listed = symbols.find((s) => s.symbol === m.pair.replace('-', '_'));
      if (!listed) return [`${m.pair}: not listed`];
      return listed.marketAddress === m.address
        ? []
        : [`${m.pair}: listed at ${listed.marketAddress}`];
    });
  }

  /**
   * Market buy spending exactly `quoteAmount` (quote token raw units). The order size is expressed in the market's
   * price precision, so the amount must convert exactly; `minBaseOut` is in base-token raw units.
   */
  async prepareMarketBuy(input: {
    profile: ProfileName;
    pair: string;
    quoteAmount: bigint;
    minBaseOut: bigint;
    healthy?: MarketHealth;
  }): Promise<PreparedMarketOrder> {
    const market = this.market(input.profile, input.pair);
    const params = await this.marketParams(input.profile, input.pair);
    const health =
      input.healthy ?? (await this.health(input.profile, input.pair));
    requireKuru(health.status === 'HEALTHY', 'MARKET_UNHEALTHY', input.pair);
    requireKuru(input.quoteAmount > 0n, 'INVALID_AMOUNT');
    requireKuru(
      input.minBaseOut > 0n,
      'MIN_OUTPUT_BREACH',
      'minOut must be positive',
    );
    const scaled = input.quoteAmount * params.pricePrecision;
    const unit = 10n ** BigInt(params.quoteDecimals);
    requireKuru(
      scaled % unit === 0n,
      'PRECISION',
      'quote amount does not fit price precision',
    );
    const quoteSize = scaled / unit;
    requireKuru(quoteSize > 0n && quoteSize <= UINT96_MAX, 'PRECISION');
    const native = market.quote.native;
    return {
      venue: 'kuru-clob',
      chainId: kuruDeployment(input.profile).chainId,
      market: market.address,
      side: 'BUY',
      inputAmount: input.quoteAmount,
      minOutput: input.minBaseOut,
      approval: native
        ? null
        : exactApproval(
            market.quote.address,
            market.address,
            input.quoteAmount,
          ),
      call: {
        target: market.address,
        calldata: encodeFunctionData({
          abi: orderBookAbi,
          functionName: 'placeAndExecuteMarketBuy',
          args: [quoteSize, input.minBaseOut, false, true],
        }),
        value: native ? input.quoteAmount : 0n,
      },
    };
  }

  /** Market sell of exactly `baseAmount` (base raw units, native MON sent as value); `minQuoteOut` in quote raw units. */
  async prepareMarketSell(input: {
    profile: ProfileName;
    pair: string;
    baseAmount: bigint;
    minQuoteOut: bigint;
    healthy?: MarketHealth;
  }): Promise<PreparedMarketOrder> {
    const market = this.market(input.profile, input.pair);
    const params = await this.marketParams(input.profile, input.pair);
    const health =
      input.healthy ?? (await this.health(input.profile, input.pair));
    requireKuru(health.status === 'HEALTHY', 'MARKET_UNHEALTHY', input.pair);
    requireKuru(input.baseAmount > 0n, 'INVALID_AMOUNT');
    requireKuru(
      input.minQuoteOut > 0n,
      'MIN_OUTPUT_BREACH',
      'minOut must be positive',
    );
    const scaled = input.baseAmount * params.sizePrecision;
    const unit = 10n ** BigInt(params.baseDecimals);
    requireKuru(
      scaled % unit === 0n,
      'PRECISION',
      'base amount does not fit size precision',
    );
    const size = scaled / unit;
    requireKuru(
      size >= params.minSize && size <= params.maxSize,
      'PRECISION',
      'size outside market bounds',
    );
    const native = market.base.native || market.base.address === NATIVE_TOKEN;
    return {
      venue: 'kuru-clob',
      chainId: kuruDeployment(input.profile).chainId,
      market: market.address,
      side: 'SELL',
      inputAmount: input.baseAmount,
      minOutput: input.minQuoteOut,
      approval: native
        ? null
        : exactApproval(market.base.address, market.address, input.baseAmount),
      call: {
        target: market.address,
        calldata: encodeFunctionData({
          abi: orderBookAbi,
          functionName: 'placeAndExecuteMarketSell',
          args: [size, input.minQuoteOut, false, true],
        }),
        value: native ? input.baseAmount : 0n,
      },
    };
  }
}
