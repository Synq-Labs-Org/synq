import Fastify, { type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import {
  ApprovalChallengeRequestSchema,
  DelegationPolicySchema,
  EnrollmentChallengeRequestSchema,
  GrantApprovalChallengeSchema,
  GroupBindingInputSchema,
  GroupViewSchema,
  HashSchema,
  IdSchema,
  IdentityChallengeSchema,
  MandateViewSchema,
  MembershipRequestSchema,
  MembershipViewSchema,
  PendingIntentViewSchema,
  PrincipalIdSchema,
  PrincipalViewSchema,
  ProviderStatusViewSchema,
  QuorumViewSchema,
  RecoveryChallengeRequestSchema,
  RecoveryResultSchema,
  RegisterDraftRequestSchema,
  SignedChallengeInputSchema,
  VerifiedApprovalSchema,
  type Asset,
} from '@synq/schemas';
import {
  DelegationService,
  DynamicAdapter,
  GrantApprovalGateway,
  IdentityError,
  MembershipService,
  PrincipalService,
  PrivyAdapter,
  type IdentityConfig,
  type IdentityStore,
} from '@synq/identity/server';
import { route, toApiError, type RouteContext } from './http.js';

export interface MandateReadPort {
  read(
    groupId: string,
    mandateId: string,
  ): Promise<z.input<typeof MandateViewSchema> | null>;
}
export type V1Deps = {
  store: IdentityStore;
  config: IdentityConfig;
  adminToken: string | null;
  localAssets?: readonly Asset[];
  mandates?: MandateReadPort;
  privy?: PrivyAdapter;
  dynamic?: DynamicAdapter;
  logger?: FastifyServerOptions['logger'];
};

const GroupParams = z.strictObject({ groupId: IdSchema });
const PrincipalParams = z.strictObject({ principalId: PrincipalIdSchema });

export function createV1Api(deps: V1Deps) {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024 });
  const principals = new PrincipalService(deps.store, deps.config);
  const membership = new MembershipService(deps.store, deps.config);
  const approvals = new GrantApprovalGateway(
    deps.store,
    deps.config,
    deps.localAssets ?? [],
  );
  const delegation = new DelegationService(deps.store, deps.config);
  const privy = deps.privy ?? new PrivyAdapter({});
  const dynamic = deps.dynamic ?? new DynamicAdapter({});
  const ctx: RouteContext = {
    store: deps.store,
    adminToken: deps.adminToken,
    now: principals.config.now,
  };

  app.get('/v1/health', async () => ({ status: 'ok' }));
  route(app, ctx, {
    method: 'GET',
    url: '/v1/providers',
    response: ProviderStatusViewSchema,
    handler: async () =>
      [privy.status(), dynamic.status()].map((s) => ({
        provider: s.provider,
        status: s.status,
        missing: s.status === 'BLOCKED' ? s.missing : [],
      })),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/principals/enrollment-challenges',
    body: EnrollmentChallengeRequestSchema,
    response: IdentityChallengeSchema,
    handler: ({ body }) => principals.issueEnrollmentChallenge(body),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/principals',
    body: SignedChallengeInputSchema,
    response: PrincipalViewSchema,
    handler: ({ body }) => principals.enroll(body),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/principals/recovery-challenges',
    body: RecoveryChallengeRequestSchema,
    response: IdentityChallengeSchema,
    handler: ({ body }) => principals.issueRecoveryChallenge(body),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/principals/recover',
    body: SignedChallengeInputSchema,
    response: RecoveryResultSchema,
    status: 200,
    handler: ({ body }) => principals.recover(body),
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/principals/:principalId',
    params: PrincipalParams,
    response: PrincipalViewSchema,
    handler: ({ params }) => principals.get(params.principalId),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups',
    admin: true,
    body: GroupBindingInputSchema,
    response: GroupViewSchema,
    handler: ({ body }) => membership.createGroup(body),
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/groups/:groupId',
    params: GroupParams,
    response: GroupViewSchema,
    handler: ({ params }) => membership.getGroup(params.groupId),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups/:groupId/membership-challenges',
    params: GroupParams,
    body: MembershipRequestSchema,
    response: IdentityChallengeSchema,
    handler: ({ params, body }) =>
      membership.issueJoinChallenge({ groupId: params.groupId, ...body }),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups/:groupId/memberships',
    params: GroupParams,
    body: SignedChallengeInputSchema,
    response: MembershipViewSchema,
    handler: async ({ params, body }) => {
      const stored = await deps.store.transaction((tx) =>
        tx.getChallenge(body.challengeId),
      );
      if (stored && stored.challenge.groupId !== params.groupId)
        throw new IdentityError('CHALLENGE_MISMATCH');
      return membership.join(body);
    },
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups/:groupId/memberships/:memberId/revoke',
    admin: true,
    params: z.strictObject({ groupId: IdSchema, memberId: IdSchema }),
    response: GroupViewSchema,
    status: 200,
    handler: ({ params }) => membership.revoke(params),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups/:groupId/operators',
    admin: true,
    params: GroupParams,
    body: MembershipRequestSchema,
    response: MembershipViewSchema,
    handler: ({ params, body }) =>
      membership.bindOperator({ groupId: params.groupId, ...body }),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/groups/:groupId/delegations',
    admin: true,
    params: GroupParams,
    body: DelegationPolicySchema,
    response: DelegationPolicySchema,
    handler: ({ params, body }) => {
      if (body.groupId !== params.groupId)
        throw new IdentityError('INVALID_INPUT', 'groupId');
      return delegation.createPolicy(body);
    },
  });

  route(app, ctx, {
    method: 'GET',
    url: '/v1/mandates/:groupId/:mandateId',
    params: z.strictObject({ groupId: HashSchema, mandateId: HashSchema }),
    response: MandateViewSchema,
    handler: async ({ params }) => {
      if (!deps.mandates) throw new IdentityError('READ_MODEL_UNAVAILABLE');
      const view = await deps.mandates.read(params.groupId, params.mandateId);
      if (!view) throw new IdentityError('MANDATE_NOT_FOUND');
      return view;
    },
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/intents',
    admin: true,
    body: RegisterDraftRequestSchema,
    response: PendingIntentViewSchema,
    handler: ({ body }) => approvals.registerDraft(body),
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/intents/:intentId',
    params: z.strictObject({ intentId: HashSchema }),
    response: PendingIntentViewSchema,
    handler: ({ params }) => approvals.pendingIntent(params.intentId),
  });

  route(app, ctx, {
    method: 'POST',
    url: '/v1/approvals/challenges',
    body: ApprovalChallengeRequestSchema,
    response: GrantApprovalChallengeSchema,
    handler: ({ body }) => approvals.issueChallenge(body),
  });
  route(app, ctx, {
    method: 'POST',
    url: '/v1/approvals',
    body: SignedChallengeInputSchema,
    response: VerifiedApprovalSchema,
    handler: ({ body }) => approvals.submit(body),
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/approvals/:draftDigest/quorum',
    params: z.strictObject({ draftDigest: HashSchema }),
    response: QuorumViewSchema,
    handler: ({ params }) => approvals.quorum(params.draftDigest),
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toApiError(error);
    if (mapped.status >= 500)
      request.log.error({ code: mapped.body.error }, 'request failed');
    reply.code(mapped.status).send(mapped.body);
  });
  return app;
}
