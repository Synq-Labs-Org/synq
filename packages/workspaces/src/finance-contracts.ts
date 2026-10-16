import { hashTypedData, type Hex } from 'viem';
import { z } from 'zod';
import { WalletSchema, WorkspaceIdSchema } from './contracts.js';
import type { PaymentIntent, PaymentMandate } from '@synq/kernel/arc';

export const UnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const VendorEditSchema = z.strictObject({
  kind: z.literal('VENDOR'),
  vendorId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  address: WalletSchema,
  verification: z.literal('OWNER_ATTESTATION'),
});
export const BudgetEditSchema = z
  .strictObject({
    kind: z.literal('BUDGET'),
    perPayment: UnitsSchema.refine((v) => BigInt(v) > 0n),
    daily: UnitsSchema.refine((v) => BigInt(v) > 0n),
    reserve: UnitsSchema,
    aiDaily: UnitsSchema,
  })
  .superRefine((v, ctx) => {
    if (
      BigInt(v.perPayment) > BigInt(v.daily) ||
      BigInt(v.aiDaily) > BigInt(v.daily)
    )
      ctx.addIssue({ code: 'custom', message: 'limit exceeds daily budget' });
  });
export const FinanceEditSchema = z.discriminatedUnion('kind', [
  VendorEditSchema,
  BudgetEditSchema,
  z.strictObject({
    kind: z.literal('REVOKE_BUDGET'),
    reason: z.string().trim().min(1).max(160),
  }),
]);
export const FinanceChangeSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  vault: WalletSchema,
  chainId: z.literal(5042002),
  token: WalletSchema,
  revision: z.number().int().nonnegative(),
  nonce: z.string().uuid(),
  expiresAt: z.number().int().positive().safe(),
  edit: FinanceEditSchema,
});
export type FinanceChange = z.output<typeof FinanceChangeSchema>;
export type FinanceEdit = z.output<typeof FinanceEditSchema>;
export function financeChangeTypedData(c: FinanceChange) {
  // A fixed tuple binds every editable field without JSON key-order ambiguity.
  const e = c.edit;
  return {
    domain: {
      name: 'Synq Workspace Finance',
      version: '1',
      chainId: c.chainId,
      verifyingContract: c.vault,
    },
    primaryType: 'FinanceChange' as const,
    types: {
      FinanceChange: [
        { name: 'workspaceId', type: 'string' },
        { name: 'token', type: 'address' },
        { name: 'revision', type: 'uint256' },
        { name: 'nonce', type: 'string' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'kind', type: 'string' },
        { name: 'terms', type: 'string[]' },
      ],
    },
    message: {
      workspaceId: c.workspaceId,
      token: c.token,
      revision: BigInt(c.revision),
      nonce: c.nonce,
      expiresAt: BigInt(c.expiresAt),
      kind: e.kind,
      terms:
        e.kind === 'VENDOR'
          ? [e.vendorId, e.name, e.address, e.verification]
          : e.kind === 'BUDGET'
            ? [e.perPayment, e.daily, e.reserve, e.aiDaily]
            : [e.reason],
    },
  };
}
export const financeChangeHash = (c: FinanceChange) =>
  hashTypedData(financeChangeTypedData(c));
export const FinanceChangeViewSchema = z.strictObject({
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  change: FinanceChangeSchema,
  signedBy: z.array(WalletSchema),
  state: z.enum(['PENDING', 'APPLIED']),
  typedData: z.unknown(),
});
export const FinanceViewSchema = z.strictObject({
  vendors: z.array(
    z.strictObject({
      id: z.string().uuid(),
      name: z.string(),
      address: WalletSchema,
      verifiedAt: z.number(),
      eligibleAt: z.number(),
      status: z.enum(['COOLING', 'VERIFIED']),
    }),
  ),
  budget: BudgetEditSchema.nullable(),
  pending: z.array(
    z.strictObject({ hash: z.string(), change: FinanceChangeSchema }),
  ),
});
export const PayoutRequestSchema = z.strictObject({
  vendorId: z.string().uuid(),
  amount: UnitsSchema.refine((v) => BigInt(v) > 0n),
  purpose: z.string().trim().min(1).max(160),
  obligation: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().uuid(),
});
export const PayoutDataSchema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: WorkspaceIdSchema,
  vendorId: z.string().uuid(),
  recipient: WalletSchema,
  amount: UnitsSchema,
  purpose: z.string().min(1).max(160),
  obligation: z.string().min(1).max(120),
  vendorChangeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  budgetChangeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  budget: BudgetEditSchema,
  primaryOwner: WalletSchema,
  token: WalletSchema,
  vault: WalletSchema,
  proposedBy: z.string(),
  approval: z.strictObject({
    nonce: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .transform((v) => v as Hex),
    deadline: z.number().int().safe(),
  }),
  createdAt: z.number().int().safe(),
});
export type PayoutData = z.output<typeof PayoutDataSchema>;
export function payoutMandate(p: PayoutData): PaymentMandate {
  return {
    mandateId: `workspace-payout:${p.id}`,
    version: 1,
    workspaceId: p.workspaceId,
    owner: p.primaryOwner,
    chainId: 5042002,
    token: p.token,
    payer: p.vault,
    recipients: [p.recipient],
    purposes: ['CONTRACTOR_PAYOUT'],
    perActionCap: BigInt(p.budget.perPayment),
    periodBudget: BigInt(p.budget.daily),
    periodSeconds: 86400,
    validFrom: p.createdAt,
    validUntil: p.approval.deadline,
  };
}
export function payoutIntent(p: PayoutData): PaymentIntent {
  return {
    intentId: `workspace-payout:${p.id}`,
    mandateId: `workspace-payout:${p.id}`,
    mandateVersion: 1,
    chainId: 5042002,
    token: p.token,
    payer: p.vault,
    recipient: p.recipient,
    amount: BigInt(p.amount),
    purpose: 'CONTRACTOR_PAYOUT',
    obligationRef: p.obligation,
    evidenceHash: p.vendorChangeHash as `0x${string}`,
    proposedBy: p.proposedBy,
  };
}
export const PayoutViewSchema = z.strictObject({
  data: PayoutDataSchema,
  state: z.enum([
    'REVIEW',
    'READY',
    'HOLD',
    'SIGNED',
    'PAID',
    'FAILED',
    'NEEDS_REVIEW',
    'CANCELLED',
  ]),
  signedBy: z.array(WalletSchema),
  mandateSigned: z.boolean(),
  reason: z.string().nullable(),
  txHash: z.string().nullable(),
});
