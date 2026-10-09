import { readFileSync } from 'node:fs';
import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';
import { contractAddress } from '@synq/chain-registry';
import {
  AddressSchema,
  EXECUTION_GRANT_TYPES,
  HashSchema,
  SigningError,
  type ProfileName,
} from '@synq/domain';

export const EXECUTION_GRANT_TYPE_STRING = `ExecutionGrant(${EXECUTION_GRANT_TYPES.ExecutionGrant.map(
  (f) => `${f.type} ${f.name}`,
).join(',')})`;
export const EXECUTION_GRANT_TYPEHASH = keccak256(
  stringToHex(EXECUTION_GRANT_TYPE_STRING),
);
const ManifestFileSchema = z.strictObject({
  ExecutionModule: AddressSchema,
  MandateRegistry: AddressSchema,
  SynqGroupFactory: AddressSchema,
  SynqSafeModuleSetup: AddressSchema,
  chainId: z.literal(10143),
  compatibilityFallbackHandler: AddressSchema,
  deployer: AddressSchema,
  eip712Name: z.literal('SynqExecutionModule'),
  eip712Version: z.literal('1'),
  grantTypehash: HashSchema,
  safeL2Singleton: AddressSchema,
  safeProxyFactory: AddressSchema,
  safeVersion: z.literal('1.4.1'),
  simulatedAtBlock: z.number().int().positive(),
});
export type SynqDeployment = {
  chainId: number;
  factory: `0x${string}`;
  registry: `0x${string}`;
  module: `0x${string}`;
  source: 'runtime-local' | 'contracts/deployments/10143.json';
};

export function testnetDeployment(
  raw: unknown = JSON.parse(
    readFileSync(
      new URL('../../../contracts/deployments/10143.json', import.meta.url),
      'utf8',
    ),
  ),
): SynqDeployment {
  const parsed = ManifestFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new SigningError('DEPLOYMENT_MANIFEST_INVALID', 'schema');
  const m = parsed.data;
  if (
    m.grantTypehash !== EXECUTION_GRANT_TYPEHASH ||
    m.safeL2Singleton !== contractAddress(10143, 'SAFE_L2').toLowerCase() ||
    m.safeProxyFactory !==
      contractAddress(10143, 'SAFE_PROXY_FACTORY').toLowerCase() ||
    m.compatibilityFallbackHandler !==
      contractAddress(
        10143,
        'SAFE_COMPATIBILITY_FALLBACK_HANDLER',
      ).toLowerCase()
  )
    throw new SigningError('DEPLOYMENT_MANIFEST_INVALID', 'registry drift');
  return {
    chainId: 10143,
    factory: m.SynqGroupFactory,
    registry: m.MandateRegistry,
    module: m.ExecutionModule,
    source: 'contracts/deployments/10143.json',
  };
}

export function synqDeployment(
  profile: ProfileName,
  local?: Omit<SynqDeployment, 'chainId' | 'source'>,
): SynqDeployment {
  if (profile === 'proof/monad-mainnet')
    throw new SigningError('DEPLOYMENT_MANIFEST_INVALID', 'mainnet disabled');
  if (profile === 'sandbox/monad-testnet') return testnetDeployment();
  if (!local)
    throw new SigningError('DEPLOYMENT_MANIFEST_INVALID', 'local addresses');
  return {
    chainId: 31337,
    factory: AddressSchema.parse(local.factory),
    registry: AddressSchema.parse(local.registry),
    module: AddressSchema.parse(local.module),
    source: 'runtime-local',
  };
}
