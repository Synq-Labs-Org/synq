import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { callerFor, mayPropose } from './member-scope.js';
import type { SendRouteDeps } from './send-routes.js';
import { TokenBucketLimiter, type RateLimitConfig } from './v1/rate-limit.js';
import {
  MandateProposalError,
  type MandateProposalService,
} from './mandate-proposals.js';

const STATUS: Record<MandateProposalError['code'], number> = {
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_NOT_PENDING: 409,
  GROUP_NOT_FOUND: 404,
  MANDATE_INVALID: 422,
  NETWORK_MISMATCH: 409,
  NOT_A_MEMBER: 403,
  NOT_AN_OWNER: 403,
  SIGNATURE_INVALID: 401,
  SAFE_HASH_MISMATCH: 409,
};
const Id = z.strictObject({ proposalId: z.string().regex(/^0x[0-9a-f]{64}$/) });
const ApprovalBody = z.strictObject({
  memberId: z.string().min(1).max(200),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
const ProposeBody = z.strictObject({
  groupId: z.string().min(1).max(200),
  mandate: z.unknown(),
  change: z.enum(['NEW', 'SUPERSEDE']),
});

/** Member proposals: a few per member and a bounded number per group per hour. */
export const MANDATE_PROPOSAL_RATE_LIMIT = {
  member: { capacity: 5, refillPerSecond: 5 / 3600 },
  group: { capacity: 20, refillPerSecond: 20 / 3600 },
} as const satisfies Record<'member' | 'group', RateLimitConfig>;

/** Review and owner approval of mandate proposals; members propose within rate limits. */
export async function mandateRoutes(
  api: FastifyInstance,
  deps: {
    service: MandateProposalService;
    adminToken: string | null;
    memberAccess?: SendRouteDeps['memberAccess'];
    proposalRateLimit?: Record<'member' | 'group', RateLimitConfig>;
    clockMs?: () => number;
  },
) {
  const limits = deps.proposalRateLimit ?? MANDATE_PROPOSAL_RATE_LIMIT;
  const perMember = new TokenBucketLimiter(limits.member, deps.clockMs);
  const perGroup = new TokenBucketLimiter(limits.group, deps.clockMs);
  const admin = (header: string | undefined) => {
    const d = (v: string) => createHash('sha256').update(v).digest();
    return (
      !!deps.adminToken &&
      timingSafeEqual(d(header ?? ''), d(`Bearer ${deps.adminToken}`))
    );
  };
  const fail = (error: unknown) => {
    if (error instanceof MandateProposalError)
      return {
        status: STATUS[error.code],
        body: { error: error.code, message: error.message },
      };
    if (error instanceof z.ZodError)
      return {
        status: 400,
        body: { error: 'INVALID_REQUEST', message: 'Request is invalid' },
      };
    throw error;
  };
  const publicView = async (id: string) => {
    const v = await deps.service.view(id);
    const p = v.proposal;
    return {
      proposalId: p.proposalId,
      groupId: p.groupId,
      change: p.change,
      securitySensitive: p.securitySensitive,
      mandate: p.mandate,
      mandateHash: p.mandateHash,
      safeTx: p.safeTx,
      safeTxHash: p.safeTxHash,
      state: p.state,
      required: v.required,
      counted: v.counted,
      executionTx: p.executionTx,
      reason: p.reason,
      proposedBy: p.proposedBy,
    };
  };

  api.get('/v1/mandate-proposals/:proposalId', async (request, reply) => {
    try {
      return await publicView(Id.parse(request.params).proposalId);
    } catch (error) {
      const f = fail(error);
      return reply.code(f.status).send(f.body);
    }
  });

  api.post(
    '/v1/mandate-proposals/:proposalId/approvals',
    async (request, reply) => {
      try {
        const { proposalId } = Id.parse(request.params);
        const body = ApprovalBody.parse(request.body);
        await deps.service.approve(proposalId, {
          memberId: body.memberId,
          signature: body.signature as `0x${string}`,
        });
        return await publicView(proposalId);
      } catch (error) {
        const f = fail(error);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  api.post('/v1/mandate-proposals', async (request, reply) => {
    try {
      const body = ProposeBody.parse(request.body);
      const caller = admin(request.headers.authorization)
        ? ({ kind: 'ADMIN' } as const)
        : await callerFor(
            request.headers.authorization,
            body.groupId.toLowerCase(),
            { adminToken: null, memberAccess: deps.memberAccess },
          );
      if (!mayPropose(caller))
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      if (
        caller.kind === 'MEMBER' &&
        !(perMember.take(caller.principalId) && perGroup.take(caller.groupId))
      )
        return reply
          .code(429)
          .send({ error: 'RATE_LIMITED', message: 'Too many proposals' });
      const p = await deps.service.propose({
        ...body,
        proposedBy:
          caller.kind === 'ADMIN'
            ? { memberId: null, source: 'OPERATOR' }
            : { memberId: caller.memberId, source: 'MEMBER' },
      });
      return reply.code(201).send(await publicView(p.proposalId));
    } catch (error) {
      const f = fail(error);
      return reply.code(f.status).send(f.body);
    }
  });
}
