import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { callerFor, mayPropose } from './member-scope.js';
import type { SendRouteDeps } from './send-routes.js';
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

/** Review and owner approval of mandate proposals; creation is operator-only. */
export async function mandateRoutes(
  api: FastifyInstance,
  deps: {
    service: MandateProposalService;
    adminToken: string | null;
    memberAccess?: SendRouteDeps['memberAccess'];
  },
) {
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
