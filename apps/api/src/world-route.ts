import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { callerFor, mayReadWorld, type MemberAccess } from './member-scope.js';

/**
 * GET /v1/world/:groupId: the group's world projection, for the operator or a
 * member session of that group holding an explicit world-read scope.
 */
export function registerWorldRoute(
  app: FastifyInstance,
  deps: {
    adminToken: string | null;
    /** Resolved per request: member sessions are wired after this route. */
    memberAccess: () => MemberAccess | undefined;
    groupExists: (groupId: string) => Promise<boolean>;
    /** GROUP for member sessions: only intents provably bound to the group. */
    build: (groupId: string, intentScope: 'ALL' | 'GROUP') => Promise<unknown>;
  },
) {
  app.get('/v1/world/:groupId', async (request, reply) => {
    const parsed = z
      .object({ groupId: z.string().min(1).max(128) })
      .safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const groupId = parsed.data.groupId.toLowerCase();
    const memberAccess = deps.memberAccess();
    const caller = await callerFor(request.headers.authorization, groupId, {
      adminToken: deps.adminToken,
      ...(memberAccess ? { memberAccess } : {}),
    });
    if (!mayReadWorld(caller))
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    if (!(await deps.groupExists(groupId)))
      return reply.code(404).send({ error: 'GROUP_NOT_FOUND' });
    return deps.build(groupId, caller.kind === 'ADMIN' ? 'ALL' : 'GROUP');
  });
}
