import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ChainRegistrySchema,
  DeploymentManifestSchema,
  assetForRole,
  chainIdForProfile,
  chainRegistry,
  contractAddress,
  isLocalChain,
  isMutationEnabledChain,
  loadChainRegistry,
  localProfile,
  monadMainnetProfile,
  monadTestnetProfile,
  officialAssets,
  profileFor,
  profileForChainId,
  verifiedAsset,
} from '@synq/chain-registry';
import { ASSET_ROLES, TREASURY_BUCKETS, type Asset } from '@synq/domain';
import { parseCsv } from '../../scripts/csv.mjs';

import raw from '../../sources/chain_registry.json' with { type: 'json' };

const clone = () => structuredClone(raw);
const sourceIds = new Set(
  parseCsv(readFileSync('sources/source_registry.csv', 'utf8')).rows.map(
    (r) => r.id,
  ),
);
function addressHolders(
  value: unknown,
  path: string[] = [],
): { path: string; holder: Record<string, unknown> }[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => addressHolders(v, [...path, String(i)]));
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = Object.values(record).some(
    (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v),
  )
    ? [{ path: path.join('.'), holder: record }]
    : [];
  return [
    ...own,
    ...Object.entries(record).flatMap(([k, v]) =>
      addressHolders(v, [...path, k]),
    ),
  ];
}

describe('chain registry', () => {
  it('P00-002 rejects duplicate chain ids and duplicate asset identities', () => {
    const ids = chainRegistry.chains.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([31337, 10143, 143, 1, 8453, 43114]),
    );
    const duplicateChain = clone();
    duplicateChain.chains.push({ ...raw.chains[1]! });
    expect(ChainRegistrySchema.safeParse(duplicateChain).success).toBe(false);
    expect(() => loadChainRegistry(duplicateChain)).toThrow('REGISTRY_INVALID');
    const duplicateAsset = clone();
    Object.assign(duplicateAsset.assets, {
      shadowAUSD: { ...duplicateAsset.assets.testnetAUSD },
    });
    expect(ChainRegistrySchema.safeParse(duplicateAsset).success).toBe(false);
  });
  it('P00-004 every configured address is tagged with a registered source and network', () => {
    const holders = addressHolders(raw);
    expect(holders.length).toBeGreaterThanOrEqual(20);
    for (const { path, holder } of holders) {
      expect(typeof holder.source, path).toBe('string');
      expect(sourceIds.has(String(holder.source)), path).toBe(true);
      expect(holder.network, path).toBe(`eip155:${String(holder.chainId)}`);
    }
    for (const chain of chainRegistry.chains)
      expect(sourceIds.has(chain.source)).toBe(true);
    const untagged = clone();
    Reflect.deleteProperty(untagged.contracts.testnetSafe, 'source');
    expect(ChainRegistrySchema.safeParse(untagged).success).toBe(false);
    const mislabeled = clone();
    mislabeled.assets.testnetAUSD.network = 'eip155:143';
    expect(ChainRegistrySchema.safeParse(mislabeled).success).toBe(false);
  });
  it('JSON is the single address source: TS exports match it and no address is hard-coded in the package', () => {
    for (const [key, entry] of Object.entries(chainRegistry.assets))
      expect(officialAssets[key as keyof typeof officialAssets]).toMatchObject({
        chainId: entry.chainId,
        address: entry.address,
        decimals: entry.decimals,
        symbol: entry.symbol,
      });
    expect(Object.keys(officialAssets).sort()).toEqual(
      Object.keys(chainRegistry.assets).sort(),
    );
    const dir = 'packages/chain-registry/src';
    for (const file of readdirSync(dir))
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(
        /0x[0-9a-fA-F]{40}/,
      );
    expect(contractAddress(10143, 'SAFE_PROXY_FACTORY')).toBe(
      chainRegistry.contracts.testnetSafeProxyFactory!.address,
    );
    expect(contractAddress(143, 'SAFE_L2')).toBe(
      chainRegistry.contracts.mainnetSafeL2!.address,
    );
  });
  it('profiles distinguish all five asset roles and four treasury buckets', () => {
    for (const profile of [
      localProfile,
      monadTestnetProfile,
      monadMainnetProfile,
    ]) {
      expect(Object.keys(profile.assetRoles).sort()).toEqual(
        [...ASSET_ROLES].sort(),
      );
      expect(Object.keys(profile.treasuryBuckets).sort()).toEqual(
        [...TREASURY_BUCKETS].sort(),
      );
    }
    expect(assetForRole(monadTestnetProfile, 'treasuryAsset')).toBe(
      officialAssets.testnetAUSD,
    );
    expect(
      assetForRole(monadTestnetProfile, 'web2SettlementAsset').symbol,
    ).toBe('USDC');
    expect(assetForRole(monadMainnetProfile, 'perplCollateralAsset')).toBe(
      officialAssets.mainnetAUSD,
    );
    expect(monadTestnetProfile.treasuryBuckets.CORE_TREASURY).toEqual({
      kind: 'ASSET',
      asset: officialAssets.testnetAUSD,
    });
    expect(monadTestnetProfile.treasuryBuckets.GAS_BUFFER).toMatchObject({
      kind: 'NATIVE',
      asset: { symbol: 'MON', canonicalAssetId: 'eip155:10143/native' },
    });
    expect(monadTestnetProfile.treasuryBuckets.STRATEGY_POSITIONS).toEqual({
      kind: 'MANDATE_DEFINED',
    });
    expect(localProfile.assetRoles.treasuryAsset.status).toBe('UNCONFIGURED');
    expect(() => assetForRole(localProfile, 'treasuryAsset')).toThrow(
      'ASSET_ROLE_UNCONFIGURED',
    );
    expect(monadTestnetProfile.faucetAddress).toBe(
      chainRegistry.contracts.testnetAUSDFaucet!.address,
    );
  });
  it('mainnet is disabled by default and cannot be enabled by editing a flag alone', () => {
    expect(monadMainnetProfile.mutationEnabled).toBe(false);
    expect(profileFor('local/anvil')).toBe(localProfile);
    expect(profileFor('sandbox/monad-testnet')).toBe(monadTestnetProfile);
    for (const name of ['proof/monad-mainnet', 'mainnet', 'monad-testnet'])
      expect(() => profileFor(name)).toThrow('NETWORK_DISABLED');
    const enabled = clone();
    enabled.profiles['proof/monad-mainnet'].mutationEnabled = true;
    expect(ChainRegistrySchema.safeParse(enabled).success).toBe(false);
  });
  it('anchors assets to official chain/address/decimals identity and rejects spoofed symbols', () => {
    const ausd = officialAssets.testnetAUSD;
    expect(verifiedAsset(ausd)).toEqual(ausd);
    expect(() =>
      verifiedAsset({ ...officialAssets.testnetUSDC, symbol: 'AUSD' }),
    ).toThrow('ASSET_REGISTRY_MISMATCH');
    expect(() =>
      verifiedAsset({ ...ausd, address: officialAssets.testnetUSDC.address }),
    ).toThrow();
    expect(() => verifiedAsset({ ...ausd, decimals: 18 })).toThrow();
    expect(() =>
      verifiedAsset({
        ...officialAssets.mainnetAUSD,
        chainId: 10143,
        canonicalAssetId: `eip155:10143/erc20:${officialAssets.mainnetAUSD.address}`,
      }),
    ).toThrow('ASSET_REGISTRY_MISMATCH');
    const local: Asset = {
      canonicalAssetId: `eip155:31337/erc20:0x${'1'.repeat(40)}`,
      chainId: 31337,
      address: `0x${'1'.repeat(40)}`,
      symbol: 'OTHER',
      decimals: 6,
    };
    expect(() => verifiedAsset(local)).toThrow('ASSET_REGISTRY_MISMATCH');
    expect(verifiedAsset(local, [local])).toEqual(local);
    expect(() => verifiedAsset(ausd, [{ ...ausd }])).toThrow(
      expect.objectContaining({
        code: 'ASSET_REGISTRY_MISMATCH',
        detail: 'runtime assets are accepted only for the local profile',
      }),
    );
  });
  it('deployment manifests accept recorded legacy profile labels but normalize them', () => {
    const recorded = JSON.parse(
      readFileSync('reports/evidence/local-deployment.json', 'utf8'),
    );
    expect(DeploymentManifestSchema.parse(recorded.manifest).network).toEqual({
      profile: 'local/anvil',
      chainId: 31337,
      providerEnvironment: 'local',
    });
  });
  it('chain-id helpers derive local and mutation-enabled chains from registry profiles', () => {
    for (const p of [localProfile, monadTestnetProfile, monadMainnetProfile]) {
      expect(chainIdForProfile(p.network.profile)).toBe(p.network.chainId);
      expect(profileForChainId(p.network.chainId)).toBe(p);
      expect(isMutationEnabledChain(p.network.chainId)).toBe(p.mutationEnabled);
      expect(isLocalChain(p.network.chainId)).toBe(
        p.network.profile === 'local/anvil',
      );
    }
    expect(isMutationEnabledChain(monadMainnetProfile.network.chainId)).toBe(
      false,
    );
    expect(profileForChainId(1)).toBeNull();
    expect(isLocalChain(1)).toBe(false);
    expect(isMutationEnabledChain(1)).toBe(false);
  });
});
