import { z } from 'zod';

const UINT256_MAX = (1n << 256n) - 1n;
const canonical = /^(0|[1-9][0-9]*)$/;

export const UintSchema = z
  .union([
    z.bigint(),
    z
      .string()
      .max(78)
      .regex(canonical, 'canonical unsigned decimal string required')
      .transform((v) => BigInt(v)),
  ])
  .refine((v) => v >= 0n && v <= UINT256_MAX, 'uint256 out of range');
export const PositiveUintSchema = UintSchema.refine(
  (v) => v > 0n,
  'must be positive',
);
const TimeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const BpsSchema = z.number().int().min(0).max(10_000);
const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);

export const AssetRefSchema = z.union([
  z.literal('native'),
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((v) => v.toLowerCase()),
]);
export const DcaAssetSchema = z.strictObject({
  symbol: z.string().min(1).max(16),
  address: AssetRefSchema,
  decimals: z.number().int().min(0).max(36),
  chainId: z.number().int().positive(),
});
export type DcaAsset = z.output<typeof DcaAssetSchema>;

export const REFERENCE_STATUSES = [
  'HEALTHY',
  'DEGRADED',
  'UNKNOWN',
  'STALE',
] as const;
export const ReferenceStatusSchema = z.enum(REFERENCE_STATUSES);
export type ReferenceStatus = z.output<typeof ReferenceStatusSchema>;

export const DcaPolicySchema = z
  .strictObject({
    strategyId: IdSchema,
    startAt: TimeSchema,
    expiresAt: TimeSchema,
    frequencySeconds: z
      .number()
      .int()
      .positive()
      .max(366 * 86_400),
    budgetAsset: DcaAssetSchema,
    targetAsset: DcaAssetSchema,
    allowedAssets: z.array(AssetRefSchema).min(1),
    venue: IdSchema,
    allowedVenues: z.array(IdSchema).min(1),
    baseTranche: PositiveUintSchema,
    maxTranche: PositiveUintSchema,
    minTranche: PositiveUintSchema,
    budget: PositiveUintSchema,
    maxDeployment: PositiveUintSchema,
    maxAllocationBps: BpsSchema,
    maxSlippageBps: BpsSchema,
    spike: z.strictObject({
      skipIf24hChangeAboveBps: z.number().int().positive().max(1_000_000),
    }),
    dip: z.strictObject({
      multiplierBps: z.number().int().min(10_000).max(100_000),
      triggerBelowTrailingBps: z.number().int().min(1).max(9_999),
    }),
    escalateIfAbsMoveAboveBps: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .default(2_000),
    maxMarketDataAgeSeconds: z.number().int().positive().max(86_400),
    pause: z.strictObject({
      paused: z.boolean(),
      pauseOnReferenceStatuses: z
        .array(z.enum(['DEGRADED', 'UNKNOWN', 'STALE']))
        .default([]),
      pauseOnVenueUnhealthy: z.boolean().default(false),
    }),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.expiresAt <= v.startAt)
      issue('expiresAt', 'expiresAt must be after startAt');
    if (v.maxTranche < v.baseTranche)
      issue('maxTranche', 'maxTranche must be at least baseTranche');
    if (v.minTranche > v.baseTranche)
      issue('minTranche', 'minTranche must not exceed baseTranche');
    if (v.maxDeployment > v.budget)
      issue('maxDeployment', 'maxDeployment must not exceed budget');
    if (!v.allowedVenues.includes(v.venue))
      issue('allowedVenues', 'venue must be in allowedVenues');
    if (
      !v.allowedAssets.includes(v.budgetAsset.address) ||
      !v.allowedAssets.includes(v.targetAsset.address)
    )
      issue('allowedAssets', 'allowedAssets must contain both assets');
    if (v.budgetAsset.address === v.targetAsset.address)
      issue('targetAsset', 'target asset must differ from budget asset');
    if (v.budgetAsset.chainId !== v.targetAsset.chainId)
      issue('targetAsset', 'assets must be on the same chain');
  });
export type DcaPolicy = z.output<typeof DcaPolicySchema>;
export type DcaPolicyInput = z.input<typeof DcaPolicySchema>;

export const MarketInputsSchema = z.strictObject({
  asOf: TimeSchema,
  venue: IdSchema,
  assetIn: AssetRefSchema,
  assetOut: AssetRefSchema,
  price: PositiveUintSchema,
  trailingReferencePrice: PositiveUintSchema,
  change24hBps: z.number().int().min(-10_000).max(1_000_000),
  venueHealthy: z.boolean(),
  venueHealthReason: z.string().max(200).optional(),
  liquidityMaxInput: UintSchema,
  referenceStatus: ReferenceStatusSchema,
  sourcesConflict: z.boolean(),
});
export type MarketInputs = z.output<typeof MarketInputsSchema>;

export const TreasuryStateSchema = z.strictObject({
  freeBudgetAsset: UintSchema,
  totalValueInBudgetAsset: UintSchema,
  targetPositionValueInBudgetAsset: UintSchema,
});
export type TreasuryState = z.output<typeof TreasuryStateSchema>;

export const EXECUTION_STATUSES = ['PENDING', 'SETTLED', 'FAILED'] as const;
export const DcaExecutionSchema = z.strictObject({
  slot: z.number().int().nonnegative(),
  intentId: IdSchema,
  at: TimeSchema,
  amountIn: PositiveUintSchema,
  status: z.enum(EXECUTION_STATUSES),
});
export type DcaExecution = z.output<typeof DcaExecutionSchema>;
export const DcaHistorySchema = z.strictObject({
  executions: z.array(DcaExecutionSchema),
  exitedPrincipal: UintSchema.default(0n),
});
export type DcaHistory = z.output<typeof DcaHistorySchema>;

export const DcaEvaluationInputSchema = z.strictObject({
  policy: DcaPolicySchema,
  market: MarketInputsSchema,
  treasury: TreasuryStateSchema,
  history: DcaHistorySchema,
  now: TimeSchema,
});
export type DcaEvaluationInput = z.output<typeof DcaEvaluationInputSchema>;
export type DcaEvaluationInputJson = z.input<typeof DcaEvaluationInputSchema>;

export function parseDcaPolicy(raw: unknown): DcaPolicy {
  return DcaPolicySchema.parse(raw);
}
export function parseDcaEvaluationInput(raw: unknown): DcaEvaluationInput {
  return DcaEvaluationInputSchema.parse(raw);
}
