import { z } from 'zod';
import { projectionConfig, type ProjectionConfig } from './config.js';
import { ReadModelError } from './errors.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const SynqDeploymentSchema = z.looseObject({
  chainId: z.number().int().positive(),
  SynqGroupFactory: address,
  MandateRegistry: address,
  ExecutionModule: address,
});
export const DeploymentReceiptsSchema = z.looseObject({
  chainId: z.number().int().positive(),
  transactions: z
    .array(
      z.looseObject({
        hash,
        blockNumber: z.number().int().positive(),
        status: z.literal(1),
      }),
    )
    .min(1),
});
export type SynqDeployment = z.output<typeof SynqDeploymentSchema>;
export interface DeploymentFacts {
  chainId: number;
  factory: `0x${string}`;
  registry: `0x${string}`;
  module: `0x${string}`;
  deploymentBlock: number;
  deploymentTransactions: `0x${string}`[];
}

export function deploymentFacts(
  deployment: unknown,
  receipts: unknown,
): DeploymentFacts {
  const d = SynqDeploymentSchema.parse(deployment);
  const r = DeploymentReceiptsSchema.parse(receipts);
  if (d.chainId !== r.chainId)
    throw new ReadModelError('CONFIG_MISMATCH', 'deployment/receipts chain');
  return {
    chainId: d.chainId,
    factory: d.SynqGroupFactory.toLowerCase() as `0x${string}`,
    registry: d.MandateRegistry.toLowerCase() as `0x${string}`,
    module: d.ExecutionModule.toLowerCase() as `0x${string}`,
    deploymentBlock: Math.min(...r.transactions.map((t) => t.blockNumber)),
    deploymentTransactions: r.transactions.map(
      (t) => t.hash.toLowerCase() as `0x${string}`,
    ),
  };
}

export function projectionConfigFromDeployment(input: {
  facts: DeploymentFacts;
  profile: string;
  treasuryAssets: readonly string[];
  reorgWindowBlocks: number;
  confirmationDepth: number;
  observedAccounts?: ProjectionConfig['observedAccounts'];
  /** Later start for a projection that only needs groups created at or after this block. */
  startBlock?: number;
}): ProjectionConfig {
  const startBlock = input.startBlock ?? input.facts.deploymentBlock;
  if (
    !Number.isSafeInteger(startBlock) ||
    startBlock < input.facts.deploymentBlock
  )
    throw new ReadModelError(
      'CONFIG_MISMATCH',
      'start block before deployment',
    );
  return projectionConfig({
    chainId: input.facts.chainId,
    profile: input.profile,
    startBlock,
    factory: input.facts.factory,
    registry: input.facts.registry,
    module: input.facts.module,
    treasuryAssets: [...input.treasuryAssets],
    reorgWindowBlocks: input.reorgWindowBlocks,
    confirmationDepth: input.confirmationDepth,
    observedAccounts: input.observedAccounts ?? [],
  });
}
