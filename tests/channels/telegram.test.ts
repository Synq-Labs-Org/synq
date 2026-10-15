import { describe, expect, it } from 'vitest';
import {
  ChannelDeliveryError,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  signTelegramLoginForTest,
  verifyTelegramLogin,
} from '@synq/channels';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const BOT = { id: 42, username: 'synq_bot' };
type Call = { method: string; body: Record<string, unknown> };

function fakeFetch(
  responder: (call: Call) => { status?: number; body: unknown },
) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const call = { method, body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}
const noWait = async () => undefined;
const adapter = (responder: Parameters<typeof fakeFetch>[0], extra = {}) => {
  const { f, calls } = fakeFetch(responder);
  const a = new TelegramAdapter({
    api: new TelegramBotApi({ token: TOKEN, fetch: f }),
    bot: BOT,
    webhookSecret: 'secret_secret_secret_1',
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    ...extra,
  });
  return { a, calls };
};
const msg = (over: Record<string, unknown>) => ({
  update_id: 7,
  message: {
    message_id: 5,
    date: 1_800_000_000,
    chat: { id: -100, type: 'supergroup', title: 'Trip' },
    from: { id: 111, is_bot: false, first_name: 'Alice', username: 'alice' },
    ...over,
  },
});

describe('telegram adapter', () => {
  it('verifies the webhook secret token in constant time and rejects bad or missing secrets', () => {
    const { a } = adapter(() => ({ body: { ok: true } }));
    expect(a.verifyWebhook('secret_secret_secret_1')).toBe(true);
    expect(a.verifyWebhook('secret_secret_secret_2')).toBe(false);
    expect(a.verifyWebhook(undefined)).toBe(false);
    expect(a.verifyWebhook(['secret_secret_secret_1'])).toBe(false);
    const { a: open } = adapter(() => ({ body: { ok: true } }), {
      webhookSecret: undefined,
    });
    expect(open.verifyWebhook('anything')).toBe(false);
  });

  it('normalizes commands, mentions and replies with privacy-mode addressing', () => {
    const { a } = adapter(() => ({ body: { ok: true } }));
    const [cmd] = a.normalize(
      msg({
        text: '/send@synq_bot 1 bob',
        entities: [{ type: 'bot_command', offset: 0, length: 14 }],
      }),
    );
    expect(cmd).toMatchObject({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        eventId: 'update:42:7',
        externalGroupId: '-100',
        externalUserId: '111',
        chatKind: 'GROUP',
        interaction: {
          kind: 'COMMAND',
          addressedToBot: true,
          command: 'send',
          args: '1 bob',
        },
        verifiedSender: { displayName: '@alice', isBot: false },
      },
    });
    const [other] = a.normalize(
      msg({
        text: '/send@other_bot 1',
        entities: [{ type: 'bot_command', offset: 0, length: 15 }],
      }),
    );
    expect(
      other?.type === 'MESSAGE_RECEIVED' &&
        other.envelope.interaction.addressedToBot,
    ).toBe(false);
    const [mention] = a.normalize(
      msg({
        text: 'hey @synq_bot balance?',
        entities: [{ type: 'mention', offset: 4, length: 9 }],
      }),
    );
    expect(
      mention?.type === 'MESSAGE_RECEIVED' && mention.envelope.interaction.kind,
    ).toBe('MENTION');
    const [reply] = a.normalize(
      msg({
        text: 'and now?',
        reply_to_message: {
          message_id: 4,
          from: { id: 42, is_bot: true, first_name: 'Synq' },
        },
      }),
    );
    expect(
      reply?.type === 'MESSAGE_RECEIVED' &&
        reply.envelope.interaction.addressedToBot,
    ).toBe(true);
    const [chatter] = a.normalize(msg({ text: 'lunch?' }));
    expect(
      chatter?.type === 'MESSAGE_RECEIVED' &&
        chatter.envelope.interaction.addressedToBot,
    ).toBe(false);
  });

  it('normalizes membership, bot addition, callbacks and ignores channels and junk', () => {
    const { a } = adapter(() => ({ body: { ok: true } }));
    expect(
      a.normalize(
        msg({
          new_chat_members: [{ id: 222, is_bot: false, first_name: 'Bob' }],
        }),
      )[0]?.type,
    ).toBe('MEMBER_JOINED');
    expect(
      a.normalize(
        msg({
          left_chat_member: { id: 222, is_bot: false, first_name: 'Bob' },
        }),
      )[0]?.type,
    ).toBe('MEMBER_LEFT');
    expect(
      a.normalize({
        update_id: 8,
        my_chat_member: {
          chat: { id: -100, type: 'group', title: 'Trip' },
          from: { id: 111, is_bot: false, first_name: 'Alice' },
          date: 1_800_000_000,
          old_chat_member: { status: 'left' },
          new_chat_member: {
            status: 'member',
            user: { id: 42, is_bot: true, first_name: 'Synq' },
          },
        },
      })[0]?.type,
    ).toBe('GROUP_CREATED');
    const cb = a.normalize({
      update_id: 9,
      callback_query: {
        id: 'q1',
        from: { id: 111, is_bot: false, first_name: 'Alice' },
        data: 'approve:0x00',
        message: {
          message_id: 3,
          date: 1_800_000_000,
          chat: { id: -100, type: 'group' },
        },
      },
    });
    expect(cb[0]).toMatchObject({ type: 'ACTION_REQUESTED', callbackId: 'q1' });
    expect(
      a.normalize(msg({ chat: { id: -5, type: 'channel' }, text: '/balance' })),
    ).toEqual([]);
    expect(a.normalize({ nonsense: true })).toEqual([]);
  });

  it('sends URL buttons, inlines local URLs Telegram would reject, and honours 429 retry_after', async () => {
    let n = 0;
    const waits: number[] = [];
    const { a, calls } = adapter(
      () =>
        ++n === 1
          ? {
              status: 429,
              body: {
                ok: false,
                error_code: 429,
                description: 'Too Many Requests',
                parameters: { retry_after: 7 },
              },
            }
          : { body: { ok: true, result: { message_id: 99 } } },
      { sleep: async (ms: number) => void waits.push(ms) },
    );
    const sent = await a.send('-100', {
      text: 'Approve',
      replyTo: '5',
      buttons: [
        { label: 'Review', url: 'https://synq.example/intents/0x1' },
        { label: 'Local', url: 'http://localhost:3000/send' },
      ],
    });
    expect(sent).toEqual({ messageId: '99' });
    expect(waits).toEqual([7000]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({
      chat_id: -100,
      text: 'Approve\nLocal: http://localhost:3000/send',
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Review', url: 'https://synq.example/intents/0x1' }],
        ],
      },
    });
  });

  it('reports provider outage and rejection as typed delivery errors without leaking the token', async () => {
    const { a: down } = adapter(() => ({
      status: 502,
      body: { ok: false, description: `bad gateway ${TOKEN}` },
    }));
    const error = await down.send('-100', { text: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(ChannelDeliveryError);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', attempts: 3 });
    expect(String(error.message)).not.toContain(TOKEN);
    const { a: rejected } = adapter(() => ({
      status: 403,
      body: { ok: false, error_code: 403, description: 'bot was kicked' },
    }));
    expect(
      await rejected.send('-100', { text: 'x' }).catch((e) => e.code),
    ).toBe('PROVIDER_REJECTED');
    expect(
      await rejected.send('chat; drop', { text: 'x' }).catch((e) => e.code),
    ).toBe('PROVIDER_REJECTED');
  });

  it('does not advance the poll offset past an update whose handling failed', async () => {
    const controller = new AbortController();
    const handled: string[] = [];
    let attempts = 0;
    const { a, calls } = adapter((call) => {
      if (call.method !== 'getUpdates') return { body: { ok: true } };
      if (call.body.offset === 9) {
        controller.abort();
        return { body: { ok: true, result: [] } };
      }
      return {
        body: {
          ok: true,
          result: [
            msg({ text: 'hi' }),
            { ...msg({ text: 'yo' }), update_id: 8 },
          ],
        },
      };
    });
    await a.poll({
      signal: controller.signal,
      handle: async (e) => {
        const body = e.type === 'MESSAGE_RECEIVED' ? e.envelope.body : '';
        if (body === 'yo' && attempts++ === 0)
          throw new Error('DATABASE_UNAVAILABLE');
        handled.push(body);
      },
    });
    const offsets = calls
      .filter((c) => c.method === 'getUpdates')
      .map((c) => c.body.offset);
    expect(offsets).toEqual([undefined, 8, 9]);
    expect(handled).toEqual(['hi', 'hi', 'yo']);
  });

  it('long-polls with an advancing offset and calls getMe on init', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    let polls = 0;
    const { a, calls } = adapter((call) => {
      if (call.method === 'getMe')
        return {
          body: {
            ok: true,
            result: {
              id: 42,
              is_bot: true,
              first_name: 'Synq',
              username: 'synq_bot',
            },
          },
        };
      polls++;
      if (polls === 1)
        return {
          body: {
            ok: true,
            result: [
              msg({ text: 'hi' }),
              { ...msg({ text: 'yo' }), update_id: 8 },
            ],
          },
        };
      controller.abort();
      return { body: { ok: true, result: [] } };
    });
    expect(await a.init()).toMatchObject({ ...BOT, privacyMode: true });
    await a.poll({
      signal: controller.signal,
      handle: async (e) =>
        void seen.push(
          e.type === 'MESSAGE_RECEIVED' ? e.envelope.body : e.type,
        ),
    });
    expect(seen).toEqual(['hi', 'yo']);
    const updates = calls.filter((c) => c.method === 'getUpdates');
    expect(updates[0]!.body.offset).toBeUndefined();
    expect(updates[1]!.body.offset).toBe(9);
    expect(updates[0]!.body.allowed_updates).toEqual([
      'message',
      'callback_query',
      'my_chat_member',
      'guest_message',
    ]);
  });

  it('rejects malformed tokens before any request', () => {
    expect(() => new TelegramBotApi({ token: 'nope' })).toThrow(
      'TELEGRAM_TOKEN_MALFORMED',
    );
  });

  it('verifies Telegram Login data with the bot-token-derived key and freshness', () => {
    const now = 1_800_000_000;
    const login = signTelegramLoginForTest(
      { id: 111, first_name: 'Alice', username: 'alice', auth_date: now - 5 },
      TOKEN,
    );
    expect(verifyTelegramLogin(login, TOKEN, now)).toBe('111');
    expect(verifyTelegramLogin({ ...login, id: 222 }, TOKEN, now)).toBeNull();
    expect(
      verifyTelegramLogin(
        login,
        '999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        now,
      ),
    ).toBeNull();
    expect(verifyTelegramLogin(login, TOKEN, now + 3600)).toBeNull();
    expect(
      verifyTelegramLogin({ ...login, extra: 'x' }, TOKEN, now),
    ).toBeNull();
  });

  it('builds t.me deep links only for safe payloads', () => {
    const { a } = adapter(() => ({ body: { ok: true } }));
    expect(a.deepLink('abc_DEF-123')).toBe(
      'https://t.me/synq_bot?start=abc_DEF-123',
    );
    expect(a.deepLink('bad payload')).toBeNull();
  });

  it('maps getChatMember status to chat roles', async () => {
    const statuses = ['creator', 'administrator', 'member', 'left'];
    let i = 0;
    const { a, calls } = adapter(() => ({
      body: { ok: true, result: { status: statuses[i++] } },
    }));
    expect(await a.chatRole('-100', '111')).toBe('OWNER');
    expect(await a.chatRole('-100', '111')).toBe('ADMIN');
    expect(await a.chatRole('-100', '111')).toBe('MEMBER');
    expect(await a.chatRole('-100', '111')).toBe('NONE');
    expect(await a.chatRole('-100; x', '111')).toBe('NONE');
    expect(calls[0]).toEqual({
      method: 'getChatMember',
      body: { chat_id: -100, user_id: 111 },
    });
    expect(calls).toHaveLength(4);
  });
});

describe('telegram card keyboard', () => {
  it('renders URL buttons and read-only callback buttons, dropping oversized callback data', async () => {
    const { a, calls } = adapter(() => ({
      body: { ok: true, result: { message_id: 9 } },
    }));
    await a.send('-100', {
      text: 'Approval needed',
      buttons: [
        {
          label: 'Review and approve',
          url: 'https://synq.example/approve?p=1',
        },
      ],
      callbacks: [
        { label: 'Refresh status', data: `r:${'a'.repeat(48)}` },
        { label: 'too big', data: 'x'.repeat(65) },
      ],
    });
    expect(calls[0]!.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: 'Review and approve',
            url: 'https://synq.example/approve?p=1',
          },
        ],
        [{ text: 'Refresh status', callback_data: `r:${'a'.repeat(48)}` }],
      ],
    });
  });
});
