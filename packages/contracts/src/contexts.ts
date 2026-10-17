import { z } from 'zod';
import {
  AddressHintSchema,
  AddressSchema,
  BalanceSchema,
  CapabilitySchema,
  FreshnessSchema,
  IdSchema,
  MoneySchema,
  RoleSchema,
  TimestampSchema,
  TxHashSchema,
  UnitsSchema,
  WorkspaceKindSchema,
  WorkspaceStatusSchema,
  pageOf,
} from './common.js';

/*
 * Contexts: one signed-in principal sees a Personal context (own wallets,
 * personal vaults and the group circles they belong to) and one context per
 * business workspace. Switching context must clear the previous context's
 * cached data on the client.
 */

export const ContextSchema = z.strictObject({
  contextId: z
    .string()
    .max(64)
    .describe('"personal" or a business workspace id'),
  kind: z.enum(['PERSONAL', 'BUSINESS']),
  workspaceId: IdSchema.nullable(),
  displayName: z.string().max(80),
  role: RoleSchema.nullable(),
  workspaceStatus: WorkspaceStatusSchema.nullable(),
  unreadCount: z.number().int().min(0),
});

export const ContextsSchema = z.strictObject({
  principalId: z.string().max(80),
  walletHint: AddressHintSchema,
  contexts: z.array(ContextSchema),
});

// MARK: Personal

export const WalletBalanceSchema = z.strictObject({
  address: AddressSchema,
  label: z.string().max(40),
  balances: z.array(BalanceSchema),
  freshness: FreshnessSchema,
});

export const CircleSummarySchema = z.strictObject({
  circleId: IdSchema.describe('The group workspace id'),
  displayName: z.string().max(80),
  status: WorkspaceStatusSchema,
  role: RoleSchema,
  memberCount: z.number().int().min(0),
  threshold: z.number().int().positive().nullable(),
  vault: AddressSchema.nullable(),
  myContribution: MoneySchema.nullable(),
  held: BalanceSchema.nullable(),
  openProposals: z.number().int().min(0),
  freshness: FreshnessSchema,
});

export const PersonalVaultSchema = z.strictObject({
  workspaceId: IdSchema,
  displayName: z.string().max(80),
  kind: WorkspaceKindSchema,
  status: WorkspaceStatusSchema,
  vault: AddressSchema.nullable(),
  balances: z.array(BalanceSchema),
});

export const ActivityItemSchema = z.strictObject({
  activityId: z.string().max(80),
  kind: z.enum([
    'CONTRIBUTION',
    'REFUND',
    'PAYMENT',
    'PROPOSAL',
    'INVOICE_PAID',
    'DEAL',
    'OTHER',
  ]),
  title: z.string().max(140),
  workspaceId: IdSchema.nullable(),
  amount: MoneySchema.nullable(),
  status: z.enum(['PENDING', 'FINAL', 'FAILED', 'REFUNDED']),
  txHash: TxHashSchema.nullable(),
  occurredAt: TimestampSchema,
});

export const PersonalOverviewSchema = z.strictObject({
  principalId: z.string().max(80),
  wallets: z.array(WalletBalanceSchema),
  circles: z.array(CircleSummarySchema),
  vaults: z.array(PersonalVaultSchema),
  recent: z.array(ActivityItemSchema),
});

export const CirclePageSchema = pageOf(CircleSummarySchema);

export const CircleMemberSchema = z.strictObject({
  principalId: z.string().max(80),
  walletHint: AddressHintSchema,
  role: RoleSchema,
  contributed: UnitsSchema,
  refunded: UnitsSchema,
});

export const CircleContributionSchema = z.strictObject({
  contributionId: z.string().max(80),
  payerHint: AddressHintSchema,
  amount: MoneySchema,
  status: z.enum(['REQUESTED', 'PENDING', 'CREDITED', 'REFUNDED', 'EXPIRED']),
  txHash: TxHashSchema.nullable(),
  observedAt: TimestampSchema,
});

export const CircleProposalSchema = z.strictObject({
  proposalId: z.string().max(80),
  kind: z.enum(['PAYMENT', 'REFUND', 'SETTINGS', 'OTHER']),
  title: z.string().max(140),
  amount: MoneySchema.nullable(),
  recipientHint: AddressHintSchema.nullable(),
  approvals: z.number().int().min(0),
  threshold: z.number().int().positive(),
  status: z.enum([
    'REVIEW',
    'READY',
    'SUBMITTED',
    'CONFIRMED',
    'FAILED',
    'NEEDS_REVIEW',
    'CANCELLED',
    'EXPIRED',
  ]),
  txHash: TxHashSchema.nullable(),
});

export const CircleDetailSchema = z.strictObject({
  circle: CircleSummarySchema,
  members: z.array(CircleMemberSchema),
  contributions: z.array(CircleContributionSchema),
  proposals: z.array(CircleProposalSchema),
  capabilities: z.record(z.string(), CapabilitySchema),
});
