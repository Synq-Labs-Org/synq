import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DeploymentManifestSchema,
  assetForRole,
  profileConfiguration,
} from '@synq/chain-registry';
import { AddressSchema, ProfileNameSchema, RegistryError } from '@synq/domain';

export const LocalDeploymentSchema = z.object({
  manifest: DeploymentManifestSchema,
  localTestToken: AddressSchema,
});
export function envioEnvironment(
  profileName: string,
  deployment?: unknown,
): Record<string, string> {
  const profile = profileConfiguration(ProfileNameSchema.parse(profileName));
  const parsed =
    deployment === undefined
      ? undefined
      : LocalDeploymentSchema.partial({ localTestToken: true }).parse(
          deployment,
        );
  if (parsed && parsed.manifest.network.chainId !== profile.network.chainId)
    throw new RegistryError('REGISTRY_INVALID', 'deployment/profile mismatch');
  const treasuryToken =
    profile.network.profile === 'local/anvil'
      ? parsed?.localTestToken
      : assetForRole(profile, 'treasuryAsset').address;
  if (!treasuryToken)
    throw new RegistryError('ASSET_ROLE_UNCONFIGURED', 'treasuryAsset');
  return {
    SYNQ_CHAIN_ID: String(profile.network.chainId),
    SYNQ_START_BLOCK: parsed?.manifest.deploymentBlock ?? '0',
    SYNQ_INDEXER_RPC_URL:
      process.env[profile.rpcEnvironment] ?? profile.defaultRpcUrl,
    SYNQ_REGISTRY_ADDRESS: parsed?.manifest.mandateRegistry ?? '',
    SYNQ_MODULE_ADDRESS: parsed?.manifest.executionModule ?? '',
    SYNQ_TREASURY_TOKEN: treasuryToken,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [profileName = 'sandbox/monad-testnet', deploymentPath] =
    process.argv.slice(2);
  const generated = envioEnvironment(
    profileName,
    deploymentPath
      ? JSON.parse(readFileSync(resolve(deploymentPath), 'utf8'))
      : undefined,
  );
  const defaults = readFileSync('indexer/envio/.env.example', 'utf8')
    .split('\n')
    .filter(
      (line) => line && !line.startsWith('#') && !line.startsWith('SYNQ_'),
    );
  const lines = [
    ...Object.entries(generated).map(([k, v]) => `${k}=${v}`),
    ...defaults,
  ];
  writeFileSync('indexer/envio/.env', lines.join('\n') + '\n', { mode: 0o600 });
  console.log(
    `indexer/envio/.env generated from sources/chain_registry.json for ${profileName}`,
  );
}
