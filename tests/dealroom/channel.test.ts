import { describe, expect, it } from 'vitest';
import {
  ChannelGateway,
  ChatContextService,
  MemoryChannelStore,
  MemoryChatContextStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  HELP_TEXT,
  type ChannelPorts,
} from '@synq/channels';
import {
  dealDraftPort,
  verifyDealLink,
  type ChatDealRequest,
  type Party,
} from '@synq/dealroom';
import { T0, parties, room } from './harness.js';

/**
 * The chat surface of the Deal Room through the real ChannelGateway and
 * TelegramAdapter (fake Bot API transport): `/deal` in an enrolled chat
 * drafts only from consented memory, "@bot draft a deal" as a guest drafts
 * only from the trigger and the replied-to message, and nothing in chat
 * signs.
 */

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const CHAT = '-1009';
const GROUP = 'grp_landing';
const DANA = 7001; // client, chat admin
const MAYA = 7002; // freelancer
const EVE = 7003; // in the chat, never opted in
const k = (...p: string[]) => p.join('\u0000');
const LINK_KEY = new Uint8Array(32).fill(5);

async function world() {
  const clock = { t: T0 };
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe')
      return ok({
        id: 42,
        is_bot: true,
        first_name: 'Synq',
        username: 'synq_bot',
        can_read_all_group_messages: true,
        supports_guest_queries: true,
      });
    if (method === 'sendMessage') return ok({ message_id: ++n });
    if (method === 'answerGuestQuery')
      return ok({ inline_message_id: `inline-${++n}` });
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'nf' }),
      { status: 404 },
    );
  }) as typeof fetch;
  const noWait = async () => undefined;
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({ token: TOKEN, fetch: fetchImpl }),
    webhookSecret: 'webhook_secret_0123456789',
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    transport: 'WEBHOOK_SECRET_TOKEN',
  });
  await adapter.init();
  const store = new MemoryChannelStore();
  store.groups.set(k('telegram', CHAT), {
    channel: 'telegram',
    externalGroupId: CHAT,
    groupId: GROUP,
    linkedByPrincipalId: 'prn_dana',
    linkedAt: T0 - 5000,
    status: 'ACTIVE',
  });
  for (const [user, principal] of [
    [DANA, 'prn_dana'],
    [MAYA, 'prn_maya'],
    [EVE, 'prn_eve'],
  ] as const)
    store.users.set(k('telegram', CHAT, String(user)), {
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: String(user),
      principalId: principal,
      linkedAt: T0 - 5000,
      status: 'ACTIVE',
      chatAdmin: user === DANA,
      confirmTokenHash: null,
    });
  const memory = new MemoryChatContextStore();
  const policy = await memory.enroll({
    channel: 'telegram',
    externalGroupId: CHAT,
    groupId: GROUP,
    retentionSeconds: 7 * 86_400,
    purpose: 'GROUP_FINANCIAL_PROPOSALS',
    visibility: 'ALL_MESSAGES',
    enrolledByPrincipalId: 'prn_dana',
    enrolledAt: T0 - 4000,
  });
  await memory.markDisclosed('telegram', CHAT, policy.version, T0 - 3000);
  for (const [user, principal] of [
    [DANA, 'prn_dana'],
    [MAYA, 'prn_maya'],
  ] as const)
    await memory.grantConsent({
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: String(user),
      principalId: principal,
      policyVersion: policy.version,
      consentedAt: T0 - 2900,
    });
  const r = room();
  // Verified parties by principal id or Telegram id; anyone else is unknown.
  const byPrincipal: Record<string, Party> = {
    prn_dana: parties.client,
    prn_maya: parties.freelancer,
  };
  const byTelegram: Record<string, Party> = {
    [String(DANA)]: parties.client,
    [String(MAYA)]: parties.freelancer,
  };
  const dealCalls: ChatDealRequest[] = [];
  const port = dealDraftPort({
    service: r.service,
    workspaceId: 'wsp_chat',
    resolveParty: async ({ principalId, externalUserId, role }) => {
      const p =
        (principalId && byPrincipal[principalId]) ||
        (externalUserId && byTelegram[externalUserId]) ||
        null;
      return p ? { ...p, role } : null;
    },
    arbiter: parties.arbiter,
    webBaseUrl: 'https://synq.example',
    linkKey: LINK_KEY,
    reasoner: null,
  });
  const ports: ChannelPorts = {
    activeMember: async (g, p) =>
      g === GROUP && ['prn_dana', 'prn_maya', 'prn_eve'].includes(p)
        ? { memberId: p }
        : null,
    treasury: async () => null,
    mandates: async () => [],
    approvals: async () => [],
    receipts: async () => [],
    deal: async (input) => {
      dealCalls.push(input);
      return port(input);
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
    context: new ChatContextService(memory),
  });
  let id = 900;
  const say = async (from: number, text: string, at = clock.t) => {
    const mid = ++id;
    const update = {
      update_id: mid,
      message: {
        message_id: mid,
        date: at,
        chat: { id: Number(CHAT), type: 'supergroup', title: 'Landing page' },
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
          : [],
      },
    };
    const out = [];
    for (const e of adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN'))
      out.push(await gateway.handle(e));
    return { out, messageId: String(mid) };
  };
  const sent = () =>
    calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  return { clock, gateway, adapter, say, sent, calls, r, dealCalls, memory };
}

describe('Deal Room chat surface', () => {
  it('/deal drafts only from consented memory and replies with a review link; chat never signs', async () => {
    const w = await world();
    expect(HELP_TEXT).toMatch(/\/deal/);
    // Sent before memory was disclosed: never stored, never citable.
    const early = await w.say(
      MAYA,
      'Earlier: 5 USDC total for all of it.',
      T0 - 3500,
    );
    expect(early.out[0]!.status).toBe('STALE');
    w.clock.t = T0 - 600;
    const scope = await w.say(
      DANA,
      'We need the Synq landing page rebuilt: hero section, pricing table and docs links.',
    );
    const price = await w.say(
      MAYA,
      'Happy to. 0.03 USDC total: 0.01 USDC when the hero section PR is merged, 0.02 USDC on final delivery of pricing and docs.',
    );
    await w.say(EVE, 'I would do it for 0.01 USDC total.');
    const when = await w.say(
      DANA,
      'Deal. Hero within 7 days, the rest within 14 days.',
    );
    w.clock.t = T0;
    const deal = await w.say(DANA, '/deal landing page');
    expect(deal.out[0]).toMatchObject({
      status: 'HANDLED',
      code: 'DEAL_DRAFTED',
    });
    const req = w.dealCalls[0]!;
    expect(req.origin).toBe('ENROLLED_CONTEXT');
    // Eve never opted in: her message was not stored and is not context.
    expect(req.context.map((m) => m.messageId)).toEqual([
      scope.messageId,
      price.messageId,
      when.messageId,
    ]);
    const reply = w.sent().at(-1)!;
    expect(String(reply.text)).toMatch(/Deal draft deal_/);
    expect(String(reply.text)).toMatch(/0\.03 USDC in escrow on Arc/);
    expect(String(reply.text)).toMatch(/never signs or funds/);
    const url = String(
      (reply.reply_markup as { inline_keyboard: { url: string }[][] })
        .inline_keyboard[0]![0]!.url,
    );
    const m = /\/deal\/(deal_[^?]+)\?t=(.+)$/.exec(url)!;
    expect(verifyDealLink(LINK_KEY, m[1]!, m[2]!)).toBe(true);
    expect(verifyDealLink(LINK_KEY, m[1]!, 'x'.repeat(32))).toBe(false);
    const view = await w.r.service.view(m[1]!);
    const cited = Object.values(view.current.provenance)
      .flat()
      .filter((p) => p.kind === 'ORIGINAL_MESSAGE')
      .map((p) => (p as { messageId: string }).messageId);
    expect(new Set(cited)).toEqual(
      new Set([scope.messageId, price.messageId, when.messageId]),
    );
    expect(Object.keys(view.deal.origin.messages)).not.toContain(
      early.messageId,
    );
    // "I approve" in chat is not a signature.
    const yes = await w.say(MAYA, 'yes');
    expect(yes.out[0]!.status).not.toBe('HANDLED');
    expect((await w.r.service.view(m[1]!)).deal.status).toBe('DRAFT');
    expect((await w.r.service.view(m[1]!)).signatures).toHaveLength(0);
  });

  it('guest "@bot draft a deal" reads only the trigger and the replied-to message', async () => {
    const w = await world();
    const update = {
      update_id: 5000,
      guest_message: {
        message_id: 61,
        date: T0,
        chat: { id: -100555, type: 'supergroup', title: 'Elsewhere' },
        from: { id: DANA, is_bot: false, first_name: 'Dana' },
        text: '@synq_bot draft a deal from this',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
        guest_query_id: 'gq-deal-1',
        reply_to_message: {
          message_id: 60,
          date: T0 - 30,
          from: { id: MAYA, is_bot: false, first_name: 'Maya' },
          text: 'We need the Synq landing page rebuilt: hero, pricing and docs. 0.03 USDC total: 0.01 USDC when the hero PR is merged within 7 days, 0.02 USDC on final delivery within 14 days.',
        },
      },
    };
    const [event] = w.adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN');
    const out = await w.gateway.handle(event!);
    expect(out.code).toBe('GUEST_ANSWERED');
    const req = w.dealCalls[0]!;
    expect(req.origin).toBe('GUEST_INVOCATION');
    expect(req.context).toEqual([]);
    expect(req.reference?.messageId).toBe('60');
    const answer = w.calls.find((c) => c.method === 'answerGuestQuery')!.body;
    const text = JSON.stringify(answer);
    expect(text).toMatch(/Deal draft deal_/);
    expect(text).toMatch(/Review and sign/);
    const dealId = /Deal draft (deal_[a-z0-9_]+)/.exec(text)![1]!;
    const view = await w.r.service.view(dealId);
    expect(view.deal.origin.source).toBe('GUEST_INVOCATION');
    expect(Object.keys(view.deal.origin.messages).sort()).toEqual(['60', '61']);
    expect(view.current.terms.client.wallet).toBe(parties.client.wallet);
    expect(view.current.terms.freelancer.wallet).toBe(
      parties.freelancer.wallet,
    );
  });

  it('refuses when the counterparty has no verified wallet link', async () => {
    const w = await world();
    const update = {
      update_id: 5001,
      guest_message: {
        message_id: 71,
        date: T0,
        chat: { id: -100556, type: 'supergroup', title: 'Elsewhere' },
        from: { id: DANA, is_bot: false, first_name: 'Dana' },
        text: '@synq_bot draft a deal',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
        guest_query_id: 'gq-deal-2',
        reply_to_message: {
          message_id: 70,
          date: T0 - 30,
          from: { id: 9999, is_bot: false, first_name: 'X' },
          text: '0.03 USDC total',
        },
      },
    };
    const [event] = w.adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN');
    await w.gateway.handle(event!);
    const text = JSON.stringify(
      w.calls.find((c) => c.method === 'answerGuestQuery')!.body,
    );
    expect(text).toMatch(
      /No deal drafted: the other party has not linked a wallet/,
    );
  });
});
