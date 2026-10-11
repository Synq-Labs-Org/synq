import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  TELEGRAM_SECRET_HEADER,
  channelCapabilities,
  type ChannelGateway,
  type LinqV3Adapter,
  type TelegramAdapter,
} from '@synq/channels';

export type ChannelRouteDeps = {
  gateway: ChannelGateway;
  telegram?: TelegramAdapter;
  linq?: LinqV3Adapter;
  /** Resolves a member session issued by the existing passkey Send access flow. */
  memberSession(
    token: string,
    groupId: string,
  ): Promise<{ memberId: string; principalId: string } | null>;
  now: () => number;
  env?: Readonly<Record<string, string | undefined>>;
};

const CodeSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const RedeemSchema = z.strictObject({
  code: CodeSchema,
  groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const REDEEM_STATUS: Record<string, number> = {
  LINKED: 200,
  CODE_INVALID: 404,
  CODE_EXPIRED: 410,
  CODE_CONSUMED: 409,
  GROUP_LINK_CONFLICT: 409,
  USER_LINK_CONFLICT: 409,
};

/** Untrusted chat ingress plus member-authenticated link redemption. */
export async function channelRoutes(
  api: FastifyInstance,
  deps: ChannelRouteDeps,
) {
  api.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_request, body, done) => done(null, body),
  );
  const json = (raw: unknown): unknown => {
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  };

  api.post('/v1/channels/telegram/webhook', async (request, reply) => {
    const telegram = deps.telegram;
    if (!telegram)
      return reply.code(404).send({ error: 'CHANNEL_NOT_CONFIGURED' });
    if (!telegram.verifyWebhook(request.headers[TELEGRAM_SECRET_HEADER]))
      return reply.code(401).send({ error: 'WEBHOOK_SECRET_INVALID' });
    const events = telegram.normalize(
      json(request.body),
      'WEBHOOK_SECRET_TOKEN',
    );
    const outcomes = [];
    for (const event of events)
      outcomes.push((await deps.gateway.handle(event)).status);
    return reply.code(200).send({ ok: true, outcomes });
  });

  api.post('/v1/channels/linq/webhook', async (request, reply) => {
    const linq = deps.linq;
    if (!linq) return reply.code(404).send({ error: 'CHANNEL_NOT_CONFIGURED' });
    const raw = String(request.body ?? '');
    const verified = linq.verify(
      request.headers as Record<string, string | string[] | undefined>,
      raw,
      deps.now(),
    );
    if (!verified.ok) return reply.code(401).send({ error: verified.code });
    const events = linq.normalize(json(raw), verified.webhookId, deps.now());
    const outcomes = [];
    for (const event of events)
      outcomes.push((await deps.gateway.handle(event)).status);
    return reply.code(200).send({ ok: true, outcomes });
  });

  api.get('/v1/channels/links/:code', async (request, reply) => {
    const parsed = z
      .strictObject({ code: CodeSchema })
      .safeParse(request.params);
    const view = parsed.success
      ? await deps.gateway.linkCodePreview(parsed.data.code)
      : null;
    return view ? view : reply.code(404).send({ error: 'CODE_INVALID' });
  });

  api.post('/v1/channels/links/redeem', async (request, reply) => {
    const body = RedeemSchema.safeParse(json(request.body));
    if (!body.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const groupId = body.data.groupId.toLowerCase();
    const session = token ? await deps.memberSession(token, groupId) : null;
    if (!session)
      return reply.code(401).send({ error: 'MEMBER_ACCESS_REQUIRED' });
    const outcome = await deps.gateway.redeemLinkCode({
      code: body.data.code,
      groupId,
      principalId: session.principalId,
    });
    return reply.code(REDEEM_STATUS[outcome.status] ?? 409).send(
      outcome.status === 'LINKED'
        ? {
            status: 'LINKED',
            channel: outcome.group.channel,
            memberId: session.memberId,
          }
        : { error: outcome.status },
    );
  });

  api.get('/v1/channels/capabilities', async () =>
    channelCapabilities(deps.env ?? {}),
  );
}
