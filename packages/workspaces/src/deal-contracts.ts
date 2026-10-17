import { z } from 'zod';
import { WalletSchema, WorkspaceIdSchema } from './contracts.js';
import { UnitsSchema } from './finance-contracts.js';
export const DraftWorkspaceDealSchema = z.strictObject({
  clientId: z.string().min(1).max(200),
  freelancerId: z.string().min(1).max(200),
  arbiterId: z.string().min(1).max(200),
  request: z.string().trim().min(10).max(4000),
  idempotencyKey: z.uuid(),
});
export const WorkspaceDealViewSchema = z.strictObject({
  id: z.string().regex(/^deal_[0-9a-f]{16,32}$/),
  workspaceId: WorkspaceIdSchema,
  status: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  total: UnitsSchema,
  termsHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  parties: z
    .array(
      z.strictObject({
        principalId: z.string(),
        role: z.enum(['CLIENT', 'FREELANCER', 'ARBITER']),
        wallet: WalletSchema,
        label: z.string(),
      }),
    )
    .length(3),
  reviewPath: z
    .string()
    .regex(/^\/deal\/deal_[0-9a-f]{16,32}\?t=[A-Za-z0-9_.-]+$/),
  execution: z.literal('PARTY_WALLET_ESCROW'),
  escrow: z
    .strictObject({ address: WalletSchema, escrowDealId: z.string() })
    .nullable(),
  milestones: z.array(
    z.strictObject({
      index: z.number().int(),
      title: z.string(),
      amount: UnitsSchema,
      evidenceType: z.string().nullable(),
      status: z.string(),
    }),
  ),
  dispute: z
    .strictObject({
      raisedBy: z.enum(['CLIENT', 'FREELANCER']),
      deadline: z.number(),
    })
    .nullable(),
});
export const WorkspaceDealContactSchema = z.strictObject({
  principalId: z.string(),
  walletHint: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']),
});
