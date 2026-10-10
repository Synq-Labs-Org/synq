import { z } from 'zod';
import {
  ASSET_ROLES,
  AddressSchema,
  AnyChainIdSchema,
  AssetSchema,
  AssetSymbolSchema,
  HashSchema,
  IsoTimestampSchema,
  LOCAL_CHAIN_ID,
  NativeAssetSchema,
  NetworkProfileSchema,
  PROFILE_NAMES,
  ProfileNameSchema,
  RegistryError,
  SourceIdSchema,
  TREASURY_BUCKETS,
  parseOrThrow,
  type Asset,
  type AssetRole,
  type NativeAsset,
  type NetworkProfile,
  type ProfileName,
  type TreasuryBucket,
} from '@synq/domain';
import rawRegistry from '../../../sources/chain_registry.json' with { type: 'json' };

const keySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/);
const tagged = {
  network: z.string().regex(/^eip155:[0-9]+$/),
  chainId: AnyChainIdSchema,
  source: SourceIdSchema,
};
const networkMatches = (v: { network: string; chainId: number }) =>
  v.network === `eip155:${v.chainId}`;
const AssetEntrySchema = z
  .strictObject({
    ...tagged,
    address: AddressSchema,
    symbol: AssetSymbolSchema,
    decimals: z.number().int().min(0).max(36),
    verifiedAt: IsoTimestampSchema,
  })
  .refine(networkMatches, 'network tag must match chainId');
const NativeEntrySchema = z
  .strictObject({
    ...tagged,
    symbol: z.enum(['MON', 'ETH', 'AVAX']),
    decimals: z.literal(18),
  })
  .refine(networkMatches, 'network tag must match chainId');
const ContractEntrySchema = z
  .strictObject({
    ...tagged,
    address: AddressSchema,
    kind: z.enum([
      'AUSD_FAUCET',
      'SAFE',
      'SAFE_L2',
      'SAFE_PROXY_FACTORY',
      'SAFE_COMPATIBILITY_FALLBACK_HANDLER',
      'SAFE_MULTI_SEND_CALL_ONLY',
    ]),
    version: z.string().optional(),
    codeHash: HashSchema.optional(),
    verifiedAt: IsoTimestampSchema,
  })
  .refine(networkMatches, 'network tag must match chainId');
const AssetRoleEntrySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('CONFIGURED'),
    asset: keySchema,
    source: SourceIdSchema,
  }),
  z.strictObject({
    status: z.literal('UNCONFIGURED'),
    reason: z.string().min(10),
  }),
]);
const BucketEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ROLE'), role: z.enum(ASSET_ROLES) }),
  z.strictObject({ kind: z.literal('NATIVE'), asset: keySchema }),
  z.strictObject({ kind: z.literal('MANDATE_DEFINED') }),
  z.strictObject({
    kind: z.literal('UNCONFIGURED'),
    reason: z.string().min(10),
  }),
]);
const ProfileEntrySchema = z.strictObject({
  network: NetworkProfileSchema,
  rpcEnvironment: z.string().regex(/^SYNQ_[A-Z0-9_]+$/),
  defaultRpcUrl: z.url(),
  explorerUrl: z.url().nullable(),
  confirmationDepth: z.number().int().positive(),
  maxIndexLagBlocks: z.string().regex(/^(0|[1-9][0-9]*)$/),
  mutationEnabled: z.boolean(),
  nativeAsset: keySchema.nullable(),
  faucet: keySchema.nullable(),
  assetRoles: z.strictObject(
    Object.fromEntries(ASSET_ROLES.map((r) => [r, AssetRoleEntrySchema])) as {
      [K in AssetRole]: typeof AssetRoleEntrySchema;
    },
  ),
  treasuryBuckets: z.strictObject(
    Object.fromEntries(TREASURY_BUCKETS.map((b) => [b, BucketEntrySchema])) as {
      [K in TreasuryBucket]: typeof BucketEntrySchema;
    },
  ),
});
const anyTagged = {
  network: z.string().regex(/^eip155:[0-9]+$/),
  chainId: z.number().int().positive(),
  source: SourceIdSchema,
  verifiedAt: IsoTimestampSchema,
};
const OftPeerSchema = z
  .strictObject({
    ...anyTagged,
    eid: z.number().int().positive(),
    name: z.string().min(1),
    peer: AddressSchema,
  })
  .refine(networkMatches, 'network tag must match chainId');
const OftNetworkSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      ...tagged,
      verifiedAt: IsoTimestampSchema,
      status: z.literal('CONFIGURED'),
      eid: z.number().int().positive(),
      endpoint: AddressSchema,
      bridge: AddressSchema,
      asset: keySchema,
      sharedDecimals: z.number().int().min(0).max(18),
      approvalRequired: z.boolean(),
      oftVersion: z.strictObject({
        interfaceId: z.string().regex(/^0x[0-9a-f]{8}$/),
        version: z.number().int().positive(),
      }),
      peers: z.array(OftPeerSchema).min(1),
    })
    .refine(networkMatches, 'network tag must match chainId'),
  z
    .strictObject({
      ...tagged,
      verifiedAt: IsoTimestampSchema,
      status: z.literal('NO_AUSD_OFT'),
      eid: z.number().int().positive(),
      endpoint: AddressSchema,
      bridge: z.null(),
      asset: keySchema,
      reason: z.string().min(20),
    })
    .refine(networkMatches, 'network tag must match chainId'),
]);
export const AusdRegistrySchema = z.strictObject({
  verifiedAt: IsoTimestampSchema,
  canonicalSymbol: z.literal('AUSD'),
  decimals: z.number().int().min(0).max(36),
  deployments: z
    .array(
      z
        .strictObject({
          ...tagged,
          verifiedAt: IsoTimestampSchema,
          asset: keySchema,
          implementation: AddressSchema,
          proxy: z.literal('EIP1967'),
          faucet: keySchema.nullable(),
        })
        .refine(networkMatches, 'network tag must match chainId'),
    )
    .min(1),
  controls: z.strictObject({
    pauseReaders: z.array(z.string().regex(/^is[A-Za-z]+Paused$/)).min(1),
    freezeReader: z.literal('isAccountFrozen'),
    absentFunctions: z.array(z.string().min(1)),
    source: SourceIdSchema,
  }),
  oft: z.array(OftNetworkSchema).min(1),
});
export type AusdRegistry = z.output<typeof AusdRegistrySchema>;
export const ChainRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    verifiedAt: IsoTimestampSchema,
    chains: z
      .array(
        z.strictObject({
          chainId: AnyChainIdSchema,
          name: z.string().min(1),
          role: z.enum(['LOCAL', 'MONAD', 'OFT_SOURCE']),
          source: SourceIdSchema,
        }),
      )
      .min(1),
    assets: z.record(keySchema, AssetEntrySchema),
    nativeAssets: z.record(keySchema, NativeEntrySchema),
    contracts: z.record(keySchema, ContractEntrySchema),
    profiles: z.strictObject(
      Object.fromEntries(PROFILE_NAMES.map((p) => [p, ProfileEntrySchema])) as {
        [K in ProfileName]: typeof ProfileEntrySchema;
      },
    ),
    ausd: AusdRegistrySchema,
  })
  .superRefine((v, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const chainIds = v.chains.map((c) => c.chainId);
    if (new Set(chainIds).size !== chainIds.length)
      fail(['chains'], 'duplicate chain id');
    for (const [group, entries] of [
      ['assets', v.assets],
      ['nativeAssets', v.nativeAssets],
      ['contracts', v.contracts],
    ] as const)
      for (const [key, entry] of Object.entries(entries))
        if (!chainIds.includes(entry.chainId))
          fail([group, key], 'chain not declared');
    const assetIds = Object.values(v.assets).map(
      (a) => `${a.chainId}:${a.address}`,
    );
    if (new Set(assetIds).size !== assetIds.length)
      fail(['assets'], 'duplicate asset identity');
    for (const [name, profile] of Object.entries(v.profiles)) {
      if (profile.network.profile !== name)
        fail(['profiles', name], 'profile key mismatch');
      const chainId = profile.network.chainId;
      if (!chainIds.includes(chainId))
        fail(['profiles', name], 'chain not declared');
      for (const [role, entry] of Object.entries(profile.assetRoles))
        if (
          entry.status === 'CONFIGURED' &&
          v.assets[entry.asset]?.chainId !== chainId
        )
          fail(['profiles', name, 'assetRoles', role], 'asset not on profile');
      if (
        profile.nativeAsset !== null &&
        v.nativeAssets[profile.nativeAsset]?.chainId !== chainId
      )
        fail(['profiles', name, 'nativeAsset'], 'native asset not on profile');
      if (
        profile.faucet !== null &&
        v.contracts[profile.faucet]?.chainId !== chainId
      )
        fail(['profiles', name, 'faucet'], 'faucet not on profile');
      for (const [bucket, entry] of Object.entries(profile.treasuryBuckets))
        if (
          entry.kind === 'NATIVE' &&
          v.nativeAssets[entry.asset]?.chainId !== chainId
        )
          fail(['profiles', name, 'treasuryBuckets', bucket], 'bad native');
    }
    if (v.profiles['proof/monad-mainnet'].mutationEnabled)
      fail(['profiles', 'proof/monad-mainnet'], 'mainnet must stay disabled');
    const ausdAsset = (
      key: string,
      chainId: number,
      path: (string | number)[],
    ) => {
      const asset = v.assets[key];
      if (
        !asset ||
        asset.chainId !== chainId ||
        asset.symbol !== v.ausd.canonicalSymbol ||
        asset.decimals !== v.ausd.decimals
      )
        fail(path, 'AUSD entry does not resolve to a registered AUSD asset');
    };
    v.ausd.deployments.forEach((d, i) => {
      ausdAsset(d.asset, d.chainId, ['ausd', 'deployments', i]);
      if (d.faucet !== null && v.contracts[d.faucet]?.chainId !== d.chainId)
        fail(['ausd', 'deployments', i, 'faucet'], 'faucet not on chain');
    });
    v.ausd.oft.forEach((o, i) => {
      ausdAsset(o.asset, o.chainId, ['ausd', 'oft', i]);
      if (o.status === 'CONFIGURED' && o.peers.some((p) => p.eid === o.eid))
        fail(['ausd', 'oft', i, 'peers'], 'bridge cannot peer with itself');
    });
    const oftChains = v.ausd.oft.map((o) => o.chainId);
    if (new Set(oftChains).size !== oftChains.length)
      fail(['ausd', 'oft'], 'duplicate OFT network');
    if (
      v.ausd.oft.some(
        (o) =>
          o.status === 'CONFIGURED' &&
          v.profiles['sandbox/monad-testnet'].network.chainId === o.chainId,
      )
    )
      fail(['ausd', 'oft'], 'no AUSD OFT exists on Monad testnet');
  });
export type ChainRegistry = z.output<typeof ChainRegistrySchema>;

export function loadChainRegistry(raw: unknown): ChainRegistry {
  try {
    return parseOrThrow(ChainRegistrySchema, raw);
  } catch (error) {
    throw new RegistryError(
      'REGISTRY_INVALID',
      error instanceof Error ? error.message : undefined,
      { cause: error },
    );
  }
}
export const chainRegistry = loadChainRegistry(rawRegistry);

function toAsset(entry: ChainRegistry['assets'][string]): Asset {
  return parseOrThrow(AssetSchema, {
    canonicalAssetId: `eip155:${entry.chainId}/erc20:${entry.address}`,
    chainId: entry.chainId,
    address: entry.address,
    symbol: entry.symbol,
    decimals: entry.decimals,
  });
}
function toNative(entry: ChainRegistry['nativeAssets'][string]): NativeAsset {
  return parseOrThrow(NativeAssetSchema, {
    canonicalAssetId: `eip155:${entry.chainId}/native`,
    chainId: entry.chainId,
    native: true,
    symbol: entry.symbol,
    decimals: entry.decimals,
  });
}
export type OfficialAssetKey = keyof typeof rawRegistry.assets;
export type NativeAssetKey = keyof typeof rawRegistry.nativeAssets;
function recordOf<K extends string, V>(
  keys: readonly K[],
  value: (key: K) => V,
): Readonly<Record<K, V>> {
  return Object.freeze(
    Object.fromEntries(keys.map((k) => [k, value(k)])) as Record<K, V>,
  );
}
function lookup<V>(table: Readonly<Record<string, V>>, key: string): V {
  const value = table[key];
  if (value === undefined)
    throw new RegistryError('ASSET_REGISTRY_MISMATCH', key);
  return value;
}
export const officialAssets = recordOf(
  Object.keys(rawRegistry.assets) as OfficialAssetKey[],
  (key) => toAsset(lookup(chainRegistry.assets, key)),
);
export const nativeAssets = recordOf(
  Object.keys(rawRegistry.nativeAssets) as NativeAssetKey[],
  (key) => toNative(lookup(chainRegistry.nativeAssets, key)),
);
export function officialAsset(key: string): Asset {
  return lookup<Asset>(officialAssets, key);
}
export type AssetRoleBinding =
  | { status: 'CONFIGURED'; asset: Asset; source: string }
  | { status: 'UNCONFIGURED'; reason: string };
export type TreasuryBucketBinding =
  | { kind: 'ASSET'; asset: Asset }
  | { kind: 'NATIVE'; asset: NativeAsset }
  | { kind: 'MANDATE_DEFINED' }
  | { kind: 'UNCONFIGURED'; reason: string };
export interface ChainConfiguration {
  network: NetworkProfile;
  rpcEnvironment: string;
  defaultRpcUrl: string;
  explorerUrl: string | null;
  confirmationDepth: number;
  maxIndexLagBlocks: bigint;
  mutationEnabled: boolean;
  nativeAsset: NativeAsset | null;
  faucetAddress: `0x${string}` | null;
  assetRoles: Readonly<Record<AssetRole, AssetRoleBinding>>;
  treasuryBuckets: Readonly<Record<TreasuryBucket, TreasuryBucketBinding>>;
}
function configuration(name: ProfileName): ChainConfiguration {
  const p = chainRegistry.profiles[name];
  const roles = Object.fromEntries(
    ASSET_ROLES.map((role) => {
      const entry = p.assetRoles[role];
      return [
        role,
        entry.status === 'CONFIGURED'
          ? {
              status: 'CONFIGURED',
              asset: officialAsset(entry.asset),
              source: entry.source,
            }
          : entry,
      ];
    }),
  ) as Record<AssetRole, AssetRoleBinding>;
  const buckets = Object.fromEntries(
    TREASURY_BUCKETS.map((bucket) => {
      const entry = p.treasuryBuckets[bucket];
      const binding: TreasuryBucketBinding =
        entry.kind === 'ROLE'
          ? (() => {
              const role = roles[entry.role];
              return role.status === 'CONFIGURED'
                ? { kind: 'ASSET', asset: role.asset }
                : { kind: 'UNCONFIGURED', reason: role.reason };
            })()
          : entry.kind === 'NATIVE'
            ? { kind: 'NATIVE', asset: nativeAssetOf(entry.asset) }
            : entry;
      return [bucket, binding];
    }),
  ) as Record<TreasuryBucket, TreasuryBucketBinding>;
  return Object.freeze({
    network: p.network,
    rpcEnvironment: p.rpcEnvironment,
    defaultRpcUrl: p.defaultRpcUrl,
    explorerUrl: p.explorerUrl,
    confirmationDepth: p.confirmationDepth,
    maxIndexLagBlocks: BigInt(p.maxIndexLagBlocks),
    mutationEnabled: p.mutationEnabled,
    nativeAsset: p.nativeAsset === null ? null : nativeAssetOf(p.nativeAsset),
    faucetAddress:
      p.faucet === null
        ? null
        : (chainRegistry.contracts[p.faucet]?.address ?? null),
    assetRoles: Object.freeze(roles),
    treasuryBuckets: Object.freeze(buckets),
  });
}
function nativeAssetOf(key: string): NativeAsset {
  return lookup<NativeAsset>(nativeAssets, key);
}
export const localProfile = configuration('local/anvil');
export const monadTestnetProfile = configuration('sandbox/monad-testnet');
export const monadMainnetProfile = configuration('proof/monad-mainnet');
const profiles: Record<ProfileName, ChainConfiguration> = {
  'local/anvil': localProfile,
  'sandbox/monad-testnet': monadTestnetProfile,
  'proof/monad-mainnet': monadMainnetProfile,
};
export function profileConfiguration(name: ProfileName): ChainConfiguration {
  return profiles[parseOrThrow(ProfileNameSchema, name)];
}
export function chainIdForProfile(name: ProfileName): number {
  return profileConfiguration(name).network.chainId;
}
export function profileForChainId(chainId: number): ChainConfiguration | null {
  return (
    Object.values(profiles).find((p) => p.network.chainId === chainId) ?? null
  );
}
export function isLocalChain(chainId: number): boolean {
  return profileForChainId(chainId)?.network.profile === 'local/anvil';
}
export function isMutationEnabledChain(chainId: number): boolean {
  return profileForChainId(chainId)?.mutationEnabled === true;
}
export function profileFor(name: string): ChainConfiguration {
  const parsed = ProfileNameSchema.safeParse(name);
  if (!parsed.success || !profiles[parsed.data].mutationEnabled)
    throw new RegistryError('NETWORK_DISABLED', name);
  return profiles[parsed.data];
}
export function assetForRole(
  config: ChainConfiguration,
  role: AssetRole,
): Asset {
  const binding = config.assetRoles[role];
  if (binding.status !== 'CONFIGURED')
    throw new RegistryError(
      'ASSET_ROLE_UNCONFIGURED',
      `${config.network.profile}:${role}`,
    );
  return binding.asset;
}
export function contractAddress(
  chainId: number,
  kind: ChainRegistry['contracts'][string]['kind'],
): `0x${string}` {
  const match = Object.values(chainRegistry.contracts).find(
    (c) => c.chainId === chainId && c.kind === kind,
  );
  if (!match) throw new RegistryError('ASSET_ROLE_UNCONFIGURED', kind);
  return match.address;
}
export function verifiedAsset(
  candidate: unknown,
  localDeployment: readonly Asset[] = [],
): Asset {
  const parsed = parseOrThrow(AssetSchema, candidate);
  const local = localDeployment.map((a) => parseOrThrow(AssetSchema, a));
  if (local.some((a) => a.chainId !== LOCAL_CHAIN_ID))
    throw new RegistryError(
      'ASSET_REGISTRY_MISMATCH',
      'runtime assets are accepted only for the local profile',
    );
  const actual = [...Object.values(officialAssets), ...local].find(
    (asset) =>
      asset.chainId === parsed.chainId && asset.address === parsed.address,
  );
  if (
    !actual ||
    actual.symbol !== parsed.symbol ||
    actual.decimals !== parsed.decimals ||
    actual.canonicalAssetId !== parsed.canonicalAssetId
  )
    throw new RegistryError('ASSET_REGISTRY_MISMATCH');
  return actual;
}
const legacyProfiles: Record<string, ProfileName> = {
  local: 'local/anvil',
  testnet: 'sandbox/monad-testnet',
  mainnet: 'proof/monad-mainnet',
};
const ManifestNetworkSchema = z.preprocess(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'profile' in value &&
    typeof value.profile === 'string' &&
    value.profile in legacyProfiles
      ? { ...value, profile: legacyProfiles[value.profile] }
      : value,
  NetworkProfileSchema,
);
export const DeploymentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  network: ManifestNetworkSchema,
  account: AddressSchema,
  mandateRegistry: AddressSchema,
  executionModule: AddressSchema,
  deploymentTransactions: z.array(HashSchema).min(3),
  deploymentBlock: z.string().regex(/^[0-9]+$/),
  sandboxOnly: z.literal(true),
});

export type AusdDeployment = {
  chainId: number;
  asset: Asset;
  implementation: `0x${string}`;
  proxy: 'EIP1967';
  faucetAddress: `0x${string}` | null;
  source: string;
  verifiedAt: string;
};
type OftEntry = AusdRegistry['oft'][number];
export type AusdOftConfigured = Extract<OftEntry, { status: 'CONFIGURED' }> & {
  ausd: Asset;
};
export type AusdOftAbsent = Extract<OftEntry, { status: 'NO_AUSD_OFT' }> & {
  ausd: Asset;
};
export type AusdOftNetwork = AusdOftConfigured | AusdOftAbsent;
export type AusdOftPeer = AusdOftConfigured['peers'][number];
export const ausdRegistry: Readonly<AusdRegistry> = Object.freeze(
  structuredClone(chainRegistry.ausd),
);
export const AUSD_PAUSE_READERS: readonly string[] = Object.freeze([
  ...chainRegistry.ausd.controls.pauseReaders,
]);
export function ausdDeployment(chainId: number): AusdDeployment | null {
  const d = chainRegistry.ausd.deployments.find((x) => x.chainId === chainId);
  if (!d) return null;
  return {
    chainId: d.chainId,
    asset: officialAsset(d.asset),
    implementation: d.implementation,
    proxy: d.proxy,
    faucetAddress:
      d.faucet === null
        ? null
        : (chainRegistry.contracts[d.faucet]?.address ?? null),
    source: d.source,
    verifiedAt: d.verifiedAt,
  };
}
export function ausdOftNetwork(chainId: number): AusdOftNetwork | null {
  const o = chainRegistry.ausd.oft.find((x) => x.chainId === chainId);
  return o
    ? ({
        ...structuredClone(o),
        ausd: officialAsset(o.asset),
      } as AusdOftNetwork)
    : null;
}
/** Every registered AUSD asset across Monad and OFT peer chains. */
export function ausdAssets(): Asset[] {
  return Object.values(officialAssets).filter(
    (a) => a.symbol === chainRegistry.ausd.canonicalSymbol,
  );
}
