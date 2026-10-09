import { z } from 'zod';
import { keccak256, stringToHex } from 'viem';
import { canonicalJson } from './events.js';
import type { Hex } from './tables.js';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => x.toLowerCase() as Hex);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const block = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ObservedAccountSchema = z.strictObject({
  account: address,
  baselineBlock: block,
  baselineBalances: z.record(address, uint),
  label: z.string().min(1).max(120),
});
export const ProjectionConfigSchema = z
  .strictObject({
    chainId: block.positive(),
    profile: z.string().min(1),
    startBlock: block,
    factory: address,
    registry: address,
    module: address,
    treasuryAssets: z.array(address).min(1),
    observedAccounts: z.array(ObservedAccountSchema).default([]),
    reorgWindowBlocks: block.positive(),
    confirmationDepth: block.positive(),
  })
  .superRefine((c, ctx) => {
    for (const o of c.observedAccounts) {
      if (o.baselineBlock >= c.startBlock)
        ctx.addIssue({
          code: 'custom',
          message: 'observed baseline must precede start block',
        });
      for (const asset of Object.keys(o.baselineBalances))
        if (!c.treasuryAssets.includes(asset as Hex))
          ctx.addIssue({ code: 'custom', message: 'baseline asset unknown' });
    }
  });
export type ProjectionConfig = z.output<typeof ProjectionConfigSchema>;
export type ProjectionConfigInput = z.input<typeof ProjectionConfigSchema>;

export function projectionConfig(
  input: ProjectionConfigInput,
): ProjectionConfig {
  return ProjectionConfigSchema.parse(input);
}
export function configHash(config: ProjectionConfig): Hex {
  return keccak256(stringToHex(canonicalJson(config)));
}
