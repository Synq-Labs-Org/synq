import { writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import {
  chainRegistry,
  monadMainnetProfile,
  monadTestnetProfile,
} from '@synq/chain-registry';

const onchainSymbol: Record<string, string> = { PERPL_TEST_USD: 'USD' };
const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
async function probe(rpcUrl: string, expectedChainId: number) {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 10000, retryCount: 0 }),
  });
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) throw new Error('WRONG_CHAIN');
  const assets = await Promise.all(
    Object.entries(chainRegistry.assets)
      .filter(([, a]) => a.chainId === chainId)
      .map(async ([key, asset]) => {
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
        const ok =
          !!code &&
          code !== '0x' &&
          decimals === asset.decimals &&
          symbol === (onchainSymbol[asset.symbol] ?? asset.symbol);
        return {
          key,
          address: asset.address,
          source: asset.source,
          decimals,
          symbol,
          ok,
        };
      }),
  );
  const contracts = await Promise.all(
    Object.entries(chainRegistry.contracts)
      .filter(([, c]) => c.chainId === chainId)
      .map(async ([key, contract]) => {
        const code = await client.getCode({ address: contract.address });
        const codeHash = code && code !== '0x' ? keccak256(code) : null;
        const ok =
          codeHash !== null &&
          (contract.codeHash === undefined || codeHash === contract.codeHash);
        return {
          key,
          address: contract.address,
          source: contract.source,
          codeHash,
          ok,
        };
      }),
  );
  return { chainId, rpcUrl, assets, contracts };
}
const results = [];
for (const profile of [monadTestnetProfile, monadMainnetProfile])
  results.push(
    await probe(
      process.env[profile.rpcEnvironment] ?? profile.defaultRpcUrl,
      profile.network.chainId,
    ),
  );
const report = {
  checkedAt: new Date().toISOString(),
  registryVerifiedAt: chainRegistry.verifiedAt,
  results,
  mutationPerformed: false,
};
writeFileSync(
  'reports/evidence/testnet-readonly-probe.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
const failures = results.flatMap((r) =>
  [...r.assets, ...r.contracts].filter((x) => !x.ok).map((x) => x.key),
);
if (failures.length) {
  console.error(`Registry probe mismatch: ${failures.join(', ')}`);
  process.exitCode = 1;
}
