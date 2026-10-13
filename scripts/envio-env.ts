import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assetForRole, profileConfiguration } from '@synq/chain-registry';
import { AddressSchema, ProfileNameSchema, RegistryError } from '@synq/domain';
import {
  ObservedAccountSchema,
  deploymentFacts,
  projectionConfigFromDeployment,
  type ProjectionConfig,
} from '@synq/read-model';

export const DEFAULT_MAX_REORG_DEPTH = 200;
export const MONAD_RPC_LOG_RANGE = 100;
export interface IndexerSettingsInput {
  profileName: string;
  deployment: unknown;
  receipts: unknown;
  localTreasuryAsset?: string;
  observedAccounts?: unknown[];
  rpcUrl?: string;
  maxReorgDepth?: number;
  startBlock?: number;
}
export interface IndexerSettings {
  env: Record<string, string>;
  projection: ProjectionConfig;
  maxLagBlocks: number;
  rpcUrl: string;
}

export function indexerSettings(input: IndexerSettingsInput): IndexerSettings {
  const profile = profileConfiguration(
    ProfileNameSchema.parse(input.profileName),
  );
  const facts = deploymentFacts(input.deployment, input.receipts);
  if (facts.chainId !== profile.network.chainId)
    throw new RegistryError('REGISTRY_INVALID', 'deployment/profile mismatch');
  const local = profile.network.profile === 'local/anvil';
  if (!local && input.localTreasuryAsset)
    throw new RegistryError(
      'ASSET_REGISTRY_MISMATCH',
      'test tokens are accepted only for local/anvil',
    );
  const treasury = local
    ? AddressSchema.parse(input.localTreasuryAsset)
    : assetForRole(profile, 'treasuryAsset').address;
  const observed = z
    .array(ObservedAccountSchema)
    .parse(input.observedAccounts ?? []);
  const reorg = input.maxReorgDepth ?? DEFAULT_MAX_REORG_DEPTH;
  const rpcUrl =
    input.rpcUrl ??
    // An empty value (an unset compose variable) means the profile default.
    (process.env[profile.rpcEnvironment] || profile.defaultRpcUrl);
  const projection = projectionConfigFromDeployment({
    facts,
    profile: profile.network.profile,
    treasuryAssets: [treasury],
    reorgWindowBlocks: reorg,
    confirmationDepth: profile.confirmationDepth,
    observedAccounts: observed,
    ...(input.startBlock === undefined ? {} : { startBlock: input.startBlock }),
  });
  return {
    projection,
    maxLagBlocks: Number(profile.maxIndexLagBlocks),
    rpcUrl,
    env: {
      SYNQ_CHAIN_ID: String(facts.chainId),
      SYNQ_START_BLOCK: String(projection.startBlock),
      SYNQ_MAX_REORG_DEPTH: String(reorg),
      SYNQ_INDEXER_RPC_URL: rpcUrl,
      SYNQ_FACTORY_ADDRESS: facts.factory,
      SYNQ_REGISTRY_ADDRESS: facts.registry,
      SYNQ_MODULE_ADDRESS: facts.module,
      SYNQ_TREASURY_ASSETS: projection.treasuryAssets.join(','),
      SYNQ_OBSERVED_ACCOUNTS: `[${observed.map((o) => o.account).join(',')}]`,
      SYNQ_RPC_LOG_RANGE: String(MONAD_RPC_LOG_RANGE),
    },
  };
}

export function deploymentPaths(chainId: number) {
  return {
    deployment: resolve(`contracts/deployments/${chainId}.json`),
    receipts: resolve(`contracts/deployments/${chainId}.receipts.json`),
  };
}

export function registryDeploymentSettings(
  profileName: string,
  extra: Omit<
    IndexerSettingsInput,
    'profileName' | 'deployment' | 'receipts'
  > = {},
): IndexerSettings {
  const chainId = profileConfiguration(ProfileNameSchema.parse(profileName))
    .network.chainId;
  const paths = deploymentPaths(chainId);
  return indexerSettings({
    profileName,
    deployment: JSON.parse(readFileSync(paths.deployment, 'utf8')),
    receipts: JSON.parse(readFileSync(paths.receipts, 'utf8')),
    ...extra,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [profileName = 'sandbox/monad-testnet', observedPath] =
    process.argv.slice(2);
  const settings = registryDeploymentSettings(profileName, {
    observedAccounts: observedPath
      ? (JSON.parse(readFileSync(resolve(observedPath), 'utf8')) as unknown[])
      : [],
  });
  const defaults = readFileSync('indexer/envio/.env.example', 'utf8')
    .split('\n')
    .filter(
      (line) => line && !line.startsWith('#') && !line.startsWith('SYNQ_'),
    );
  const lines = [
    ...Object.entries(settings.env).map(([k, v]) => `${k}=${v}`),
    ...defaults,
  ];
  writeFileSync('indexer/envio/.env', lines.join('\n') + '\n', { mode: 0o600 });
  console.log(
    `indexer/envio/.env generated from sources/chain_registry.json and contracts/deployments for ${profileName}`,
  );
}
