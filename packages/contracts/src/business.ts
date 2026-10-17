import { z } from 'zod';
import {
  AddressHintSchema,
  BalanceSchema,
  CapabilitySchema,
  CursorSchema,
  FreshnessSchema,
  HashSchema,
  IdSchema,
  MoneySchema,
  ProofLevelSchema,
  RoleSchema,
  TimestampSchema,
  TxHashSchema,
  UnitsSchema,
  WorkspaceStatusSchema,
  pageOf,
} from './common.js';

/*
 * Business context: overview, private-lead inbox, offers and the agent
 * activity timeline. Details already served by /v2 (books, invoices, payouts,
 * deals, vault actions) keep their /v2 shapes.
 */

// MARK: Agent runs (defined first: the overview shows highlights)

/** Status of a run or one event in it. FINALIZED/RECONCILED only from chain or provider proof. */
export const RunStatusSchema = z.enum([
  'PENDING',
  'REQUIRES_OWNER',
  'AUTHORIZED',
  'BROADCAST',
  'FINALIZED',
  'RECONCILED',
  'BLOCKED',
  'REJECTED',
  'TIMED_OUT',
  'REORG_PENDING',
  'REVOKED',
  'QUARANTINED',
]);

export const AgentRunSummarySchema = z.strictObject({
  runId: IdSchema,
  workspaceId: IdSchema,
  title: z.string().max(140),
  trigger: z.enum([
    'INVOICE_SETTLED',
    'DEPOSIT_FINALIZED',
    'SCHEDULE',
    'OWNER_REQUEST',
    'LEAD_MESSAGE',
    'OTHER',
  ]),
  status: RunStatusSchema,
  amount: MoneySchema.nullable(),
  proofLevel: ProofLevelSchema,
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Who produced an event. A model never authorizes; record both roles when both acted. */
export const EventActorSchema = z.enum([
  'MODEL',
  'DETERMINISTIC',
  'HUMAN',
  'CHAIN',
  'PROVIDER',
]);

export const AgentEconomicEventSchema = z.strictObject({
  eventId: IdSchema,
  workspaceId: IdSchema,
  runId: IdSchema,
  sequence: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .describe('Monotonic per workspace'),
  correlationId: z.string().max(80),
  causationId: z.string().max(80).nullable(),
  kind: z.enum([
    'DECISION',
    'INTENT',
    'GRANT',
    'BROADCAST',
    'FINALIZED',
    'REJECTED',
    'RECONCILED',
    'ESCALATED',
  ]),
  actor: EventActorSchema,
  status: RunStatusSchema,
  summary: z
    .string()
    .max(400)
    .describe('Redacted explanation; never model reasoning'),
  sourceKind: z.string().max(40),
  observedAt: TimestampSchema,
  effectiveAt: TimestampSchema.nullable(),
  evidenceHash: HashSchema.nullable(),
  proofLevel: ProofLevelSchema,
  amount: MoneySchema.nullable(),
  recipientHint: AddressHintSchema.nullable(),
  txHash: TxHashSchema.nullable(),
  chainId: z.number().int().nullable(),
});

export const ReceiptSchema = z.strictObject({
  chainId: z.number().int(),
  txHash: TxHashSchema,
  blockNumber: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .nullable(),
  finality: z.enum(['PENDING', 'FINALIZED', 'REORGED']),
  explorerUrl: z.url().nullable(),
  ledgerEntryId: z.string().max(80).nullable(),
});

export const AgentRunPageSchema = pageOf(AgentRunSummarySchema);
export const AgentRunDetailSchema = z.strictObject({
  run: AgentRunSummarySchema,
  events: z.array(AgentEconomicEventSchema),
  receipts: z.array(ReceiptSchema),
});

/** A standing agent lease as the enforcing contract reports it. */
export const AgentLeaseSchema = z.strictObject({
  leaseId: z.string().max(80),
  policyHash: HashSchema,
  agentId: z.string().max(80),
  actions: z.array(z.string().max(40)),
  recipients: z.array(AddressHintSchema),
  assetIds: z.array(z.string().max(64)),
  perActionUnits: UnitsSchema,
  availableUnits: UnitsSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  enforcingContract: z.string().max(42),
  chainId: z.number().int(),
  proofLevel: ProofLevelSchema,
});
export const MandatesSchema = z.strictObject({
  capability: CapabilitySchema,
  leases: z.array(AgentLeaseSchema),
});

// MARK: Overview

export const WorkspaceOverviewSchema = z.strictObject({
  workspaceId: IdSchema,
  displayName: z.string().max(80),
  status: WorkspaceStatusSchema,
  role: RoleSchema,
  balances: z.array(BalanceSchema),
  receivables: z.strictObject({
    open: z.number().int().min(0),
    units: UnitsSchema,
  }),
  payables: z.strictObject({
    open: z.number().int().min(0),
    units: UnitsSchema,
  }),
  leads: z.strictObject({
    open: z.number().int().min(0),
    needsOwner: z.number().int().min(0),
  }),
  pendingApprovals: z.number().int().min(0),
  agentHighlights: z.array(AgentRunSummarySchema).max(5),
  capabilities: z.record(z.string(), CapabilitySchema),
  freshness: FreshnessSchema,
});

// MARK: Leads

export const LeadStageSchema = z.enum([
  'LEAD_OPEN',
  'DISCOVERY',
  'QUALIFIED',
  'OFFER_DRAFTED',
  'OFFER_VALIDATED',
  'OFFER_SENT',
  'NEGOTIATING',
  'AGREED_PENDING_SIGNATURES',
  'SIGNED',
  'FUNDING_PENDING',
  'FUNDED',
  'ACTIVE',
  'DELIVERED',
  'ACCEPTANCE_PENDING',
  'RELEASED',
  'REFUNDED',
  'DISPUTED',
  'CANCELLED',
]);
export const LeadHandlingSchema = z.enum(['AGENT', 'HUMAN', 'FROZEN']);
export const LeadSourceSchema = z.enum(['TELEGRAM', 'WEB', 'IMESSAGE']);

export const LeadSummarySchema = z.strictObject({
  leadId: IdSchema,
  workspaceId: IdSchema,
  label: z
    .string()
    .max(80)
    .describe('Redacted display label, never a full name'),
  source: LeadSourceSchema,
  stage: LeadStageSchema,
  handling: LeadHandlingSchema,
  needsOwner: z.boolean(),
  unread: z.number().int().min(0),
  lastActivityAt: TimestampSchema,
});
export const InboxPageSchema = pageOf(LeadSummarySchema);

export const LeadMessageSchema = z.strictObject({
  messageId: IdSchema,
  author: z.enum(['LEAD', 'AGENT', 'STAFF', 'SYSTEM']),
  text: z.string().max(4000),
  offerVersion: z.number().int().positive().nullable(),
  createdAt: TimestampSchema,
});

export const OfferLineSchema = z.strictObject({
  description: z.string().max(200),
  quantity: z.number().int().positive(),
  unitUnits: UnitsSchema,
  totalUnits: UnitsSchema,
});
export const OfferMilestoneSchema = z.strictObject({
  label: z.string().max(120),
  units: UnitsSchema,
  dueAt: TimestampSchema.nullable(),
});
/** One immutable offer version; a counteroffer is a new version, never an edit. */
export const OfferVersionSchema = z.strictObject({
  offerId: IdSchema,
  version: z.number().int().positive(),
  termsHash: HashSchema,
  previousTermsHash: HashSchema.nullable(),
  policyVersion: z.number().int().positive(),
  status: z.enum([
    'DRAFTED',
    'VALIDATED',
    'SENT',
    'ACCEPTED',
    'REJECTED',
    'COUNTERED',
    'EXPIRED',
    'WITHDRAWN',
  ]),
  createdBy: z.enum(['AGENT', 'STAFF']),
  total: MoneySchema,
  lines: z.array(OfferLineSchema),
  milestones: z.array(OfferMilestoneSchema),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
});

export const LeadDetailSchema = z.strictObject({
  lead: LeadSummarySchema,
  handlingVersion: z.number().int().min(0),
  consent: z.strictObject({
    granted: z.boolean(),
    grantedAt: TimestampSchema.nullable(),
    scope: z.string().max(200),
  }),
  messages: z.array(LeadMessageSchema),
  olderMessagesCursor: CursorSchema.nullable(),
  offers: z.array(OfferVersionSchema),
});

/*
 * The outside client's own view of a lead (web channel). It carries no staff
 * fields: no handling state, owner flags, unread counts or internal offer data.
 */
export const ClientLeadSummarySchema = z.strictObject({
  leadId: IdSchema,
  businessName: z.string().max(80),
  stage: LeadStageSchema,
  lastActivityAt: TimestampSchema,
});
export const ClientLeadListSchema = z.strictObject({
  leads: z.array(ClientLeadSummarySchema),
});
export const ClientOfferVersionSchema = OfferVersionSchema.omit({
  policyVersion: true,
  previousTermsHash: true,
  createdBy: true,
});
export const ClientLeadDetailSchema = z.strictObject({
  lead: ClientLeadSummarySchema,
  consent: LeadDetailSchema.shape.consent,
  messages: z.array(LeadMessageSchema),
  olderMessagesCursor: CursorSchema.nullable(),
  offers: z.array(ClientOfferVersionSchema),
});

export const LeadMessageRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
});
export const TakeoverRequestSchema = z.strictObject({
  action: z.enum([
    'HUMAN_TAKEOVER',
    'HAND_BACK_TO_AGENT',
    'FREEZE_OFFERS',
    'ESCALATE_TO_OWNER',
  ]),
  expectedVersion: z.number().int().min(0),
});
export const TakeoverResultSchema = z.strictObject({
  handling: LeadHandlingSchema,
  handlingVersion: z.number().int().min(0),
});

export const LeadInviteRequestSchema = z.strictObject({
  source: z.enum(['TELEGRAM', 'WEB']),
  expiresInSeconds: z.number().int().min(300).max(604800),
});
export const LeadInviteSchema = z.strictObject({
  inviteId: IdSchema,
  telegramUrl: z.url().nullable(),
  webUrl: z.url(),
  expiresAt: TimestampSchema,
});
export const LeadInviteRedeemSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
export const LeadInviteRedeemResultSchema = z.strictObject({
  leadId: IdSchema,
  bound: z.boolean(),
});

export const OfferValidationSchema = z.strictObject({
  allowed: z.boolean(),
  policyVersion: z.number().int().positive(),
  checks: z.array(
    z.strictObject({
      rule: z.string().max(60),
      passed: z.boolean(),
      detail: z.string().max(300),
    }),
  ),
});
