import { z } from 'zod';
import { WalletSchema, WorkspaceIdSchema } from './contracts.js';
import { UnitsSchema } from './finance-contracts.js';

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const date = new Date(`${s}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s
    );
  });
export const DraftWorkspaceInvoiceSchema = z.strictObject({
  number: z.string().trim().min(1).max(80),
  payerName: z.string().trim().min(1).max(120),
  dueDate: Day,
  lineItems: z
    .array(
      z.strictObject({
        description: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(1_000_000),
        unitPrice: UnitsSchema.refine((v) => BigInt(v) > 0n),
      }),
    )
    .min(1)
    .max(30),
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  taxLabel: z.string().trim().min(1).max(80).nullable().default(null),
  memo: z.string().trim().max(300).default(''),
});

export const WorkspaceInvoiceViewSchema = z.strictObject({
  invoiceId: z.string().regex(/^inv_[0-9a-f]{20}$/),
  workspaceId: WorkspaceIdSchema,
  number: z.string(),
  version: z.number().int().positive(),
  status: z.enum([
    'DRAFT',
    'ISSUED',
    'PARTIALLY_PAID',
    'PAID',
    'OVERPAID',
    'VOID',
  ]),
  reconciliation: z.enum(['NOT_PAID', 'PENDING', 'FINALIZED', 'REVIEW']),
  issuer: z.strictObject({
    principalId: z.string(),
    name: z.string(),
    wallet: WalletSchema,
    payoutAddress: WalletSchema,
  }),
  payer: z.strictObject({ name: z.string() }),
  asset: z.strictObject({
    assetId: z.string(),
    network: z.literal('eip155:5042002'),
    chainId: z.literal(5042002),
    address: WalletSchema,
    symbol: z.literal('USDC'),
    canonical: z.literal('USDC'),
    decimals: z.literal(6),
    environment: z.literal('ARC_TESTNET'),
  }),
  lineItems: z.array(
    z.strictObject({
      description: z.string(),
      quantity: z.number().int().positive(),
      unitPrice: UnitsSchema,
    }),
  ),
  taxLabel: z.string().nullable(),
  taxRateBps: z.number().int(),
  total: UnitsSchema,
  subtotal: UnitsSchema,
  tax: UnitsSchema,
  paid: UnitsSchema,
  amountDue: UnitsSchema,
  dueDate: Day,
  memo: z.string(),
  termsHash: z.string().nullable(),
  paymentRef: z.string().nullable(),
  checkoutPath: z
    .string()
    .regex(/^\/pay\/[a-zA-Z0-9_.-]+$/)
    .nullable(),
});
