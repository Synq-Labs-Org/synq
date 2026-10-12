import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  TELEGRAM_SECRET_HEADER,
  webhookTokenMatches,
  channelCapabilities,
  type ChannelGateway,
  type IMessageBridge,
  type IMessageTransport,
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
  /** Telegram Login verification for link redemption (binds the web session to the chat user). */
  telegramLogin?: {
    botId: number;
    required: boolean;
    verify(raw: unknown, nowSeconds: number): string | null;
  };
  env?: Readonly<Record<string, string | undefined>>;
  /** Local iMessage bridge (BlueBubbles pushes webhooks to the API on the same Mac). */
  imessage?: {
    bridge: IMessageBridge;
    transport: IMessageTransport;
    webhookToken: string | null;
  };
};

const CodeSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const RedeemSchema = z.strictObject({
  code: CodeSchema,
  groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  telegramLogin: z.record(z.string(), z.unknown()).optional(),
});
const REDEEM_STATUS: Record<string, number> = {
  LINKED: 200,
  CODE_INVALID: 404,
  CODE_EXPIRED: 410,
  CODE_CONSUMED: 409,
  GROUP_LINK_CONFLICT: 409,
  USER_LINK_CONFLICT: 409,
  EXTERNAL_PROOF_REQUIRED: 403,
  EXTERNAL_IDENTITY_MISMATCH: 403,
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

  api.post('/v1/channels/imessage/webhook/:token', async (request, reply) => {
    const im = deps.imessage;
    const token = (request.params as { token?: string }).token ?? '';
    if (!im?.webhookToken)
      return reply.code(404).send({ error: 'CHANNEL_NOT_CONFIGURED' });
    if (!webhookTokenMatches(im.webhookToken, token))
      return reply.code(401).send({ error: 'WEBHOOK_TOKEN_INVALID' });
    const outcomes = [];
    for (const m of im.transport.parseEvent(json(request.body)))
      outcomes.push((await im.bridge.ingest(m, 'WEBHOOK')).status);
    return reply.code(200).send({ ok: true, outcomes });
  });

  api.get('/v1/channels/links/:code', async (request, reply) => {
    const parsed = z
      .strictObject({ code: CodeSchema })
      .safeParse(request.params);
    const view = parsed.success
      ? await deps.gateway.linkCodePreview(parsed.data.code)
      : null;
    if (!view) return reply.code(404).send({ error: 'CODE_INVALID' });
    return {
      ...view,
      telegramLogin:
        view.channel === 'telegram' && deps.telegramLogin
          ? {
              botId: deps.telegramLogin.botId,
              required: deps.telegramLogin.required,
            }
          : null,
    };
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
    let proven: string | undefined;
    if (body.data.telegramLogin !== undefined) {
      const id = deps.telegramLogin?.verify(
        body.data.telegramLogin,
        deps.now(),
      );
      if (!id) return reply.code(401).send({ error: 'TELEGRAM_LOGIN_INVALID' });
      proven = id;
    }
    const outcome = await deps.gateway.redeemLinkCode({
      code: body.data.code,
      groupId,
      principalId: session.principalId,
      ...(proven !== undefined ? { provenExternalUserId: proven } : {}),
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

  api.post('/v1/channels/links/unlink', async (request, reply) => {
    const body = z
      .strictObject({
        groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        channel: z.enum(['telegram', 'linq', 'imessage']),
        externalGroupId: z.string().min(1).max(200),
      })
      .safeParse(json(request.body));
    if (!body.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const groupId = body.data.groupId.toLowerCase();
    const session = token ? await deps.memberSession(token, groupId) : null;
    if (!session)
      return reply.code(401).send({ error: 'MEMBER_ACCESS_REQUIRED' });
    const outcome = await deps.gateway.unlinkChat({
      channel: body.data.channel,
      externalGroupId: body.data.externalGroupId,
      groupId,
      principalId: session.principalId,
    });
    return reply
      .code(outcome === 'UNLINKED' ? 200 : outcome === 'NOT_LINKED' ? 404 : 403)
      .send(outcome === 'UNLINKED' ? { status: outcome } : { error: outcome });
  });

  const CardLinkSchema = z.strictObject({
    proposalId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
    groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    nonce: z.string().min(1).max(200),
  });
  const CARD_STATUS: Record<string, number> = {
    OK: 200,
    NOT_PENDING: 200,
    CARDS_DISABLED: 404,
    LINK_MALFORMED: 400,
    LINK_INVALID: 403,
    LINK_EXPIRED: 410,
    NOT_A_MEMBER: 403,
    PROPOSAL_NOT_FOUND: 404,
  };
  /** A tapped card link: member-authenticated, group-bound, canonical read; never an approval. */
  api.post('/v1/cards/resolve', async (request, reply) => {
    const body = CardLinkSchema.safeParse(json(request.body));
    if (!body.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const groupId = body.data.groupId.toLowerCase();
    const session = token ? await deps.memberSession(token, groupId) : null;
    if (!session)
      return reply.code(401).send({ error: 'MEMBER_ACCESS_REQUIRED' });
    const outcome = await deps.gateway.resolveCardLink({
      proposalId: body.data.proposalId,
      groupId,
      nonce: body.data.nonce,
      principalId: session.principalId,
    });
    const code = CARD_STATUS[outcome.status] ?? 403;
    return reply
      .code(code)
      .send(code === 200 ? outcome : { error: outcome.status });
  });

  api.get('/v1/cards/status', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const parsed = CardLinkSchema.safeParse({
      proposalId: q.p,
      groupId: q.g,
      nonce: q.n,
    });
    if (!parsed.success)
      return reply.code(400).send({ error: 'INVALID_REQUEST' });
    const outcome = await deps.gateway.cardLinkStatus({
      ...parsed.data,
      groupId: parsed.data.groupId.toLowerCase(),
    });
    const code = CARD_STATUS[outcome.status] ?? 403;
    return reply
      .code(code)
      .header('cache-control', 'no-store')
      .send(code === 200 ? outcome : { error: outcome.status });
  });

  api.get('/v1/channels/capabilities', async () =>
    channelCapabilities(deps.env ?? {}),
  );
}
