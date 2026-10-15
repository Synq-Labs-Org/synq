import { z } from 'zod';
import { PAYMENT_PURPOSES } from '@synq/kernel/arc';
import { PROVENANCES, FIELD_FRESHNESS } from '@synq/schemas';

/**
 * Typed agent outputs. Everything a specialist hands upward is one of these;
 * the Supervisor merges them and the Kernel turns PAYMENT proposals into
 * decisions. Model drafts are separate schemas and are re-validated against
 * deterministic facts before they can shape a proposal.
 */

const BaseUnits = z.string().regex(/^\d{1,30}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CitationSchema = z.strictObject({
  path: z.string().min(1).max(120),
  provenance: z.enum(PROVENANCES),
  source: z.string().min(1).max(128),
  observedAt: z.number().int().nullable(),
  freshness: z.enum(FIELD_FRESHNESS),
  ageSeconds: z.number().int().nullable(),
});
export type Citation = z.output<typeof CitationSchema>;

export const RiskFlagSchema = z.strictObject({
  code: z.string().min(1).max(64),
  severity: z.enum(['HARD', 'SOFT']),
  detail: z.string().max(400),
});

export const InvoiceDraftProposalSchema = z.strictObject({
  kind: z.literal('INVOICE_DRAFT'),
  invoiceId: z.string().min(1),
  number: z.string().min(1).max(40),
  payer: z.string().min(1).max(120),
  asset: z.enum(['USDC', 'EURC']),
  totalBaseUnits: BaseUnits,
  dueDate: Day,
  draftedBy: z.string().min(1),
  status: z.literal('DRAFT'),
});
export type InvoiceDraftProposal = z.output<typeof InvoiceDraftProposalSchema>;

export const IssuanceRequestSchema = z.strictObject({
  kind: z.literal('ISSUANCE_REQUEST'),
  invoiceId: z.string().min(1),
  signer: Address,
  primaryType: z.literal('IssueInvoice'),
  chainId: z.number().int().positive(),
  note: z.string().max(300),
});
export type IssuanceRequest = z.output<typeof IssuanceRequestSchema>;

export const PaymentProposalSchema = z.strictObject({
  kind: z.literal('PAYMENT'),
  intentId: z.string().min(1),
  vendorInvoiceId: z.string().min(1),
  vendorId: z.string().min(1),
  recipient: Address,
  verifiedRecipient: Address.nullable(),
  amountBaseUnits: BaseUnits,
  purpose: z.enum(PAYMENT_PURPOSES),
  obligationRef: z.string().min(1),
  proposedBy: z.string().min(1),
  draftSource: z.enum(['DETERMINISTIC', 'MODEL_DRAFT']),
});
export type PaymentProposal = z.output<typeof PaymentProposalSchema>;

export const ReallocationProposalSchema = z.strictObject({
  kind: z.literal('REALLOCATION'),
  from: z.enum(['GATEWAY_UNIFIED_BALANCE']),
  to: z.literal('ARC_TREASURY'),
  amountBaseUnits: BaseUnits,
  capBaseUnits: BaseUnits,
  reason: z.string().max(300),
  requiresOwnerApproval: z.literal(true),
});
export type ReallocationProposal = z.output<typeof ReallocationProposalSchema>;

export const TimingRecommendationSchema = z.strictObject({
  kind: z.literal('TIMING_RECOMMENDATION'),
  vendorInvoiceId: z.string().min(1),
  action: z.enum(['PAY_EARLY', 'PAY_ON_DUE_DATE', 'HOLD', 'REFUSE_STALE']),
  payOn: Day.nullable(),
  dueOn: Day,
  amountBaseUnits: BaseUnits,
  freeCashBaseUnits: BaseUnits.nullable(),
  cashBufferBaseUnits: BaseUnits.nullable(),
  cashAfterBaseUnits: z
    .string()
    .regex(/^-?\d{1,30}$/)
    .nullable(),
  savingBaseUnits: BaseUnits,
  reason: z.string().max(400),
  explanation: z.string().max(1200),
  citations: z.array(CitationSchema).min(1),
});
export type TimingRecommendation = z.output<typeof TimingRecommendationSchema>;

export const LiquidityReportSchema = z.strictObject({
  kind: z.literal('LIQUIDITY_REPORT'),
  decisionGrade: z.boolean(),
  freeCashBaseUnits: BaseUnits.nullable(),
  cashBufferBaseUnits: BaseUnits.nullable(),
  payablesDue30dBaseUnits: BaseUnits,
  receivablesDue30dBaseUnits: BaseUnits,
  gatewayAvailableBaseUnits: BaseUnits,
  cctpInFlightBaseUnits: BaseUnits,
  runwayDays: z.number().int().nonnegative().nullable(),
  explanation: z.string().max(1200),
  citations: z.array(CitationSchema).min(1),
});
export type LiquidityReport = z.output<typeof LiquidityReportSchema>;

export const RiskRecommendationSchema = z.strictObject({
  kind: z.literal('RISK_RECOMMENDATION'),
  subject: z.string().min(1),
  recommendation: z.enum(['CLEAR', 'REVIEW', 'VETO']),
  flags: z.array(RiskFlagSchema),
  injectionSignals: z.array(z.string()),
});
export type RiskRecommendation = z.output<typeof RiskRecommendationSchema>;

/** What the Payment Agent's model may draft. Untrusted until re-validated. */
export const PaymentDraftSchema = z.strictObject({
  kind: z.literal('PAYMENT'),
  vendorInvoiceId: z.string().min(1).max(80),
  recipient: Address,
  amountBaseUnits: BaseUnits,
  purpose: z.enum(PAYMENT_PURPOSES),
  rationale: z.string().max(600),
  riskAssessment: z.string().max(400),
});
export type PaymentDraft = z.output<typeof PaymentDraftSchema>;

/** What the Invoice Agent's model may extract when the fast rules cannot. */
export const InvoiceTermsSchema = z.strictObject({
  payer: z.string().min(1).max(120),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
  asset: z.enum(['USDC', 'EURC']),
  description: z.string().min(1).max(200),
  dueInDays: z.number().int().min(0).max(120),
});
export type InvoiceTerms = z.output<typeof InvoiceTermsSchema>;
