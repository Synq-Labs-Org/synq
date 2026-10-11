import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import {
  officialAsset,
  perplNetwork,
  profileConfiguration,
} from '@synq/chain-registry';
import {
  MarketCatalog,
  PerplCollateralAdapter,
  PerplMarketDataStream,
  PerplRestClient,
  quoteFrom,
} from '@synq/plugin-perpl';
import { LIVE, recordEvidence } from './evidence.js';

const rpc = (profile: 'sandbox/monad-testnet' | 'proof/monad-mainnet') => {
  const c = profileConfiguration(profile);
  return createPublicClient({
    chain: profile === 'proof/monad-mainnet' ? monad : monadTestnet,
    transport: http(process.env[c.rpcEnvironment] ?? c.defaultRpcUrl, {
      retryCount: 3,
    }),
  }) as PublicClient;
};

describe.skipIf(!LIVE)('Perpl public reads', () => {
  it('MAINNET_READ_ONLY: mainnet AUSD collateral validated from context and chain, not funded', async () => {
    const network = perplNetwork('proof/monad-mainnet');
    expect(network.mutationEnabled).toBe(false);
    const rest = new PerplRestClient({ network });
    const context = await rest.context();
    const adapter = new PerplCollateralAdapter(network);
    const collateral = adapter.resolve(context);
    const onchain = await adapter.verifyOnchain(rpc('proof/monad-mainnet'));
    const catalog = new MarketCatalog(network, context, Date.now());
    const mon = catalog.byBase('MON');
    const ticker = await rest.ticker(mon.id);
    const quote = quoteFrom(
      mon.id,
      ticker.d[String(mon.id)]!,
      120_000,
      Date.now(),
    );
    expect(collateral.address).toBe(officialAsset('mainnetAUSD').address);
    expect(onchain.tokenSymbol).toBe('AUSD');
    recordEvidence('mainnet-collateral-readonly', 'MAINNET_READ_ONLY', {
      chainId: network.chainId,
      exchange: network.exchange,
      contextCollateral: collateral,
      onchain,
      monMarket: {
        ...mon,
        quote: { mark: quote.mark, block: quote.block, at: quote.at },
      },
      markets: catalog.all().map((m) => ({
        id: m.id,
        base: m.base,
        maxLeverageHundredths: m.maxLeverageHundredths,
      })),
      funded: false,
    });
  });

  it('REAL_TESTNET: Agora testnet AUSD collateral and live market-data WebSocket with forced reconnect', async () => {
    const network = perplNetwork('sandbox/monad-testnet');
    const rest = new PerplRestClient({ network });
    const context = await rest.context();
    const adapter = new PerplCollateralAdapter(network);
    const collateral = adapter.resolve(context);
    const onchain = await adapter.verifyOnchain(rpc('sandbox/monad-testnet'));
    const catalog = new MarketCatalog(network, context, Date.now());
    const mon = catalog.byBase('MON');
    const book = await rest.book(mon.id, 5);
    const md = new PerplMarketDataStream({ network });
    const heartbeats: number[] = [];
    const events: string[] = [];
    md.on('frame', (f) => {
      if (f.mt === 100 && typeof f.sn === 'number') heartbeats.push(f.sn);
    });
    md.on('ready', (r) =>
      events.push(r.reconnect ? 'ready:reconnect' : 'ready'),
    );
    md.on('resync', (r) => events.push(`resync:${r.reason}`));
    md.on('gap', (g) => events.push(`gap:${g.expected}->${g.got}`));
    md.on('close', (c) => events.push(`close:${c.code}:${c.reconnectInMs}`));
    md.subscribe([`market-state@${network.chainId}`]);
    const wait = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!cond() && Date.now() < end)
        await new Promise((r) => setTimeout(r, 100));
      return cond();
    };
    md.connect();
    expect(await wait(() => heartbeats.length >= 5, 30_000)).toBe(true);
    const before = heartbeats.length;
    md.forceReconnect('test: forced reconnect');
    expect(
      await wait(
        () =>
          events.includes('ready:reconnect') && heartbeats.length >= before + 5,
        30_000,
      ),
    ).toBe(true);
    md.close();
    const contiguous = heartbeats
      .slice(before)
      .every((sn, i, a) => i === 0 || sn === a[i - 1]! + 1);
    expect(contiguous).toBe(true);
    recordEvidence('testnet-public-and-ws', 'REAL_TESTNET', {
      chainId: network.chainId,
      contextCollateral: collateral,
      onchain,
      monMarket: mon,
      book: { sn: book.sn, bestBid: book.bid[0], bestAsk: book.ask[0] },
      ws: {
        url: md.url,
        connections: md.connections,
        heartbeatsObserved: heartbeats.length,
        firstSn: heartbeats[0],
        lastSn: heartbeats.at(-1),
        contiguousAfterReconnect: contiguous,
        events,
      },
    });
  });
});
