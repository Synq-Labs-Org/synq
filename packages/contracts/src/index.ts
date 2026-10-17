import { z } from 'zod';
import * as approvals from './approvals.js';
import * as auth from './auth.js';
import * as business from './business.js';
import * as common from './common.js';
import * as contexts from './contexts.js';
import * as notifications from './notifications.js';
import { MetaRouteSchema, MetaSchema } from './routes.js';

export * from './approvals.js';
export * from './auth.js';
export * from './business.js';
export * from './common.js';
export * from './contexts.js';
export * from './notifications.js';
export * from './routes.js';

/** Every named wire schema, by the name generated clients use. */
export const NAMED_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ApiError: common.ApiErrorSchema,
  Ok: common.OkSchema,
  ProofLevel: common.ProofLevelSchema,
  CapabilityStatus: common.CapabilityStatusSchema,
  Capability: common.CapabilitySchema,
  WorkspaceKind: common.WorkspaceKindSchema,
  WorkspaceStatus: common.WorkspaceStatusSchema,
  Role: common.RoleSchema,
  Money: common.MoneySchema,
  Balance: common.BalanceSchema,
  Freshness: common.FreshnessSchema,
  MetaRoute: MetaRouteSchema,
  Meta: MetaSchema,
  Device: auth.DeviceSchema,
  DeviceSessionRequest: auth.DeviceSessionRequestSchema,
  DeviceCodeSessionRequest: auth.DeviceCodeSessionRequestSchema,
  RefreshRequest: auth.RefreshRequestSchema,
  DeviceSession: auth.DeviceSessionSchema,
  SessionSummary: auth.SessionSummarySchema,
  SessionList: auth.SessionListSchema,
  RevokeAll: auth.RevokeAllSchema,
  Context: contexts.ContextSchema,
  Contexts: contexts.ContextsSchema,
  WalletBalance: contexts.WalletBalanceSchema,
  CircleSummary: contexts.CircleSummarySchema,
  PersonalVault: contexts.PersonalVaultSchema,
  ActivityItem: contexts.ActivityItemSchema,
  PersonalOverview: contexts.PersonalOverviewSchema,
  CirclePage: contexts.CirclePageSchema,
  CircleMember: contexts.CircleMemberSchema,
  CircleContribution: contexts.CircleContributionSchema,
  CircleProposal: contexts.CircleProposalSchema,
  CircleDetail: contexts.CircleDetailSchema,
  RunStatus: business.RunStatusSchema,
  EventActor: business.EventActorSchema,
  AgentRunSummary: business.AgentRunSummarySchema,
  AgentEconomicEvent: business.AgentEconomicEventSchema,
  Receipt: business.ReceiptSchema,
  AgentRunPage: business.AgentRunPageSchema,
  AgentRunDetail: business.AgentRunDetailSchema,
  AgentLease: business.AgentLeaseSchema,
  Mandates: business.MandatesSchema,
  WorkspaceOverview: business.WorkspaceOverviewSchema,
  LeadStage: business.LeadStageSchema,
  LeadHandling: business.LeadHandlingSchema,
  LeadSource: business.LeadSourceSchema,
  LeadSummary: business.LeadSummarySchema,
  InboxPage: business.InboxPageSchema,
  LeadMessage: business.LeadMessageSchema,
  OfferLine: business.OfferLineSchema,
  OfferMilestone: business.OfferMilestoneSchema,
  OfferVersion: business.OfferVersionSchema,
  LeadDetail: business.LeadDetailSchema,
  LeadMessageRequest: business.LeadMessageRequestSchema,
  TakeoverRequest: business.TakeoverRequestSchema,
  TakeoverResult: business.TakeoverResultSchema,
  LeadInviteRequest: business.LeadInviteRequestSchema,
  LeadInvite: business.LeadInviteSchema,
  LeadInviteRedeem: business.LeadInviteRedeemSchema,
  LeadInviteRedeemResult: business.LeadInviteRedeemResultSchema,
  OfferValidation: business.OfferValidationSchema,
  ApprovalPurpose: approvals.ApprovalPurposeSchema,
  ApprovalItem: approvals.ApprovalItemSchema,
  ApprovalPage: approvals.ApprovalPageSchema,
  TypedData: approvals.TypedDataSchema,
  SigningRequest: approvals.SigningRequestSchema,
  SignatureSubmit: approvals.SignatureSubmitSchema,
  SignatureResult: approvals.SignatureResultSchema,
  NotificationCategory: notifications.NotificationCategorySchema,
  Notification: notifications.NotificationSchema,
  NotificationPage: notifications.NotificationPageSchema,
  MarkRead: notifications.MarkReadSchema,
  DeviceRegistration: notifications.DeviceRegistrationSchema,
  DeviceRegistered: notifications.DeviceRegisteredSchema,
  StreamEvent: notifications.StreamEventSchema,
  StreamEventPage: notifications.StreamEventPageSchema,
};
