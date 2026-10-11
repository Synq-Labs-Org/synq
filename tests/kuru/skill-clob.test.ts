import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  maxUint256,
  type Hex,
} from 'viem';
import { PluginManifestSchema, networkProfileForChain } from '@synq/domain';
import { PluginRegistry } from '@synq/plugin-sdk';
import type { ProfileName } from '@synq/domain';
import {
  KuruCapabilities,
  reconcileSwapBalances,
  KuruClobAdapter,
  KuruError,
  KuruSkillAdapter,
  PreparedSwapStore,
  SKILL_SOURCE,
  decodeL2Book,
  kuruClobManifest,
  kuruClobPlugin,
  kuruDeployment,
  kuruFlowManifest,
  kuruFlowPlugin,
  kuruSkillManifest,
  marketHealth,
  orderBookAbi,
  type KuruPluginDeps,
} from '@synq/plugin-kuru';
import {
  ACCOUNT,
  AUSD,
  T0,
  USDC,
  WMON,
  mainnet,
  recordedFlow,
} from './fixtures.js';

const codeAsync = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof KuruError) return error.code;
    throw error;
  }
  return 'OK';
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof KuruError) return error.code;
    throw error;
  }
  return 'OK';
};

type Recorded = {
  params: Record<
    | 'pricePrecision'
    | 'sizePrecision'
    | 'baseAsset'
    | 'baseDecimals'
    | 'quoteAsset'
    | 'quoteDecimals'
    | 'tickSize'
    | 'minSize'
    | 'maxSize'
    | 'takerFeeBps'
    | 'makerFeeBps',
    string
  >;
  health: { bestBid: string; bestAsk: string };
};
const clobReads = JSON.parse(
  readFileSync('bounty-evidence/kuru/clob-reads.json', 'utf8'),
) as {
  markets: Record<string, Recorded>;
};
function chainFor(
  profile: ProfileName,
  patch: (pair: string) => Partial<Recorded> = () => ({}),
) {
  const deployment = kuruDeployment(profile);
  return {
    getChainId: async () => deployment.chainId,
    readContract: (async (args: { address: string; functionName: string }) => {
      const market = deployment.markets.find(
        (m) => m.address === args.address.toLowerCase(),
      );
      if (!market) throw new Error('unknown contract');
      const recorded = {
        ...clobReads.markets[`${profile}:${market.pair}`]!,
        ...patch(market.pair),
      };
      const p = recorded.params;
      if (args.functionName === 'getMarketParams')
        return [
          Number(p.pricePrecision),
          BigInt(p.sizePrecision),
          p.baseAsset,
          BigInt(p.baseDecimals),
          p.quoteAsset,
          BigInt(p.quoteDecimals),
          Number(p.tickSize),
          BigInt(p.minSize),
          BigInt(p.maxSize),
          BigInt(p.takerFeeBps),
          BigInt(p.makerFeeBps),
        ];
      if (args.functionName === 'bestBidAsk')
        return [
          BigInt(recorded.health.bestBid),
          BigInt(recorded.health.bestAsk),
        ];
      throw new Error(args.functionName);
    }) as never,
  };
}
const clob = (patch?: (pair: string) => Partial<Recorded>) =>
  new KuruClobAdapter((profile) => chainFor(profile, patch));

describe('Kuru skill adapter keeps the official USDC-settled semantics', () => {
  it('BUY spends USDC for the token and SELL returns USDC; aliases and addresses resolve', () => {
    expect(SKILL_SOURCE.commit).toBe('6075030b');
    const buy = KuruSkillAdapter.pair(
      'proof/monad-mainnet',
      'buy',
      'wrapped monad',
    );
    expect([buy.tokenIn.symbol, buy.tokenOut.symbol]).toEqual(['USDC', 'WMON']);
    const sell = KuruSkillAdapter.pair(
      'proof/monad-mainnet',
      'sell',
      AUSD.address,
    );
    expect([sell.tokenIn.symbol, sell.tokenOut.symbol]).toEqual([
      'AUSD',
      'USDC',
    ]);
    expect(
      KuruSkillAdapter.tokens('proof/monad-mainnet').map((t) => t.symbol),
    ).toEqual(['USDC', 'WMON', 'AUSD']);
    expect(
      code(() => KuruSkillAdapter.pair('proof/monad-mainnet', 'buy', 'USDC')),
    ).toBe('UNSUPPORTED_PAIR');
    expect(
      code(() => KuruSkillAdapter.pair('proof/monad-mainnet', 'buy', 'MON')),
    ).toBe('TOKEN_NOT_ALLOWED');
    expect(
      code(() => KuruSkillAdapter.pair('proof/monad-mainnet', 'buy', '')),
    ).toBe('TOKEN_NOT_ALLOWED');
  });
  it('refuses AUSD->WMON (and any pair without USDC) as unsupported skill semantics', () => {
    expect(
      code(() =>
        KuruSkillAdapter.assertSkillPair(
          'proof/monad-mainnet',
          AUSD.address,
          WMON.address,
        ),
      ),
    ).toBe('UNSUPPORTED_PAIR');
    expect(
      code(() =>
        KuruSkillAdapter.assertSkillPair(
          'proof/monad-mainnet',
          WMON.address,
          AUSD.address,
        ),
      ),
    ).toBe('UNSUPPORTED_PAIR');
    expect(
      KuruSkillAdapter.assertSkillPair(
        'proof/monad-mainnet',
        USDC.address,
        WMON.address,
      ),
    ).toBe('buy');
    expect(
      KuruSkillAdapter.assertSkillPair(
        'proof/monad-mainnet',
        AUSD.address,
        USDC.address,
      ),
    ).toBe('sell');
    expect(code(() => KuruSkillAdapter.tokens('sandbox/monad-testnet'))).toBe(
      'UNAVAILABLE_IN_NETWORK_PROFILE',
    );
  });
  it('prepare is key-free: exact approval only when the allowance is short, then the swap', async () => {
    const { adapter } = recordedFlow();
    let allowance = 0n;
    const skill = new KuruSkillAdapter(adapter, {
      readContract: (async () => allowance) as never,
    });
    const input = {
      side: 'buy' as const,
      token: 'WMON',
      amountIn: 1_000_000n,
      from: ACCOUNT,
      slippageBps: 50,
      now: T0,
    };
    const short = await skill.prepare(input, {
      maxSlippageBps: 75,
      maxInputAmount: 1_000_000n,
    });
    expect(short).toMatchObject({
      venue: 'kuru-skill',
      side: 'buy',
      tokenIn: USDC.address,
      tokenOut: WMON.address,
    });
    expect(short.approval).toMatchObject({
      amount: 1_000_000n,
      spender: mainnet.flowEntrypoint,
    });
    allowance = 5_000_000n;
    const covered = await skill.prepare(
      { ...input, now: T0 + 5_000 },
      { maxSlippageBps: 75, maxInputAmount: 1_000_000n },
    );
    expect(covered.approval).toBeNull();
  });
});

describe('Kuru CLOB adapter (viem reads, market-order calldata)', () => {
  it('reads market params and flags the MON-AUSD empty book (bestBidAsk sentinel) as UNHEALTHY', async () => {
    const adapter = clob();
    const params = await adapter.marketParams(
      'proof/monad-mainnet',
      'MON-USDC',
    );
    expect(params).toMatchObject({
      pricePrecision: 100_000_000n,
      sizePrecision: 10_000_000_000n,
      quoteDecimals: 6,
    });
    expect(
      await adapter.health('proof/monad-mainnet', 'MON-AUSD'),
    ).toMatchObject({ status: 'UNHEALTHY', reason: 'EMPTY_BOOK' });
    expect(
      await adapter.health('proof/monad-mainnet', 'MON-USDC'),
    ).toMatchObject({ status: 'HEALTHY' });
    expect(
      await adapter.health('sandbox/monad-testnet', 'MON-USDC'),
    ).toMatchObject({ status: 'UNHEALTHY', reason: 'NO_BIDS' });
    expect(marketHealth(5n, 5n)).toMatchObject({ reason: 'CROSSED' });
    expect(marketHealth(1n, maxUint256)).toMatchObject({ reason: 'NO_ASKS' });
  });
  it('a missing market or a mismatched market fails closed', async () => {
    const adapter = clob();
    expect(
      code(() => adapter.market('sandbox/monad-testnet', 'MON-AUSD')),
    ).toBe('MARKET_MISSING');
    expect(code(() => adapter.market('proof/monad-mainnet', 'AUSD-USDC'))).toBe(
      'MARKET_MISSING',
    );
    const drifted = clob(() => ({
      params: {
        ...clobReads.markets['proof/monad-mainnet:MON-USDC']!.params,
        quoteAsset: AUSD.address,
      },
    }));
    expect(
      await codeAsync(() =>
        drifted.marketParams('proof/monad-mainnet', 'MON-USDC'),
      ),
    ).toBe('MARKET_MISMATCH');
    expect(
      await codeAsync(() =>
        clob().prepareMarketBuy({
          profile: 'proof/monad-mainnet',
          pair: 'MON-AUSD',
          quoteAmount: 1_000_000n,
          minBaseOut: 1n,
        }),
      ),
    ).toBe('MARKET_UNHEALTHY');
    expect(
      KuruClobAdapter.exchangeDrift('proof/monad-mainnet', [
        { symbol: 'MON_USDC', status: 'TRADING', marketAddress: AUSD.address },
      ]),
    ).toEqual(['MON-AUSD: not listed', `MON-USDC: listed at ${AUSD.address}`]);
  });
  it('builds an exact-approval FOK market buy in price-precision units with a positive minOut', async () => {
    const order = await clob().prepareMarketBuy({
      profile: 'proof/monad-mainnet',
      pair: 'MON-USDC',
      quoteAmount: 1_000_000n,
      minBaseOut: 36n * 10n ** 18n,
    });
    const decoded = decodeFunctionData({
      abi: orderBookAbi,
      data: order.call.calldata,
    });
    expect(decoded.functionName).toBe('placeAndExecuteMarketBuy');
    expect(decoded.args).toEqual([100_000_000n, 36n * 10n ** 18n, false, true]);
    expect(order.approval).toMatchObject({
      token: USDC.address,
      spender: order.market,
      amount: 1_000_000n,
    });
    expect(order.call.value).toBe(0n);
    expect(
      await codeAsync(() =>
        clob().prepareMarketBuy({
          profile: 'proof/monad-mainnet',
          pair: 'MON-USDC',
          quoteAmount: 1_000_000n,
          minBaseOut: 0n,
        }),
      ),
    ).toBe('MIN_OUTPUT_BREACH');
    const sell = await clob().prepareMarketSell({
      profile: 'proof/monad-mainnet',
      pair: 'MON-USDC',
      baseAmount: 250n * 10n ** 18n,
      minQuoteOut: 20_000n,
    });
    expect(
      decodeFunctionData({ abi: orderBookAbi, data: sell.call.calldata }).args,
    ).toEqual([2_500_000_000_000n, 20_000n, false, true]);
    expect(sell).toMatchObject({
      approval: null,
      call: { value: 250n * 10n ** 18n },
    });
    expect(
      await codeAsync(() =>
        clob().prepareMarketSell({
          profile: 'proof/monad-mainnet',
          pair: 'MON-USDC',
          baseAmount: 1n,
          minQuoteOut: 1n,
        }),
      ),
    ).toBe('PRECISION');
  });
  it('decodes getL2Book bids and asks', () => {
    const data = encodeAbiParameters(Array(8).fill({ type: 'uint256' }), [
      7n,
      2_465_700n,
      5n,
      2_465_000n,
      3n,
      0n,
      2_470_000n,
      9n,
    ]) as Hex;
    expect(decodeL2Book(data)).toEqual({
      blockNumber: 7n,
      bids: [
        { price: 2_465_700n, size: 5n },
        { price: 2_465_000n, size: 3n },
      ],
      asks: [{ price: 2_470_000n, size: 9n }],
    });
    expect(
      decodeL2Book(
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }],
          [7n, 0n],
        ),
      ),
    ).toEqual({ blockNumber: 7n, bids: [], asks: [] });
  });
});

describe('Kuru capabilities and plugin contract', () => {
  it('testnet reports Flow and skill as UNAVAILABLE_IN_NETWORK_PROFILE; mainnet lists AUSD->WMON via Flow only', async () => {
    const { client } = recordedFlow();
    const caps = new KuruCapabilities({
      clob: clob(),
      flow: client,
      probeAddress: ACCOUNT,
    });
    const testnet = await caps.discover('sandbox/monad-testnet', 1);
    expect(testnet.flow.status).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    expect(testnet.skill.status).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    expect(testnet.execution.status).toBe('UNAVAILABLE');
    const main = await caps.discover('proof/monad-mainnet', 1);
    expect(main.flow.status).toBe('AVAILABLE');
    expect(main.clob.status).toBe('DEGRADED');
    expect(
      main.routes.find((r) => r.from === 'AUSD' && r.to === 'WMON')?.venues,
    ).toEqual(['kuru-flow']);
    expect(
      main.routes.find((r) => r.from === 'USDC' && r.to === 'WMON')?.venues,
    ).toEqual(['kuru-flow', 'kuru-skill']);
    expect(
      main.routes.find((r) => r.from === 'AUSD' && r.to === 'MON')?.venues,
    ).toEqual(['kuru-flow']);
    const offline = new KuruCapabilities({
      clob: clob(),
      probeAddress: ACCOUNT,
    });
    expect((await offline.discover('proof/monad-mainnet', 1)).flow.status).toBe(
      'UNAVAILABLE',
    );
  });
  it('manifests are valid financial-execution manifests and the plugins register', () => {
    for (const m of [kuruFlowManifest, kuruSkillManifest, kuruClobManifest])
      expect(PluginManifestSchema.parse(m).riskClass).toBe(
        'FINANCIAL_EXECUTION',
      );
    expect(PluginManifestSchema.parse(kuruFlowManifest).environments).toEqual([
      'proof/monad-mainnet',
    ]);
    expect(PluginManifestSchema.parse(kuruClobManifest).environments).toEqual([
      'sandbox/monad-testnet',
      'proof/monad-mainnet',
    ]);
  });
  it('plugin unavailable: a failing health check makes the registry refuse the plugin; execution is not wired', async () => {
    const { client } = recordedFlow();
    const deps: KuruPluginDeps = {
      clientFor: () => ({ getChainId: async () => 1 }) as never,
      flow: client,
      clob: clob(),
      probeAddress: ACCOUNT,
    };
    const registry = new PluginRegistry();
    registry.register(kuruFlowPlugin(deps));
    registry.register(kuruClobPlugin(deps));
    const mainnetProfile = networkProfileForChain(143);
    expect(
      await registry.refreshHealth('kuru-flow', {
        network: mainnetProfile,
        now: 100,
      }),
    ).toBe(false);
    expect(() => registry.get('kuru-flow', mainnetProfile, 100)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
    expect(() =>
      registry.get('kuru-flow', networkProfileForChain(10143), 100),
    ).toThrow('PLUGIN_UNAVAILABLE');
    expect(
      await registry.refreshHealth('kuru-clob', {
        network: mainnetProfile,
        now: 100,
      }),
    ).toBe(true);
    const plugin = registry.getMutator('kuru-clob', mainnetProfile, 100);
    expect(
      await codeAsync(() =>
        plugin.execute(
          { network: mainnetProfile, now: 100 },
          {} as never,
          [],
          {} as never,
        ),
      ),
    ).toBe('EXECUTION_PATH_UNAVAILABLE');
  });
  it('grant-bound prepare returns only the stored swap and enforces the grant amount, minimum output and deadline', async () => {
    const { adapter } = recordedFlow();
    const quote = await adapter.quote(
      {
        profile: 'proof/monad-mainnet',
        account: ACCOUNT,
        tokenIn: AUSD.address,
        tokenOut: WMON.address,
        amountIn: 1_000_000n,
        slippageBps: 50,
      },
      T0,
    );
    const prepared = adapter.prepare(quote, {
      maxSlippageBps: 75,
      maxInputAmount: 1_000_000n,
      now: T0,
    });
    const store = new PreparedSwapStore();
    store.put(prepared);
    const context = {
      network: networkProfileForChain(143),
      now: Math.floor(T0 / 1000),
    };
    const grant = {
      chainId: 143,
      account: ACCOUNT,
      target: prepared.swap.target,
      selector: prepared.swap.calldata.slice(0, 10),
      calldataHash: prepared.calldataHash,
      inputAsset: { address: AUSD.address },
      outputToken: WMON.address,
      maxInputAmount: '1000000',
      minOutputAmount: prepared.minOutput.toString(),
      validAfter: Math.floor(T0 / 1000),
      validUntil: Math.floor(T0 / 1000) + 60,
      intentHash: `0x${'ab'.repeat(32)}`,
    } as never as Parameters<PreparedSwapStore['forGrant']>[1];
    expect(
      code(() => store.forGrant({ ...context, now: grant.validUntil }, grant)),
    ).toBe('QUOTE_EXPIRED');
    expect(
      code(() =>
        store.forGrant({ ...context, now: grant.validAfter - 1 }, grant),
      ),
    ).toBe('QUOTE_EXPIRED');
    const actions = store.forGrant(context, grant);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      target: mainnet.flowEntrypoint,
      calldata: prepared.swap.calldata,
    });
    const variant = (patch: Record<string, unknown>) =>
      code(() =>
        store.forGrant(context, { ...grant, ...patch } as typeof grant),
      );
    expect(variant({ maxInputAmount: '999999' })).toBe('MAX_INPUT_BREACH');
    expect(
      variant({ minOutputAmount: (prepared.minOutput + 1n).toString() }),
    ).toBe('MIN_OUTPUT_BREACH');
    expect(variant({ calldataHash: `0x${'00'.repeat(32)}` })).toBe(
      'CALLDATA_MISMATCH',
    );
    expect(variant({ outputToken: USDC.address })).toBe('WRONG_TOKEN');
    expect(variant({ validUntil: Math.floor(T0 / 1000) - 120 })).toBe(
      'QUOTE_EXPIRED',
    );
    expect(
      code(() =>
        store.forGrant({ ...context, now: Math.floor(T0 / 1000) + 31 }, grant),
      ),
    ).toBe('QUOTE_EXPIRED');
  });
});

describe('Kuru route and partial receipt boundaries', () => {
  it('compares the same direct pair: Skill rejects a non-USDC pair while Flow prepares only its verified route', async () => {
    const { adapter } = recordedFlow();
    const request = {
      profile: 'proof/monad-mainnet' as const,
      account: ACCOUNT,
      tokenIn: AUSD.address,
      tokenOut: WMON.address,
      amountIn: 1_000_000n,
      slippageBps: 75,
    };
    expect(
      code(() =>
        KuruSkillAdapter.assertSkillPair(
          request.profile,
          request.tokenIn,
          request.tokenOut,
        ),
      ),
    ).toBe('UNSUPPORTED_PAIR');
    const quote = await adapter.quote(request, T0);
    const prepared = adapter.prepare(quote, {
      maxSlippageBps: 75,
      maxInputAmount: 1_000_000n,
      now: T0,
    });
    expect(prepared).toMatchObject({
      tokenIn: AUSD.address,
      tokenOut: WMON.address,
      amountIn: 1_000_000n,
    });
  });
  it('reconciles exact partial deltas, preserves remaining input, and rejects over-spend and below-floor proceeds', async () => {
    const { adapter } = recordedFlow();
    const quote = await adapter.quote(
      {
        profile: 'proof/monad-mainnet',
        account: ACCOUNT,
        tokenIn: AUSD.address,
        tokenOut: WMON.address,
        amountIn: 1_000_000n,
        slippageBps: 75,
      },
      T0,
    );
    const swap = adapter.prepare(quote, {
      maxSlippageBps: 75,
      maxInputAmount: 1_000_000n,
      now: T0,
    });
    const receipt = {
      chainId: swap.chainId,
      account: swap.account,
      transactionSucceeded: true,
      confirmed: true,
      inputBefore: swap.amountIn,
      inputAfter: swap.amountIn / 2n,
      outputBefore: 0n,
      outputAfter: (swap.minOutput + 1n) / 2n,
    };
    expect(reconcileSwapBalances(swap, receipt)).toMatchObject({
      state: 'PARTIAL',
      inputSpent: '500000',
      remainingInput: '500000',
    });
    expect(
      reconcileSwapBalances(swap, {
        ...receipt,
        inputAfter: 0n,
        outputAfter: swap.minOutput,
      }).state,
    ).toBe('FILLED');
    expect(
      reconcileSwapBalances(swap, { ...receipt, confirmed: false }).state,
    ).toBe('PENDING');
    expect(
      reconcileSwapBalances(swap, { ...receipt, transactionSucceeded: false })
        .state,
    ).toBe('REVERTED');
    expect(
      code(() => reconcileSwapBalances(swap, { ...receipt, inputAfter: -1n })),
    ).toBe('MAX_INPUT_BREACH');
    expect(
      code(() => reconcileSwapBalances(swap, { ...receipt, outputAfter: 0n })),
    ).toBe('MIN_OUTPUT_BREACH');
  });
});
