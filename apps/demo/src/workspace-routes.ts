import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AcceptInviteSchema,
  CompleteLoginSchema,
  WorkspaceError,
  WorkspaceIdSchema,
  loginTypedData,
  PostgresWorkspaceStore,
  workspaceView,
} from '@synq/workspaces';

const COOKIE = '__Host-synq_workspace';
export function workspaceCapabilities() {
  const blocked = (reason: string) => ({ status: 'BLOCKED' as const, reason });
  return {
    chainId: 5042002,
    network: 'Arc testnet',
    moneyApproval: 'OWNER_EIP712_KERNEL_ONE_USE_GRANT',
    workspaces: { status: 'AVAILABLE', scope: 'IDENTITY_AND_FORMATION_ONLY' },
    vaultCreation: blocked(
      'Owner-signed setup, Kernel admission and sponsor outbox are not connected yet.',
    ),
    circleWallets: blocked(
      'Requires Circle credentials and a verified wallet adapter.',
    ),
    gasStation: blocked('Requires Circle Wallets and a sponsorship policy.'),
    usyc: blocked('Requires a per-wallet eligibility check.'),
    earn: blocked('Requires workspace reserves and owner-signed execution.'),
    swap: blocked('Requires workspace owner-signed guarded execution.'),
    duffel: blocked('Workspace booking integration is not connected.'),
    lithic: blocked('Workspace sandbox card integration is not connected.'),
    cctp: blocked('Workspace settlement integration is not connected.'),
    gateway: blocked('Workspace settlement integration is not connected.'),
    channelBinding: blocked(
      'Requires authenticated channel-link proof; URL parameters are not proof.',
    ),
  };
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  store: PostgresWorkspaceStore,
) {
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
  app.get('/v2/capabilities', (_req, reply) =>
    handle(reply, async () => workspaceCapabilities()),
  );
  app.post('/v2/auth/challenge', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      // Native clients sign the same configured origin in their explicit native audience.
      if ((req.body as { audience?: unknown } | null)?.audience !== 'native')
        origin(req);
      const challenge = await store.challenge(req.body);
      return {
        challengeId: challenge.id,
        typedData: loginTypedData(challenge),
      };
    }),
  );
  app.post('/v2/auth/session', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      const body = CompleteLoginSchema.parse(req.body);
      // Web sessions can be set only by a same-origin request. Native sessions never set cookies.
      const r = await store.pool.query(
        'SELECT data FROM synq_ws_challenges WHERE id=$1',
        [body.challengeId],
      );
      if (r.rows[0]?.data?.audience !== 'native') origin(req);
      const session = await store.login(
        body.challengeId,
        body.signature as `0x${string}`,
      );
      if (session.audience === 'web') {
        reply.header(
          'set-cookie',
          `${COOKIE}=${session.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`,
        );
        return {
          principalId: session.principalId,
          expiresAt: session.expiresAt,
        };
      }
      return {
        principalId: session.principalId,
        expiresAt: session.expiresAt,
        token: session.token,
      };
    }),
  );
  app.post('/v2/auth/logout', (req, reply) =>
    handle(reply, async () => {
      await auth(req, true);
      const t = token(req);
      await store.logout(t.value);
      if (t.audience === 'web')
        reply.header(
          'set-cookie',
          `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        );
      return { ok: true };
    }),
  );
  app.get('/v2/auth/me', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return { principalId: session.principalId };
    }),
  );
  app.get('/v2/workspaces', (req, reply) =>
    handle(reply, async () => ({
      workspaces: await store.list((await auth(req)).principalId),
    })),
  );
  app.post('/v2/workspaces', (req, reply) =>
    handle(reply, async () =>
      workspaceView(
        await store.create((await auth(req, true)).principalId, req.body),
      ),
    ),
  );
  app.get('/v2/workspaces/:workspaceId', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return workspaceView(await store.get(await id(req), session.principalId));
    }),
  );
  app.post('/v2/workspaces/:workspaceId/invites', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return store.invite(await id(req), session.principalId, req.body);
    }),
  );
  app.post('/v2/workspace-invites/accept', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return store.accept(
        session.principalId,
        AcceptInviteSchema.parse(req.body).token,
      );
    }),
  );
}
