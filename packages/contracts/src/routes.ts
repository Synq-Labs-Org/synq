import { z } from 'zod';
import * as approvals from './approvals.js';
import * as auth from './auth.js';
import * as business from './business.js';
import * as commercial from './commercial.js';
import * as common from './common.js';
import * as contexts from './contexts.js';
import * as notifications from './notifications.js';

/*
 * Every v3 route, its auth, who may call it and its wire shapes. `status`
 * says whether the server implements it yet; GET /v3/meta reports the same
 * list at runtime so clients can hide what the server cannot serve.
 *
 * Auth: `none`; `session` (bearer access token or web cookie, plus workspace
 * membership on /workspaces/{id} routes); `mutation` (session, plus same-origin
 * for cookie sessions and an `Idempotency-Key` header).
 */

export type RouteAuth = 'none' | 'session' | 'mutation';
export type RouteStatus = 'PLANNED' | 'IMPLEMENTED';
export type Route = {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  auth: RouteAuth;
  roles: string;
  query?: z.ZodType;
  request?: z.ZodType;
  response: z.ZodType | 'text/event-stream';
  status: RouteStatus;
  summary: string;
};

const PageQuery = z.strictObject({
  cursor: common.CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const MetaRouteSchema = z.strictObject({
  id: z.string(),
  status: z.enum(['PLANNED', 'IMPLEMENTED']),
});
export const MetaSchema = z.strictObject({
  contractVersion: z.string(),
  routes: z.array(MetaRouteSchema),
});

export const ROUTES: readonly Route[] = [
  {
    id: 'meta',
    method: 'GET',
    path: '/v3/meta',
    auth: 'none',
    roles: 'anyone',
    response: MetaSchema,
    status: 'IMPLEMENTED',
    summary: 'Contract version and which routes this server implements.',
  },
  // Auth (sign-in challenge stays POST /v2/auth/challenge with audience "native").
  {
    id: 'auth.deviceSession',
    method: 'POST',
    path: '/v3/auth/device-session',
    auth: 'none',
    roles: 'wallet that signed the /v2 login challenge',
    request: auth.DeviceSessionRequestSchema,
    response: auth.DeviceSessionSchema,
    status: 'IMPLEMENTED',
    summary: 'Exchange a signed native login challenge for a device session.',
  },
  {
    id: 'auth.deviceSessionFromCode',
    method: 'POST',
    path: '/v3/auth/device-session/code',
    auth: 'none',
    roles: 'holder of a fresh one-time code from a signed-in web session',
    request: auth.DeviceCodeSessionRequestSchema,
    response: auth.DeviceSessionSchema,
    status: 'IMPLEMENTED',
    summary:
      'Exchange a one-time web sign-in code for a device session (no wallet on the phone).',
  },
  {
    id: 'auth.refresh',
    method: 'POST',
    path: '/v3/auth/refresh',
    auth: 'none',
    roles: 'holder of the current refresh token for that device',
    request: auth.RefreshRequestSchema,
    response: auth.DeviceSessionSchema,
    status: 'IMPLEMENTED',
    summary: 'Rotate tokens. Reusing an old refresh token revokes the session.',
  },
  {
    id: 'auth.sessions',
    method: 'GET',
    path: '/v3/auth/sessions',
    auth: 'session',
    roles: 'principal',
    response: auth.SessionListSchema,
    status: 'IMPLEMENTED',
    summary: "The principal's signed-in devices.",
  },
  {
    id: 'auth.logout',
    method: 'POST',
    path: '/v3/auth/logout',
    auth: 'mutation',
    roles: 'principal',
    response: common.OkSchema,
    status: 'IMPLEMENTED',
    summary: 'End this device session.',
  },
  {
    id: 'auth.revokeAll',
    method: 'POST',
    path: '/v3/auth/revoke-all',
    auth: 'mutation',
    roles: 'principal',
    response: auth.RevokeAllSchema,
    status: 'IMPLEMENTED',
    summary: 'End every session of this principal, including this one.',
  },
  // Contexts and personal
  {
    id: 'me.contexts',
    method: 'GET',
    path: '/v3/me/contexts',
    auth: 'session',
    roles: 'principal',
    response: contexts.ContextsSchema,
    status: 'IMPLEMENTED',
    summary: 'Personal context plus one context per business workspace.',
  },
  {
    id: 'personal.overview',
    method: 'GET',
    path: '/v3/personal/overview',
    auth: 'session',
    roles: 'principal',
    response: contexts.PersonalOverviewSchema,
    status: 'IMPLEMENTED',
    summary: 'Own wallets, personal vaults, circles and recent activity.',
  },
  {
    id: 'personal.circles',
    method: 'GET',
    path: '/v3/personal/circles',
    auth: 'session',
    roles: 'principal',
    query: PageQuery,
    response: contexts.CirclePageSchema,
    status: 'IMPLEMENTED',
    summary: 'Group circles the principal is a verified member of.',
  },
  {
    id: 'personal.circle',
    method: 'GET',
    path: '/v3/personal/circles/{circleId}',
    auth: 'session',
    roles: 'circle member',
    response: contexts.CircleDetailSchema,
    status: 'IMPLEMENTED',
    summary: 'Members, attributed contributions, proposals and rules.',
  },
  // Business
  {
    id: 'workspace.overview',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/overview',
    auth: 'session',
    roles: 'OWNER, ADMIN, MEMBER, VIEWER',
    response: business.WorkspaceOverviewSchema,
    status: 'IMPLEMENTED',
    summary:
      'Balances, receivables, payables, leads, approvals, agent highlights.',
  },
  {
    id: 'workspace.inbox',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/inbox',
    auth: 'session',
    roles: 'OWNER, ADMIN',
    query: PageQuery.extend({
      stage: business.LeadStageSchema.optional(),
      handling: business.LeadHandlingSchema.optional(),
    }),
    response: business.InboxPageSchema,
    status: 'IMPLEMENTED',
    summary: 'Private leads, newest activity first.',
  },
  {
    id: 'workspace.lead',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/leads/{leadId}',
    auth: 'session',
    roles: 'OWNER, ADMIN',
    response: business.LeadDetailSchema,
    status: 'IMPLEMENTED',
    summary: 'Lead summary, consented transcript and offer versions.',
  },
  {
    id: 'workspace.leadMessage',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/leads/{leadId}/message',
    auth: 'mutation',
    roles: 'OWNER, ADMIN (only while handling is HUMAN)',
    request: business.LeadMessageRequestSchema,
    response: business.LeadMessageSchema,
    status: 'IMPLEMENTED',
    summary: 'Staff message to the lead.',
  },
  {
    id: 'workspace.leadTakeover',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/leads/{leadId}/takeover',
    auth: 'mutation',
    roles: 'OWNER, ADMIN',
    request: business.TakeoverRequestSchema,
    response: business.TakeoverResultSchema,
    status: 'IMPLEMENTED',
    summary:
      'Take over, hand back, freeze offers or escalate; 409 on a stale version.',
  },
  {
    id: 'workspace.leadInvite',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/lead-invites',
    auth: 'mutation',
    roles: 'OWNER, ADMIN',
    request: business.LeadInviteRequestSchema,
    response: business.LeadInviteSchema,
    status: 'IMPLEMENTED',
    summary: 'Single-use private invitation link for a prospect.',
  },
  {
    id: 'leadInvite.redeem',
    method: 'POST',
    path: '/v3/lead-invites/redeem',
    auth: 'session',
    roles: 'external lead with a provider-verified identity',
    request: business.LeadInviteRedeemSchema,
    response: business.LeadInviteRedeemResultSchema,
    status: 'IMPLEMENTED',
    summary: 'Bind a private session to the redeeming identity, once.',
  },
  {
    id: 'workspace.offerValidate',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/offers/{offerId}/versions/{version}/validate',
    auth: 'mutation',
    roles: 'OWNER, ADMIN',
    response: business.OfferValidationSchema,
    status: 'IMPLEMENTED',
    summary:
      'Run the deterministic commercial policy checks on one offer version.',
  },
  {
    id: 'workspace.leadOffer',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/leads/{leadId}/offers',
    auth: 'mutation',
    roles: 'OWNER, ADMIN (only while handling is HUMAN)',
    request: commercial.OfferSendRequestSchema,
    response: commercial.OfferSendResultSchema,
    status: 'IMPLEMENTED',
    summary:
      'Send an offer (or a new version of one) after the policy checks pass.',
  },
  {
    id: 'workspace.commercialPolicies',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/commercial-policies',
    auth: 'session',
    roles: 'OWNER, ADMIN',
    response: commercial.CommercialPolicyListSchema,
    status: 'IMPLEMENTED',
    summary: 'Commercial policy versions, newest first.',
  },
  {
    id: 'workspace.commercialPolicyPropose',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/commercial-policies',
    auth: 'mutation',
    roles: 'OWNER, ADMIN',
    request: commercial.CommercialPolicySchema,
    response: commercial.CommercialPolicyViewSchema,
    status: 'IMPLEMENTED',
    summary:
      'Propose the next policy version; an owner signs it from the approvals inbox.',
  },
  {
    id: 'workspace.agentRuns',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/agent-runs',
    auth: 'session',
    roles: 'OWNER, ADMIN, MEMBER',
    query: PageQuery,
    response: business.AgentRunPageSchema,
    status: 'IMPLEMENTED',
    summary: 'Agent runs, newest first.',
  },
  {
    id: 'workspace.agentRun',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/agent-runs/{runId}',
    auth: 'session',
    roles: 'OWNER, ADMIN, MEMBER',
    response: business.AgentRunDetailSchema,
    status: 'IMPLEMENTED',
    summary: 'Typed events and chain receipts of one run.',
  },
  {
    id: 'workspace.mandates',
    method: 'GET',
    path: '/v3/workspaces/{workspaceId}/mandates',
    auth: 'session',
    roles: 'OWNER, ADMIN',
    response: business.MandatesSchema,
    status: 'PLANNED',
    summary: 'Agent leases with on-chain remaining limits.',
  },
  {
    id: 'workspace.mandateRevoke',
    method: 'POST',
    path: '/v3/workspaces/{workspaceId}/mandates/{leaseId}/revoke-intent',
    auth: 'mutation',
    roles: 'OWNER with lease-issuer authority',
    response: approvals.SigningRequestSchema,
    status: 'PLANNED',
    summary:
      'Prepare a revoke for the issuer to sign; not revoked until on chain.',
  },
  // Approvals
  {
    id: 'approvals.list',
    method: 'GET',
    path: '/v3/approvals',
    auth: 'session',
    roles: 'principal',
    query: PageQuery,
    response: approvals.ApprovalPageSchema,
    status: 'IMPLEMENTED',
    summary: "Requests waiting for this wallet's signature, across workspaces.",
  },
  {
    id: 'approvals.get',
    method: 'GET',
    path: '/v3/approvals/{requestId}',
    auth: 'session',
    roles: 'a required signer',
    response: approvals.SigningRequestSchema,
    status: 'IMPLEMENTED',
    summary: 'Exact typed data to sign.',
  },
  {
    id: 'approvals.sign',
    method: 'POST',
    path: '/v3/approvals/{requestId}/signature',
    auth: 'mutation',
    roles: 'a required signer',
    request: approvals.SignatureSubmitSchema,
    response: approvals.SignatureResultSchema,
    status: 'IMPLEMENTED',
    summary: 'Submit a wallet signature; the server verifies the signer.',
  },
  // Notifications, devices, events
  {
    id: 'notifications.list',
    method: 'GET',
    path: '/v3/notifications',
    auth: 'session',
    roles: 'principal',
    query: PageQuery,
    response: notifications.NotificationPageSchema,
    status: 'IMPLEMENTED',
    summary: 'Redacted notification inbox.',
  },
  {
    id: 'notifications.read',
    method: 'POST',
    path: '/v3/notifications/read',
    auth: 'mutation',
    roles: 'principal',
    request: notifications.MarkReadSchema,
    response: common.OkSchema,
    status: 'IMPLEMENTED',
    summary: 'Mark notifications read.',
  },
  {
    id: 'devices.register',
    method: 'POST',
    path: '/v3/devices',
    auth: 'mutation',
    roles: 'native session of that device',
    request: notifications.DeviceRegistrationSchema,
    response: notifications.DeviceRegisteredSchema,
    status: 'IMPLEMENTED',
    summary: 'Register or update an APNs token and preferences.',
  },
  {
    id: 'devices.revoke',
    method: 'POST',
    path: '/v3/devices/{deviceId}/revoke',
    auth: 'mutation',
    roles: 'principal',
    response: common.OkSchema,
    status: 'IMPLEMENTED',
    summary: 'Stop pushes to a device.',
  },
  {
    id: 'events.stream',
    method: 'GET',
    path: '/v3/events',
    auth: 'session',
    roles: 'principal; events filtered to their contexts',
    query: z.strictObject({ cursor: common.CursorSchema.optional() }),
    response: 'text/event-stream',
    status: 'IMPLEMENTED',
    summary: 'Server-sent StreamEvent records; replay from a cursor.',
  },
  {
    id: 'events.poll',
    method: 'GET',
    path: '/v3/events/since',
    auth: 'session',
    roles: 'principal',
    query: z.strictObject({ cursor: common.CursorSchema.optional() }),
    response: notifications.StreamEventPageSchema,
    status: 'IMPLEMENTED',
    summary:
      'Same events as the stream, for clients that cannot hold a connection.',
  },
];
