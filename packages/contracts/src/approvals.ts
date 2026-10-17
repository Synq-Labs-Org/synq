import { z } from 'zod';
import {
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
  expiresAt: TimestampSchema,
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

export const SigningRequestSchema = z.strictObject({
  request: ApprovalItemSchema,
  signer: AddressHintSchema.describe('The wallet that must sign'),
  enforcedBy: z
    .string()
    .max(120)
    .describe('Contract or service that enforces it'),
  typedData: TypedDataSchema,
});

export const SignatureSubmitSchema = z.strictObject({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const SignatureResultSchema = z.strictObject({
  status: z.enum(['RECORDED', 'READY', 'SUBMITTED', 'REJECTED']),
  approvals: z.number().int().min(0),
  threshold: z.number().int().positive(),
});
