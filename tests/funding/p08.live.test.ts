import { describe, expect, it } from 'vitest';
import {
  ausdAssets,
  ausdOftNetwork,
  monadMainnetProfile,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import {
  DirectMonadAusdAdapter,
  FundingRequestSchema,
  FundingRouter,
  tokenRefOf,
  verifyAusdOnChain,
} from '@synq/funding';
import {
  IntentsApiClient,
  IntentsRouteAdapter,
  findIntentsToken,
} from '@synq/plugin-aurora';
import { AusdOftAdapter, oftAbi } from '@synq/plugin-layerzero';
import { AgoraClient, supplyOnChain } from '@synq/plugin-agora';
import { canaryRequest, readers } from '../../scripts/funding-evidence.js';

const LIVE = process.env.SYNQ_LIVE_P08 === '1';
const RECIPIENT = `0x${'a5'.repeat(20)}` as const;
const live = describe.runIf(LIVE);

live('live read-only provider and chain checks (MAINNET_READ_ONLY)', () => {
  const r = readers();

  it('B08.1 official AUSD on Monad testnet and mainnet matches the registry (implementation, decimals, pause/freeze readers, no paused())', async () => {
    for (const [client, chainId] of [
      [r.testnet, monadTestnetProfile.network.chainId],
      [r.mainnet, monadMainnetProfile.network.chainId],
    ] as const) {
      const e = await verifyAusdOnChain(client, chainId);
      expect(e.matchesRegistry, `${chainId} ${e.mismatches.join(',')}`).toBe(
        true,
      );
      expect(e.pausedFunctionAbsent).toBe(true);
      expect(Object.keys(e.controls)).toHaveLength(5);
    }
  }, 60_000);

  it('B08.1 Monad mainnet OFT peers and Monad testnet EID match the registry; testnet has no OFT bridge', async () => {
    const monad = ausdOftNetwork(monadMainnetProfile.network.chainId)!;
    if (monad.status !== 'CONFIGURED') throw new Error('registry');
    for (const p of monad.peers) {
      const peer = await r.mainnet.readContract({
        address: monad.bridge,
        abi: oftAbi,
        functionName: 'peers',
        args: [p.eid],
      });
      expect(peer.slice(-40)).toBe(p.peer.slice(2).toLowerCase());
    }
    expect(await r.testnet.getCode({ address: monad.bridge })).toBeUndefined();
  }, 60_000);

  it('AUSD-011 dry OFT quote Ethereum AUSD -> Monad AUSD via eth_call (no signature)', async () => {
    const oft = new AusdOftAdapter({ readers: { 1: r.ethereum } });
    const plan = await new FundingRouter({
      adapters: [new DirectMonadAusdAdapter(), oft],
    }).plan(
      canaryRequest(
        RECIPIENT,
        tokenRefOf(officialAssets.ethereumAUSD),
        '5000000',
      ),
    );
    expect(plan.status).toBe('ROUTED');
    expect(plan.selected).toBe('AUSD_OFT');
    expect(plan.quote?.dry).toBe(true);
    expect(BigInt(plan.quote!.fees[0]!.amount)).toBeGreaterThan(0n);
  }, 60_000);

  it('AUSD-012 live 1Click token list has Monad USDC (registry address) and no AUSD on any chain; router falls back truthfully', async () => {
    const client = new IntentsApiClient({ provider: 'NEAR_1CLICK' });
    const { tokens } = await client.tokens();
    expect(
      findIntentsToken(tokens, tokenRefOf(officialAssets.mainnetUSDC)),
    ).not.toBeNull();
    for (const a of ausdAssets())
      expect(findIntentsToken(tokens, tokenRefOf(a))).toBeNull();
    expect(tokens.some((t) => t.symbol === 'AUSD')).toBe(false);
    const baseUsdc = tokens.find(
      (t) => t.blockchain === 'base' && t.symbol === 'USDC',
    )!;
    const intents = new IntentsRouteAdapter({ client });
    const plan = await new FundingRouter({
      adapters: [new DirectMonadAusdAdapter(), intents],
      intentLeg: intents,
    }).plan(
      canaryRequest(
        RECIPIENT,
        {
          chainId: 8453,
          address: baseUsdc.contractAddress!.toLowerCase() as `0x${string}`,
          symbol: 'USDC',
          decimals: 6,
        },
        '5000000',
      ),
    );
    expect(
      plan.capabilities.find((c) => c.route === 'AURORA_INTENTS')?.availability,
    ).toBe('UNAVAILABLE');
    expect(plan.status).toBe('CONVERSION_VENUE_PENDING');
    expect(plan.quote?.dry).toBe(true);
    expect(plan.quote?.depositAddress).toBeNull();
    expect(BigInt(plan.quote!.minAmountOut)).toBeLessThanOrEqual(5_000_000n);
  }, 60_000);

  it('Aurora testnet unavailable and Aurora key PENDING_CREDENTIALS without a Studio key', async () => {
    const aurora = new IntentsRouteAdapter({
      client: new IntentsApiClient({ provider: 'AURORA_INTENTS' }),
    });
    const req = FundingRequestSchema.parse({
      ...canaryRequest(RECIPIENT, tokenRefOf(officialAssets.mainnetUSDC), '1'),
    });
    const cap = await aurora.capability(req);
    expect(cap.availability).toBe(
      process.env.SYNQ_AURORA_INTENTS_API_KEY
        ? 'UNAVAILABLE'
        : 'PENDING_CREDENTIALS',
    );
    const oneClick = new IntentsRouteAdapter({
      client: new IntentsApiClient({ provider: 'NEAR_1CLICK' }),
    });
    const testnet = await oneClick.capability(
      FundingRequestSchema.parse({
        ...req,
        destination: {
          chainId: monadTestnetProfile.network.chainId,
          account: RECIPIENT,
          token: tokenRefOf(officialAssets.testnetAUSD),
        },
      }),
    );
    expect(testnet.availability).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
  }, 60_000);

  it('B08.6 Agora public metrics are live; rewards are unavailable (no invented yield)', async () => {
    const agora = new AgoraClient();
    const { metrics } = await agora.metrics();
    const monad = supplyOnChain(
      metrics,
      `eip155:${monadMainnetProfile.network.chainId}`,
    );
    expect(monad?.network).toBe('monad');
    expect(Number(monad?.totalSupply)).toBeGreaterThan(0);
    expect(agora.status().status).toBe('PENDING_CREDENTIALS');
    expect(agora.rewards()).toMatchObject({ status: 'UNAVAILABLE', apy: null });
    await expect(agora.accounts()).rejects.toThrow('Agora API key absent');
  }, 60_000);
});
