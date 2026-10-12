import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FundingRequestSchema,
  type DestinationReceipt,
  type FundingActivities,
  type FundingSession,
} from '@synq/funding';
import { callerFor, mayFund } from './member-scope.js';
import type { SendRouteDeps } from './send-routes.js';

export type FundingRouteDeps = {
  activities: FundingActivities;
  sessions: { get(sessionId: string): Promise<FundingSession | null> };
  context: SendRouteDeps['groups']['context'];
  now(): number;
  adminToken: string | null;
  memberAccess?: SendRouteDeps['memberAccess'];
  receipt(
    session: FundingSession,
    hash: `0x${string}`,
  ): Promise<DestinationReceipt>;
};

/** Funding sessions: the operator, or a MEMBER_CONTRIBUTE session funding from its own signer. */
export async function fundingRoutes(
  app: FastifyInstance,
  deps: FundingRouteDeps,
) {
  const id = z.string().regex(/^0x[0-9a-f]{64}$/);
  const unauthorized = { error: 'UNAUTHORIZED' };
  /** Load a session the caller may act on; unknown and foreign sessions look alike to members. */
  const owned = async (header: string | undefined, sessionId: string) => {
    const s = await deps.sessions.get(sessionId);
    const caller = s
      ? await callerFor(header, s.groupId.toLowerCase(), deps)
      : await callerFor(header, '', deps);
    if (caller?.kind === 'ADMIN') return s ? { s } : { status: 404 as const };
    if (!s || !mayFund(caller, s.quote.sourceSender ?? ''))
      return { status: 401 as const };
    return { s };
  };
  app.post('/v1/funding/quotes', async (req, reply) => {
    const request = FundingRequestSchema.parse(req.body);
    const caller = await callerFor(
      req.headers.authorization,
      request.groupId.toLowerCase(),
      deps,
    );
    if (
      !mayFund(caller, request.source.sender) ||
      (caller.kind === 'MEMBER' &&
        request.source.refundTo.toLowerCase() !== caller.signer.toLowerCase())
    )
      return reply.code(401).send(unauthorized);
    const context = await deps.context(request.groupId);
    if (
      !context ||
      context.mandate.account !== request.destination.account ||
      !context.members.some(
        (m) => m.signer.toLowerCase() === request.source.sender.toLowerCase(),
      )
    )
      return reply.code(403).send({ error: 'FUNDING_BINDING_INVALID' });
    const now = deps.now();
    const plan = await deps.activities.planRoute({ ...request, now });
    if (plan.status !== 'ROUTED') return reply.code(422).send(plan);
    return deps.activities.openFromPlan({
      groupId: request.groupId,
      plan,
      now,
    });
  });
  app.get('/v1/funding/:sessionId', async (req, reply) => {
    const { sessionId } = z.object({ sessionId: id }).parse(req.params);
    const r = await owned(req.headers.authorization, sessionId);
    if (!r.s)
      return reply
        .code(r.status)
        .send(r.status === 404 ? { error: 'FUNDING_NOT_FOUND' } : unauthorized);
    return r.s;
  });
  app.post('/v1/funding/:sessionId/authorize', async (req, reply) => {
    const { sessionId } = z.object({ sessionId: id }).parse(req.params);
    const r = await owned(req.headers.authorization, sessionId);
    if (!r.s)
      return reply
        .code(r.status)
        .send(r.status === 404 ? { error: 'FUNDING_NOT_FOUND' } : unauthorized);
    return deps.activities.authorize(sessionId, deps.now());
  });
  app.post('/v1/funding/:sessionId/source', async (req, reply) => {
    const { sessionId } = z.object({ sessionId: id }).parse(req.params);
    const { transactionHash } = z
      .strictObject({ transactionHash: id })
      .parse(req.body);
    const r = await owned(req.headers.authorization, sessionId);
    if (!r.s)
      return reply
        .code(r.status)
        .send(r.status === 404 ? { error: 'FUNDING_NOT_FOUND' } : unauthorized);
    return deps.activities.recordSource(
      sessionId,
      await deps.receipt(r.s, transactionHash as `0x${string}`),
      deps.now(),
    );
  });
  app.post('/v1/funding/:sessionId/reconcile', async (req, reply) => {
    const { sessionId } = z.object({ sessionId: id }).parse(req.params);
    const r = await owned(req.headers.authorization, sessionId);
    if (!r.s)
      return reply
        .code(r.status)
        .send(r.status === 404 ? { error: 'FUNDING_NOT_FOUND' } : unauthorized);
    const now = deps.now();
    await deps.activities.observeDestination(sessionId, now);
    const s = await deps.activities.confirmIndexed(sessionId, now);
    return s.state === 'INDEXED' || s.state === 'CREDITED'
      ? deps.activities.credit(sessionId, now)
      : s;
  });
}
