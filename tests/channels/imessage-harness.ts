import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BlueBubblesTransport,
  CardLinkIssuer,
  ChannelGateway,
  IMessageBridge,
  IMessageChannelAdapter,
  OutboundLimiter,
  type ChannelEvent,
  type GatewayOutcome,
} from '@synq/channels';
import { CARD_KEY, fixture } from './harness.js';

export const NOW = 1_800_000_000;
export const GROUP_CHAT = 'iMessage;+;chat123456789012345678';
export const OTHER_CHAT = 'iMessage;+;chat999999999999999999';
export const SECOND_CHAT = 'iMessage;+;chat222222222222222222';
export const ALICE = '+15550100001';
export const BOB = '+15550100002';
export const MALLORY = '+15550100666';
export const BOT_HANDLE = 'synq-bridge@example.com';
const PASSWORD = 'bb-test-password-123';

export const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/imessage', name), 'utf8'),
  ) as Record<string, unknown>;

type ServerMessage = {
  guid: string;
  text: string;
  handle: { address: string } | null;
  chats: { guid: string }[];
  attachments: [];
  dateCreated: number;
  isFromMe: boolean;
  associatedMessageGuid: null;
  threadOriginatorGuid: null;
};

/** In-memory BlueBubbles server behind fetch: the real transport code runs against it. */
export class FakeBlueBubbles {
  up = true;
  rejectSends = false;
  messages = new Map<string, ServerMessage>();
  sent: { chatGuid: string; text: string; tempGuid: string }[] = [];
  urls: string[] = [];
  private n = 0;
  constructor(private readonly clock: { t: number }) {}

  /** A member writes in a chat (the server learns it; a webhook may or may not follow). */
  write(chat: string, handle: string, text: string, at = this.clock.t) {
    const guid = `IN-${++this.n}`;
    const m: ServerMessage = {
      guid,
      text,
      handle: { address: handle },
      chats: [{ guid: chat }],
      attachments: [],
      dateCreated: at * 1000,
      isFromMe: false,
      associatedMessageGuid: null,
      threadOriginatorGuid: null,
    };
    this.messages.set(guid, m);
    return { type: 'new-message', data: m };
  }

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    this.urls.push(String(input));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (url.searchParams.get('password') !== PASSWORD)
      return json({ status: 401, error: { type: 'Unauthorized' } }, 401);
    if (!this.up) throw new TypeError('fetch failed');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (path === '/ping') return json({ status: 200, data: 'pong' });
    if (path === '/server/info')
      return json({
        status: 200,
        data: {
          os_version: '27.2',
          server_version: 'fake',
          private_api: false,
        },
      });
    if (path === '/message/text') {
      if (this.rejectSends)
        return json({ status: 400, error: { type: 'Bad Request' } }, 400);
      const body = JSON.parse(String(init?.body)) as {
        chatGuid: string;
        message: string;
        tempGuid: string;
        method: string;
      };
      this.sent.push({
        chatGuid: body.chatGuid,
        text: body.message,
        tempGuid: body.tempGuid,
      });
      return json({ status: 200, data: { guid: `OUT-${this.sent.length}` } });
    }
    if (path === '/message/query') {
      const body = JSON.parse(String(init?.body)) as {
        chatGuid: string;
        after: number;
      };
      return json({
        status: 200,
        data: [...this.messages.values()].filter(
          (m) =>
            m.chats[0]!.guid === body.chatGuid && m.dateCreated > body.after,
        ),
      });
    }
    const one = /^\/message\/([^/]+)$/.exec(path);
    if (one) {
      const m = this.messages.get(decodeURIComponent(one[1]!));
      return m
        ? json({ status: 200, data: m })
        : json({ status: 404, error: { type: 'Not Found' } }, 404);
    }
    return json({ status: 404 }, 404);
  }) as typeof fetch;

  textsTo(chat: string) {
    return this.sent.filter((s) => s.chatGuid === chat).map((s) => s.text);
  }
}

export function imessageFixture(
  options: { chatLinkQuorum?: number; allowed?: string[] } = {},
) {
  const f = fixture(NOW, { cards: true });
  const server = new FakeBlueBubbles(f.clock);
  const transport = new BlueBubblesTransport({
    baseUrl: 'http://127.0.0.1:1234',
    password: PASSWORD,
    fetch: server.fetch,
  });
  const noWait = async () => undefined;
  const adapter = new IMessageChannelAdapter({
    transport,
    botHandle: BOT_HANDLE,
    sleep: noWait,
    nowMs: () => f.clock.t * 1000,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
  });
  const gateway = new ChannelGateway({
    store: f.store,
    ports: f.ports,
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
    now: () => f.clock.t,
    brainCooldownSeconds: 0,
    chatLinkQuorum: options.chatLinkQuorum ?? 1,
    cards: {
      links: new CardLinkIssuer({
        key: CARD_KEY,
        webBaseUrl: 'https://synq.example',
        now: () => f.clock.t,
        ttlSeconds: 3600,
      }),
    },
  });
  const handled: { event: ChannelEvent; outcome: GatewayOutcome }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const bridge = new IMessageBridge({
    transport,
    adapter,
    gateway: {
      handle: async (event) => {
        const outcome = await gateway.handle(event);
        handled.push({ event, outcome });
        return outcome;
      },
    },
    allowedChats: options.allowed ?? [GROUP_CHAT, SECOND_CHAT],
    now: () => f.clock.t,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
  });
  const webhook = (raw: unknown) =>
    Promise.all(
      transport.parseEvent(raw).map((m) => bridge.ingest(m, 'WEBHOOK')),
    );
  /** A member writes in a chat and the server fires its webhook. */
  const say = async (chat: string, handle: string, text: string) =>
    (await webhook(server.write(chat, handle, text)))[0]!;

  /** Full link through iMessage: group /synq, DM /start, web redemption, DM /confirm. */
  const link = async (
    handle: string,
    principalId: string,
    groupId: string,
    chat = GROUP_CHAT,
  ) => {
    await say(chat, handle, '/synq');
    const deep = server.textsTo(chat).at(-1) ?? '';
    const nonce = /start%20([A-Za-z0-9_-]+)/.exec(deep)?.[1] ?? '';
    const dm = `any;-;${handle}`;
    await say(dm, handle, `/start ${nonce}`);
    const code =
      /\/channels\/link\?code=([A-Za-z0-9_-]+)/.exec(
        server.textsTo(`iMessage;-;${handle}`).join('\n'),
      )?.[1] ?? '';
    const redeemed = await gateway.redeemLinkCode({
      code,
      groupId,
      principalId,
    });
    const token =
      /\/confirm ([A-Za-z0-9_-]+)/.exec(
        server.textsTo(`iMessage;-;${handle}`).at(-1) ?? '',
      )?.[1] ?? '';
    const confirmed = await say(dm, handle, `/confirm ${token}`);
    return { deep, nonce, code, redeemed, confirmed };
  };
  return {
    ...f,
    server,
    transport,
    adapter,
    gateway,
    bridge,
    handled,
    logs,
    webhook,
    say,
    link,
  };
}
