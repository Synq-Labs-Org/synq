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
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'invalid date');
const Positive = UnitsSchema.refine((v) => BigInt(v) > 0n, 'must be positive');
/** A vendor invoice the workspace owes; quorum-signed because a split may pay it. */
export const PayableEditSchema = z
  .strictObject({
    kind: z.literal('PAYABLE'),
    payableId: z.string().uuid(),
    vendorId: z.string().uuid(),
    number: z.string().trim().min(1).max(40),
    amount: Positive,
    issuedOn: IsoDate,
    dueOn: IsoDate,
    reference: z.string().trim().min(1).max(80).nullable(),
    documentText: z.string().trim().min(1).max(2000),
  })
  .refine((v) => v.dueOn >= v.issuedOn, 'due date before issue date');
export const ObligationEditSchema = z.strictObject({
  kind: z.literal('OBLIGATION'),
  reference: z.string().trim().min(1).max(80),
  vendorId: z.string().uuid(),
  approvedAmount: Positive,
  status: z.enum(['APPROVED', 'DELIVERED', 'ACCEPTED', 'DISPUTED']),
});
export const BillEditSchema = z.strictObject({
  kind: z.literal('BILL'),
  billId: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
  billKind: z.enum(['BILL', 'PAYROLL', 'RENT', 'SUBSCRIPTION']),
  amount: Positive,
  nextDueOn: IsoDate,
  cadenceDays: z.number().int().min(1).max(366),
});
export const FinanceEditSchema = z.discriminatedUnion('kind', [
  VendorEditSchema,
  BudgetEditSchema,
  z.strictObject({
    kind: z.literal('REVOKE_BUDGET'),
    reason: z.string().trim().min(1).max(160),
  }),
  PayableEditSchema,
  z.strictObject({
    kind: z.literal('CLOSE_PAYABLE'),
    payableId: z.string().uuid(),
    status: z.enum(['PAID_ELSEWHERE', 'VOID']),
    reason: z.string().trim().min(1).max(160),
  }),
  ObligationEditSchema,
  BillEditSchema,
  z.strictObject({
    kind: z.literal('REMOVE_BILL'),
    billId: z.string().uuid(),
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
      terms: financeTerms(e),
    },
  };
}
/** Every field of an edit, in a fixed order, as the signed `terms` tuple. */
export function financeTerms(e: FinanceEdit): string[] {
  switch (e.kind) {
    case 'VENDOR':
      return [e.vendorId, e.name, e.address, e.verification];
    case 'BUDGET':
      return [e.perPayment, e.daily, e.reserve, e.aiDaily];
    case 'REVOKE_BUDGET':
      return [e.reason];
    case 'PAYABLE':
      return [
        e.payableId,
        e.vendorId,
        e.number,
        e.amount,
        e.issuedOn,
        e.dueOn,
        e.reference ?? '',
        e.documentText,
      ];
    case 'CLOSE_PAYABLE':
      return [e.payableId, e.status, e.reason];
    case 'OBLIGATION':
      return [e.reference, e.vendorId, e.approvedAmount, e.status];
    case 'BILL':
      return [
        e.billId,
        e.label,
        e.billKind,
        e.amount,
        e.nextDueOn,
        String(e.cadenceDays),
      ];
    case 'REMOVE_BILL':
      return [e.billId, e.reason];
  }
}
const usdc = (v: string) => {
  const n = BigInt(v),
    whole = n / 1_000_000n,
    frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} USDC`;
};
/** Exact plain-language summary of an edit, shown to owners before they sign. */
export function describeFinanceEdit(e: FinanceEdit): string {
  switch (e.kind) {
    case 'VENDOR':
      return `Verify vendor ${e.name} at ${e.address}. A changed address waits at least 24 hours.`;
    case 'BUDGET':
      return `Budget: ${usdc(e.perPayment)} per payment, ${usdc(e.daily)} per day, ${usdc(e.reserve)} reserve, ${usdc(e.aiDaily)} AI daily.`;
    case 'REVOKE_BUDGET':
      return `Revoke the budget: ${e.reason}. Payments already signed by the worker still reconcile.`;
    case 'PAYABLE':
      return `Record vendor bill ${e.number} for ${usdc(e.amount)}, issued ${e.issuedOn}, due ${e.dueOn}${e.reference ? `, against ${e.reference}` : ', with no PO or milestone'}. Automatic splits may pay it to the vendor's verified address.`;
    case 'CLOSE_PAYABLE':
      return `Close bill ${e.payableId} as ${e.status === 'VOID' ? 'void' : 'paid elsewhere'}: ${e.reason}.`;
    case 'OBLIGATION':
      return `Milestone ${e.reference}: approved up to ${usdc(e.approvedAmount)}, status ${e.status.toLowerCase()}. Only accepted milestones release matching bills.`;
    case 'BILL':
      return `Recurring ${e.billKind.toLowerCase()} "${e.label}": ${usdc(e.amount)} every ${e.cadenceDays} days from ${e.nextDueOn}. Splits hold for it before distributing.`;
    case 'REMOVE_BILL':
      return `Stop recurring bill ${e.billId}: ${e.reason}.`;
  }
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
  /** VAULT_POLICY: operator pays within on-chain caps. SAFE_QUORUM: above the signed per-payment budget, the full Safe quorum signs a direct transfer. */
  route: z.enum(['VAULT_POLICY', 'SAFE_QUORUM']).default('VAULT_POLICY'),
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

export const BooksViewSchema = z.strictObject({
  payables: z.array(
    z.strictObject({
      id: z.string().uuid(),
      vendorId: z.string().uuid(),
      number: z.string(),
      amount: UnitsSchema,
      issuedOn: z.string(),
      dueOn: z.string(),
      reference: z.string().nullable(),
      payTo: WalletSchema,
      status: z.enum(['OPEN', 'PAID_ELSEWHERE', 'VOID', 'PAID']),
    }),
  ),
  obligations: z.array(
    z.strictObject({
      reference: z.string(),
      vendorId: z.string().uuid(),
      approvedAmount: UnitsSchema,
      status: z.enum(['APPROVED', 'DELIVERED', 'ACCEPTED', 'DISPUTED', 'PAID']),
    }),
  ),
  bills: z.array(
    z.strictObject({
      id: z.string().uuid(),
      label: z.string(),
      billKind: z.enum(['BILL', 'PAYROLL', 'RENT', 'SUBSCRIPTION']),
      amount: UnitsSchema,
      nextDueOn: z.string(),
      cadenceDays: z.number().int(),
    }),
  ),
});
export type BooksView = z.output<typeof BooksViewSchema>;
