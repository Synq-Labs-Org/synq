import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { monadTestnet, monad } from 'viem/chains';
import {
  profileConfiguration,
  perplNetwork,
  officialAsset,
} from '@synq/chain-registry';
import { PerplRestClient, MarketCatalog } from '@synq/plugin-perpl';
import {
  KuruFlowClient,
  KuruFlowAdapter,
  kuruDeployment,
} from '@synq/plugin-kuru';

if (
  process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true' ||
  BigInt(process.env.SYNQ_MAINNET_CANARY_MAX_USD ?? '0') !== 0n
)
  throw new Error('MAINNET_BROADCAST_REFUSED');
const testnet = profileConfiguration('sandbox/monad-testnet');
const mainnet = profileConfiguration('proof/monad-mainnet');
const chain = createPublicClient({
  chain: monadTestnet,
  transport: http(process.env[testnet.rpcEnvironment] ?? testnet.defaultRpcUrl),
});
const mainChain = createPublicClient({
  chain: monad,
  transport: http(process.env[mainnet.rpcEnvironment] ?? mainnet.defaultRpcUrl),
});
if (
  (await chain.getChainId()) !== testnet.network.chainId ||
  (await mainChain.getChainId()) !== mainnet.network.chainId
)
  throw new Error('RPC_CHAIN_MISMATCH');
const receipts = [];
const historicalOpenTx =
  '0x9bdaf851fc8056a88c104b3a9086ff244e3f969390391c9c0bab11c3a0592a31' as const;
const historicalCloseTx =
  '0xe6779f59822612c51189baf294a0f7808cf558020e220eaa0f6ee168d3fc40bf' as const;
for (const hash of [historicalOpenTx, historicalCloseTx]) {
  const receipt = await chain.getTransactionReceipt({ hash });
  if (receipt.status !== 'success')
    throw new Error('HISTORICAL_RECEIPT_REVERTED');
  receipts.push({
    executionMode: 'REAL_TESTNET',
    historical: true,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  });
}
const context = await new PerplRestClient({
  network: perplNetwork('proof/monad-mainnet'),
}).context();
const catalog = new MarketCatalog(
  perplNetwork('proof/monad-mainnet'),
  context,
  Date.now(),
);
const ausd = officialAsset('mainnetAUSD');
if (context.chain.chain_id !== ausd.chainId)
  throw new Error('COLLATERAL_CHAIN_MISMATCH');
const deployment = kuruDeployment('proof/monad-mainnet');
const flow = new KuruFlowAdapter(
  new KuruFlowClient({
    fetch: (url, init) => fetch(url, init),
    clock: { now: Date.now },
  }),
);
const quote = await flow.quote(
  {
    profile: 'proof/monad-mainnet',
    account: '0x0000000000000000000000000000000000000071',
    tokenIn: deployment.tokens.AUSD!.address,
    tokenOut: deployment.tokens.WMON!.address,
    amountIn: 25n * 10n ** BigInt(ausd.decimals),
    slippageBps: 50,
  },
  Date.now(),
);
const prepared = flow.prepare(quote, {
  maxSlippageBps: 75,
  maxInputAmount: 25n * 10n ** BigInt(ausd.decimals),
  now: Date.now(),
});
const result = {
  checkedAt: new Date().toISOString(),
  receipts,
  perpl: {
    executionMode: 'MAINNET_READ_ONLY',
    chainId: context.chain.chain_id,
    markets: catalog
      .all()
      .map((m) => ({ id: m.id, base: m.base, open: m.open })),
  },
  kuru: { executionMode: 'MAINNET_READ_ONLY', quote },
  canary: {
    executionMode: 'CANARY_READY',
    prepared,
    unsigned: true,
    broadcast: false,
  },
  mainnetBroadcasts: 0,
};
const dir = resolve('bounty-evidence/integration');
mkdirSync(dir, { recursive: true });
writeFileSync(
  resolve(dir, 'fresh-read-only-evidence.json'),
  JSON.stringify(
    result,
    (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    historicalReceipts: receipts.length,
    quoteMode: 'MAINNET_READ_ONLY',
    preparedMode: 'CANARY_READY',
    amountIn: quote.amountIn.toString(),
    mainnetBroadcasts: 0,
  }),
);
