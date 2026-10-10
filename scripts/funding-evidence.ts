import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPublicClient, http, type PublicClient } from 'viem';
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
  contentHash,
  labelEvidenceHex,
  tokenRefOf,
  verifyAusdOnChain,
  type FundingRequestInput,
} from '@synq/funding';
import {
  INTENTS_BLOCKCHAIN,
  IntentsApiClient,
  IntentsRouteAdapter,
  findIntentsToken,
} from '@synq/plugin-aurora';
import { AusdOftAdapter, oftAbi } from '@synq/plugin-layerzero';
import {
  AgoraClient,
  presentAusdBalance,
  supplyOnChain,
} from '@synq/plugin-agora';
import { AddressSchema } from '@synq/domain';

export const ETHEREUM_RPC =
  process.env.SYNQ_ETHEREUM_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const MODE = 'MAINNET_READ_ONLY';

function client(url: string): PublicClient {
  return createPublicClient({
    transport: http(url, { retryCount: 3, timeout: 20_000 }),
  }) as PublicClient;
}
export const readers = () => ({
  testnet: client(
    process.env[monadTestnetProfile.rpcEnvironment] ??
      monadTestnetProfile.defaultRpcUrl,
  ),
  mainnet: client(
    process.env[monadMainnetProfile.rpcEnvironment] ??
      monadMainnetProfile.defaultRpcUrl,
  ),
  ethereum: client(ETHEREUM_RPC),
});

export function canaryRequest(
  recipient: string,
  source: FundingRequestInput['source']['token'],
  amount: string,
): FundingRequestInput {
  const ausd = officialAssets.mainnetAUSD;
  return {
    requestId: `canary-${source.chainId}-${source.symbol}-${amount}`,
    groupId: 'mainnet-canary-group',
    destination: {
      chainId: monadMainnetProfile.network.chainId,
      account: recipient,
      token: tokenRefOf(ausd),
    },
    source: { token: source, amount, sender: recipient, refundTo: recipient },
    maxSlippageBps: 50,
    now: Math.floor(Date.now() / 1000),
  };
}

const replacer = (_: string, v: unknown) =>
  typeof v === 'bigint' ? v.toString() : v;

/** Read-only provider and chain evidence: no signature, no deposit, no broadcast. */
export async function collectFundingEvidence(input: {
  recipient: string;
  outDir: string;
}) {
  const stamp =
    new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const r = readers();
  const out = (dir: string, name: string, body: unknown) => {
    const d = join(input.outDir, dir);
    mkdirSync(d, { recursive: true });
    const file = join(d, `${stamp}-${name}.json`);
    writeFileSync(file, JSON.stringify(labelEvidenceHex(body), null, 2) + '\n');
    return file;
  };
  const written: string[] = [];

  // AUSD revalidation on both Monad networks.
  const ausd = {
    executionMode: MODE,
    capturedAt: new Date().toISOString(),
    testnet: await verifyAusdOnChain(
      r.testnet,
      monadTestnetProfile.network.chainId,
    ),
    mainnet: await verifyAusdOnChain(
      r.mainnet,
      monadMainnetProfile.network.chainId,
    ),
    testnetOftEndpointEid: await r.testnet.readContract({
      address: ausdOftNetwork(monadTestnetProfile.network.chainId)!.endpoint,
      abi: [
        {
          type: 'function',
          name: 'eid',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'uint32' }],
        },
      ] as const,
      functionName: 'eid',
    }),
  };
  written.push(out('ausd-oft', 'ausd-revalidation', ausd));

  // OFT: Monad bridge peers and a dry Ethereum -> Monad quote.
  const monad = ausdOftNetwork(monadMainnetProfile.network.chainId)!;
  if (monad.status !== 'CONFIGURED') throw new Error('registry OFT missing');
  const peersOnChain = await Promise.all(
    monad.peers.map(async (p) => ({
      eid: p.eid,
      name: p.name,
      registry: p.peer.toLowerCase(),
      onchain: await r.mainnet.readContract({
        address: monad.bridge,
        abi: oftAbi,
        functionName: 'peers',
        args: [p.eid],
      }),
    })),
  );
  const oft = new AusdOftAdapter({ readers: { 1: r.ethereum } });
  const ethRequest = canaryRequest(
    input.recipient,
    tokenRefOf(officialAssets.ethereumAUSD),
    '5000000',
  );
  const oftRouter = new FundingRouter({
    adapters: [new DirectMonadAusdAdapter(), oft],
  });
  const oftPlan = await oftRouter.plan(ethRequest);
  const testnetPlan = await new FundingRouter({
    adapters: [new DirectMonadAusdAdapter(), oft],
  }).plan({
    ...ethRequest,
    requestId: 'testnet-oft-availability',
    destination: {
      chainId: monadTestnetProfile.network.chainId,
      account: input.recipient,
      token: tokenRefOf(officialAssets.testnetAUSD),
    },
  });
  written.push(
    out('ausd-oft', 'oft-dry-quote', {
      executionMode: MODE,
      capturedAt: new Date().toISOString(),
      monadBridge: monad.bridge,
      monadEid: monad.eid,
      peersOnChain,
      peerVerification: await oft.verifyPeer(
        FundingRequestSchema.parse(ethRequest),
      ),
      ethereumToMonadPlan: oftPlan,
      monadTestnetAvailability: testnetPlan.capabilities.find(
        (c) => c.route === 'AUSD_OFT',
      ),
    }),
  );

  // NEAR 1Click: token discovery + dry quote; Aurora: key status.
  const oneClick = new IntentsApiClient({ provider: 'NEAR_1CLICK' });
  const tokens = await oneClick.tokens();
  const monadTokens = tokens.tokens.filter((t) => t.blockchain === 'monad');
  const ausdListed = ausdAssets().map((a) => ({
    chainId: a.chainId,
    blockchain: INTENTS_BLOCKCHAIN[a.chainId] ?? null,
    listed: findIntentsToken(tokens.tokens, tokenRefOf(a)) !== null,
  }));
  written.push(
    out('aurora', '1click-tokens', {
      executionMode: MODE,
      endpoint: tokens.evidence.url,
      fetchedAt: tokens.evidence.fetchedAt,
      httpStatus: tokens.evidence.status,
      tokenCount: tokens.tokens.length,
      bodySha: contentHash(tokens.evidence.body),
      monadTokens,
      ausdListedOnAnyChain: ausdListed.some((x) => x.listed),
      ausdBySymbol: tokens.tokens.filter((t) => t.symbol === 'AUSD'),
      ausdListed,
      tokens: tokens.tokens,
    }),
  );
  const intents = new IntentsRouteAdapter({ client: oneClick });
  const baseUsdc = tokens.tokens.find(
    (t) => t.blockchain === 'base' && t.symbol === 'USDC',
  );
  if (!baseUsdc?.contractAddress) throw new Error('Base USDC not listed');
  const usdcRequest = canaryRequest(
    input.recipient,
    {
      chainId: 8453,
      address: AddressSchema.parse(baseUsdc.contractAddress.toLowerCase()),
      symbol: 'USDC',
      decimals: baseUsdc.decimals,
    },
    '5000000',
  );
  const plan = await new FundingRouter({
    adapters: [new DirectMonadAusdAdapter(), oft, intents],
    intentLeg: intents,
  }).plan(usdcRequest);
  const rawQuote = await oneClick.quote({
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 50,
    originAsset: baseUsdc.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: monadTokens.find((t) => t.symbol === 'USDC')!.assetId,
    amount: '5000000',
    refundTo: input.recipient,
    refundType: 'ORIGIN_CHAIN',
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    quoteWaitingTimeMs: 3000,
  });
  const aurora = new IntentsApiClient({
    provider: 'AURORA_INTENTS',
    ...(process.env.SYNQ_AURORA_INTENTS_API_KEY
      ? { apiKey: process.env.SYNQ_AURORA_INTENTS_API_KEY }
      : {}),
  });
  const auroraStatus = aurora.hasCredentials
    ? {
        status: 'KEY_PRESENT',
        tokenCount: (await aurora.tokens()).tokens.length,
      }
    : {
        status: 'PENDING_CREDENTIALS',
        reason:
          'Aurora Intents requires an Intents Studio key in the path (/api/{kind}/{apiKey}); none configured',
        endpoints: {
          tokens: aurora.endpoint('tokens'),
          quote: aurora.endpoint('quote'),
          status: aurora.endpoint('status'),
        },
      };
  written.push(
    out('aurora', '1click-dry-quote', {
      executionMode: MODE,
      dry: true,
      note: 'dry:true quote; no deposit address was requested or created',
      request: rawQuote.evidence.body,
      depositAddressPresent: Boolean(rawQuote.response.quote.depositAddress),
      routerPlanBaseUsdcToMonadAusd: plan,
      aurora: auroraStatus,
    }),
  );

  // Agora public metrics (no auth); no yield.
  const agora = new AgoraClient();
  const metrics = await agora.metrics();
  written.push(
    out('agora', 'metrics', {
      executionMode: MODE,
      endpoint: 'GET https://api.agora.finance/v0/metrics',
      ...metrics,
      monad: supplyOnChain(
        metrics.metrics,
        `eip155:${monadMainnetProfile.network.chainId}`,
      ),
      authenticatedApi: agora.status(),
      rewards: agora.rewards(),
      balancePresentation: presentAusdBalance('1.000000'),
    }),
  );
  return { written, plan, oftPlan, rawQuote: rawQuote.response, ausd };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).endsWith('funding-evidence.ts')
) {
  const recipient = process.env.SYNQ_CANARY_RECIPIENT;
  if (!recipient)
    throw new Error(
      'SYNQ_CANARY_RECIPIENT (an address you control) is required',
    );
  const result = await collectFundingEvidence({
    recipient: AddressSchema.parse(recipient),
    outDir: resolve(process.env.SYNQ_FUNDING_EVIDENCE_DIR ?? 'bounty-evidence'),
  });
  console.log(result.written.join('\n'));
  console.log(
    JSON.stringify(
      {
        oftPlan: { status: result.oftPlan.status, quote: result.oftPlan.quote },
        intentsPlan: {
          status: result.plan.status,
          capabilities: result.plan.capabilities,
          quote: result.plan.quote,
          conversion: result.plan.conversion,
        },
        dryQuote: result.rawQuote.quote,
      },
      replacer,
      2,
    ),
  );
}
