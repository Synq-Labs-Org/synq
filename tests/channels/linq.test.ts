import { describe, expect, it } from 'vitest';
import {
  LinqV3Adapter,
  OutboundLimiter,
  WhatsAppAdapter,
  channelCapabilities,
  signLinqWebhookForTest,
  verifyLinqWebhook,
} from '@synq/channels';

const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const NOW = 1_800_000_000;
const noWait = async () => undefined;
const signed = (body: string, ts = NOW, id = 'msg_1') => ({
  'webhook-id': id,
  'webhook-timestamp': String(ts),
  'webhook-signature': `v1,AAAA ${signLinqWebhookForTest(SECRET, id, ts, body)}`,
});
const received = {
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
};

describe('linq v3 adapter', () => {
  it('verifies Standard Webhooks signatures over the raw body', () => {
    const body = JSON.stringify(received);
    expect(
      verifyLinqWebhook({
        secret: SECRET,
        headers: signed(body),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toEqual({
      ok: true,
      webhookId: 'msg_1',
      timestamp: NOW,
    });
    const tampered = body.replace('/balance', '/send 9 me');
    expect(
      verifyLinqWebhook({
        secret: SECRET,
        headers: signed(body),
        rawBody: tampered,
        nowSeconds: NOW,
      }),
    ).toEqual({
      ok: false,
      code: 'SIGNATURE_INVALID',
    });
    expect(
      verifyLinqWebhook({
        secret: SECRET,
        headers: signed(body, NOW - 301),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toMatchObject({ code: 'TIMESTAMP_OUT_OF_WINDOW' });
    expect(
      verifyLinqWebhook({
        secret: undefined,
        headers: signed(body),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toMatchObject({
      code: 'SECRET_NOT_CONFIGURED',
    });
    expect(
      verifyLinqWebhook({
        secret: SECRET,
        headers: {},
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toMatchObject({
      code: 'HEADERS_MISSING',
    });
    const otherSecret = `whsec_${Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64')}`;
    expect(
      verifyLinqWebhook({
        secret: otherSecret,
        headers: signed(body),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('normalizes 2026 and 2025 message payloads, participants and group creation', () => {
    const a = new LinqV3Adapter({ webhookSecret: SECRET });
    const [m] = a.normalize(received, 'msg_1', NOW);
    expect(m).toMatchObject({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'linq',
        eventId: 'webhook:msg_1',
        externalGroupId: 'chat_1',
        externalUserId: '+15551112222',
        chatKind: 'GROUP',
        body: '/balance',
        timestamp: Date.parse('2027-01-15T08:00:00Z') / 1000,
        interaction: {
          kind: 'COMMAND',
          command: 'balance',
          addressedToBot: true,
        },
        verifiedSender: { transport: 'WEBHOOK_HMAC' },
      },
    });
    const [legacy] = a.normalize(
      {
        event_type: 'message.received',
        data: {
          chat_id: 'chat_2',
          from_handle: '+1555',
          is_group: true,
          message: {
            id: 'm2',
            parts: [{ type: 'text', value: 'hey synq what is our balance' }],
          },
        },
      },
      'msg_2',
      NOW,
    );
    expect(legacy).toMatchObject({
      envelope: {
        externalGroupId: 'chat_2',
        interaction: { kind: 'MENTION', addressedToBot: true },
      },
    });
    expect(
      a.normalize(
        { ...received, data: { ...received.data, direction: 'outbound' } },
        'msg_3',
        NOW,
      ),
    ).toEqual([]);
    expect(
      a.normalize(
        {
          event_type: 'participant.removed',
          data: {
            chat_id: 'chat_1',
            participant: { handle: '+1555', status: 'removed' },
            removed_at: '2027-01-15T08:00:00Z',
          },
        },
        'msg_4',
        NOW,
      )[0],
    ).toMatchObject({
      type: 'MEMBER_LEFT',
      members: [{ externalUserId: '+1555' }],
    });
    expect(
      a.normalize(
        {
          event_type: 'chat.created',
          data: { id: 'chat_9', is_group: true, display_name: 'Tokyo' },
        },
        'msg_5',
        NOW,
      )[0],
    ).toMatchObject({ type: 'GROUP_CREATED', title: 'Tokyo' });
    expect(
      a.normalize({ event_type: 'poll.sent', data: {} }, 'msg_6', NOW),
    ).toEqual([]);
  });

  it('sends text then standalone link parts with idempotency keys and retries 429', async () => {
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    let n = 0;
    const a = new LinqV3Adapter({
      apiKey: 'linq_test_key',
      sleep: noWait,
      limiter: new OutboundLimiter({
        perChatIntervalMs: 0,
        globalIntervalMs: 0,
        sleep: noWait,
      }),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        });
        return ++n === 1
          ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
          : new Response(JSON.stringify({ id: `out_${n}` }), { status: 200 });
      }) as typeof fetch,
    });
    const r = await a.send('chat_1', {
      text: 'Approve',
      buttons: [{ label: 'Review', url: 'https://synq.example/intents/0x1' }],
      idempotencyKey: 'k',
    });
    expect(r).toEqual({ messageId: 'out_3' });
    expect(calls.map((c) => c.url)).toEqual(
      Array(3).fill(
        'https://api.linqapp.com/api/partner/v3/chats/chat_1/messages',
      ),
    );
    expect(calls[0]!.auth).toBe('Bearer linq_test_key');
    expect(calls[1]!.body).toEqual({
      message: {
        parts: [{ type: 'text', value: 'Approve' }],
        idempotency_key: 'k:0',
      },
    });
    expect(calls[2]!.body).toEqual({
      message: {
        parts: [{ type: 'link', value: 'https://synq.example/intents/0x1' }],
        idempotency_key: 'k:1',
      },
    });
  });

  it('refuses to send without credentials', async () => {
    expect(
      await new LinqV3Adapter({}).send('c', { text: 'x' }).catch((e) => e.code),
    ).toBe('CHANNEL_UNAVAILABLE');
  });
});

describe('channel capabilities', () => {
  it('reports WhatsApp unavailable and credential state honestly', async () => {
    const caps = channelCapabilities({ TELEGRAM_BOT_TOKEN: 'x' });
    expect(caps.map((c) => [c.channel, c.status])).toEqual([
      ['telegram', 'AVAILABLE'],
      ['linq', 'CREDENTIALS_MISSING'],
      ['imessage', 'CREDENTIALS_MISSING'],
      ['whatsapp', 'UNAVAILABLE'],
    ]);
    expect(await new WhatsAppAdapter().send().catch((e) => e.code)).toBe(
      'CHANNEL_UNAVAILABLE',
    );
  });
});
