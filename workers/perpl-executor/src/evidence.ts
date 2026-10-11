import type { HedgeEvidenceMode, HedgeFacts } from '@synq/kernel';
import {
  MarketCatalog,
  PerplCollateralAdapter,
  PerplError,
  PerplRestClient,
  accountInput,
  erc20Abi,
  hedgeMarket,
  markObservation,
  positionInputs,
  quoteFrom,
  type MarketQuote,
  type MarketSpec,
} from '@synq/plugin-perpl';
import {
  evaluatePortfolio,
  portfolioRiskHash,
  type HedgeMarket,
  type PortfolioRisk,
} from '@synq/risk-engine';

// Treasury balances read from chain. The reader declares the mode of the
// transport it reads through; it must match the venue transport.
export interface TreasuryBalanceReader {
  readonly executionMode: HedgeEvidenceMode;
  nativeBalance(): Promise<bigint>;
  collateralBalance(): Promise<bigint>;
}

export type HedgeEvidence = {
  executionMode: HedgeEvidenceMode;
  market: MarketSpec;
  quote: {
    mark: string;
    oracle: string;
    bid: string;
    ask: string;
    at: number;
    block: string;
  };
  risk: PortfolioRisk;
  riskPacketHash: `0x${string}`;
  freeCoreTreasury: string;
  marketOpen: boolean;
};

// Builds the risk packet and market evidence the Kernel hedge policy derives
// every economic field from. Callers never supply prices, sizes or balances.
export class PerplHedgeEvidenceReader {
  private readonly now: () => number;
  constructor(
    private readonly options: {
      rest: PerplRestClient;
      treasury: TreasuryBalanceReader;
      accountId: number;
      base: string;
      maxPriceAgeMs?: number;
      now?: () => number;
    },
  ) {
    const mode = options.rest.executionMode;
    if (mode === 'MAINNET_READ_ONLY' || mode !== options.treasury.executionMode)
      throw new PerplError(
        'PROFILE_MISMATCH',
        'hedge evidence needs one testnet or simulation transport',
      );
    this.now = options.now ?? Date.now;
  }

  get executionMode(): HedgeEvidenceMode {
    return this.options.rest.executionMode as HedgeEvidenceMode;
  }

  async read(): Promise<HedgeEvidence> {
    const { rest, treasury, accountId } = this.options;
    const maxAge = this.options.maxPriceAgeMs ?? 60_000;
    const context = await rest.context();
    const venueCollateral = new PerplCollateralAdapter(rest.network).resolve(
      context,
    );
    const catalog = new MarketCatalog(rest.network, context, this.now());
    const spec = catalog
      .all()
      .find((m) => m.base === this.options.base.toUpperCase());
    if (!spec)
      throw new PerplError('MARKET_UNAVAILABLE', `${this.options.base} market`);
    const [wallet, positions, ticker, native, collateral] = await Promise.all([
      rest.wallet(),
      rest.positions(),
      rest.ticker(spec.id),
      treasury.nativeBalance(),
      treasury.collateralBalance(),
    ]);
    const state = ticker.d[String(spec.id)];
    if (!state) throw new PerplError('MARKET_STALE', `market ${spec.id}`);
    const now = this.now();
    const quote: MarketQuote = quoteFrom(spec.id, state, maxAge, now);
    const valueDecimals = venueCollateral.decimals;
    const risk = evaluatePortfolio({
      asOf: now,
      valueDecimals,
      spot: [
        {
          asset: spec.base,
          canonicalAssetId: `eip155:${rest.network.chainId}/native`,
          amount: native,
          decimals: 18,
          bucket: 'GAS_BUFFER',
        },
        {
          asset: rest.network.collateral.symbol,
          canonicalAssetId: venueCollateral.canonicalAssetId,
          amount: collateral,
          decimals: valueDecimals,
          bucket: 'CORE_TREASURY',
          stable: true,
        },
      ],
      perpAccount: accountInput(
        wallet.as?.find((a) => a.id === accountId) ?? null,
      ),
      perpPositions: positionInputs(catalog, positions.d, accountId),
      prices: [markObservation(spec, quote, rest.network.label)],
      maxPriceAgeMs: maxAge,
      scenarios: [
        {
          id: `${spec.base.toLowerCase()}-down-30`,
          shocksBps: { [spec.base]: -3000 },
        },
        {
          id: `${spec.base.toLowerCase()}-up-30`,
          shocksBps: { [spec.base]: 3000 },
        },
      ],
    });
    return {
      executionMode: this.executionMode,
      market: spec,
      quote: {
        mark: quote.mark.toString(),
        oracle: quote.oracle.toString(),
        bid: quote.bid.toString(),
        ask: quote.ask.toString(),
        at: quote.at,
        block: quote.block.toString(),
      },
      risk,
      riskPacketHash: portfolioRiskHash(risk),
      freeCoreTreasury: collateral.toString(),
      marketOpen: spec.open,
    };
  }
}

export function hedgeMarketFrom(e: HedgeEvidence): HedgeMarket {
  return hedgeMarket(e.market, {
    marketId: e.market.id,
    mark: BigInt(e.quote.mark),
    oracle: BigInt(e.quote.oracle),
    bid: BigInt(e.quote.bid),
    ask: BigInt(e.quote.ask),
    block: BigInt(e.quote.block),
    at: e.quote.at,
  });
}

// Policy facts at evaluation time from persisted reader evidence. Only the
// clock moves; every economic input is the evidence the intent was sized from.
export function factsFromEvidence(
  e: HedgeEvidence,
  network: {
    chainId: number;
    exchange: string;
    collateral: { chainId: number; address: string; decimals: number };
  },
  nowMs: number,
): HedgeFacts {
  const asset = e.risk.assets.find((a) => a.asset === e.market.base);
  const perp = BigInt(asset?.perpNotional ?? '0');
  return {
    now: Math.floor(nowMs / 1000),
    nowMs,
    marketOpen: e.marketOpen,
    expectedCollateral: network.collateral,
    freeCoreTreasury: e.freeCoreTreasury,
    perpFreeCollateral: e.risk.perpFreeCollateral,
    currentHedgeNotional: (perp < 0n ? -perp : 0n).toString(),
    spotExposure: asset?.spotValue ?? '0',
    riskPacketHash: e.riskPacketHash,
    risk: e.risk,
    market: {
      marketId: e.market.id,
      base: e.market.base,
      chainId: network.chainId,
      exchange: network.exchange,
      priceDecimals: e.market.priceDecimals,
      sizeDecimals: e.market.sizeDecimals,
      maintenanceMarginBps: e.market.maintenanceMarginBps,
      maxLeverageHundredths: e.market.maxLeverageHundredths,
      executionMode: e.executionMode,
      source: `perpl:${network.chainId}:ticker:${e.market.id}:${e.quote.block}`,
      mark: e.quote.mark,
      bid: e.quote.bid,
      ask: e.quote.ask,
      at: e.quote.at,
    },
  };
}

type ChainReads = {
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
  readContract(args: {
    address: `0x${string}`;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: readonly [`0x${string}`];
  }): Promise<unknown>;
};

// Live testnet treasury balances of the account that owns the Perpl account.
export function testnetTreasuryReader(input: {
  chain: ChainReads;
  owner: `0x${string}`;
  network: PerplRestClient['network'];
}): TreasuryBalanceReader {
  if (input.network.profile !== 'sandbox/monad-testnet')
    throw new PerplError('PROFILE_MISMATCH', 'testnet treasury only');
  return {
    executionMode: 'REAL_TESTNET',
    nativeBalance: () => input.chain.getBalance({ address: input.owner }),
    collateralBalance: async () =>
      BigInt(
        (await input.chain.readContract({
          address: input.network.collateral.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [input.owner],
        })) as bigint,
      ),
  };
}
