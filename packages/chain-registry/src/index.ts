import { z } from 'zod';
import {
  AssetSchema,
  NetworkProfileSchema,
  type Asset,
  type NetworkProfile,
} from '../../schemas/src/index.js';

const addresses = {
  ausdTestnet: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
  ausdMainnet: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
  usdcTestnet: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  usdcMainnet: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
} as const;
export const registrySources = {
  network: 'https://docs.monad.xyz/developer-essentials/testnet',
  ausd: 'https://docs.agora.finance/developer/contract-deployments',
  usdc: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  verifiedAt: '2026-10-09T07:03:37Z',
} as const;
function token(
  chainId: 10143 | 143,
  address: string,
  symbol: 'AUSD' | 'USDC',
): Asset {
  return AssetSchema.parse({
    chainId,
    address,
    symbol,
    decimals: 6,
    canonicalAssetId: `eip155:${chainId}/erc20:${address.toLowerCase()}`,
  });
}
export const officialAssets = {
  testnetAUSD: token(10143, addresses.ausdTestnet, 'AUSD'),
  testnetUSDC: token(10143, addresses.usdcTestnet, 'USDC'),
  mainnetAUSD: token(143, addresses.ausdMainnet, 'AUSD'),
  mainnetUSDC: token(143, addresses.usdcMainnet, 'USDC'),
};
export interface ChainConfiguration {
  network: NetworkProfile;
  rpcEnvironment: string;
  defaultRpcUrl: string;
  explorerUrl: string | null;
  confirmationDepth: number;
  maxIndexLagBlocks: bigint;
  treasuryAsset: Asset | null;
  edgeSettlementAsset: Asset | null;
  faucetAddress: `0x${string}` | null;
  mutationEnabled: boolean;
}
export const localProfile: ChainConfiguration = {
  network: NetworkProfileSchema.parse({
    profile: 'local',
    chainId: 31337,
    providerEnvironment: 'local',
  }),
  rpcEnvironment: 'SYNQ_LOCAL_RPC_URL',
  defaultRpcUrl: 'http://127.0.0.1:8545',
  explorerUrl: null,
  confirmationDepth: 1,
  maxIndexLagBlocks: 0n,
  treasuryAsset: null,
  edgeSettlementAsset: null,
  faucetAddress: null,
  mutationEnabled: true,
};
export const monadTestnetProfile: ChainConfiguration = {
  network: NetworkProfileSchema.parse({
    profile: 'testnet',
    chainId: 10143,
    providerEnvironment: 'sandbox',
  }),
  rpcEnvironment: 'SYNQ_MONAD_TESTNET_RPC_URL',
  defaultRpcUrl: 'https://testnet-rpc.monad.xyz',
  explorerUrl: 'https://testnet.monadexplorer.com',
  confirmationDepth: 2,
  maxIndexLagBlocks: 5n,
  treasuryAsset: officialAssets.testnetAUSD,
  edgeSettlementAsset: officialAssets.testnetUSDC,
  faucetAddress: addresses.ausdFaucet.toLowerCase() as `0x${string}`,
  mutationEnabled: true,
};
export function profileFor(name: string): ChainConfiguration {
  if (name === 'local') return localProfile;
  if (name === 'monad-testnet') return monadTestnetProfile;
  throw new Error(
    'NETWORK_DISABLED: only local and monad-testnet mutation profiles are enabled',
  );
}
export function verifiedAsset(candidate: unknown): Asset {
  const parsed = AssetSchema.parse(candidate);
  const actual = Object.values(officialAssets).find(
    (asset) =>
      asset.chainId === parsed.chainId && asset.address === parsed.address,
  );
  if (
    !actual ||
    actual.symbol !== parsed.symbol ||
    actual.decimals !== parsed.decimals ||
    actual.canonicalAssetId !== parsed.canonicalAssetId
  )
    throw new Error('ASSET_REGISTRY_MISMATCH');
  return actual;
}
export const DeploymentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  network: NetworkProfileSchema,
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  mandateRegistry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  executionModule: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  deploymentTransactions: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))
    .min(3),
  deploymentBlock: z.string().regex(/^[0-9]+$/),
  sandboxOnly: z.literal(true),
});
