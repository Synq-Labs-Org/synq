import { z } from 'zod';
import {
  chainRegistry,
  monadMainnetProfile,
  monadTestnetProfile,
  officialAsset,
} from '@synq/chain-registry';
import { AddressSchema, type ProfileName } from '@synq/domain';
import type {
  RiskAttestationGateConfig,
  RiskAttestationReader,
} from '@synq/kernel';
import testnetManifest from '../../../contracts/deployments/10143.risk-attestation.json' with { type: 'json' };
import testnetConfig from '../synq-ausd-risk/config.testnet.json' with { type: 'json' };
import mainnetConfig from '../synq-ausd-risk/config.mainnet.json' with { type: 'json' };
import { canonicalAssetKey, sourceConfigHash } from './attestation.js';

export const RiskAttestationManifestSchema = z.strictObject({
  RiskAttestationRegistry: AddressSchema,
  chainId: z.number().int().positive(),
  deployer: AddressSchema,
  forwarder: AddressSchema,
  forwarderKind: z.enum(['CRE_MOCK_FORWARDER', 'CRE_FORWARDER']),
  forwarderRegistryKey: z.string(),
  simulatedAtBlock: z.number().int().positive(),
});
export type RiskAttestationDeployment = z.output<
  typeof RiskAttestationManifestSchema
>;

export function riskAttestationDeployment(
  profile: ProfileName,
  raw: unknown = testnetManifest,
): RiskAttestationDeployment {
  if (profile !== 'sandbox/monad-testnet')
    throw new Error(`no RiskAttestationRegistry deployment for ${profile}`);
  const m = RiskAttestationManifestSchema.parse(raw);
  const forwarder = chainRegistry.contracts[m.forwarderRegistryKey];
  if (
    m.chainId !== monadTestnetProfile.network.chainId ||
    !forwarder ||
    forwarder.chainId !== m.chainId ||
    forwarder.kind !== m.forwarderKind ||
    forwarder.address.toLowerCase() !== m.forwarder
  )
    throw new Error('risk attestation manifest drifts from the chain registry');
  return m;
}

export function stableRiskGateConfig(
  profile: ProfileName,
  reader: RiskAttestationReader,
  maxAttestationAgeSeconds: number,
): RiskAttestationGateConfig {
  const deployment = riskAttestationDeployment(profile);
  const ausd = officialAsset('testnetAUSD');
  return {
    reader,
    chainId: deployment.chainId,
    registry: deployment.RiskAttestationRegistry,
    assets: [
      {
        address: ausd.address,
        assetId: canonicalAssetKey(ausd.chainId, ausd.address),
      },
    ],
    maxAttestationAgeSeconds,
    trustedSourceConfigHash: sourceConfigHash({
      config: validateWorkflowConfig(testnetConfig),
      chainId: deployment.chainId,
    }),
    maxReferenceStalenessSeconds: testnetConfig.thresholds.maxStalenessSec,
    maxHealthyDeviationBps: testnetConfig.thresholds.degradedDeviationBps,
    trustedForwarder: deployment.forwarder,
    forwarderKind: deployment.forwarderKind,
    trustedWorkflowId: `0x${'11'.repeat(32)}`,
  };
}

const ThresholdsSchema = z.strictObject({
  maxStalenessSec: z.number().int().positive(),
  degradedDeviationBps: z.number().int().min(0).max(10_000),
  maxVenueDeviationBps: z.number().int().min(0).max(10_000),
});
export const WorkflowConfigSchema = z.strictObject({
  schedule: z.string().min(1),
  chainSelectorName: z.enum(['monad-testnet', 'monad-mainnet']),
  isTestnet: z.boolean(),
  assetRegistryKey: z.string(),
  referenceFeedRegistryKey: z.string().nullable(),
  referenceUnavailableReason: z.string().optional(),
  auxiliaryFeedRegistryKeys: z.array(z.string()),
  thresholds: ThresholdsSchema,
  kuruQuote: z
    .strictObject({
      apiBaseUrl: z.url({ protocol: /^https$/ }),
      tokenInRegistryKey: z.string(),
      tokenOutRegistryKey: z.string(),
      amountIn: z.string().regex(/^[1-9][0-9]*$/),
      quoteIdentity: z.string().regex(/^0x0{36}[0-9a-fA-F]{4}$/),
    })
    .nullable(),
  receiverDeployment: z.enum(['monad-testnet']).nullable(),
  gasLimit: z.string().regex(/^[1-9][0-9]*$/),
});
export type WorkflowConfig = z.output<typeof WorkflowConfigSchema>;

/** Validates a workflow config against the chain registry: every key exists, sits on the config's chain and has the right kind. */
export function validateWorkflowConfig(raw: unknown): WorkflowConfig {
  const config = WorkflowConfigSchema.parse(raw);
  const profile = config.isTestnet ? monadTestnetProfile : monadMainnetProfile;
  const chainId = profile.network.chainId;
  if (
    (config.chainSelectorName === 'monad-testnet') !== config.isTestnet ||
    (config.receiverDeployment !== null && !config.isTestnet)
  )
    throw new Error('network fields disagree');
  const asset = chainRegistry.assets[config.assetRegistryKey];
  if (!asset || asset.chainId !== chainId || asset.symbol !== 'AUSD')
    throw new Error(
      `asset ${config.assetRegistryKey} is not AUSD on ${chainId}`,
    );
  for (const key of [
    ...(config.referenceFeedRegistryKey
      ? [config.referenceFeedRegistryKey]
      : []),
    ...config.auxiliaryFeedRegistryKeys,
  ]) {
    const feed = chainRegistry.contracts[key];
    if (
      !feed ||
      feed.chainId !== chainId ||
      feed.kind !== 'CHAINLINK_PRICE_FEED'
    )
      throw new Error(`feed ${key} is not a Chainlink feed on ${chainId}`);
  }
  if (config.referenceFeedRegistryKey) {
    const pair = chainRegistry.contracts[config.referenceFeedRegistryKey]?.pair;
    if (pair !== 'AUSD/USD') throw new Error('reference feed must be AUSD/USD');
  } else if (!config.referenceUnavailableReason)
    throw new Error('a missing reference feed needs a reason');
  if (config.kuruQuote)
    for (const key of [
      config.kuruQuote.tokenInRegistryKey,
      config.kuruQuote.tokenOutRegistryKey,
    ])
      if (chainRegistry.assets[key]?.chainId !== chainId)
        throw new Error(`quote asset ${key} is not on ${chainId}`);
  return config;
}

export const workflowConfigs = {
  testnet: testnetConfig as unknown,
  mainnet: mainnetConfig as unknown,
} as const;
