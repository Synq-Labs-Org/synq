import { mkdirSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from 'viem';
import { contractForPair, monadMainnetProfile } from '@synq/chain-registry';
import { AddressSchema } from '@synq/domain';
import {
  KuruFlowAdapter,
  KuruFlowClient,
  canaryGate,
  kuruDeployment,
  simulateSwap,
  verifyPreparedSwap,
  minimumOutput,
  type Address,
} from '@synq/plugin-kuru';

/**
 * Prepares the tiny AUSD->WMON Kuru canary from the group account and writes a CANARY_READY packet. It never signs:
 * no key is loaded, and the canary gate cannot return a broadcast decision while the ExecutionModule has no bounded
 * swap action (ADR-0013). The group account defaults to a deterministic group-like address with no funds; set
 * SYNQ_CANARY_GROUP_SAFE to the Safe that will hold the canary AUSD.
 *
 *   node --import tsx scripts/kuru-canary.ts [outFile]
 */
const AMOUNT_IN = 100_000n;
const MAX_SLIPPAGE_BPS = 75;
const outFile = process.argv[2] ?? 'bounty-evidence/kuru/canary-packet.json';
const account = (
  process.env.SYNQ_CANARY_GROUP_SAFE
    ? AddressSchema.parse(process.env.SYNQ_CANARY_GROUP_SAFE)
    : `0x${keccak256(stringToHex('synq:kuru-canary:group-like-account')).slice(-40)}`
) as Address;

const client = createPublicClient({
  transport: http(
    process.env[monadMainnetProfile.rpcEnvironment] ??
      monadMainnetProfile.defaultRpcUrl,
  ),
});
const deployment = kuruDeployment('proof/monad-mainnet');
const AUSD = deployment.tokens.AUSD!;
const WMON = deployment.tokens.WMON!;
const feed = contractForPair(
  monadMainnetProfile.network.chainId,
  'CHAINLINK_PRICE_FEED',
  'AUSD/USD',
)!;
const [, answer, , updatedAt] = await client.readContract({
  address: feed.address,
  abi: parseAbi([
    'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  ]),
  functionName: 'latestRoundData',
});
const notionalUsdCents =
  (AMOUNT_IN * answer * 100n) / (10n ** BigInt(AUSD.decimals) * 10n ** 8n) + 1n;
const gate = canaryGate({
  env: {
    SYNQ_ALLOW_MAINNET_BROADCAST: process.env.SYNQ_ALLOW_MAINNET_BROADCAST,
    SYNQ_MAINNET_CANARY_MAX_USD: process.env.SYNQ_MAINNET_CANARY_MAX_USD,
  },
  notionalUsdCents,
  executionPathAvailable: false,
});

const flow = new KuruFlowAdapter(
  new KuruFlowClient({ fetch: (u, i) => fetch(u, i), clock: Date }),
);
const quote = await flow.quote(
  {
    profile: 'proof/monad-mainnet',
    account,
    tokenIn: AUSD.address,
    tokenOut: WMON.address,
    amountIn: AMOUNT_IN,
    slippageBps: 50,
  },
  Date.now(),
);
const prepared = flow.prepare(quote, {
  maxSlippageBps: MAX_SLIPPAGE_BPS,
  maxInputAmount: AMOUNT_IN,
  now: Date.now(),
});
verifyPreparedSwap(prepared, {
  profile: 'proof/monad-mainnet',
  account,
  tokenIn: AUSD.address,
  tokenOut: WMON.address,
  amountIn: AMOUNT_IN,
  maxInputAmount: AMOUNT_IN,
  minOutputFloor: minimumOutput(prepared.quotedOutput, MAX_SLIPPAGE_BPS),
  quotedOutput: prepared.quotedOutput,
  now: Date.now(),
});
const code = await client.getCode({ address: account });
const simulation =
  code && code !== '0x'
    ? {
        skipped:
          'the group account is a contract; Monad eth_simulateV1 refuses non-EOA senders ("sender not eoa"), so the module path must be simulated through the module (ADR-0013)',
      }
    : await simulateSwap(client, {
        account,
        tokenIn: prepared.tokenIn,
        tokenOut: prepared.tokenOut,
        amountIn: prepared.amountIn,
        approval: prepared.approval,
        swap: prepared.swap,
      });

const packet = {
  executionMode: 'CANARY_READY',
  capturedAt: new Date().toISOString(),
  broadcast: gate.broadcast,
  gate,
  notional: {
    amountIn: AMOUNT_IN,
    token: 'AUSD',
    ausdUsdReference: { feed: feed.address, answer, decimals: 8, updatedAt },
    notionalUsdCents,
  },
  groupAccount: account,
  groupAccountIsContract: Boolean(code && code !== '0x'),
  prepared,
  verification:
    'verifyPreparedSwap passed (registry entrypoint target, exact approval, token/amount/minOut/executor/flags)',
  simulation,
  intentFields: {
    action: 'SPOT_TRADE',
    pluginId: 'kuru-flow',
    chainId: prepared.chainId,
    account,
    recipient: account,
    target: prepared.swap.target,
    selector: prepared.swap.calldata.slice(0, 10),
    calldataHash: prepared.calldataHash,
    inputToken: AUSD.address,
    maxInputAmount: AMOUNT_IN,
    outputToken: WMON.address,
    minOutputAmount: prepared.minOutput,
    nativeValue: '0',
    maxSlippageBps: MAX_SLIPPAGE_BPS,
  },
  nextStep:
    'Deploy and audit the bounded swap action (ADR-0013), configure a mandate binding (kuru-flow, SPOT_TRADE, entrypoint, selector), fund the Safe with the canary AUSD, re-quote within the grant TTL, collect owner approvals and only then run a broadcast with SYNQ_ALLOW_MAINNET_BROADCAST=true and a cap.',
};
mkdirSync(outFile.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(packet, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
);
console.log(
  `CANARY_READY packet written to ${outFile}; broadcast refused: ${gate.reasons.join('; ')}`,
);
