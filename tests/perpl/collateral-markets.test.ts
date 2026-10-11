import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  chainRegistry,
  officialAsset,
  perplNetwork,
  perplNetworkForChain,
} from '@synq/chain-registry';
import {
  MarketCatalog,
  OrderTracker,
  PerplCollateralAdapter,
  RequestIdSequencer,
  isForwardingDisabled,
  marginBps,
  quoteFrom,
  validateOrder,
  type PerplContext,
  type PerplOrder,
} from '@synq/plugin-perpl';
import { contextFixture, registryAddress } from './context-fixture.js';

const testnetCtx = contextFixture('testnet');
const mainnetCtx = contextFixture('mainnet');
const testnet = perplNetwork('sandbox/monad-testnet');
const mainnet = perplNetwork('proof/monad-mainnet');
const withToken = (ctx: PerplContext, address: string): PerplContext => ({
  ...ctx,
  tokens: ctx.tokens.map((t) => ({ ...t, address })),
});

describe('Perpl profiles and collateral identity', () => {
  it('registers both Perpl profiles with source tags and refuses the local profile', () => {
    expect(testnet).toMatchObject({
      label: 'TESTNET',
      restUrl: 'https://testnet.perpl.xyz/api',
      wsUrl: 'wss://testnet.perpl.xyz',
      exchange: registryAddress('testnetPerplExchange'),
      source: 'S101',
      mutationEnabled: true,
    });
    expect(mainnet).toMatchObject({
      label: 'MAINNET',
      restUrl: 'https://app.perpl.xyz/api',
      exchange: registryAddress('mainnetPerplExchange'),
      mutationEnabled: false,
    });
    expect(perplNetworkForChain(10143).profile).toBe('sandbox/monad-testnet');
    expect(() => perplNetwork('local/anvil')).toThrow(
      /ASSET_ROLE_UNCONFIGURED/,
    );
    expect(
      chainRegistry.profiles['sandbox/monad-testnet'].assetRoles
        .perplCollateralAsset,
    ).toEqual({ status: 'CONFIGURED', asset: 'testnetAUSD', source: 'S101' });
  });

  it('testnet collateral resolves Agora testnet AUSD by (chainId, address), labelled truthfully', () => {
    const c = new PerplCollateralAdapter(testnet).resolve(testnetCtx);
    expect(c).toMatchObject({
      chainId: 10143,
      address: registryAddress('testnetAUSD'),
      decimals: 6,
      label: 'AUSD (Agora Monad testnet token)',
      minAccountOpen: 100_000_000n,
    });
    expect(c.canonicalAssetId).toBe(
      officialAsset('testnetAUSD').canonicalAssetId,
    );
  });

  it('mainnet profile resolves mainnet AUSD and its 10 AUSD account minimum', () => {
    const c = new PerplCollateralAdapter(mainnet).resolve(mainnetCtx);
    expect(c).toMatchObject({
      chainId: 143,
      address: registryAddress('mainnetAUSD'),
      minAccountOpen: 10_000_000n,
    });
  });

  it('wrong collateral: mainnet AUSD or the legacy Perpl test USD on testnet fails closed', () => {
    const adapter = new PerplCollateralAdapter(testnet);
    expect(() =>
      adapter.resolve(
        withToken(testnetCtx, officialAsset('mainnetAUSD').address),
      ),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(() =>
      adapter.resolve(
        withToken(testnetCtx, registryAddress('testnetPerplUSD')),
      ),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(() =>
      adapter.assertCollateral(officialAsset('mainnetAUSD')),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(() =>
      adapter.assertCollateral(officialAsset('testnetPerplUSD')),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(adapter.assertCollateral(officialAsset('testnetAUSD')).symbol).toBe(
      'AUSD',
    );
    expect(() =>
      new PerplCollateralAdapter(mainnet).assertCollateral(
        officialAsset('testnetAUSD'),
      ),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(() => adapter.resolve(mainnetCtx)).toThrow(/PROFILE_MISMATCH/);
    expect(() =>
      adapter.resolve({
        ...testnetCtx,
        instances: [
          {
            ...testnetCtx.instances[0]!,
            address: registryAddress('mainnetPerplExchange'),
          },
        ],
      }),
    ).toThrow(/COLLATERAL_MISMATCH/);
    expect(() =>
      adapter.resolve({
        ...testnetCtx,
        tokens: [{ ...testnetCtx.tokens[0]!, decimals: 18 }],
      }),
    ).toThrow(/COLLATERAL_MISMATCH/);
  });

  it('verifies the exchange collateral on-chain without trusting the symbol', async () => {
    const fake = (collateral: string, decimals: bigint) =>
      ({
        getChainId: async () => 10143,
        readContract: async ({ functionName }: { functionName: string }) =>
          ({
            getExchangeInfo: [
              0n,
              0n,
              0n,
              decimals,
              collateral,
              '0x0000000000000000000000000000000000000000',
            ],
            getMinAccountOpenCNS: 100_000_000n,
            symbol: 'AUSD',
            decimals: 6,
          })[functionName],
      }) as unknown as PublicClient;
    const adapter = new PerplCollateralAdapter(testnet);
    expect(
      await adapter.verifyOnchain(
        fake(
          registryAddress('testnetAUSD').toUpperCase().replace('0X', '0x'),
          6n,
        ),
      ),
    ).toMatchObject({ tokenSymbol: 'AUSD', minAccountOpen: 100_000_000n });
    await expect(
      adapter.verifyOnchain(fake(officialAsset('mainnetAUSD').address, 6n)),
    ).rejects.toThrow(/COLLATERAL_MISMATCH/);
  });
});

describe('Perpl markets loaded at runtime', () => {
  it('derives margins from the leverage-hundredths margin fields', () => {
    expect(marginBps(1_000)).toBe(1_000);
    expect(marginBps(2_000)).toBe(500);
    expect(marginBps(300)).toBe(3_334);
  });

  it('resolves markets by id or base asset per network, never by hard-coded ids', () => {
    const t = new MarketCatalog(testnet, testnetCtx, 0);
    const m = new MarketCatalog(mainnet, mainnetCtx, 0);
    expect(t.byBase('MON')).toMatchObject({
      id: 64,
      priceDecimals: 5,
      sizeDecimals: 0,
      maxLeverageHundredths: 300,
      maintenanceMarginBps: 2_000,
    });
    expect(m.byBase('mon').id).toBe(10);
    expect(() => new MarketCatalog(testnet, mainnetCtx, 0)).toThrow(
      /PROFILE_MISMATCH/,
    );
  });

  it('market unavailable: unknown, closed or ambiguous markets fail closed', () => {
    const closed = {
      ...testnetCtx,
      markets: testnetCtx.markets.map((mk) => ({
        ...mk,
        config: { ...mk.config, is_open: mk.id !== 64 },
      })),
    };
    const t = new MarketCatalog(testnet, closed, 0);
    expect(() => t.byIdOrThrow(999)).toThrow(/MARKET_UNAVAILABLE/);
    expect(() => t.byBase('MON')).toThrow(/MARKET_UNAVAILABLE/);
    expect(() => t.byBase('DOGE')).toThrow(/MARKET_UNAVAILABLE/);
  });

  it('stale market state fails closed', () => {
    const state = testnetCtx.markets.find((mk) => mk.id === 64)!.state!;
    const at = state.at.t!;
    expect(quoteFrom(64, state, 60_000, at + 1_000).mark).toBe(
      BigInt(state.mrk),
    );
    expect(() => quoteFrom(64, state, 60_000, at + 61_000)).toThrow(
      /MARKET_STALE/,
    );
    expect(() => quoteFrom(64, { ...state, at: {} }, 60_000, at)).toThrow(
      /MARKET_STALE/,
    );
  });
});

describe('Perpl order rules', () => {
  const market = new MarketCatalog(testnet, testnetCtx, 0).byBase('MON');
  const order = {
    rq: 1,
    mkt: 64,
    acc: 1058,
    t: 2 as const,
    p: 2_400,
    s: 40,
    fl: 4,
    lv: 100,
    lb: 1_020,
  };

  it('validates leverage, last-exec block window, sizes and order types', () => {
    expect(validateOrder(order, market, 1_000)).toEqual(order);
    expect(() => validateOrder({ ...order, lv: 301 }, market, 1_000)).toThrow(
      /leverage/,
    );
    expect(() => validateOrder({ ...order, lb: 1_000 }, market, 1_000)).toThrow(
      /lb/,
    );
    expect(() => validateOrder({ ...order, lb: 1_021 }, market, 1_000)).toThrow(
      /lb/,
    );
    expect(validateOrder({ ...order, lb: 0 }, market, 1_000).lb).toBe(0);
    expect(() => validateOrder({ ...order, s: 0 }, market, 1_000)).toThrow(
      /size/,
    );
    expect(() =>
      validateOrder({ ...order, p: 0, fl: 0 }, market, 1_000),
    ).toThrow(/IOC/);
    expect(() =>
      validateOrder({ ...order, t: 6 as never }, market, 1_000),
    ).toThrow(/order type/);
    expect(() =>
      validateOrder({ ...order, t: 7 as never }, market, 1_000),
    ).toThrow(/order type/);
    expect(() => validateOrder({ ...order, t: 5 }, market, 1_000)).toThrow(
      /oid/,
    );
    expect(() =>
      validateOrder({ ...order, mnp: 70_000 }, market, 1_000),
    ).toThrow(/mnp/);
  });

  it('seeds strictly increasing request ids from lfr', () => {
    const seq = new RequestIdSequencer(41);
    expect(seq.next()).toBe(42);
    seq.observe(100);
    expect(seq.next()).toBe(101);
    seq.observe(5);
    expect(seq.next()).toBe(102);
  });

  const o = (st: number, extra: Partial<PerplOrder> = {}): PerplOrder => ({
    rq: 7,
    mkt: 64,
    acc: 1058,
    st,
    t: 2,
    ...extra,
  });

  it('deduplicates order updates: first non-failure is definitive, duplicates ignored', () => {
    const tracker = new OrderTracker();
    expect(tracker.ingest(o(2, { at: { b: 1 } }))).toBe(true);
    expect(tracker.ingest(o(2, { at: { b: 1 } }))).toBe(false);
    expect(tracker.ingest(o(7, { sr: 36, at: { b: 2 } }))).toBe(false);
    tracker.ingest(o(3, { fs: 10, at: { b: 3 } }));
    expect(tracker.outcome(7)).toMatchObject({
      kind: 'LIVE',
      order: { st: 3, fs: 10 },
    });
  });

  it('partial fill then cancel of the remainder is reconciled to the actual fill', () => {
    const tracker = new OrderTracker();
    tracker.ingest(o(3, { fs: 25, os: 40, at: { b: 1 } }));
    tracker.ingest(o(5, { fs: 25, os: 40, r: true, at: { b: 2 } }));
    expect(tracker.outcome(7)).toMatchObject({
      kind: 'LIVE',
      order: { st: 5, fs: 25 },
    });
  });

  it('only failures: the first failure counts; superseded rq ignores late failures', () => {
    const tracker = new OrderTracker();
    tracker.ingest(o(7, { sr: 34, at: { b: 1 } }));
    tracker.ingest(o(7, { sr: 15, at: { b: 2 } }));
    const outcome = tracker.outcome(7);
    expect(outcome).toMatchObject({ kind: 'FAILED', order: { sr: 34 } });
    expect(
      outcome.kind === 'FAILED' && isForwardingDisabled(outcome.order),
    ).toBe(true);
    const t2 = new OrderTracker();
    t2.supersede(7);
    expect(t2.ingest(o(7, { sr: 32 }))).toBe(false);
    expect(t2.outcome(7).kind).toBe('PENDING');
  });
});
