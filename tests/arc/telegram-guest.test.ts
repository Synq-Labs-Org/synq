import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ChannelEventSchema,
  ChannelGateway,
  ChatContextService,
  MemoryChannelStore,
  MemoryChatContextStore,
  OutboundLimiter,
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_SECRET_HEADER,
  TelegramAdapter,
  TelegramBotApi,
  channelCapabilities,
  signTelegramMiniAppInitDataForTest,
  verifyTelegramMiniAppInitData,
  type ChannelPorts,
  type ChannelStore,
  type GuestReplyInput,
} from '@synq/channels';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';

// Spy on the comparison primitive to prove the webhook check is constant-time.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const OTHER_TOKEN = '654321:ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvu';
const SECRET = 'webhook_secret_0123456789';
const NOW = 1_800_000_000;
const DAY = 86_400;
const CHAT = '-1001';
const GROUP = `0x${'a1'.repeat(32)}`;
const ALICE = 111; // linked member, chat admin
const BOB = 222; // linked member
const CAROL = 333; // in the chat, not linked
const noWait = async () => undefined;
const k = (...parts: string[]) => parts.join('\u0000');

type Call = { method: string; body: Record<string, unknown> };

/** A fake Bot API: answers the methods Synq calls and records each call. */
function botApi(opts: {
  canReadAll?: boolean | undefined;
  guest?: boolean;
  admins?: Set<string>;
  failGuest?: 'network';
  botId?: number;
}) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body =
      init?.body instanceof FormData
        ? {}
        : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    switch (method) {
      case 'getMe':
        return ok({
          id: opts.botId ?? 42,
          is_bot: true,
          first_name: 'Synq',
          username: 'synq_bot',
          ...(opts.canReadAll === undefined
            ? {}
            : { can_read_all_group_messages: opts.canReadAll }),
          supports_guest_queries: opts.guest ?? true,
        });
      case 'getChatMember':
        return ok({
          status: opts.admins?.has(String(body.user_id))
            ? 'administrator'
            : 'member',
        });
      case 'sendMessage':
        return ok({ message_id: ++n });
      case 'answerGuestQuery':
        if (opts.failGuest === 'network') throw new TypeError('fetch failed');
        return ok({ inline_message_id: `inline-${++n}` });
    }
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }),
      { status: 404 },
    );
  }) as typeof fetch;
  return { f, calls };
}

async function world(
  opts: Parameters<typeof botApi>[0] & {
    memory?: boolean;
    store?: MemoryChannelStore;
  } = {},
) {
  const clock = { t: NOW };
  const api = botApi({ canReadAll: false, admins: new Set(['111']), ...opts });
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({ token: TOKEN, fetch: api.f }),
    webhookSecret: SECRET,
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    transport: 'WEBHOOK_SECRET_TOKEN',
  });
  await adapter.init();
  const store = opts.store ?? new MemoryChannelStore();
  store.groups.set(k('telegram', CHAT), {
    channel: 'telegram',
    externalGroupId: CHAT,
    groupId: GROUP,
    linkedByPrincipalId: 'principal_alice',
    linkedAt: NOW - 100,
    status: 'ACTIVE',
  });
  for (const [user, principal] of [
    [ALICE, 'principal_alice'],
    [BOB, 'principal_bob'],
  ] as const)
    store.users.set(k('telegram', CHAT, String(user)), {
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: String(user),
      principalId: principal,
      linkedAt: NOW - 100,
      status: 'ACTIVE',
      chatAdmin: user === ALICE,
      confirmTokenHash: null,
    });
  const memory = new MemoryChatContextStore();
  const portCalls: string[] = [];
  const brainCalls: Parameters<NonNullable<ChannelPorts['brain']>>[0][] = [];
  const guestCalls: GuestReplyInput[] = [];
  const members: Record<string, string> = {
    principal_alice: 'member_0',
    principal_bob: 'member_1',
  };
  const ports: ChannelPorts = {
    activeMember: async (g, p) => {
      portCalls.push('activeMember');
      return g === GROUP && members[p] ? { memberId: members[p] } : null;
    },
    treasury: async () => (portCalls.push('treasury'), null),
    mandates: async () => (portCalls.push('mandates'), []),
    approvals: async () => (portCalls.push('approvals'), []),
    receipts: async () => (portCalls.push('receipts'), []),
    brain: async (input) => {
      brainCalls.push(input);
      return {
        text: 'Drafted a proposal for the Kernel.',
        proposals: [
          {
            kind: 'ACTION',
            status: 'PENDING_APPROVAL',
            code: null,
            intentHash: `0x${'ab'.repeat(32)}`,
          },
        ],
      };
    },
    guest: async (input) => {
      guestCalls.push(input);
      return { text: 'Draft only: 120 USDC split three ways is 40 USDC each.' };
    },
  };
  const gateway = new ChannelGateway({
    store,
    ports,
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://explorer.example/tx/',
    now: () => clock.t,
    botUsernames: { telegram: 'synq_bot' },
    brainCooldownSeconds: 0,
    guestCooldownSeconds: 0,
    ...(opts.memory === false
      ? {}
      : { context: new ChatContextService(memory) }),
  });
  let updateId = 1000;
  const groupUpdate = (from: number, text: string, id = ++updateId) => ({
    update_id: id,
    message: {
      message_id: id,
      date: clock.t,
      chat: { id: Number(CHAT), type: 'supergroup', title: 'Cabin trip' },
      from: { id: from, is_bot: false, first_name: `U${from}` },
      text,
      entities: text.startsWith('/')
        ? [
            {
              type: 'bot_command',
              offset: 0,
              length: text.split(' ')[0]!.length,
            },
          ]
        : text.includes('@synq_bot')
          ? [{ type: 'mention', offset: text.indexOf('@synq_bot'), length: 9 }]
          : [],
    },
  });
  const guestUpdate = (
    over: Record<string, unknown> = {},
    id = ++updateId,
  ) => ({
    update_id: id,
    guest_message: {
      message_id: 77,
      date: clock.t,
      // Same numeric id as the enrolled chat: a guest chat id names nothing.
      chat: { id: Number(CHAT), type: 'supergroup', title: 'Somewhere else' },
      from: { id: 555, is_bot: false, first_name: 'Guest' },
      text: '@synq_bot split this three ways',
      entities: [{ type: 'mention', offset: 0, length: 9 }],
      guest_query_id: 'gq-1',
      reply_to_message: {
        message_id: 76,
        date: clock.t - 30,
        from: { id: 556, is_bot: false, first_name: 'Host' },
        text: 'Cabin is 120 USDC total',
      },
      ...over,
    },
  });
  const deliver = async (update: unknown) => {
    const out = [];
    for (const e of adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN'))
      out.push(await gateway.handle(e));
    return out;
  };
  const say = (from: number, text: string) => deliver(groupUpdate(from, text));
  const sent = () =>
    api.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const lastText = () => String(sent().at(-1)?.text ?? '');
  return {
    clock,
    members,
    api,
    adapter,
    store,
    memory,
    gateway,
    portCalls,
    brainCalls,
    guestCalls,
    groupUpdate,
    guestUpdate,
    deliver,
    say,
    sent,
    lastText,
  };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function routes(w: Awaited<ReturnType<typeof world>>) {
  app = Fastify();
  await app.register(channelRoutes, {
    gateway: w.gateway,
    telegram: w.adapter,
    now: () => w.clock.t,
    telegramLogin: {
      botId: 42,
      required: true,
      verify: () => null,
      verifyInitData: (raw, at) => w.adapter.verifyMiniAppInitData(raw, at),
      consumeInitData: (hash, at) =>
        (w.store as ChannelStore).claimNotification(
          'telegram',
          'miniapp',
          w.adapter.miniAppReplayKey(hash),
          at,
        ),
      releaseInitData: (hash) =>
        w.store.releaseNotification(
          'telegram',
          'miniapp',
          w.adapter.miniAppReplayKey(hash),
        ),
    },
    telegramProbe: () => w.adapter.profile,
    memberSession: async (token, groupId) =>
      token === 'alice-session' && groupId === GROUP
        ? { memberId: 'member_0', principalId: 'principal_alice' }
        : null,
    env: { TELEGRAM_BOT_TOKEN: 'present' },
  });
  return app;
}

const webhook = (body: unknown, secret?: string | string[]) => ({
  method: 'POST' as const,
  url: '/v1/channels/telegram/webhook',
  headers: {
    'content-type': 'application/json',
    ...(secret !== undefined ? { [TELEGRAM_SECRET_HEADER]: secret } : {}),
  },
  payload: JSON.stringify(body),
});

describe('Telegram Guest Mode and message ingress', () => {
  it('P04-01 a guest invocation carries only its message and one bounded reference, never chat history', async () => {
    const w = await world();
    expect(TELEGRAM_ALLOWED_UPDATES).toContain('guest_message');
    // The enrolled chat has consented memory with stored messages.
    w.clock.t += 10;
    await w.say(ALICE, '/memory on 30');
    await w.say(ALICE, '/memory optin');
    w.clock.t += 10;
    await w.say(ALICE, 'remember: Bob owes 40 USDC for fuel');
    expect(w.memory.stored.size).toBe(1);
    const storedBefore = [...w.memory.stored.values()];

    const long = `Quote: ${'x'.repeat(5000)}`;
    const update = w.guestUpdate({
      reply_to_message: {
        message_id: 76,
        date: w.clock.t - 30,
        from: { id: 556, is_bot: false, first_name: 'Host' },
        text: long,
      },
    });
    const [event] = w.adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN');
    expect(ChannelEventSchema.parse(event)).toEqual(event); // strict schema: nothing extra rides along
    expect(event).toMatchObject({
      type: 'GUEST_QUERY',
      guestQueryId: 'gq-1',
      envelope: {
        externalUserId: '555',
        replyTo: '76',
        interaction: { kind: 'MENTION', addressedToBot: true },
      },
      reference: {
        source: 'REPLY_TO_MESSAGE',
        messageId: '76',
        externalUserId: '556',
        truncated: true,
        textSha256: createHash('sha256').update(long).digest('hex'),
      },
    });
    expect(event?.type === 'GUEST_QUERY' && event.reference!.text).toBe(
      long.slice(0, 1000),
    );

    w.portCalls.length = 0;
    const [outcome] = await w.deliver(update);
    expect(outcome).toMatchObject({
      status: 'HANDLED',
      code: 'GUEST_ANSWERED',
    });
    // The guest port saw the message and one reference, nothing else.
    expect(w.guestCalls).toHaveLength(1);
    expect(Object.keys(w.guestCalls[0]!).sort()).toEqual([
      'reference',
      'runId',
      'text',
    ]);
    expect(w.guestCalls[0]!.text).toBe('split this three ways');
    expect(w.guestCalls[0]!.reference?.messageId).toBe('76');
    expect(JSON.stringify(w.guestCalls[0])).not.toContain('Bob owes');
    // No group, member, treasury or Brain port was consulted; memory untouched.
    expect(w.portCalls).toEqual([]);
    expect(w.brainCalls).toHaveLength(0);
    expect([...w.memory.stored.values()]).toEqual(storedBefore);
    const answer = w.api.calls.find((c) => c.method === 'answerGuestQuery')!;
    const content = (
      answer.body.result as { input_message_content: { message_text: string } }
    ).input_message_content.message_text;
    expect(content).toContain('Draft only');
    expect(content).toContain(
      "I can see only your message and the one you replied to: not this chat's history",
    );
    expect(content).not.toContain('Bob owes');

    // A message without guest_query_id is not a guest query.
    const bare = w.guestUpdate({ guest_query_id: undefined });
    expect(w.adapter.normalize(bare)).toEqual([]);
  });

  it('P04-02 a guest response goes out through answerGuestQuery, never sendMessage', async () => {
    const w = await world();
    const direct = await w.adapter.answerGuest('gq-direct', {
      text: 'hello',
      buttons: [
        { label: 'Open Synq', url: 'https://synq.example/' },
        { label: 'local', url: 'http://localhost:3000/' },
      ],
    });
    expect(direct.inlineMessageId).toMatch(/^inline-/);
    const call = w.api.calls.at(-1)!;
    expect(call.method).toBe('answerGuestQuery');
    expect(call.body).toMatchObject({
      guest_query_id: 'gq-direct',
      result: {
        type: 'article',
        title: 'Synq',
        input_message_content: { message_text: 'hello' },
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Open Synq', url: 'https://synq.example/' }],
          ],
        },
      },
    });
    expect(
      String((call.body.result as { id: string }).id).length,
    ).toBeLessThanOrEqual(64);

    const before = w.api.calls.length;
    await w.deliver(w.guestUpdate({ guest_query_id: 'gq-2' }));
    // A guest asking to approve funds is refused, still via answerGuestQuery.
    w.clock.t += 1;
    await w.deliver(
      w.guestUpdate({
        guest_query_id: 'gq-3',
        text: '@synq_bot approve',
        reply_to_message: undefined,
      }),
    );
    const methods = w.api.calls.slice(before).map((c) => c.method);
    expect(methods).toEqual(['answerGuestQuery', 'answerGuestQuery']);
    expect(w.sent()).toHaveLength(0);
    const refusal = (
      w.api.calls.at(-1)!.body.result as {
        input_message_content: { message_text: string };
      }
    ).input_message_content.message_text;
    expect(refusal).toMatch(/^Chat messages never approve anything/);
    expect(refusal).toContain('I can see only your message:');
    expect(w.brainCalls).toHaveLength(0);

    // A network failure may have posted: it is not retried and nothing falls back to sendMessage.
    const flaky = await world({ failGuest: 'network' });
    const [failed] = await flaky.deliver(flaky.guestUpdate());
    expect(failed).toMatchObject({
      status: 'REFUSED',
      code: 'GUEST_ANSWER_FAILED',
    });
    expect(
      flaky.api.calls.filter((c) => c.method === 'answerGuestQuery'),
    ).toHaveLength(1);
    expect(flaky.sent()).toHaveLength(0);
    expect(flaky.store.failures.at(-1)?.reason).toContain('DELIVERY_UNCERTAIN');
  });

  it('P04-03 a privacy-mode bot does not claim full group visibility', async () => {
    const w = await world({ canReadAll: false, guest: false });
    expect(w.adapter.profile).toMatchObject({
      privacyMode: true,
      guestQueries: false,
      groupVisibility: 'ADDRESSED_ONLY',
    });
    expect(await w.adapter.groupVisibility(CHAT)).toBe('ADDRESSED_ONLY');
    // getMe without the field is treated as privacy mode.
    const unknown = await world({ canReadAll: undefined });
    expect(unknown.adapter.profile?.privacyMode).toBe(true);
    // Admin rights or privacy off are the only ways to see new messages.
    const admin = await world({ admins: new Set(['111', '42']) });
    expect(await admin.adapter.groupVisibility(CHAT)).toBe('ALL_MESSAGES');
    const open = await world({ canReadAll: true });
    expect(open.adapter.profile?.groupVisibility).toBe('ALL_MESSAGES');

    const tg = (probe?: { privacyMode: boolean; guestQueries: boolean }) =>
      channelCapabilities(
        { TELEGRAM_BOT_TOKEN: 'x' },
        probe ? { telegram: probe } : {},
      ).find((c) => c.channel === 'telegram')!;
    for (const cap of [tg(), tg({ privacyMode: true, guestQueries: false })]) {
      expect(cap.features).toContain('group-visibility:addressed-only');
      expect(cap.features).not.toContain('group-visibility:new-messages');
      expect(cap.features).not.toContain('guest-mode');
      expect(cap.groupModel).toMatch(/privacy mode limits it/);
      expect(cap.groupModel).toMatch(/No pre-join history/);
    }
    expect(tg({ privacyMode: false, guestQueries: true }).features).toEqual(
      expect.arrayContaining(['group-visibility:new-messages', 'guest-mode']),
    );
    app = await routes(w);
    const reported = (
      await app.inject({
        method: 'GET',
        url: '/v1/channels/capabilities',
      })
    ).json() as { channel: string; features: string[] }[];
    expect(reported.find((c) => c.channel === 'telegram')!.features).toContain(
      'group-visibility:addressed-only',
    );

    // Turning memory on discloses the real, limited visibility.
    await w.say(ALICE, '/memory on 7');
    expect(w.lastText()).toContain(
      'Telegram privacy mode is on for Synq here: it receives only commands, @mentions and replies to it, not every message',
    );
    expect(w.lastText()).not.toMatch(/receives new messages in this chat/);
    expect((await w.memory.policy('telegram', CHAT))?.visibility).toBe(
      'ADDRESSED_ONLY',
    );
    w.clock.t += 1;
    await w.say(BOB, '/memory');
    expect(w.lastText()).toContain('privacy mode is on');
    // A plain group message is not treated as addressed to the bot.
    const [plain] = w.adapter.normalize(w.groupUpdate(BOB, 'see you at 6'));
    expect(
      plain?.type === 'MESSAGE_RECEIVED' &&
        plain.envelope.interaction.addressedToBot,
    ).toBe(false);
  });

  it('P04-04 a spoofed webhook secret header is rejected with a constant-time compare', async () => {
    const w = await world();
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    for (const spoof of [
      'webhook_secret_0123456788',
      'x',
      'w'.repeat(4096),
      '',
    ])
      expect(w.adapter.verifyWebhook(spoof)).toBe(false);
    // Every candidate, whatever its length, goes through one fixed-size timingSafeEqual.
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
    expect(w.adapter.verifyWebhook([SECRET])).toBe(false);
    expect(w.adapter.verifyWebhook(undefined)).toBe(false);
    expect(w.adapter.verifyWebhook(SECRET)).toBe(true);

    app = await routes(w);
    const handle = vi.spyOn(w.gateway, 'handle');
    const update = w.groupUpdate(ALICE, '/propose pay the cabin deposit');
    for (const spoof of [
      undefined,
      'webhook_secret_0123456788',
      SECRET.toUpperCase(),
    ]) {
      const res = await app.inject(webhook(update, spoof));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'WEBHOOK_SECRET_INVALID' });
    }
    // A forged guest invocation is rejected the same way.
    const forged = await app.inject(
      webhook(w.guestUpdate(), 'nope_nope_nope_nope'),
    );
    expect(forged.statusCode).toBe(401);
    expect(handle).not.toHaveBeenCalled();
    expect(w.store.events.size).toBe(0);
    expect(w.api.calls.filter((c) => c.method !== 'getMe')).toEqual([]);
    expect((await app.inject(webhook(update, SECRET))).statusCode).toBe(200);
  });

  it('P04-05 tampered or stale Mini App initData fails; a valid one proves the user once', async () => {
    const user = JSON.stringify({
      id: 111,
      first_name: 'Alice',
      username: 'alice',
    });
    const fields = {
      auth_date: String(NOW - 60),
      query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
      user,
      chat_type: 'supergroup',
      chat_instance: '-8338601402939221000',
    };
    // Independent oracle: the documented algorithm, written out here.
    const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const check = Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, v]) => `${key}=${v}`)
      .join('\n');
    const hash = createHmac('sha256', secret).update(check).digest('hex');
    const initData = new URLSearchParams({ ...fields, hash }).toString();
    expect(signTelegramMiniAppInitDataForTest(fields, TOKEN)).toBe(initData);

    expect(verifyTelegramMiniAppInitData(initData, TOKEN, NOW)).toMatchObject({
      telegramUserId: '111',
      authDate: NOW - 60,
      chatType: 'supergroup',
      queryId: fields.query_id,
      hash,
    });
    const tamper = (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(initData);
      mutate(p);
      return p.toString();
    };
    const bad = [
      tamper((p) => p.set('user', user.replace('111', '222'))),
      tamper((p) => p.set('auth_date', String(NOW))),
      tamper((p) => p.set('chat_type', 'private')),
      tamper((p) => p.append('start_param', 'admin')),
      tamper((p) => p.append('user', user)),
      tamper((p) =>
        p.set('hash', hash.replace(/^./, hash[0] === 'a' ? 'b' : 'a')),
      ),
      tamper((p) => p.set('hash', hash.toUpperCase())),
      tamper((p) => p.delete('hash')),
      tamper((p) => p.delete('auth_date')),
      signTelegramMiniAppInitDataForTest(fields, OTHER_TOKEN),
      // Telegram Login's key derivation (SHA-256 of the token) must not pass as initData.
      new URLSearchParams({
        ...fields,
        hash: createHmac('sha256', createHash('sha256').update(TOKEN).digest())
          .update(check)
          .digest('hex'),
      }).toString(),
      signTelegramMiniAppInitDataForTest(
        { ...fields, user: JSON.stringify({ id: 9, is_bot: true }) },
        TOKEN,
      ),
    ];
    for (const raw of bad)
      expect(verifyTelegramMiniAppInitData(raw, TOKEN, NOW)).toBeNull();
    for (const raw of [undefined, 42, '', 'a'.repeat(9000), { initData }])
      expect(verifyTelegramMiniAppInitData(raw, TOKEN, NOW)).toBeNull();
    // auth_date max age (default one hour) and future skew.
    expect(
      verifyTelegramMiniAppInitData(initData, TOKEN, NOW - 60 + 3600),
    ).not.toBeNull();
    expect(
      verifyTelegramMiniAppInitData(initData, TOKEN, NOW - 60 + 3601),
    ).toBeNull();
    expect(
      verifyTelegramMiniAppInitData(initData, TOKEN, NOW - 200),
    ).toBeNull();

    // Through the API: tampered is refused, a valid one is accepted once.
    const w = await world();
    app = await routes(w);
    const redeem = (telegramInitData: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/channels/links/redeem',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer alice-session',
        },
        payload: JSON.stringify({
          code: 'abcdefghijklmnop1234',
          groupId: GROUP,
          telegramInitData,
        }),
      });
    const tampered = await redeem(bad[0]!);
    expect([tampered.statusCode, tampered.json()]).toEqual([
      401,
      { error: 'TELEGRAM_MINIAPP_INVALID' },
    ]);
    const first = await redeem(initData);
    expect(first.json()).toEqual({ error: 'CODE_INVALID' }); // proof accepted; the code is unknown
    // A failed redemption does not spend the initData; a successful one does,
    // and its replay is refused (see "spent only by a successful link").
    const retry = await redeem(initData);
    expect(retry.json()).toEqual({ error: 'CODE_INVALID' });
  });

  it('P04-06 only consented, disclosed, unexpired messages are stored; retention is enforced', async () => {
    const w = await world();
    // Before memory is on, nothing is stored.
    await w.say(ALICE, 'hello before enrollment @synq_bot');
    expect(w.memory.stored.size).toBe(0);
    // Only a chat admin can turn it on.
    w.clock.t += 1;
    await w.say(BOB, '/memory on 7');
    expect(w.lastText()).toBe(
      'Only a chat admin can turn Synq memory on or off.',
    );
    expect(await w.memory.policy('telegram', CHAT)).toBeNull();
    w.clock.t += 1;
    await w.say(ALICE, '/memory on 7');
    const policy = await w.memory.policy('telegram', CHAT);
    expect(policy).toMatchObject({
      groupId: GROUP,
      retentionSeconds: 7 * DAY,
      purpose: 'GROUP_FINANCIAL_PROPOSALS',
      disclosedAt: w.clock.t,
    });
    expect(w.lastText()).toContain('Synq memory is ON for this chat.');
    // Enrolled but nobody opted in: still nothing stored.
    w.clock.t += 1;
    await w.say(ALICE, 'pre-consent message');
    expect(w.memory.stored.size).toBe(0);
    w.clock.t += 1;
    await w.say(ALICE, '/memory optin');
    // Carol is not linked, so she cannot opt in.
    await w.say(CAROL, '/memory optin');
    expect(w.lastText()).toContain('not linked to a Synq member');
    w.clock.t += 60;
    await w.say(ALICE, 'Deposit is due Friday');
    await w.say(BOB, 'I can cover fuel');
    await w.say(CAROL, 'my phone is +1 555 0100');
    await w.say(ALICE, '/balance'); // commands are not memory
    const stored = [...w.memory.stored.values()];
    expect(stored.map((m) => [m.externalUserId, m.text])).toEqual([
      ['111', 'Deposit is due Friday'],
    ]);
    expect(stored[0]).toMatchObject({
      principalId: 'principal_alice',
      textSha256: createHash('sha256')
        .update('Deposit is due Friday')
        .digest('hex'),
      expiresAt: w.clock.t + 7 * DAY,
    });
    // The Brain gets that consented context, nothing from Bob or Carol.
    await w.say(ALICE, '/propose pay the deposit');
    expect(w.brainCalls.at(-1)?.context?.map((m) => m.text)).toEqual([
      'Deposit is due Friday',
    ]);
    // Status shows what is kept.
    await w.say(BOB, '/memory');
    expect(w.lastText()).toContain(
      'Stored now: 1 message (0 yours). You are not opted in.',
    );

    // Retention: expired messages are never returned, then purged.
    const service = new ChatContextService(w.memory);
    w.clock.t += 7 * DAY;
    expect(
      await service.contextFor({
        channel: 'telegram',
        externalGroupId: CHAT,
        groupId: GROUP,
        now: w.clock.t,
      }),
    ).toEqual([]);
    expect(w.memory.stored.size).toBe(1);
    expect(await service.purge(w.clock.t)).toBe(1);
    expect(w.memory.stored.size).toBe(0);
    // Retention is bounded: 0 days is rejected, a huge value is capped at 90 days.
    await w.say(ALICE, '/memory on 0');
    expect(w.lastText()).toMatch(/^Usage: \/memory on <days>/);
    await w.say(ALICE, '/memory on 999');
    expect((await w.memory.policy('telegram', CHAT))?.retentionSeconds).toBe(
      90 * DAY,
    );

    // New terms need a fresh opt-in.
    w.clock.t += 1;
    await w.say(ALICE, 'under new terms, no fresh consent');
    expect(w.memory.stored.size).toBe(0);
    await w.say(ALICE, '/memory optin');
    // Opt-out deletes that member's messages; memory off deletes everything.
    w.clock.t += 1;
    await w.say(ALICE, 'second note');
    expect(w.memory.stored.size).toBe(1);
    await w.say(ALICE, '/memory optout');
    expect(w.memory.stored.size).toBe(0);
    expect(await w.memory.consent('telegram', CHAT, '111')).toBeNull();
    await w.say(ALICE, 'after optout');
    expect(w.memory.stored.size).toBe(0);
    await w.say(ALICE, '/memory optin');
    w.clock.t += 1;
    await w.say(ALICE, 'kept again');
    expect(w.memory.stored.size).toBe(1);
    await w.say(ALICE, '/memory off');
    expect(w.memory.stored.size).toBe(0);
    expect(await w.memory.policy('telegram', CHAT)).toBeNull();

    // A disclosure that never reached the chat stores nothing.
    const quiet = await world();
    quiet.adapter.send = async () => {
      throw new Error('down');
    };
    await quiet.say(ALICE, '/memory on 7');
    expect(
      (await quiet.memory.policy('telegram', CHAT))?.disclosedAt,
    ).toBeNull();
    await quiet.memory.grantConsent({
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: '111',
      principalId: 'principal_alice',
      policyVersion: 1,
      consentedAt: NOW,
    });
    quiet.clock.t += 5;
    await quiet.say(ALICE, 'should not be kept');
    expect(quiet.memory.stored.size).toBe(0);

    // Leaving the chat withdraws consent and deletes; unlinking ends memory.
    const left = await world();
    await left.say(ALICE, '/memory on 7');
    await left.say(BOB, '/memory optin');
    left.clock.t += 1;
    await left.say(BOB, 'bob note');
    expect(left.memory.stored.size).toBe(1);
    await left.deliver({
      update_id: 9999,
      message: {
        message_id: 9999,
        date: left.clock.t,
        chat: { id: Number(CHAT), type: 'supergroup' },
        from: { id: BOB, is_bot: false, first_name: 'Bob' },
        left_chat_member: { id: BOB, is_bot: false, first_name: 'Bob' },
      },
    });
    expect(left.memory.stored.size).toBe(0);
    await left.say(ALICE, '/unlink');
    expect(await left.memory.policy('telegram', CHAT)).toBeNull();
  });

  it('P04-07 a duplicate update_id does not create two proposals or two guest answers', async () => {
    const w = await world();
    app = await routes(w);
    const update = w.groupUpdate(ALICE, '/propose pay the cabin deposit');
    const first = await app.inject(webhook(update, SECRET));
    const again = await app.inject(webhook(update, SECRET));
    expect(first.json()).toEqual({ ok: true, outcomes: ['HANDLED'] });
    expect(again.json()).toEqual({ ok: true, outcomes: ['DUPLICATE'] });
    expect(w.brainCalls).toHaveLength(1);
    // Concurrent redelivery of one update (webhook retry racing a poll).
    const racing = w.groupUpdate(ALICE, '/propose book the ferry');
    const outcomes = await Promise.all([
      app.inject(webhook(racing, SECRET)),
      app.inject(webhook(racing, SECRET)),
      w.deliver(racing),
    ]);
    expect(w.brainCalls).toHaveLength(2);
    expect(
      outcomes
        .flatMap((o) =>
          'json' in o
            ? (o.json() as { outcomes: string[] }).outcomes
            : o.map((x) => x.status),
        )
        .sort(),
    ).toEqual(['DUPLICATE', 'DUPLICATE', 'HANDLED']);

    // Guest: the same update twice, and a new update_id for the same guest query.
    const guest = w.guestUpdate({ guest_query_id: 'gq-dup' });
    expect((await app.inject(webhook(guest, SECRET))).json()).toEqual({
      ok: true,
      outcomes: ['HANDLED'],
    });
    expect((await app.inject(webhook(guest, SECRET))).json()).toEqual({
      ok: true,
      outcomes: ['DUPLICATE'],
    });
    const sameQuery = w.guestUpdate({ guest_query_id: 'gq-dup' });
    expect(sameQuery.update_id).not.toBe(guest.update_id);
    expect(await w.deliver(sameQuery)).toMatchObject([
      { status: 'DUPLICATE', code: 'GUEST_ALREADY_ANSWERED' },
    ]);
    expect(
      w.api.calls.filter((c) => c.method === 'answerGuestQuery'),
    ).toHaveLength(1);
  });
});

describe('Telegram ingress: review regressions', () => {
  it('P04-06 a member removed from the Synq group is no longer captured or read, and can still see status and opt out', async () => {
    const w = await world();
    await w.say(ALICE, '/memory on 7');
    await w.say(BOB, '/memory optin');
    w.clock.t += 1;
    await w.say(BOB, 'bob note');
    expect(w.memory.stored.size).toBe(1);
    delete w.members.principal_bob; // removed from the Synq group, still linked in the chat
    w.clock.t += 1;
    await w.say(BOB, 'after removal');
    expect([...w.memory.stored.values()].map((m) => m.text)).toEqual([
      'bob note',
    ]);
    await w.say(ALICE, '/propose pay the deposit');
    expect(w.brainCalls.at(-1)?.context ?? []).toEqual([]);
    await w.say(BOB, '/memory');
    expect(w.lastText()).toMatch(/^Mode: ENROLLED_CONTEXT/);
    await w.say(BOB, '/memory optout');
    expect(w.lastText()).toMatch(/^Opted out: deleted 1 stored message/);
    expect(w.memory.stored.size).toBe(0);
  });

  it('P04-06 shortening retention applies to stored rows; a new policy needs a fresh opt-in', async () => {
    const w = await world();
    const service = new ChatContextService(w.memory);
    const read = () =>
      service.contextFor({
        channel: 'telegram',
        externalGroupId: CHAT,
        groupId: GROUP,
        now: w.clock.t,
      });
    await w.say(ALICE, '/memory on 30');
    await w.say(ALICE, '/memory optin');
    w.clock.t += 1;
    await w.say(ALICE, 'old note');
    expect((await read()).map((m) => m.text)).toEqual(['old note']);
    await w.say(ALICE, '/memory on 1'); // shorter retention
    w.clock.t += DAY + 10;
    expect(await read()).toEqual([]);
    expect(await service.purge(w.clock.t)).toBe(1);
    await w.say(ALICE, '/memory on 30'); // longer again: earlier opt-ins do not carry over
    w.clock.t += 1;
    await w.say(ALICE, 'new note without fresh consent');
    expect(w.memory.stored.size).toBe(0);
    await w.say(ALICE, '/memory optin');
    w.clock.t += 1;
    await w.say(ALICE, 'newer note');
    expect((await read()).map((m) => m.text)).toEqual(['newer note']);
  });

  it('P04-06 forwarded messages are never stored as the forwarder’s words', async () => {
    const w = await world();
    await w.say(ALICE, '/memory on 7');
    await w.say(ALICE, '/memory optin');
    w.clock.t += 1;
    const base = w.groupUpdate(ALICE, '@synq_bot forwarded quote');
    const forwarded = {
      ...base,
      message: {
        ...base.message,
        forward_origin: {
          type: 'user',
          date: w.clock.t - 99,
          sender_user: { id: 999, is_bot: false, first_name: 'Someone' },
        },
      },
    };
    const [event] = w.adapter.normalize(forwarded);
    expect(event?.type === 'MESSAGE_RECEIVED' && event.envelope.forwarded).toBe(
      true,
    );
    await w.deliver(forwarded);
    const auto = w.groupUpdate(ALICE, '@synq_bot channel post');
    await w.deliver({
      ...auto,
      message: { ...auto.message, is_automatic_forward: true },
    });
    expect(w.memory.stored.size).toBe(0);
    await w.say(ALICE, '@synq_bot my own words');
    expect([...w.memory.stored.values()].map((m) => m.text)).toEqual([
      '@synq_bot my own words',
    ]);
  });

  it('P04-06 chat memory is off by default until the Brain consumes it as untrusted input', async () => {
    const { channelMemoryEnabled } =
      await import('../../apps/api/src/channel-server.js');
    expect(channelMemoryEnabled({})).toBe(false);
    expect(channelMemoryEnabled({ SYNQ_CHANNEL_MEMORY: '1' })).toBe(true);
    const tg = (env: Record<string, string>) =>
      channelCapabilities({ TELEGRAM_BOT_TOKEN: 'x', ...env }).find(
        (c) => c.channel === 'telegram',
      )!.features;
    expect(tg({})).not.toContain('consented-memory');
    expect(tg({ SYNQ_CHANNEL_MEMORY: '1' })).toContain('consented-memory');
  });

  it('P04-07 dedup keys are scoped to the receiving bot', async () => {
    const a = await world();
    const b = await world({ botId: 43, store: a.store });
    const update = a.groupUpdate(ALICE, '/propose pay the deposit');
    expect(await a.deliver(update)).toMatchObject([{ status: 'HANDLED' }]);
    expect(await b.deliver(update)).toMatchObject([{ status: 'HANDLED' }]);
    expect(await a.deliver(update)).toMatchObject([{ status: 'DUPLICATE' }]);
    const guest = a.guestUpdate({ guest_query_id: 'gq-shared' });
    expect(await a.deliver(guest)).toMatchObject([{ code: 'GUEST_ANSWERED' }]);
    expect(await b.deliver(guest)).toMatchObject([{ code: 'GUEST_ANSWERED' }]);
    const [event] = a.adapter.normalize(update);
    expect(event?.type === 'MESSAGE_RECEIVED' && event.envelope.eventId).toBe(
      `update:42:${update.update_id}`,
    );
    expect(a.adapter.miniAppReplayKey('ab')).toBe('initdata:42:ab');
    expect(b.adapter.miniAppReplayKey('ab')).toBe('initdata:43:ab');
  });

  it('P04-05 a Mini App initData is spent only by a successful link', async () => {
    const w = await world();
    app = await routes(w);
    const code = 'abcdefghijklmnop5678';
    await w.store.createLinkCode({
      codeHash: createHash('sha256')
        .update(`synq-channel-link:${code}`)
        .digest('hex'),
      channel: 'telegram',
      externalGroupId: '-1002',
      externalUserId: '111',
      displayName: '@alice',
      createdAt: NOW,
      expiresAt: NOW + 900,
    });
    const initData = signTelegramMiniAppInitDataForTest(
      {
        auth_date: String(NOW - 60),
        user: JSON.stringify({ id: 111, first_name: 'Alice' }),
      },
      TOKEN,
    );
    const redeem = (c: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/channels/links/redeem',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer alice-session',
        },
        payload: JSON.stringify({
          code: c,
          groupId: GROUP,
          telegramInitData: initData,
        }),
      });
    expect((await redeem('zzzzzzzzzzzzzzzz0000')).json()).toEqual({
      error: 'CODE_INVALID',
    });
    const linked = await redeem(code);
    expect(linked.json()).toMatchObject({ status: 'LINKED' });
    expect((await redeem(code)).json()).toEqual({
      error: 'TELEGRAM_MINIAPP_REPLAYED',
    });
  });
});
