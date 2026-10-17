import { z } from 'zod';
import { AddressSchema, HashSchema, IdSchema } from './common.js';

/*
 * Amane-enforced agent payments: an owner registers an Amane account they
 * control (one recipient, one token, owner-signed policy) and a lease to
 * Synq's agent, then creates contractor jobs the agent pays inside the lease.
 * Registration only records what the chain already enforces.
 */

export const AmaneAccountRegisterSchema = z.strictObject({
  account: AddressSchema,
  vendorId: IdSchema.nullable().optional(),
});
export const AmaneAccountSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  chainId: z.number().int(),
  account: AddressSchema,
  codeHash: HashSchema,
  token: AddressSchema,
  recipient: AddressSchema,
  adapterId: HashSchema,
  rootHash: HashSchema,
  root: z.record(z.string(), z.string()),
});
export const AmaneLeaseRegisterSchema = z.strictObject({
  accountId: IdSchema,
  leaseId: HashSchema,
});
export const AmaneLeaseRegisteredSchema = z.strictObject({
  leaseId: HashSchema,
  accountId: IdSchema,
});
export const AmaneJobCreateSchema = z.strictObject({
  leaseId: HashSchema,
  triggerKind: z.enum(['INVOICE_PAID', 'OWNER_REQUEST']),
  triggerRef: z.string().min(1).max(80),
  amount: z.string().regex(/^[1-9][0-9]{0,30}$/),
  purpose: z.string().trim().min(1).max(160),
});
export const AmaneJobSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  accountId: IdSchema,
  leaseId: HashSchema,
  triggerKind: z.enum(['INVOICE_PAID', 'OWNER_REQUEST']),
  triggerRef: z.string(),
  amount: z.string(),
  purpose: z.string(),
  state: z.enum([
    'WAITING',
    'READY',
    'SENT',
    'PAID',
    'REFUSED',
    'NEEDS_REVIEW',
  ]),
  nonce: z.string().nullable(),
  txHash: z.string().nullable(),
  reason: z.string().nullable(),
});
export const AmaneJobListSchema = z.strictObject({
  jobs: z.array(AmaneJobSchema),
});
