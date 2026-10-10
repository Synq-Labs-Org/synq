import {
  bytesToHex,
  type CronPayload,
  cre,
  encodeCallMsg,
  getNetwork,
  type HTTPSendRequester,
  LAST_FINALIZED_BLOCK_NUMBER,
  median,
  ConsensusAggregationByFields,
  prepareReportRequest,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk';
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  zeroAddress,
} from 'viem';
import { z } from 'zod';
import registry from '../../../sources/chain_registry.json';
import testnetDeployment from '../../../contracts/deployments/10143.risk-attestation.json';
import {
  assessAusdRisk,
  canonicalAssetKey,
  encodeAttestationReport,
  sourceConfigHash,
  type FeedRound,
  type VenueQuote,
} from '../src/attestation';

export const configSchema = z
  .object({
    schedule: z.string(),
    chainSelectorName: z.enum(['monad-testnet', 'monad-mainnet']),
    isTestnet: z.boolean(),
    assetRegistryKey: z.string(),
    referenceFeedRegistryKey: z.string().nullable(),
    referenceUnavailableReason: z.string().optional(),
    auxiliaryFeedRegistryKeys: z.array(z.string()),
    thresholds: z
      .object({
        maxStalenessSec: z.number().int().positive(),
        degradedDeviationBps: z.number().int().min(0).max(10_000),
        maxVenueDeviationBps: z.number().int().min(0).max(10_000),
      })
      .strict(),
    kuruQuote: z
      .object({
        apiBaseUrl: z
          .string()
          .regex(/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/),
        tokenInRegistryKey: z.string(),
        tokenOutRegistryKey: z.string(),
        amountIn: z.string().regex(/^[1-9][0-9]*$/),
        quoteIdentity: z.string().regex(/^0x0{36}[0-9a-fA-F]{4}$/),
      })
      .strict()
      .nullable(),
    receiverDeployment: z.enum(['monad-testnet']).nullable(),
    gasLimit: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

type RegistryContract = { chainId: number; address: string; kind: string };
type RegistryAsset = { chainId: number; address: string; decimals: number };
const contracts = registry.contracts as Record<string, RegistryContract>;
const assets = registry.assets as Record<string, RegistryAsset>;

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

function chainIdOf(config: Config): number {
  const profile = config.isTestnet
    ? registry.profiles['sandbox/monad-testnet']
    : registry.profiles['proof/monad-mainnet'];
  return profile.network.chainId;
}

function contractFor(key: string, chainId: number, kind: string): Address {
  const entry = contracts[key];
  if (!entry || entry.chainId !== chainId || entry.kind !== kind)
    throw new Error(`registry entry ${key} is not a ${kind} on ${chainId}`);
  return entry.address as Address;
}

function assetFor(key: string, chainId: number): RegistryAsset {
  const entry = assets[key];
  if (!entry || entry.chainId !== chainId)
    throw new Error(`registry asset ${key} is not on ${chainId}`);
  return entry;
}

function evmClient(config: Config) {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.chainSelectorName,
    isTestnet: config.isTestnet,
  });
  if (!network) throw new Error(`unknown network ${config.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function readFeed(
  runtime: Runtime<Config>,
  client: ReturnType<typeof evmClient>,
  address: Address,
): FeedRound {
  const call = (functionName: 'latestRoundData' | 'decimals') =>
    client
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: address,
          data: encodeFunctionData({ abi: feedAbi, functionName }),
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
  const round = decodeFunctionResult({
    abi: feedAbi,
    functionName: 'latestRoundData',
    data: bytesToHex(call('latestRoundData').data),
  });
  const decimals = decodeFunctionResult({
    abi: feedAbi,
    functionName: 'decimals',
    data: bytesToHex(call('decimals').data),
  });
  return {
    roundId: round[0],
    answer: round[1],
    startedAt: round[2],
    updatedAt: round[3],
    answeredInRound: round[4],
    decimals,
  };
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n =
      (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63]! : '=';
  }
  return out;
}

type KuruPrice = { priceE8: bigint };
function fetchKuruPrice(sender: HTTPSendRequester, config: Config): KuruPrice {
  const quote = config.kuruQuote!;
  const chainId = chainIdOf(config);
  const tokenIn = assetFor(quote.tokenInRegistryKey, chainId);
  const tokenOut = assetFor(quote.tokenOutRegistryKey, chainId);
  const post = (path: string, body: unknown, token?: string) => {
    const response = sender
      .sendRequest({
        method: 'POST',
        url: `${quote.apiBaseUrl}${path}`,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: base64(JSON.stringify(body)),
      })
      .result();
    if (response.statusCode !== 200)
      throw new Error(`kuru ${path} HTTP ${response.statusCode}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as Record<
      string,
      unknown
    >;
  };
  const auth = post('/generate-token', { user_address: quote.quoteIdentity });
  if (typeof auth.token !== 'string') throw new Error('kuru token shape');
  const result = post(
    '/quote',
    {
      userAddress: quote.quoteIdentity,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amount: quote.amountIn,
      slippageTolerance: 50,
      autoSlippage: false,
    },
    auth.token,
  );
  if (result.status !== 'success' || typeof result.output !== 'string')
    throw new Error('kuru quote shape');
  const amountIn = BigInt(quote.amountIn);
  const output = BigInt(result.output);
  const scale =
    10n ** BigInt(8 + tokenIn.decimals) / 10n ** BigInt(tokenOut.decimals);
  return { priceE8: (output * scale) / amountIn };
}

export function onCron(runtime: Runtime<Config>, payload: CronPayload): string {
  const config = runtime.config;
  const chainId = chainIdOf(config);
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  runtime.log(
    `evaluation time (DON) ${now}; scheduled ${payload.scheduledExecutionTime?.seconds ?? 'n/a'}`,
  );
  const client = evmClient(config);
  const asset = assetFor(config.assetRegistryKey, chainId);
  const assetId = canonicalAssetKey(chainId, asset.address);

  const reference = config.referenceFeedRegistryKey
    ? readFeed(
        runtime,
        client,
        contractFor(
          config.referenceFeedRegistryKey,
          chainId,
          'CHAINLINK_PRICE_FEED',
        ),
      )
    : null;
  if (reference)
    runtime.log(
      `reference ${config.referenceFeedRegistryKey} answer=${reference.answer} decimals=${reference.decimals} updatedAt=${reference.updatedAt} round=${reference.roundId}`,
    );
  else
    runtime.log(
      `reference unavailable: ${config.referenceUnavailableReason ?? 'REFERENCE_UNAVAILABLE'}`,
    );
  for (const key of config.auxiliaryFeedRegistryKeys) {
    const aux = readFeed(
      runtime,
      client,
      contractFor(key, chainId, 'CHAINLINK_PRICE_FEED'),
    );
    runtime.log(
      `auxiliary ${key} answer=${aux.answer} decimals=${aux.decimals} updatedAt=${aux.updatedAt} ageSec=${now - aux.updatedAt}`,
    );
  }

  let venue: VenueQuote | null = null;
  if (config.kuruQuote) {
    const http = new cre.capabilities.HTTPClient();
    const price = http
      .sendRequest(
        runtime,
        fetchKuruPrice,
        ConsensusAggregationByFields<KuruPrice>({ priceE8: median }),
      )(config)
      .result();
    venue = { priceE8: price.priceE8, source: 'kuru-flow' };
    runtime.log(`kuru AUSD->USDC venue price (1e8) median=${price.priceE8}`);
  }

  const attestation = assessAusdRisk({
    assetId,
    now,
    reference,
    referenceUnavailableReason: config.referenceUnavailableReason,
    venue,
    thresholds: config.thresholds,
    sourceConfigHash: sourceConfigHash({ config, chainId }),
  });
  runtime.log(
    `AUSDRiskAttestation ${JSON.stringify(attestation, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  );
  const encoded = encodeAttestationReport(attestation);
  const report = runtime.report(prepareReportRequest(encoded)).result();
  runtime.log(`report payload ${encoded}`);

  if (config.receiverDeployment === null) {
    runtime.log(
      'no receiver deployed for this network; report generated without an onchain write',
    );
    return attestation.status;
  }
  const receiver = testnetDeployment.RiskAttestationRegistry as Address;
  if (testnetDeployment.chainId !== chainId)
    throw new Error('receiver deployment chain mismatch');
  const write = client
    .writeReport(runtime, {
      receiver,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();
  const txHash = write.txHash ? bytesToHex(write.txHash) : 'none';
  runtime.log(
    `writeReport receiver=${receiver} txStatus=${TxStatus[write.txStatus]} receiverStatus=${write.receiverContractExecutionStatus ?? 'n/a'} txHash=${txHash} error=${write.errorMessage ?? ''}`,
  );
  if (write.txStatus !== TxStatus.SUCCESS)
    throw new Error(
      `writeReport failed: ${write.errorMessage ?? write.txStatus}`,
    );
  return `${attestation.status}:${txHash}`;
}

export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
}
