import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  WorkspaceError,
  WorkspaceIdSchema,
  type PostgresWorkspaceStore,
} from '@synq/workspaces';
import { IdentityError } from '@synq/identity';

/*
 * Request plumbing shared by the /v2 and /v3 workspace routes: error mapping,
 * the origin check for cookie mutations, session lookup and throttles. One
 * copy, so both API versions authenticate the same way.
 */

export const COOKIE = '__Host-synq_workspace';

export function workspaceHttp(store: PostgresWorkspaceStore) {
  const handle = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    reply.header('cache-control', 'no-store');
    try {
      return reply.send(await run());
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: 'INVALID_REQUEST',
          message: 'Invalid workspace request.',
        });
      if (error instanceof WorkspaceError)
        return reply.code(error.status).send({
          error: error.code,
          message: error.code.replaceAll('_', ' ').toLowerCase(),
        });
      if (error instanceof IdentityError)
        return reply.code(403).send({
          error: error.code,
          message:
            'Channel identity proof or wallet signature was not accepted.',
        });
      // SQL errors may contain session hashes or invite digests. Never log request data.
      return reply.code(500).send({
        error: 'WORKSPACE_UNAVAILABLE',
        message: 'Workspace service unavailable.',
      });
    }
  };
  const origin = (req: FastifyRequest) => {
    if (req.headers.origin !== store.origin)
      throw new WorkspaceError('ORIGIN_MISMATCH', 403);
  };
  const token = (req: FastifyRequest) => {
    const bearer = req.headers.authorization;
    if (bearer !== undefined) {
      if (!/^Bearer [0-9a-f]{64}$/.test(bearer))
        throw new WorkspaceError('UNAUTHENTICATED', 401);
      return { value: bearer.slice(7), audience: 'native' as const };
    }
    const cookies = (req.headers.cookie ?? '').split(';').map((p) => p.trim());
    const found = cookies.filter((p) => p.startsWith(`${COOKIE}=`));
    if (found.length !== 1) throw new WorkspaceError('UNAUTHENTICATED', 401);
    return {
      value: found[0]!.slice(COOKIE.length + 1),
      audience: 'web' as const,
    };
  };
  const auth = async (req: FastifyRequest, mutation = false) => {
    const t = token(req);
    if (t.audience === 'web' && mutation) origin(req);
    const session = await store.session(t.value, t.audience);
    await store.throttle(`principal:${session.principalId}`, 120);
    return session;
  };
  const id = async (req: FastifyRequest) => {
    const workspaceId = z
      .strictObject({ workspaceId: WorkspaceIdSchema })
      .parse(req.params).workspaceId;
    await store.throttle(`workspace:${workspaceId}`, 240);
    return workspaceId;
  };
  const anonymous = async (req: FastifyRequest) => {
    const address = createHash('sha256').update(req.ip).digest('hex');
    await store.throttle(`auth:${address}`, 20);
  };
  return { handle, origin, token, auth, id, anonymous };
}
