import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  LinqV3Adapter,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  signLinqWebhookForTest,
  signTelegramLoginForTest,
  verifyTelegramLogin,
} from '@synq/channels';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { CHAT_A, GROUP_A, fixture } from './harness.js';

const SECRET = 'webhook_secret_0123456789';
const TG_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const LINQ_SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const noWait = async () => undefined;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function server(requireTelegramProof = false) {
  const f = fixture(1_800_000_000, { requireTelegramProof });
  const telegram = new TelegramAdapter({
    api: new TelegramBotApi({
      token: TG_TOKEN,
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
        )) as typeof fetch,
    }),
    bot: { id: 42, username: 'synq_bot' },
    webhookSecret: SECRET,
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
  });
  const linq = new LinqV3Adapter({ webhookSecret: LINQ_SECRET });
  app = Fastify();
  await app.register(channelRoutes, {
    gateway: f.gateway,
    telegram,
    linq,
    now: () => f.clock.t,
    telegramLogin: {
      botId: 42,
      required: requireTelegramProof,
      verify: (raw, at) => verifyTelegramLogin(raw, TG_TOKEN, at),
    },
    memberSession: async (token, groupId) =>
      token === 'alice-session' && groupId === GROUP_A
        ? { memberId: 'member_0', principalId: 'principal_alice' }
        : null,
    env: { TELEGRAM_BOT_TOKEN: 'present' },
  });
  const update = (id: number, text: string) => ({
    update_id: id,
    message: {
      message_id: id,
      date: f.clock.t,
      chat: { id: Number(CHAT_A), type: 'supergroup' },
      from: { id: 111, is_bot: false, first_name: 'Alice' },
      text,
      entities: text.startsWith('/')
        ? [
            {
              type: 'bot_command',
              offset: 0,
              length: text.split(' ')[0]!.length,
            },
          ]
        : [],
    },
  });
  return { f, update };
}

const tg = (body: unknown, secret?: string) => ({
  method: 'POST' as const,
  url: '/v1/channels/telegram/webhook',
  headers: {
    'content-type': 'application/json',
    ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
  },
  payload: JSON.stringify(body),
});

describe('channel routes', () => {
  it('rejects a Telegram webhook with a missing or wrong secret token before parsing', async () => {
    const { update, f } = await server();
    expect((await app!.inject(tg(update(1, '/synq')))).statusCode).toBe(401);
    expect(
      (await app!.inject(tg(update(1, '/synq'), 'wrong_secret_0123456789')))
        .statusCode,
    ).toBe(401);
    expect(f.store.events.size).toBe(0);
  });

  it('accepts a verified webhook once and dedupes a replay', async () => {
    const { update, f } = await server();
    const first = await app!.inject(tg(update(5, '/synq'), SECRET));
    expect(first.json()).toEqual({ ok: true, outcomes: ['HANDLED'] });
    const replay = await app!.inject(tg(update(5, '/synq'), SECRET));
    expect(replay.json()).toEqual({ ok: true, outcomes: ['DUPLICATE'] });
    expect([...f.store.codes.values()]).toHaveLength(1);
    expect((await app!.inject(tg({ junk: true }, SECRET))).json()).toEqual({
      ok: true,
      outcomes: [],
    });
  });

  it('redeems a link code only with a member session for that group', async () => {
    const { update, f } = await server();
    await app!.inject(tg(update(6, '/synq'), SECRET));
    const start = new URL(f.adapter.last()!.buttons![0]!.url).searchParams.get(
      'start',
    )!;
    const dm = update(7, `/start ${start}`);
    dm.message.chat = { id: 111, type: 'private' };
    await app!.inject(tg(dm, SECRET));
    expect(f.adapter.sent.at(-1)!.chat).toBe('111');
    const raw = new URL(f.adapter.last()!.buttons![0]!.url).searchParams.get(
      'code',
    )!;
    const redeem = (auth: string | null, groupId = GROUP_A) =>
      app!.inject({
        method: 'POST',
        url: '/v1/channels/links/redeem',
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        payload: JSON.stringify({ code: raw, groupId }),
      });
    expect(
      (
        await app!.inject({ method: 'GET', url: `/v1/channels/links/${raw}` })
      ).json(),
    ).toMatchObject({
      channel: 'telegram',
      groupLinked: false,
    });
    expect((await redeem(null)).statusCode).toBe(401);
    expect((await redeem('mallory')).statusCode).toBe(401);
    expect(
      (await redeem('alice-session', `0x${'c3'.repeat(32)}`)).statusCode,
    ).toBe(401);
    const ok = await redeem('alice-session');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      status: 'LINKED',
      channel: 'telegram',
      memberId: 'member_0',
    });
    expect((await redeem('alice-session')).json()).toEqual({
      error: 'CODE_CONSUMED',
    });
    expect(
      (await app!.inject({ method: 'GET', url: `/v1/channels/links/${raw}` }))
        .statusCode,
    ).toBe(404);
  });

  it('verifies Linq webhooks over the raw body and dedupes by webhook-id', async () => {
    const { f } = await server();
    const body = JSON.stringify({
      event_type: 'message.received',
      data: {
        id: 'm1',
        direction: 'inbound',
        chat: { id: 'linq_chat', is_group: true },
        sender_handle: { handle: '+15551112222', is_me: false },
        parts: [{ type: 'text', value: '/help' }],
      },
    });
    const send = (sig: string, id = 'wh_1') =>
      app!.inject({
        method: 'POST',
        url: '/v1/channels/linq/webhook',
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(f.clock.t),
          'webhook-signature': sig,
        },
        payload: body,
      });
    expect((await send('v1,AAAA')).json()).toEqual({
      error: 'SIGNATURE_INVALID',
    });
    const sig = signLinqWebhookForTest(LINQ_SECRET, 'wh_1', f.clock.t, body);
    expect((await send(sig)).json()).toEqual({
      ok: true,
      outcomes: ['HANDLED'],
    });
    expect(f.store.failures[0]).toMatchObject({
      channel: 'linq',
      externalGroupId: 'linq_chat',
    });
    expect((await send(sig)).json()).toEqual({
      ok: true,
      outcomes: ['DUPLICATE'],
    });
  });

  it('reports channel capabilities without exposing credentials', async () => {
    await server();
    const caps = (
      await app!.inject({ method: 'GET', url: '/v1/channels/capabilities' })
    ).json();
    expect(JSON.stringify(caps)).not.toContain('present');
    expect(
      caps.find((c: { channel: string }) => c.channel === 'whatsapp').status,
    ).toBe('BLOCKED_EXTERNAL');
  });

  it('binds redemption to a verified Telegram Login when required', async () => {
    const { update, f } = await server(true);
    await app!.inject(tg(update(6, '/synq'), SECRET));
    const start = new URL(f.adapter.last()!.buttons![0]!.url).searchParams.get(
      'start',
    )!;
    const dm = update(7, `/start ${start}`);
    dm.message.chat = { id: 111, type: 'private' };
    await app!.inject(tg(dm, SECRET));
    const code = new URL(f.adapter.last()!.buttons![0]!.url).searchParams.get(
      'code',
    )!;
    const preview = (
      await app!.inject({ method: 'GET', url: `/v1/channels/links/${code}` })
    ).json();
    expect(preview.telegramLogin).toEqual({ botId: 42, required: true });
    const redeem = (telegramLogin?: unknown) =>
      app!.inject({
        method: 'POST',
        url: '/v1/channels/links/redeem',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer alice-session',
        },
        payload: JSON.stringify({
          code,
          groupId: GROUP_A,
          ...(telegramLogin ? { telegramLogin } : {}),
        }),
      });
    const login = (id: number, token = TG_TOKEN) =>
      signTelegramLoginForTest(
        { id, first_name: 'X', auth_date: f.clock.t },
        token,
      );
    expect((await redeem()).json()).toEqual({
      error: 'EXTERNAL_PROOF_REQUIRED',
    });
    expect(
      (await redeem(login(111, '999:forgedforgedforgedforgedforged')))
        .statusCode,
    ).toBe(401);
    expect((await redeem(login(222))).json()).toEqual({
      error: 'EXTERNAL_IDENTITY_MISMATCH',
    });
    expect((await redeem(login(111))).json()).toMatchObject({
      status: 'LINKED',
    });
  });
});
