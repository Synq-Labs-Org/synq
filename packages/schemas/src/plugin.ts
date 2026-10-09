import { z } from 'zod';
import {
  ChainIdSchema,
  ProfileNameSchema,
  profilesForChains,
} from './network.js';
import { PluginIdSchema, SourceIdSchema } from './primitives.js';

export const CAPABILITIES = [
  'READ_MARKET',
  'QUOTE',
  'PROPOSE_ACTION',
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CARD_PAYMENT',
  'X402_PAYMENT',
  'CROSS_CHAIN_FUND',
  'SUBSCRIPTION',
  'CONVERSION',
  'SIGN',
  'WITHDRAW',
  'CHANGE_OWNER',
  'CHANGE_THRESHOLD',
  'INSTALL_MODULE',
  'CHANGE_POLICY',
  'ISSUE_GRANT',
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.output<typeof CapabilitySchema>;
export const NON_DELEGABLE_CAPABILITIES = [
  'SIGN',
  'WITHDRAW',
  'CHANGE_OWNER',
  'CHANGE_THRESHOLD',
  'INSTALL_MODULE',
  'CHANGE_POLICY',
  'ISSUE_GRANT',
] as const satisfies readonly Capability[];
export const MUTATING_CAPABILITIES = [
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CARD_PAYMENT',
  'X402_PAYMENT',
  'CROSS_CHAIN_FUND',
  'SUBSCRIPTION',
  'CONVERSION',
] as const satisfies readonly Capability[];
export function isNonDelegable(capability: Capability): boolean {
  return (NON_DELEGABLE_CAPABILITIES as readonly Capability[]).includes(
    capability,
  );
}
export function isMutating(capability: Capability): boolean {
  return (MUTATING_CAPABILITIES as readonly Capability[]).includes(capability);
}

export const MAX_PLUGIN_GRANT_TTL_SECONDS = 900;
export const PluginRiskClassSchema = z.enum([
  'READ_ONLY',
  'FINANCIAL_EXECUTION',
]);
const exactVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'exact version required');
export const PluginHealthRequirementSchema = z.strictObject({
  maxStalenessSeconds: z.number().int().min(1).max(3600),
  checks: z.array(
    z.enum(['RPC', 'PROVIDER_API', 'CREDENTIALS', 'INDEXER', 'QUOTE_SOURCE']),
  ),
});
export const DEFAULT_PLUGIN_HEALTH = {
  maxStalenessSeconds: 60,
  checks: [],
} as const;
export const PluginManifestSchema = z
  .strictObject({
    id: PluginIdSchema,
    version: exactVersion,
    capabilities: z.array(CapabilitySchema).min(1),
    chains: z.array(ChainIdSchema).min(1),
    environments: z.array(ProfileNameSchema).min(1).optional(),
    riskClass: PluginRiskClassSchema,
    requiresSimulation: z.boolean(),
    maxGrantTtlSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_PLUGIN_GRANT_TTL_SECONDS),
    dependencies: z
      .record(z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/), exactVersion)
      .default({}),
    sourceDocs: z.array(z.url({ protocol: /^https$/ })).default([]),
    sourceIds: z.array(SourceIdSchema).default([]),
    health: PluginHealthRequirementSchema.default({
      ...DEFAULT_PLUGIN_HEALTH,
      checks: [],
    }),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (new Set(v.capabilities).size !== v.capabilities.length)
      issue('duplicate capability', 'capabilities');
    if (new Set(v.chains).size !== v.chains.length)
      issue('duplicate chain', 'chains');
    if (v.capabilities.some(isNonDelegable))
      issue('plugin requests a non-delegable capability', 'capabilities');
    const mutating = v.capabilities.some(isMutating);
    if (v.riskClass === 'READ_ONLY' && mutating)
      issue('READ_ONLY plugin requests a mutating capability', 'riskClass');
    if (v.riskClass === 'FINANCIAL_EXECUTION' && !mutating)
      issue('FINANCIAL_EXECUTION plugin declares no mutation', 'riskClass');
    if (v.riskClass === 'FINANCIAL_EXECUTION' && !v.requiresSimulation)
      issue('financial plugins require simulation', 'requiresSimulation');
    if (v.environments) {
      const supported = profilesForChains(v.chains);
      if (v.environments.some((e) => !supported.includes(e)))
        issue('environment has no declared chain', 'environments');
    }
  })
  .transform((v) => ({
    ...v,
    environments: v.environments ?? profilesForChains(v.chains),
  }));
export type PluginManifest = z.output<typeof PluginManifestSchema>;
export type PluginManifestInput = z.input<typeof PluginManifestSchema>;
export const PluginHealthSchema = z.strictObject({
  available: z.boolean(),
  checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().max(200).optional(),
});
export type PluginHealth = z.output<typeof PluginHealthSchema>;
