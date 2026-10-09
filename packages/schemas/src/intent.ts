import { z } from 'zod';
import { ChainIdSchema } from './network.js';
import {
  AddressSchema,
  AmountSchema,
  BpsSchema,
  GroupIdSchema,
  HashSchema,
  IntentIdSchema,
  MandateIdSchema,
  NonZeroAddressSchema,
  PluginIdSchema,
  PositiveAmountSchema,
  SelectorSchema,
  TimestampSchema,
} from './primitives.js';

export const ONCHAIN_ACTION_KINDS = [
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CROSS_CHAIN_FUND',
  'SUBSCRIPTION',
  'CONVERSION',
] as const;
export const PROVIDER_ACTION_KINDS = ['CARD_PAYMENT', 'X402_PAYMENT'] as const;
export const ACTION_KINDS = [
  ...ONCHAIN_ACTION_KINDS,
  ...PROVIDER_ACTION_KINDS,
] as const;
export const OnchainActionKindSchema = z.enum(ONCHAIN_ACTION_KINDS);
export const ProviderActionKindSchema = z.enum(PROVIDER_ACTION_KINDS);
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.output<typeof ActionKindSchema>;

export const ProviderRefSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9._~:/-]{1,200}$/,
    'provider reference must be <provider>:<reference>',
  )
  .brand<'ProviderRef'>();
export type ProviderRef = z.output<typeof ProviderRefSchema>;

export const ACTION_INTENT_SCHEMA_VERSION = 1;
const intentFields = {
  schemaVersion: z.literal(ACTION_INTENT_SCHEMA_VERSION).default(1),
  intentId: IntentIdSchema,
  groupId: GroupIdSchema,
  mandateId: MandateIdSchema,
  mandateVersion: z.number().int().positive(),
  chainId: ChainIdSchema,
  pluginId: PluginIdSchema,
  selector: SelectorSchema.optional(),
  calldataHash: HashSchema.optional(),
  inputToken: AddressSchema.optional(),
  maxInputAmount: PositiveAmountSchema.optional(),
  outputToken: AddressSchema.optional(),
  minOutputAmount: AmountSchema.optional(),
  validAfter: TimestampSchema,
  validUntil: TimestampSchema,
  nonce: AmountSchema,
  evidenceHash: HashSchema,
  riskPacketHash: HashSchema,
  account: AddressSchema.optional(),
  operator: AddressSchema.optional(),
  nativeValue: AmountSchema.default('0'),
  maxSlippageBps: BpsSchema.default(0),
  leverageBps: z.number().int().min(0).max(1_000_000).default(0),
};
type EnvelopeView = {
  validAfter: number;
  validUntil: number;
  outputToken?: string | undefined;
  minOutputAmount?: string | undefined;
  selector?: string | undefined;
  calldataHash?: string | undefined;
};
function checkEnvelope(v: EnvelopeView, ctx: z.core.$RefinementCtx): void {
  if (v.validUntil <= v.validAfter)
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: 'validUntil must be after validAfter',
    });
  if (
    v.outputToken === undefined &&
    v.minOutputAmount !== undefined &&
    v.minOutputAmount !== '0'
  )
    ctx.addIssue({
      code: 'custom',
      path: ['minOutputAmount'],
      message: 'minOutputAmount requires outputToken',
    });
  if ((v.selector === undefined) !== (v.calldataHash === undefined))
    ctx.addIssue({
      code: 'custom',
      path: ['calldataHash'],
      message: 'selector and calldataHash are bound together',
    });
}
export const OnchainActionIntentSchema = z.strictObject({
  ...intentFields,
  action: OnchainActionKindSchema,
  target: AddressSchema,
});
export const ProviderActionIntentSchema = z.strictObject({
  ...intentFields,
  action: ProviderActionKindSchema,
  target: z.union([AddressSchema, ProviderRefSchema]),
});
export const ActionIntentSchema = z
  .discriminatedUnion('action', [
    OnchainActionIntentSchema,
    ProviderActionIntentSchema,
  ])
  .superRefine(checkEnvelope);
export type ActionIntent = z.output<typeof ActionIntentSchema>;
export type ActionIntentInput = z.input<typeof ActionIntentSchema>;

export const BoundActionIntentSchema = z
  .strictObject({
    ...intentFields,
    action: ActionKindSchema,
    target: NonZeroAddressSchema,
    selector: SelectorSchema,
    calldataHash: HashSchema,
    inputToken: AddressSchema,
    maxInputAmount: PositiveAmountSchema,
    minOutputAmount: AmountSchema.default('0'),
    account: AddressSchema,
    operator: AddressSchema,
  })
  .superRefine(checkEnvelope);
export type BoundActionIntent = z.output<typeof BoundActionIntentSchema>;
export type BoundActionIntentInput = z.input<typeof BoundActionIntentSchema>;
