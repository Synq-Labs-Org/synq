import { z } from 'zod';
import {
  AddressSchema,
  HashSchema,
  IdSchema,
  MoneySchema,
  ProofLevelSchema,
  TimestampSchema,
  TxHashSchema,
} from './common.js';
import { TypedDataSchema } from './approvals.js';

/*
 * Deal agreements with outside clients. After a client accepts an offer in
 * chat, the business owner and the client each sign the exact accepted terms
 * with their own wallet, then the client funds the milestone escrow from
 * their own wallet. The client is the lead's bound identity, never a
 * workspace member. A chat message or Telegram identity is never a signature.
 */

export const AgreementStatusSchema = z.enum([
  'PENDING_SIGNATURES',
  'SIGNED',
  'FUNDING_PENDING',
  'FUNDED',
  'VOID',
  'EXPIRED',
]);

export const ClientWalletTypedDataSchema = z.strictObject({
  expiresAt: TimestampSchema,
  typedData: TypedDataSchema,
});
export const ClientWalletLinkSchema = z.strictObject({
  wallet: AddressSchema,
  expiresAt: TimestampSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const ClientWalletSchema = z.strictObject({
  wallet: AddressSchema,
  linkedAt: TimestampSchema,
});

export const AgreementMilestoneSchema = z.strictObject({
  label: z.string().max(120),
  amount: MoneySchema,
  dueInDays: z.number().int().min(0),
});
export const AgreementSignatureSchema = z.strictObject({
  wallet: AddressSchema,
  signedAt: TimestampSchema,
});
export const AgreementEscrowSchema = z.strictObject({
  state: z.enum(['PREPARED', 'PENDING_CONFIRMATION', 'FUNDED']),
  openTxHash: TxHashSchema.nullable(),
  escrowDealId: z.string().nullable(),
  proofLevel: ProofLevelSchema,
});
export const AgreementSchema = z.strictObject({
  agreementId: IdSchema,
  workspaceId: IdSchema,
  leadId: IdSchema,
  offerId: IdSchema,
  offerVersion: z.number().int().positive(),
  termsHash: HashSchema,
  agreementHash: HashSchema,
  status: AgreementStatusSchema,
  clientWallet: AddressSchema,
  ownerWallet: AddressSchema,
  payee: AddressSchema,
  arbiter: AddressSchema.nullable(),
  total: MoneySchema,
  milestones: z.array(AgreementMilestoneSchema),
  expiresAt: TimestampSchema,
  signatures: z.strictObject({
    client: AgreementSignatureSchema.nullable(),
    owner: AgreementSignatureSchema.nullable(),
  }),
  typedData: TypedDataSchema,
  escrow: AgreementEscrowSchema.nullable(),
});
export const LeadAgreementSchema = z.strictObject({
  clientWallet: AddressSchema.nullable(),
  agreement: AgreementSchema.nullable(),
  blocked: z
    .string()
    .max(200)
    .nullable()
    .describe('Why no agreement exists yet, when none does'),
});
export const AgreementSignatureSubmitSchema = z.strictObject({
  agreementId: IdSchema,
  offerVersion: z.number().int().positive(),
  termsHash: HashSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export const EscrowTransactionSchema = z.strictObject({
  step: z.enum(['APPROVE', 'OPEN']),
  label: z.string().max(120),
  to: AddressSchema,
  data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
  value: z.literal('0'),
});
export const EscrowCallSchema = z.strictObject({
  agreementId: IdSchema,
  chainId: z.number().int(),
  from: AddressSchema,
  transactions: z.array(EscrowTransactionSchema),
  refundAfter: TimestampSchema,
});
export const EscrowFundingSubmitSchema = z.strictObject({
  openTxHash: TxHashSchema,
});
