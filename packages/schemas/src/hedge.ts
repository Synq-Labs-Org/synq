import { z } from 'zod';
import {
  AmountSchema,
  IdSchema,
  GroupIdSchema,
  HashSchema,
  TimestampSchema,
} from './primitives.js';
import { ChainIdSchema } from './network.js';
const BaseAssetSchema = z.string().regex(/^[A-Z0-9]{2,12}$/);
export const HEDGE_ACTION_KINDS = [
  'OPEN',
  'INCREASE',
  'REDUCE',
  'CLOSE',
  'CANCEL',
] as const;
export const HedgeActionKindSchema = z.enum(HEDGE_ACTION_KINDS);
export type HedgeActionKind = z.output<typeof HedgeActionKindSchema>;
export const RISK_REDUCING_KINDS: ReadonlySet<HedgeActionKind> = new Set([
  'REDUCE',
  'CLOSE',
  'CANCEL',
]);
export const HedgeSideSchema = z.enum(['SHORT', 'LONG']);
export type HedgeSide = z.output<typeof HedgeSideSchema>;
export const HedgeTriggerSchema = z.enum([
  'SCHEDULED_REVIEW',
  'BRAIN_FLAG_EXCESSIVE_DOWNSIDE',
  'LIQUIDATION_BUFFER_BREACH',
  'OPERATOR_TEST',
]);

export const HedgeIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    intentId: IdSchema,
    groupId: GroupIdSchema,
    hedgeMandateId: IdSchema,
    hedgeMandateVersion: z.number().int().positive(),
    chainId: ChainIdSchema,
    venue: z.literal('perpl'),
    perplAccountId: AmountSchema,
    kind: HedgeActionKindSchema,
    side: HedgeSideSchema,
    marketId: z.number().int().positive(),
    base: BaseAssetSchema,
    size: AmountSchema,
    limitPrice: AmountSchema,
    leverageHundredths: z.number().int().min(0).max(10_000),
    notional: AmountSchema,
    collateral: AmountSchema,
    orderId: AmountSchema.optional(),
    postTradeHedgeRatioBps: z.number().int().min(0).max(1_000_000),
    postTradeLiquidationBufferBps: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable(),
    riskPacketHash: HashSchema,
    marketDataAt: TimestampSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    trigger: HedgeTriggerSchema,
  })
  .superRefine((v, ctx) => {
    const issue = (path: string[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (v.expiresAt <= v.createdAt) issue(['expiresAt'], 'expiry');
    if (v.kind === 'CANCEL') {
      if (v.orderId === undefined) issue(['orderId'], 'cancel needs orderId');
    } else if (BigInt(v.size) === 0n) issue(['size'], 'size must be positive');
    if (!RISK_REDUCING_KINDS.has(v.kind) && v.leverageHundredths < 100)
      issue(['leverageHundredths'], 'opening leverage must be at least 1x');
  });
export type HedgeIntent = z.output<typeof HedgeIntentSchema>;
