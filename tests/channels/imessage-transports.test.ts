import { describe, expect, it } from 'vitest';
import {
  BeeperTransport,
  BlueBubblesTransport,
  IMessageBridge,
  IMessageChannelAdapter,
  IMessageTransportError,
  LinqTransport,
  LinqV3Adapter,
  OutboundLimiter,
  normalizeChatGuid,
  normalizeHandle,
  type ChannelEvent,
} from '@synq/channels';
import { loadFixture } from './imessage-harness.js';

type Call = { url: string; init: RequestInit | undefined };
const recorder = (
  respond: (url: string) => { status?: number; body: unknown },
) => {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = respond(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
};

describe('BlueBubblesTransport', () => {
  const PASSWORD = 'secret-password-xyz';
  it('sends via AppleScript to the normalized chat GUID with a stable tempGuid', async () => {
    const { f, calls } = recorder(() => ({
      body: { status: 200, data: { guid: 'G1' } },
    }));
    const t = new BlueBubblesTransport({
      baseUrl: 'http://127.0.0.1:1234',
      password: PASSWORD,
      fetch: f,
    });
    expect(
      await t.send('any;+;chat1', {
        text: 'hi',
        idempotencyKey: 'k1',
        replyToMessageId: 'X',
      }),
    ).toEqual({
      messageId: 'G1',
    });
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toEqual({
      chatGuid: 'iMessage;+;chat1',
      tempGuid: 'synq-k1',
      message: 'hi',
      method: 'apple-script',
    });
    expect(calls[0]!.url).toContain('/api/v1/message/text?');
    expect(t.capabilities).toMatchObject({
      replies: false,
      requiresSipDisabled: false,
    });
  });

  it('never leaks the server password in errors', async () => {
    const { f } = recorder(() => ({
      status: 500,
      body: { error: `boom ${PASSWORD}` },
    }));
    const t = new BlueBubblesTransport({
      baseUrl: 'http://127.0.0.1:1234',
      password: PASSWORD,
      fetch: f,
    });
    const error = await t
      .send('iMessage;+;c', { text: 'x', idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IMessageTransportError);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect((error as IMessageTransportError).retryable).toBe(true);
    const health = await t.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain(PASSWORD);
  });

  it('parses recorded webhook shapes and skips tapbacks', () => {
    const t = new BlueBubblesTransport({
      baseUrl: 'http://127.0.0.1:1234',
      password: PASSWORD,
    });
    expect(t.parseEvent(loadFixture('bluebubbles-group-command.json'))).toEqual(
      [
        {
          transport: 'bluebubbles',
          kind: 'MESSAGE',
          messageId: '8F0C2A4E-1D3B-4C55-9A61-0B7E2D9C1A01',
          chatId: 'iMessage;+;chat123456789012345678',
          isGroup: true,
          senderHandle: '+15550100001',
          senderName: null,
          isFromMe: false,
          text: '/balance',
          timestamp: 1_800_000_000,
          replyToMessageId: null,
          attachments: [],
          members: [],
        },
      ],
    );
    expect(
      t.parseEvent(loadFixture('bluebubbles-direct-start.json'))[0],
    ).toMatchObject({
      chatId: 'iMessage;-;+15550100001',
      isGroup: false,
    });
    expect(t.parseEvent(loadFixture('bluebubbles-tapback.json'))).toEqual([]);
    expect(
      t.parseEvent(loadFixture('bluebubbles-participant-left.json'))[0],
    ).toMatchObject({
      kind: 'MEMBER_LEFT',
      members: ['+15550100001'],
    });
    expect(t.parseEvent({ type: 'typing-indicator', data: {} })).toEqual([]);
    expect(t.parseEvent('garbage')).toEqual([]);
  });

  it('normalizes handles and macOS 26+ chat GUIDs', () => {
    expect(normalizeChatGuid('any;-;+15550100001')).toBe(
      'iMessage;-;+15550100001',
    );
    expect(normalizeHandle('+1 (555) 010-0001')).toBe('+15550100001');
    expect(normalizeHandle('Alice@Example.com')).toBe('alice@example.com');
    expect(normalizeHandle('not a handle')).toBeNull();
  });
});

describe('BeeperTransport', () => {
  it('only talks to the local Desktop API', () => {
    expect(
      () =>
        new BeeperTransport({
          baseUrl: 'https://evil.example',
          token: 'tok-12345678',
        }),
    ).toThrow('BEEPER_DESKTOP_API_MUST_BE_LOCAL');
  });

  it('sends with bearer auth and parses message.upserted frames', async () => {
    const { f, calls } = recorder(() => ({
      body: { chatID: 'c', pendingMessageID: 'p1' },
    }));
    const t = new BeeperTransport({ token: 'tok-12345678', fetch: f });
    expect(
      await t.send('!c:beeper.local', {
        text: 'hi',
        idempotencyKey: 'k',
        replyToMessageId: 'm0',
      }),
    ).toEqual({
      messageId: 'p1',
    });
    expect(calls[0]!.url).toBe(
      'http://localhost:23373/v1/chats/!c%3Abeeper.local/messages',
    );
    expect(
      (calls[0]!.init!.headers as Record<string, string>).authorization,
    ).toBe('Bearer tok-12345678');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      text: 'hi',
      replyToMessageID: 'm0',
    });
    expect(
      t.parseEvent(loadFixture('beeper-message-upserted.json')),
    ).toMatchObject([
      {
        transport: 'beeper',
        chatId: '!imsgchat123:beeper.local',
        senderHandle: '+15550100002',
        text: '@synq what is our balance?',
        timestamp: 1_800_000_000,
        isGroup: null,
      },
    ]);
    expect(JSON.parse(BeeperTransport.subscribeFrame(['!a']))).toEqual({
      type: 'subscriptions.set',
      requestID: 'synq-bridge',
      chatIDs: ['!a'],
    });
  });

  it('forwards an allowlisted Beeper group mention with the mention stripped', async () => {
    const { f } = recorder((url) =>
      url.includes('/messages/msg_0001')
        ? {
            body: (
              loadFixture('beeper-message-upserted.json').entries as unknown[]
            )[0],
          }
        : { body: {} },
    );
    const t = new BeeperTransport({ token: 'tok-12345678', fetch: f });
    const seen: ChannelEvent[] = [];
    const bridge = new IMessageBridge({
      transport: t,
      adapter: new IMessageChannelAdapter({
        transport: t,
        limiter: new OutboundLimiter({
          perChatIntervalMs: 0,
          globalIntervalMs: 0,
        }),
      }),
      gateway: {
        handle: async (e) => {
          seen.push(e);
          return { status: 'HANDLED', code: null, delivered: 0, failed: 0 };
        },
      },
      allowedChats: ['!imsgchat123:beeper.local'],
      now: () => 1_800_000_000,
    });
    const [m] = t.parseEvent(loadFixture('beeper-message-upserted.json'));
    expect((await bridge.ingest(m!, 'SOCKET')).status).toBe('FORWARDED');
    expect(seen[0]).toMatchObject({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'imessage',
        chatKind: 'GROUP',
        body: 'what is our balance?',
        interaction: { kind: 'MENTION', addressedToBot: true },
        verifiedSender: { transport: 'IMESSAGE_BRIDGE' },
      },
    });
  });

  it('drops a non-allowlisted Beeper chat that the chat lookup reports as a group', async () => {
    const { f } = recorder(() => ({ body: { type: 'group' } }));
    const t = new BeeperTransport({ token: 'tok-12345678', fetch: f });
    const bridge = new IMessageBridge({
      transport: t,
      adapter: new IMessageChannelAdapter({ transport: t }),
      gateway: {
        handle: async () => ({
          status: 'HANDLED',
          code: null,
          delivered: 0,
          failed: 0,
        }),
      },
      allowedChats: [],
    });
    const [m] = t.parseEvent(loadFixture('beeper-message-upserted.json'));
    expect((await bridge.ingest(m!, 'SOCKET')).status).toBe(
      'DROPPED_NOT_ALLOWLISTED',
    );
  });
});

describe('LinqTransport', () => {
  it('wraps the Linq V3 adapter behind the transport interface', async () => {
    const { f, calls } = recorder(() => ({
      body: { id: 'lm_1', message: { id: 'lm_1' } },
    }));
    const adapter = new LinqV3Adapter({
      apiKey: 'linq-key',
      webhookSecret: `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`,
      fetch: f,
      limiter: new OutboundLimiter({
        perChatIntervalMs: 0,
        globalIntervalMs: 0,
      }),
    });
    const t = new LinqTransport(adapter, true, () => 1_800_000_000);
    await t.send('chat_1', { text: 'hello', idempotencyKey: 'k' });
    expect(calls).toHaveLength(1);
    expect(t.parseEvent()).toEqual([]);
    const [m] = t.parseVerified(
      {
        api_version: 'v3',
        webhook_version: '2026-02-03',
        event_type: 'message.received',
        event_id: 'evt_1',
        created_at: '2027-01-15T08:00:00Z',
        data: {
          id: 'm_1',
          direction: 'inbound',
          chat: {
            id: 'chat_1',
            is_group: true,
            owner_handle: { handle: '+15550000000' },
          },
          sender_handle: { handle: '+15551112222', is_me: false },
          parts: [{ type: 'text', value: '/balance' }],
          sent_at: '2027-01-15T08:00:00Z',
        },
      },
      'msg_1',
    );
    expect(m).toMatchObject({
      transport: 'linq',
      chatId: 'chat_1',
      isGroup: true,
      text: '/balance',
    });
    expect((await t.health()).ok).toBe(true);
  });
});
