import Fastify, { type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import {
  ApprovalChallengeRequestSchema,
  DelegationPolicySchema,
  EnrollmentChallengeRequestSchema,
  GrantApprovalChallengeSchema,
  GrantApprovalSubmissionSchema,
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
  PublicQuorumViewSchema,
  QuorumViewSchema,
  RecoveryChallengeRequestSchema,
  RecoveryResultSchema,
  IntentProposalResultSchema,
  IntentProposalSchema,
  SignedChallengeInputSchema,
  VerifiedApprovalSchema,
  type Asset,
  type GrantDraft,
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
import { TokenBucketLimiter, type RateLimitConfig } from './rate-limit.js';

export const MIN_ADMIN_TOKEN_LENGTH = 32;

export interface MandateReadPort {
  read(
    groupId: string,
    mandateId: string,
  ): Promise<z.input<typeof MandateViewSchema> | null>;
}
export interface IntentAuthorizer {
  authorize(request: unknown): Promise<
    | {
        status: 'AUTHORIZED';
        intentId: string | null;
        draft: GrantDraft;
      }
    | {
        status: 'PENDING_APPROVAL';
        intentId: string | null;
        code: string;
        draft: GrantDraft | null;
      }
    | {
        status: 'POLICY_REJECTED' | 'RISK_REJECTED' | 'EXPIRED';
        intentId: string | null;
        code: string;
      }
  >;
}
export type V1Deps = {
  intents?: IntentAuthorizer;
  store: IdentityStore;
  config: IdentityConfig;
  adminToken: string | null;
  executionModules: Readonly<Record<number, string>>;
  localAssets?: readonly Asset[];
  rateLimit?: RateLimitConfig;
  trustProxy?: boolean | string;
  mandates?: MandateReadPort;
  privy?: PrivyAdapter;
  dynamic?: DynamicAdapter;
  logger?: FastifyServerOptions['logger'];
};

const GroupParams = z.strictObject({ groupId: IdSchema });
const PrincipalParams = z.strictObject({ principalId: PrincipalIdSchema });

export function createV1Api(deps: V1Deps) {
  if (
    deps.adminToken !== null &&
    deps.adminToken.length < MIN_ADMIN_TOKEN_LENGTH
  )
    throw new Error(
      `admin token must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`,
    );
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 64 * 1024,
    trustProxy: deps.trustProxy ?? false,
  });
  const principals = new PrincipalService(deps.store, deps.config);
  const membership = new MembershipService(deps.store, deps.config);
  const approvals = new GrantApprovalGateway(deps.store, deps.config, {
    executionModules: deps.executionModules,
    localAssets: deps.localAssets ?? [],
  });
  const delegation = new DelegationService(deps.store, deps.config);
  const privy = deps.privy ?? new PrivyAdapter({});
  const dynamic = deps.dynamic ?? new DynamicAdapter({});
  const ctx: RouteContext = {
    store: deps.store,
    adminToken: deps.adminToken,
    now: principals.config.now,
    limiter: new TokenBucketLimiter(
      deps.rateLimit ?? { capacity: 30, refillPerSecond: 1 },
    ),
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
    handler: ({ params, body }) =>
      membership.join({ groupId: params.groupId, ...body }),
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
    body: IntentProposalSchema,
    response: IntentProposalResultSchema,
    handler: async ({ body }) => {
      if (!deps.intents) throw new IdentityError('KERNEL_UNAVAILABLE');
      const decision = await deps.intents.authorize({ ...body, approvals: [] });
      if (decision.status === 'PENDING_APPROVAL') {
        if (!decision.draft)
          throw new IdentityError('INTENT_REJECTED', decision.code);
        return {
          status: decision.status,
          code: decision.code,
          intentId: decision.intentId,
          pending: await approvals.registerKernelDraft(decision.draft),
        };
      }
      if (decision.status === 'AUTHORIZED')
        return {
          status: decision.status,
          code: null,
          intentId: decision.intentId,
          pending: null,
        };
      throw new IdentityError('INTENT_REJECTED', decision.code);
    },
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
    body: GrantApprovalSubmissionSchema,
    response: VerifiedApprovalSchema,
    handler: ({ body }) => approvals.submit(body),
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/approvals/:draftDigest/quorum',
    params: z.strictObject({ draftDigest: HashSchema }),
    response: PublicQuorumViewSchema,
    handler: async ({ params }) => {
      const quorum = await approvals.quorum(params.draftDigest);
      return {
        ...quorum,
        counted: quorum.counted.map(
          ({ signature: _signature, ...rest }) => rest,
        ),
      };
    },
  });
  route(app, ctx, {
    method: 'GET',
    url: '/v1/approvals/:draftDigest/verified',
    admin: true,
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
