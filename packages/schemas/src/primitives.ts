import { isAddress } from 'viem';
import { z } from 'zod';

export const UINT256_MAX = (1n << 256n) - 1n;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
export function canonicalBigInt(value: string): bigint | null {
  return value.length <= 78 && CANONICAL_DECIMAL.test(value)
    ? BigInt(value)
    : null;
}
const decimalString = z
  .string()
  .max(78)
  .regex(CANONICAL_DECIMAL, 'canonical unsigned decimal string required')
  .refine((v) => {
    const n = canonicalBigInt(v);
    return n !== null && n <= UINT256_MAX;
  }, 'uint256 overflow');
export const AmountSchema = z.union([
  decimalString,
  z
    .bigint()
    .nonnegative()
    .max(UINT256_MAX, 'uint256 overflow')
    .transform((v) => v.toString()),
]);
export const PositiveAmountSchema = AmountSchema.refine(
  (v) => (canonicalBigInt(v) ?? 0n) > 0n,
  'amount must be positive',
);
export type Amount = z.output<typeof AmountSchema>;

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be 20-byte hex')
  .refine(
    (v) => v === v.toLowerCase() || isAddress(v, { strict: true }),
    'mixed-case address fails EIP-55 checksum',
  )
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const NonZeroAddressSchema = AddressSchema.refine(
  (v) => !/^0x0{40}$/.test(v),
  'zero address is not a valid target',
);
export const HashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const SelectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const SignatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/)
  .transform((v) => v as `0x${string}`);
export const TimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const BpsSchema = z.number().int().min(0).max(10_000);

export const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const GroupIdSchema = IdSchema.brand<'GroupId'>();
export const MandateIdSchema = IdSchema.brand<'MandateId'>();
export const IntentIdSchema = IdSchema.brand<'IntentId'>();
export const ProposalIdSchema = IdSchema.brand<'ProposalId'>();
export const PluginIdSchema = IdSchema.brand<'PluginId'>();
export const MemberIdSchema = IdSchema.brand<'MemberId'>();
export const PrincipalIdSchema = IdSchema.brand<'PrincipalId'>();
export const EventIdSchema = IdSchema.brand<'EventId'>();
export const CorrelationIdSchema = IdSchema.brand<'CorrelationId'>();
export const SourceIdSchema = z
  .string()
  .regex(/^(S[0-9]{3}|SYNQ-[0-9]{3})$/)
  .brand<'SourceId'>();
export type GroupId = z.output<typeof GroupIdSchema>;
export type MandateId = z.output<typeof MandateIdSchema>;
export type IntentId = z.output<typeof IntentIdSchema>;
export type ProposalId = z.output<typeof ProposalIdSchema>;
export type PluginId = z.output<typeof PluginIdSchema>;
export type MemberId = z.output<typeof MemberIdSchema>;
export type PrincipalId = z.output<typeof PrincipalIdSchema>;
export type EventId = z.output<typeof EventIdSchema>;
export type CorrelationId = z.output<typeof CorrelationIdSchema>;
export type SourceId = z.output<typeof SourceIdSchema>;
export const ID_SCHEMAS = {
  group: GroupIdSchema,
  mandate: MandateIdSchema,
  intent: IntentIdSchema,
  proposal: ProposalIdSchema,
  plugin: PluginIdSchema,
  member: MemberIdSchema,
  principal: PrincipalIdSchema,
  event: EventIdSchema,
  correlation: CorrelationIdSchema,
} as const;
export type IdKind = keyof typeof ID_SCHEMAS;
export type IdOf<K extends IdKind> = z.output<(typeof ID_SCHEMAS)[K]>;
