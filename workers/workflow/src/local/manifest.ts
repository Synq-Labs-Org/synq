import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  AddressSchema,
  AssetSchema,
  HashSchema,
  MandateSchema,
} from '@synq/schemas';

const absolute = z
  .string()
  .refine((p) => isAbsolute(p), 'path must be absolute');

/** Everything a local-anvil worker process needs to rebuild its runtime after a restart. */
export const LocalWorkflowManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionMode: z.literal('SIMULATION'),
  rpcUrl: z.url(),
  riskAttestation: z
    .strictObject({
      registry: AddressSchema,
      forwarder: AddressSchema,
      workflowId: HashSchema,
      sourceConfigHash: HashSchema,
      assetId: HashSchema,
    })
    .optional(),
  factory: AddressSchema,
  registry: AddressSchema,
  module: AddressSchema,
  token: AddressSchema,
  account: AddressSchema,
  recipient: AddressSchema,
  executor: AddressSchema,
  chainGroupId: HashSchema,
  deploymentBlock: z.string().regex(/^[0-9]+$/),
  groupId: z.string(),
  mandate: MandateSchema,
  asset: AssetSchema,
  owners: z.array(AddressSchema).min(1),
  databaseUrl: z.string(),
  kernelInstance: z.string().regex(/^[a-z0-9:/_.-]{1,128}$/i),
  executorKeyFile: absolute,
  auditKeyFile: absolute,
  journalKeyFile: absolute,
  journalDirectory: absolute,
  freezeFile: absolute,
  ticksFile: absolute,
  outboxFile: absolute,
});
export type LocalWorkflowManifest = z.output<
  typeof LocalWorkflowManifestSchema
>;

export function readLocalManifest(path: string): LocalWorkflowManifest {
  return LocalWorkflowManifestSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
}
