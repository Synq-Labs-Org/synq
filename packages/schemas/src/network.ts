import { z } from 'zod';
import { AddressSchema } from './primitives.js';

export const LOCAL_CHAIN_ID = 31337;
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_MAINNET_CHAIN_ID = 143;
export const ChainIdSchema = z.union([
  z.literal(LOCAL_CHAIN_ID),
  z.literal(MONAD_TESTNET_CHAIN_ID),
  z.literal(MONAD_MAINNET_CHAIN_ID),
]);
export type ChainId = z.output<typeof ChainIdSchema>;
export const OftSourceChainIdSchema = z.union([
  z.literal(1),
  z.literal(8453),
  z.literal(43114),
]);
export type OftSourceChainId = z.output<typeof OftSourceChainIdSchema>;
export const AnyChainIdSchema = z.union([
  ChainIdSchema,
  OftSourceChainIdSchema,
]);
export type AnyChainId = z.output<typeof AnyChainIdSchema>;

export const PROFILE_NAMES = [
  'local/anvil',
  'sandbox/monad-testnet',
  'proof/monad-mainnet',
] as const;
export const ProfileNameSchema = z.enum(PROFILE_NAMES);
export type ProfileName = z.output<typeof ProfileNameSchema>;
export const NetworkProfileSchema = z.discriminatedUnion('profile', [
  z.strictObject({
    profile: z.literal('local/anvil'),
    chainId: z.literal(LOCAL_CHAIN_ID),
    providerEnvironment: z.literal('local'),
  }),
  z.strictObject({
    profile: z.literal('sandbox/monad-testnet'),
    chainId: z.literal(MONAD_TESTNET_CHAIN_ID),
    providerEnvironment: z.literal('sandbox'),
  }),
  z.strictObject({
    profile: z.literal('proof/monad-mainnet'),
    chainId: z.literal(MONAD_MAINNET_CHAIN_ID),
    providerEnvironment: z.literal('production'),
  }),
]);
export type NetworkProfile = z.output<typeof NetworkProfileSchema>;
const profileByChain = {
  [LOCAL_CHAIN_ID]: {
    profile: 'local/anvil',
    chainId: LOCAL_CHAIN_ID,
    providerEnvironment: 'local',
  },
  [MONAD_TESTNET_CHAIN_ID]: {
    profile: 'sandbox/monad-testnet',
    chainId: MONAD_TESTNET_CHAIN_ID,
    providerEnvironment: 'sandbox',
  },
  [MONAD_MAINNET_CHAIN_ID]: {
    profile: 'proof/monad-mainnet',
    chainId: MONAD_MAINNET_CHAIN_ID,
    providerEnvironment: 'production',
  },
} as const satisfies Record<ChainId, NetworkProfile>;
export function networkProfileForChain(chainId: ChainId): NetworkProfile {
  return { ...profileByChain[chainId] };
}
export function profilesForChains(chains: readonly ChainId[]): ProfileName[] {
  return [...new Set(chains)].map((c) => profileByChain[c].profile);
}

export const AssetSymbolSchema = z.enum([
  'AUSD',
  'USDC',
  'MON',
  'WMON',
  'PERPL_TEST_USD',
  'OTHER',
]);
export const AssetSchema = z
  .strictObject({
    canonicalAssetId: z.string(),
    chainId: AnyChainIdSchema,
    address: AddressSchema,
    symbol: AssetSymbolSchema,
    decimals: z.number().int().min(0).max(36),
  })
  .refine(
    (v) => v.canonicalAssetId === `eip155:${v.chainId}/erc20:${v.address}`,
    'canonical asset mismatch',
  );
export type Asset = z.output<typeof AssetSchema>;
export const NativeAssetSchema = z
  .strictObject({
    canonicalAssetId: z.string(),
    chainId: AnyChainIdSchema,
    native: z.literal(true),
    symbol: z.enum(['MON', 'ETH', 'AVAX']),
    decimals: z.literal(18),
  })
  .refine(
    (v) => v.canonicalAssetId === `eip155:${v.chainId}/native`,
    'canonical native asset mismatch',
  );
export type NativeAsset = z.output<typeof NativeAssetSchema>;
export const AssetIdentitySchema = z.union([AssetSchema, NativeAssetSchema]);
export type AssetIdentity = z.output<typeof AssetIdentitySchema>;

export const ASSET_ROLES = [
  'treasuryAsset',
  'web2SettlementAsset',
  'perplCollateralAsset',
  'x402Asset',
  'cardFundingAsset',
] as const;
export const AssetRoleSchema = z.enum(ASSET_ROLES);
export type AssetRole = z.output<typeof AssetRoleSchema>;
export const TREASURY_BUCKETS = [
  'CORE_TREASURY',
  'WEB2_SETTLEMENT_BUFFER',
  'GAS_BUFFER',
  'STRATEGY_POSITIONS',
] as const;
export const TreasuryBucketSchema = z.enum(TREASURY_BUCKETS);
export type TreasuryBucket = z.output<typeof TreasuryBucketSchema>;
