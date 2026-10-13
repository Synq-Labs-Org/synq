import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  WhatsAppAdapter,
  WhatsAppCloudApi,
  channelCapabilities,
  renderWhatsAppCard,
  signWhatsAppWebhook,
  whatsappConfigFromEnv,
  type ChannelPorts,
} from '@synq/channels';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { SAMPLE_CARDS } from './card-samples.js';
import {
  FAKE_BASE_URL,
  FAKE_PHONE_NUMBER_ID,
  FAKE_VERSION,
  FAKE_WA_TOKEN,
  FakeWhatsAppGraph,
  type WaInteractive,
  waWebhook,
} from './fake-whatsapp-graph.js';

const APP_SECRET = 'whatsapp-app-secret-fixture-0123';
const VERIFY_TOKEN = 'verify-token-fixture-0123456789';
const ALICE = '16505551234';
const MALLORY = '16505559999';
const NOW = 1_800_000_000;
const noWait = async () => undefined;
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

function adapter(
  graph = new FakeWhatsAppGraph(),
  extra: Partial<ConstructorParameters<typeof WhatsAppAdapter>[0]> = {},
) {
  const a = new WhatsAppAdapter({
    api: new WhatsAppCloudApi({
      token: FAKE_WA_TOKEN,
      phoneNumberId: FAKE_PHONE_NUMBER_ID,
      baseUrl: FAKE_BASE_URL,
      version: FAKE_VERSION,
      fetch: graph.fetch,
    }),
    phoneNumberId: FAKE_PHONE_NUMBER_ID,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    allowedWaIds: [ALICE],
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    ...extra,
  });
  return { a, graph };
}

const text = (id: string, body: string, from = ALICE, ts = NOW) => ({
  from,
  id: `wamid.${id}`,
  timestamp: String(ts),
  type: 'text',
  text: { body },
});
const buttonReply = (id: string, buttonId: string, from = ALICE) => ({
  context: { from: '15550783881', id: 'wamid.ORIGINAL' },
  from,
  id: `wamid.${id}`,
  timestamp: String(NOW),
  type: 'interactive',
  interactive: {
    type: 'button_reply',
    button_reply: { id: buttonId, title: 'Approve' },
  },
});

describe('whatsapp cloud api adapter: send', () => {
  it('sends text to an allowlisted wa_id with the documented payload and bearer token', async () => {
    const { a, graph } = adapter();
    const r = await a.send(ALICE, { text: 'hello', replyTo: 'wamid.PREV' });
    expect(r.messageId).toMatch(/^wamid\./);
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: `+${ALICE}`,
      context: { message_id: 'wamid.PREV' },
      type: 'text',
      text: { preview_url: false, body: 'hello' },
    });
    expect(
      graph.authHeaders.every((h) => h === `Bearer ${FAKE_WA_TOKEN}`),
    ).toBe(true);
  });

  it('refuses recipients outside the allowlist without calling Meta', async () => {
    const { a, graph } = adapter();
    const err = await a.send(MALLORY, { text: 'hi' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(await a.send('+1 650', { text: 'hi' }).catch((e) => e.code)).toBe(
      'PROVIDER_REJECTED',
    );
    expect(graph.sent).toHaveLength(0);
    expect(graph.authHeaders).toHaveLength(0);
  });

  it('uploads the card banner through /media and opens the review link with a CTA URL button', async () => {
    const card = SAMPLE_CARDS.proposal!;
    const rendered: string[] = [];
    const { a, graph } = adapter(undefined, {
      banners: {
        render: async (c) => {
          rendered.push(c.cardId);
          return PNG;
        },
      },
    });
    await a.send(ALICE, renderWhatsAppCard(card));
    expect(rendered).toEqual([card.cardId]);
    expect(graph.uploads).toEqual([
      { type: 'image/png', filename: `${card.cardId}.png`, bytes: PNG.length },
    ]);
    expect(graph.sent.map((s) => s.type)).toEqual([
      'image',
      'interactive:cta_url',
      'interactive:button',
    ]);
    const [image, cta, buttons] = graph.sent.map((s) => s.body);
    expect(image!.image).toMatchObject({ id: 'media-1' });
    const action = (cta!.interactive as Required<WaInteractive>).action;
    expect(action).toEqual({
      name: 'cta_url',
      parameters: {
        display_text: 'Review & approve',
        url: card.actions[0]!.url,
      },
    });
    // The second link is listed in the body, never turned into a reply button.
    expect((cta!.interactive as Required<WaInteractive>).body.text).toContain(
      `Reject: ${card.actions[1]!.url}`,
    );
    const replies = (buttons!.interactive as Required<WaInteractive>).action
      .buttons;
    expect(replies).toEqual([
      {
        type: 'reply',
        reply: { id: `r:${'ab'.repeat(24)}`, title: 'Refresh status' },
      },
    ]);
  });

  it('puts the banner in the reply-button header when there is no link, within the limits', async () => {
    const { a, graph } = adapter(undefined, {
      banners: { render: async () => PNG },
    });
    await a.send(ALICE, {
      text: 'x'.repeat(1500),
      card: SAMPLE_CARDS.proposal!,
      callbacks: [
        { label: 'A very long label that exceeds twenty', data: 'v:1' },
        { label: 'A very long label that exceeds twenty', data: 'v:2' },
        { label: 'three', data: 'v:3' },
        { label: 'four', data: 'v:4' },
      ],
    });
    expect(graph.sent.map((s) => s.type)).toEqual([
      'interactive:button',
      'text',
    ]);
    const it0 = graph.sent[0]!.body.interactive as Required<WaInteractive>;
    expect(it0.header).toEqual({ type: 'image', image: { id: 'media-1' } });
    expect(String(it0.body.text).length).toBeLessThanOrEqual(1024);
    const titles = (it0.action.buttons ?? []).map((b) =>
      String(b.reply?.title),
    );
    expect(titles).toHaveLength(3);
    expect(new Set(titles).size).toBe(3);
    expect(titles.every((t) => t.length <= 20)).toBe(true);
  });

  it('falls back to text when the banner upload fails and sends an image caption otherwise', async () => {
    const errors: unknown[] = [];
    const { a, graph } = adapter(undefined, {
      banners: { render: async () => PNG },
      onBannerError: (e) => errors.push(e),
    });
    graph.failNext.push({ endpoint: 'media', status: 400, code: 131053 });
    await a.send(ALICE, { text: 'receipt', card: SAMPLE_CARDS.dca! });
    expect(errors).toHaveLength(1);
    expect(graph.sent.map((s) => s.type)).toEqual(['text']);
    await a.send(ALICE, { text: 'receipt', card: SAMPLE_CARDS.dca! });
    expect(graph.sent.at(-1)!.body.image).toEqual({
      id: 'media-2',
      caption: 'receipt',
    });
  });

  it('retries documented throttling codes and never leaks the token in errors', async () => {
    const { a, graph } = adapter();
    graph.failNext.push({ endpoint: 'messages', status: 400, code: 130429 });
    await a.send(ALICE, { text: 'ok' });
    expect(graph.sent).toHaveLength(1);
    graph.failNext.push(
      { endpoint: 'messages', status: 400, code: 131056 },
      { endpoint: 'messages', status: 400, code: 131056 },
      { endpoint: 'messages', status: 400, code: 131056 },
    );
    expect(await a.send(ALICE, { text: 'x' }).catch((e) => e.code)).toBe(
      'RATE_LIMITED',
    );
    graph.failNext.push({ endpoint: 'messages', status: 400, code: 131047 });
    const window = await a.send(ALICE, { text: 'x' }).catch((e) => e);
    expect(window).toMatchObject({ code: 'PROVIDER_REJECTED', attempts: 1 });
    const badToken = new WhatsAppAdapter({
      api: new WhatsAppCloudApi({
        token: `${FAKE_WA_TOKEN}-wrong`,
        phoneNumberId: FAKE_PHONE_NUMBER_ID,
        baseUrl: FAKE_BASE_URL,
        fetch: graph.fetch,
      }),
      phoneNumberId: FAKE_PHONE_NUMBER_ID,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      allowedWaIds: [ALICE],
      sleep: noWait,
    });
    const denied = await badToken.send(ALICE, { text: 'x' }).catch((e) => e);
    expect(denied.code).toBe('PROVIDER_REJECTED');
    expect(String(denied.message)).not.toContain(FAKE_WA_TOKEN);
  });

  it('is BLOCKED_EXTERNAL and refuses every send without configuration', async () => {
    const blocked = new WhatsAppAdapter();
    expect(blocked.status).toBe('BLOCKED_EXTERNAL');
    const err = await blocked.send(ALICE, { text: 'x' }).catch((e) => e);
    expect(err.code).toBe('CHANNEL_UNAVAILABLE');
    expect(err.message).toMatch(/^BLOCKED_EXTERNAL/);
    const cap = channelCapabilities({}).find((c) => c.channel === 'whatsapp')!;
    expect(cap).toMatchObject({
      status: 'BLOCKED_EXTERNAL',
      evidence: 'NONE',
    });
    expect(cap.reason).toMatch(/Official Business Account/);
    expect(cap.reason).toMatch(/do not support interactive messages/);
    const configured = channelCapabilities({
      SYNQ_WHATSAPP_TOKEN: 'present',
      SYNQ_WHATSAPP_PHONE_NUMBER_ID: '1',
      SYNQ_WHATSAPP_APP_SECRET: 'present',
      SYNQ_WHATSAPP_VERIFY_TOKEN: 'present',
      SYNQ_WHATSAPP_ALLOWED_WA_IDS: ALICE,
    }).find((c) => c.channel === 'whatsapp')!;
    expect(configured).toMatchObject({
      status: 'AVAILABLE',
      evidence: 'FIXTURE_ONLY',
    });
  });

  it('reads configuration from env names and rejects partial configuration', () => {
    expect(whatsappConfigFromEnv({})).toBeNull();
    expect(() => whatsappConfigFromEnv({ SYNQ_WHATSAPP_TOKEN: 'x' })).toThrow(
      /SYNQ_WHATSAPP_PHONE_NUMBER_ID/,
    );
    const env = {
      SYNQ_WHATSAPP_TOKEN: FAKE_WA_TOKEN,
      SYNQ_WHATSAPP_PHONE_NUMBER_ID: FAKE_PHONE_NUMBER_ID,
      SYNQ_WHATSAPP_APP_SECRET: APP_SECRET,
      SYNQ_WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      SYNQ_WHATSAPP_ALLOWED_WA_IDS: `+${ALICE}, 447700900123`,
    };
    expect(whatsappConfigFromEnv(env)?.allowedWaIds).toEqual([
      ALICE,
      '447700900123',
    ]);
    expect(() =>
      whatsappConfigFromEnv({
        ...env,
        SYNQ_WHATSAPP_ALLOWED_WA_IDS: 'alice',
      }),
    ).toThrow(/ALLOWED_WA_IDS/);
    try {
      whatsappConfigFromEnv({ ...env, SYNQ_WHATSAPP_VERIFY_TOKEN: 'short' });
    } catch (e) {
      expect(String(e)).not.toContain(APP_SECRET);
      expect(String(e)).not.toContain(FAKE_WA_TOKEN);
    }
  });
});

describe('whatsapp cloud api adapter: receive', () => {
  it('verifies X-Hub-Signature-256 over the raw body in constant time', () => {
    const { a } = adapter();
    const raw = JSON.stringify(waWebhook(text('A', 'hi')));
    const sig = signWhatsAppWebhook(APP_SECRET, raw);
    expect(a.verifySignature(raw, sig)).toBe(true);
    expect(
      a.verifySignature(raw, sig.toUpperCase().replace('SHA256', 'sha256')),
    ).toBe(true);
    expect(a.verifySignature(`${raw} `, sig)).toBe(false);
    expect(a.verifySignature(raw, signWhatsAppWebhook('other', raw))).toBe(
      false,
    );
    expect(a.verifySignature(raw, sig.slice(7))).toBe(false);
    expect(a.verifySignature(raw, undefined)).toBe(false);
    expect(a.verifySignature(raw, [sig])).toBe(false);
    expect(
      new WhatsAppAdapter({ allowedWaIds: [ALICE] }).verifySignature(raw, sig),
    ).toBe(false);
  });

  it('answers the subscription handshake only with the verify token', () => {
    const { a } = adapter();
    const q = {
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1158201444',
    };
    expect(a.verifyChallenge(q)).toBe('1158201444');
    expect(a.verifyChallenge({ ...q, 'hub.verify_token': 'nope' })).toBeNull();
    expect(a.verifyChallenge({ ...q, 'hub.mode': 'unsubscribe' })).toBeNull();
    expect(a.verifyChallenge({ ...q, 'hub.challenge': '<script>' })).toBeNull();
  });

  it('maps text and button replies to 1:1 events and drops other senders, numbers and groups', () => {
    const drops: string[] = [];
    const { a } = adapter(undefined, { onDrop: (r) => drops.push(r) });
    const [cmd] = a.normalize(waWebhook(text('A', '/help me')));
    expect(cmd).toMatchObject({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'whatsapp',
        eventId: 'wamid:wamid.A',
        externalGroupId: ALICE,
        chatKind: 'DIRECT',
        externalUserId: ALICE,
        interaction: { kind: 'COMMAND', command: 'help', args: 'me' },
        verifiedSender: {
          transport: 'WEBHOOK_HMAC',
          displayName: 'Alice',
          isBot: false,
        },
      },
    });
    const [tap] = a.normalize(waWebhook(buttonReply('B', 'approve')));
    expect(tap).toMatchObject({
      type: 'ACTION_REQUESTED',
      callbackId: `${ALICE}:wamid.B`,
      envelope: {
        interaction: { kind: 'CALLBACK', callbackData: 'approve' },
        replyTo: 'wamid.ORIGINAL',
      },
    });
    expect(a.normalize(waWebhook(text('C', 'hi', MALLORY)))).toEqual([]);
    expect(
      a.normalize(waWebhook(text('D', 'hi'), { phoneNumberId: '999999' })),
    ).toEqual([]);
    expect(
      a.normalize(waWebhook({ ...text('E', 'hi'), group_id: 'g1' })),
    ).toEqual([]);
    expect(
      a.normalize(
        waWebhook({ ...text('F', ''), type: 'image', image: { id: '1' } }),
      ),
    ).toEqual([]);
    expect(a.normalize({ object: 'page', entry: [] })).toEqual([]);
    expect(drops).toEqual([
      'NOT_ALLOWLISTED',
      'WRONG_PHONE_NUMBER_ID',
      'GROUP_MESSAGE',
      'UNSUPPORTED_TYPE',
    ]);
  });
});

describe('whatsapp webhook routes through the gateway', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function server() {
    const graph = new FakeWhatsAppGraph();
    const { a } = adapter(graph);
    const store = new MemoryChannelStore();
    const approvalCalls: string[] = [];
    const ports: ChannelPorts = {
      activeMember: async () => ({ memberId: 'member_0' }),
      treasury: async () => null,
      mandates: async () => [],
      approvals: async (g) => {
        approvalCalls.push(g);
        return [
          {
            intentHash: `0x${'ab'.repeat(32)}`,
            draftDigest: `0x${'cd'.repeat(32)}`,
            label: 'Send 10 AUSD',
            counted: 1,
            required: 2,
            status: 'PENDING',
          },
        ];
      },
      receipts: async () => [],
    };
    const gateway = new ChannelGateway({
      store,
      ports,
      adapters: [a],
      webBaseUrl: 'https://synq.example',
      explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
      now: () => NOW,
      cards: { links: null },
    });
    app = Fastify();
    await app.register(channelRoutes, {
      gateway,
      whatsapp: a,
      now: () => NOW,
      memberSession: async () => null,
      env: {},
    });
    const post = (body: unknown, sign = true) => {
      const raw = JSON.stringify(body);
      return app!.inject({
        method: 'POST',
        url: '/v1/channels/whatsapp/webhook',
        headers: {
          'content-type': 'application/json',
          ...(sign
            ? { 'x-hub-signature-256': signWhatsAppWebhook(APP_SECRET, raw) }
            : {}),
        },
        payload: raw,
      });
    };
    return { graph, store, post, approvalCalls };
  }

  it('echoes the challenge for the verify token and 403s otherwise', async () => {
    await server();
    const ok = await app!.inject({
      method: 'GET',
      url: `/v1/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=8723`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('8723');
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    const bad = await app!.inject({
      method: 'GET',
      url: '/v1/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=8723',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned or mis-signed posts before any processing', async () => {
    const { post, store, graph } = await server();
    expect((await post(waWebhook(text('A', '/help')), false)).statusCode).toBe(
      401,
    );
    const raw = JSON.stringify(waWebhook(text('A', '/help')));
    const tampered = await app!.inject({
      method: 'POST',
      url: '/v1/channels/whatsapp/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWhatsAppWebhook(APP_SECRET, raw),
      },
      payload: raw.replace('/help', '/send'),
    });
    expect(tampered.statusCode).toBe(401);
    expect(store.events.size).toBe(0);
    expect(graph.sent).toHaveLength(0);
  });

  it('handles a signed message once and dedupes Meta retries by wamid', async () => {
    const { post, graph } = await server();
    const body = waWebhook(text('A', '/help'));
    expect((await post(body)).json()).toEqual({
      ok: true,
      outcomes: ['HANDLED'],
    });
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]!.body.context).toEqual({ message_id: 'wamid.A' });
    expect((await post(body)).json()).toEqual({
      ok: true,
      outcomes: ['DUPLICATE'],
    });
    expect(graph.sent).toHaveLength(1);
    expect((await post(waWebhook(text('Z', '/help', MALLORY)))).json()).toEqual(
      { ok: true, outcomes: [] },
    );
  });

  it('never turns a button reply or chat text into an approval', async () => {
    const { post, graph, approvalCalls } = await server();
    const outcomes = [];
    for (const [i, id] of [
      'approve',
      'yes',
      `r:${'ab'.repeat(24)}`,
      'APPROVE_REVIEW_APPROVE',
    ].entries())
      outcomes.push(
        ...(await post(waWebhook(buttonReply(`T${i}`, id)))).json().outcomes,
      );
    outcomes.push(
      ...(await post(waWebhook(text('Y', 'approve')))).json().outcomes,
    );
    expect(outcomes).toEqual([
      'REFUSED',
      'REFUSED',
      'UNAUTHORIZED',
      'REFUSED',
      'REFUSED',
    ]);
    // Refresh in an unlinked 1:1 chat never reads proposals, let alone counts one.
    expect(approvalCalls).toEqual([]);
    const replies = graph.sent.map(
      (s) => (s.body.text as { body: string }).body,
    );
    expect(replies.slice(0, 2)).toEqual([
      'Approvals happen only on the Synq web page with your passkey.',
      'Approvals happen only on the Synq web page with your passkey.',
    ]);
    expect(replies.at(-1)).toMatch(/never approve/);
    expect(graph.sent.every((s) => s.to === `+${ALICE}`)).toBe(true);
  });
});
