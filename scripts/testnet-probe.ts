import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { monadTestnet } from 'viem/chains';
import {
  monadTestnetProfile,
  officialAssets,
  registrySources,
} from '../packages/chain-registry/src/index.js';
const client = createPublicClient({
  chain: monadTestnet,
  transport: http(monadTestnetProfile.defaultRpcUrl, {
    timeout: 10000,
    retryCount: 0,
  }),
});
const chainId = await client.getChainId();
if (chainId !== 10143) throw new Error('WRONG_TESTNET');
const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const records = await Promise.all(
  [officialAssets.testnetAUSD, officialAssets.testnetUSDC].map(
    async (asset) => {
      const [code, decimals, symbol] = await Promise.all([
        client.getCode({ address: asset.address }),
        client.readContract({
          address: asset.address,
          abi,
          functionName: 'decimals',
        }),
        client.readContract({
          address: asset.address,
          abi,
          functionName: 'symbol',
        }),
      ]);
      if (
        !code ||
        code === '0x' ||
        decimals !== asset.decimals ||
        symbol !== asset.symbol
      )
        throw new Error('TOKEN_METADATA_MISMATCH');
      return { asset, codeBytes: (code.length - 2) / 2, decimals, symbol };
    },
  ),
);
const report = {
  checkedAt: new Date().toISOString(),
  chainId,
  rpcUrl: monadTestnetProfile.defaultRpcUrl,
  registrySources,
  records,
  mutationPerformed: false,
};
writeFileSync(
  'reports/evidence/testnet-readonly-probe.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
