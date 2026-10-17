import { z } from 'zod';
import {
  AddressSchema,
  AddressHintSchema,
  IdSchema,
  MoneySchema,
  TimestampSchema,
  pageOf,
} from './common.js';

/*
 * Approvals: everything waiting for the signed-in wallet's signature, across
 * workspaces. The client shows the exact typed data and signs it with the
 * user's own wallet; a login session, biometric unlock or notification tap
 * never counts as an approval.
 */

export const ApprovalPurposeSchema = z.enum([
  'VAULT_SETUP',
  'VAULT_ACTION',
  'PAYOUT',
  'FINANCE_CHANGE',
  'REVENUE_POLICY',
  'DEAL_TERMS',
  'ESCROW',
  'LEASE_ISSUE',
  'LEASE_REVOKE',
  'CIRCLE_REFUND',
  'COMMERCIAL_POLICY',
]);

export const ApprovalItemSchema = z.strictObject({
  requestId: IdSchema,
  workspaceId: IdSchema,
  workspaceName: z.string().max(80),
  purpose: ApprovalPurposeSchema,
  summary: z.string().max(300),
  amount: MoneySchema.nullable(),
  recipientHint: AddressHintSchema.nullable(),
  approvals: z.number().int().min(0),
  threshold: z.number().int().positive(),
  expiresAt: TimestampSchema.nullable().describe(
    'Null when the request does not expire',
  ),
});
export const ApprovalPageSchema = pageOf(ApprovalItemSchema);

/** EIP-712 payload exactly as the wallet must sign it (eth_signTypedData_v4 JSON). */
export const TypedDataSchema = z.strictObject({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(
    z.string(),
    z.array(z.strictObject({ name: z.string(), type: z.string() })),
  ),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

/** One signature the wallet must make; some approvals need two, in order. */
export const SigningStepSchema = z.strictObject({
  label: z.string().max(80),
  typedData: TypedDataSchema,
});

export const SigningRequestSchema = z.strictObject({
  request: ApprovalItemSchema,
  signer: AddressHintSchema.describe('The wallet that must sign (display)'),
  signerAddress: AddressSchema.describe(
    'Full address of the wallet that must sign; refuse to sign from any other',
  ),
  enforcedBy: z
    .string()
    .max(120)
    .describe('Contract or service that enforces it'),
  steps: z.array(SigningStepSchema).min(1).max(3),
});

/** One signature per step, in the same order as `steps`. */
export const SignatureSubmitSchema = z.strictObject({
  signatures: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{130}$/))
    .min(1)
    .max(3),
});
export const SignatureResultSchema = z.strictObject({
  status: z.enum(['RECORDED', 'READY', 'SUBMITTED', 'REJECTED']),
  approvals: z.number().int().min(0),
  threshold: z.number().int().positive(),
});

/**
 * Typed data exactly as a wallet should receive it: every integer inside
 * `message` (bigint or number) becomes a decimal string, so no client parses a
 * uint256 into a float. `domain.chainId` stays a number (always below 2^53).
 */
export function walletTypedData(data: unknown): Record<string, unknown> {
  const plain = JSON.parse(
    JSON.stringify(data, (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    ),
  ) as { message?: unknown; [k: string]: unknown };
  const strings = (v: unknown): unknown =>
    typeof v === 'number'
      ? String(v)
      : Array.isArray(v)
        ? v.map(strings)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, strings(x)]),
            )
          : v;
  return { ...plain, message: strings(plain.message) };
}
