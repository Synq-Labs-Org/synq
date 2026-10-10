import { describe, expect, it } from 'vitest';
import { pad, type Hex } from 'viem';
import { ausdOftNetwork, officialAssets } from '@synq/chain-registry';
import {
  DirectMonadAusdAdapter,
  FundingError,
  FundingRequestSchema,
  FundingRouter,
  bindConversionQuote,
  conversionIntent,
  tokenRefOf,
  type ConversionVenue,
} from '@synq/funding';
import { IntentsApiClient, IntentsRouteAdapter } from '@synq/plugin-aurora';
import { AusdOftAdapter, type OftReader } from '@synq/plugin-layerzero';
import {
  MAINNET,
  NOW,
  SAFE,
  TESTNET,
  fakeFetch,
  liveLikeTokens,
  quoteResponder,
  request,
} from './helpers.js';

function intents(
  overrides: {
    tokens?: unknown;
    quote?: ReturnType<typeof quoteResponder>;
  } = {},
) {
  const f = fakeFetch({
    '/v0/tokens': () => overrides.tokens ?? liveLikeTokens(),
    '/v0/quote': overrides.quote ?? quoteResponder(),
  });
  return {
    adapter: new IntentsRouteAdapter({
      client: new IntentsApiClient({ provider: 'NEAR_1CLICK', fetch: f.fetch }),
      clock: () => NOW,
    }),
    calls: f.calls,
  };
}
const venue = (amountOut: (amountIn: bigint) => bigint): ConversionVenue => ({
  venue: 'test-venue',
  async quote({ amountIn, now }) {
    return {
      venue: 'test-venue',
      quoteId: 'q',
      amountIn: String(amountIn),
      amountOut: String(amountOut(amountIn)),
      expiresAt: now + 60,
      artifactHash: `0x${'00'.repeat(32)}`,
    };
  },
});

describe('FundingRouter (B08.5)', () => {
  it('AUSD-012 Aurora/1Click does not list AUSD: route reports UNAVAILABLE and falls back to USDC-then-convert with an explicit ConversionIntent', async () => {
    const { adapter, calls } = intents();
    const router = new FundingRouter({
      adapters: [new DirectMonadAusdAdapter(), adapter],
      intentLeg: adapter,
    });
    const plan = await router.plan(request());
    const aurora = plan.capabilities.find((c) => c.route === 'AURORA_INTENTS')!;
    expect(aurora.availability).toBe('UNAVAILABLE');
    expect(aurora.reason).toMatch(/not in the live NEAR_1CLICK token list/);
    expect(plan.status).toBe('CONVERSION_VENUE_PENDING');
    expect(plan.selected).toBe('BRIDGE_TO_USDC_THEN_CONVERT');
    expect(plan.quote?.destination.address).toBe(
      officialAssets.mainnetUSDC.address.toLowerCase(),
    );
    expect(plan.quote?.dry).toBe(true);
    expect(plan.conversion?.fromAsset).toEqual(officialAssets.mainnetUSDC);
    expect(plan.conversion?.toAsset).toEqual(officialAssets.mainnetAUSD);
    expect(plan.conversion?.amountIn).toBe(plan.quote?.minAmountOut);
    expect(plan.expectedCreditMin).toBeNull();
    const quoteCall = calls.find((c) => c.url.endsWith('/v0/quote'));
    expect((quoteCall?.body as { dry: boolean }).dry).toBe(true);
  });

  it('fallback conversion within the slippage bound is ROUTED; beyond it is CONVERSION_REJECTED', async () => {
    const { adapter } = intents();
    const ok = await new FundingRouter({
      adapters: [adapter],
      intentLeg: adapter,
      conversionVenue: venue((x) => (x * 9_998n) / 10_000n),
    }).plan(request());
    expect(ok.status).toBe('ROUTED');
    expect(ok.conversion?.status).toBe('QUOTED');
    expect(ok.conversion?.realizedSlippageBps).toBe(2);
    expect(ok.expectedCreditMin).toBe(ok.conversion?.minAmountOut);
    const bad = await new FundingRouter({
      adapters: [adapter],
      intentLeg: adapter,
      conversionVenue: venue((x) => (x * 9_900n) / 10_000n),
    }).plan(request());
    expect(bad.status).toBe('CONVERSION_REJECTED');
    expect(bad.conversion?.reason).toMatch(
      /SLIPPAGE_EXCEEDED: 100 bps > 50 bps/,
    );
    expect(bad.expectedCreditMin).toBeNull();
  });

  it('ConversionIntent is bounded and single-chain; expired venue quotes are refused', () => {
    const intent = conversionIntent({
      fromAsset: officialAssets.mainnetUSDC,
      toAsset: officialAssets.mainnetAUSD,
      amountIn: 1_000_000n,
      maxSlippageBps: 30,
      reference: 'r',
    });
    expect(intent.minAmountOut).toBe('997000');
    expect(() =>
      conversionIntent({
        fromAsset: officialAssets.baseAUSD,
        toAsset: officialAssets.mainnetAUSD,
        amountIn: 1n,
        maxSlippageBps: 30,
        reference: 'r',
      }),
    ).toThrow('NETWORK_MISMATCH');
    expect(() =>
      bindConversionQuote(
        intent,
        {
          venue: 'v',
          quoteId: 'q',
          amountIn: '1000000',
          amountOut: '999000',
          expiresAt: NOW - 1,
          artifactHash: `0x${'00'.repeat(32)}`,
        },
        NOW,
      ),
    ).toThrow('QUOTE_EXPIRED');
  });

  it('Aurora testnet unavailable: a Monad-testnet destination is UNAVAILABLE_IN_NETWORK_PROFILE for intents and OFT; direct AUSD still routes', async () => {
    const { adapter, calls } = intents();
    const plan = await new FundingRouter({
      adapters: [
        new DirectMonadAusdAdapter(),
        new AusdOftAdapter({ readers: {} }),
        adapter,
      ],
      intentLeg: adapter,
    }).plan(
      request({
        destinationChainId: TESTNET,
        sourceToken: tokenRefOf(officialAssets.testnetUSDC),
      }),
    );
    const by = Object.fromEntries(plan.capabilities.map((c) => [c.route, c]));
    expect(by.AURORA_INTENTS?.availability).toBe(
      'UNAVAILABLE_IN_NETWORK_PROFILE',
    );
    expect(by.AUSD_OFT?.availability).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    expect(by.AUSD_OFT?.reason).toMatch(/EID 40442/);
    expect(by.BRIDGE_TO_USDC_THEN_CONVERT?.availability).toBe('UNAVAILABLE');
    expect(plan.status).toBe('UNAVAILABLE');
    expect(calls.filter((c) => c.url.includes('/quote'))).toHaveLength(0);
    const direct = await new FundingRouter({
      adapters: [new DirectMonadAusdAdapter()],
    }).plan(
      request({
        destinationChainId: TESTNET,
        sourceToken: tokenRefOf(officialAssets.testnetAUSD),
      }),
    );
    expect(direct.status).toBe('ROUTED');
    expect(direct.selected).toBe('DIRECT_MONAD_AUSD');
    expect(direct.quote?.mode).toBe('REAL_TESTNET');
    expect(direct.expectedCreditMin).toBe('5000000');
  });

  it('Aurora Intents without a Studio key reports PENDING_CREDENTIALS and makes no request', async () => {
    const f = fakeFetch({});
    const aurora = new IntentsRouteAdapter({
      client: new IntentsApiClient({
        provider: 'AURORA_INTENTS',
        fetch: f.fetch,
      }),
    });
    const cap = await aurora.capability(FundingRequestSchema.parse(request()));
    expect(cap.availability).toBe('PENDING_CREDENTIALS');
    expect(f.calls).toHaveLength(0);
    const keyed = new IntentsApiClient({
      provider: 'AURORA_INTENTS',
      apiKey: 'studio-key',
      fetch: f.fetch,
    });
    expect(keyed.endpoint('quote')).toBe(
      'https://intents-api.aurora.dev/api/quote/{apiKey}',
    );
  });

  it('destination mismatch: a provider echo with another recipient or asset is rejected', async () => {
    for (const patch of [
      { recipient: `0x${'99'.repeat(20)}` },
      { destinationAsset: 'nep141:other.near' },
    ]) {
      const { adapter } = intents({ quote: quoteResponder(patch) });
      const plan = await new FundingRouter({
        adapters: [adapter],
        intentLeg: adapter,
      }).plan(request());
      expect(plan.status).toBe('UNAVAILABLE');
      expect(plan.reasons.join(' ')).toMatch(/DESTINATION_MISMATCH/);
    }
  });

  it('quote with minAmountOut above amountOut is invalid', async () => {
    const { adapter } = intents({
      quote: quoteResponder({ amountOut: '100', minAmountOut: '200' }),
    });
    const plan = await new FundingRouter({
      adapters: [adapter],
      intentLeg: adapter,
    }).plan(request());
    expect(plan.status).toBe('UNAVAILABLE');
    expect(plan.reasons.join(' ')).toMatch(/QUOTE_INVALID/);
  });

  it('wrong destination token: the router refuses a non-AUSD treasury destination', async () => {
    const bad = request();
    bad.destination.token = tokenRefOf(officialAssets.mainnetUSDC);
    await expect(new FundingRouter({ adapters: [] }).plan(bad)).rejects.toThrow(
      FundingError,
    );
  });
});

function oftReader(
  overrides: {
    chainId?: number;
    eid?: number;
    peer?: Hex;
    token?: string;
  } = {},
): OftReader {
  const monad = ausdOftNetwork(MAINNET)!;
  const bridge = monad.status === 'CONFIGURED' ? monad.bridge : '0x';
  return {
    getChainId: async () => overrides.chainId ?? 1,
    readContract: (async (args: { functionName: string; args?: unknown[] }) => {
      switch (args.functionName) {
        case 'token':
          return overrides.token ?? officialAssets.ethereumAUSD.address;
        case 'endpoint':
          return `0x${'1a'.repeat(20)}`;
        case 'eid':
          return overrides.eid ?? 30101;
        case 'peers':
          return (
            overrides.peer ?? pad(bridge.toLowerCase() as Hex, { size: 32 })
          );
        case 'approvalRequired':
          return false;
        case 'sharedDecimals':
          return 6;
        case 'quoteOFT': {
          const p = args.args![0] as { amountLD: bigint };
          return [
            { minAmountLD: 0n, maxAmountLD: 10n ** 30n },
            [],
            { amountSentLD: p.amountLD, amountReceivedLD: p.amountLD },
          ];
        }
        case 'quoteSend':
          return { nativeFee: 201281465027251n, lzTokenFee: 0n };
      }
      throw new Error(args.functionName);
    }) as OftReader['readContract'],
  };
}

describe('AUSD OFT adapter (B08.5)', () => {
  const ethAusd = request({
    sourceToken: tokenRefOf(officialAssets.ethereumAUSD),
  });

  it('AUSD-011 AUSD on a peer chain prefers the native OFT route with a dry on-chain quote', async () => {
    const { adapter } = intents();
    const plan = await new FundingRouter({
      adapters: [
        new DirectMonadAusdAdapter(),
        new AusdOftAdapter({ readers: { 1: oftReader() } }),
        adapter,
      ],
      intentLeg: adapter,
    }).plan(ethAusd);
    expect(plan.status).toBe('ROUTED');
    expect(plan.selected).toBe('AUSD_OFT');
    expect(plan.quote?.mode).toBe('MAINNET_READ_ONLY');
    expect(plan.quote?.dry).toBe(true);
    expect(plan.quote?.fees[0]?.kind).toBe('MESSAGING');
    expect(plan.quote?.recipient).toBe(SAFE);
  });

  it('LayerZero network mismatch: wrong EID, foreign peer, wrong token or wrong RPC chain refuses the quote', async () => {
    for (const r of [
      oftReader({ eid: 40161 }),
      oftReader({ peer: pad(`0x${'77'.repeat(20)}`, { size: 32 }) }),
      oftReader({
        token: officialAssets.ethereumAUSD.address.replace('a', 'b'),
      }),
      oftReader({ chainId: 8453 }),
    ]) {
      const oft = new AusdOftAdapter({ readers: { 1: r } });
      await expect(
        oft.quote(FundingRequestSchema.parse(ethAusd)),
      ).rejects.toThrow(/NETWORK_MISMATCH|WRONG_TOKEN/);
    }
  });

  it('bridge route unavailable: non-peer source chain, missing RPC, non-AUSD source', async () => {
    const oft = new AusdOftAdapter({ readers: {} });
    const missingRpc = await oft.capability(
      FundingRequestSchema.parse(ethAusd),
    );
    expect(missingRpc.availability).toBe('UNAVAILABLE');
    expect(missingRpc.reason).toMatch(/no read RPC/);
    const usdc = await oft.capability(FundingRequestSchema.parse(request()));
    expect(usdc.reason).toMatch(/not registered AUSD/);
  });
});
