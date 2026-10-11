import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelEvent,
  type DeliveryResult,
  type Envelope,
  type OutboundMessage,
} from './events.js';
import {
  OutboundLimiter,
  sleep as defaultSleep,
  type Sleep,
} from './outbound.js';

export const LINQ_DEFAULT_BASE_URL = 'https://api.linqapp.com/api/partner/v3';
export const LINQ_REPLAY_WINDOW_SECONDS = 300;

export type LinqWebhookHeaders = {
  'webhook-id'?: string | string[];
  'webhook-timestamp'?: string | string[];
  'webhook-signature'?: string | string[];
};
export type LinqVerification =
  | { ok: true; webhookId: string; timestamp: number }
  | {
      ok: false;
      code:
        | 'SECRET_NOT_CONFIGURED'
        | 'HEADERS_MISSING'
        | 'TIMESTAMP_INVALID'
        | 'TIMESTAMP_OUT_OF_WINDOW'
        | 'SIGNATURE_INVALID';
    };

const one = (v: string | string[] | undefined) =>
  typeof v === 'string' ? v : null;

/**
 * Standard Webhooks verification as documented for Linq V3: HMAC-SHA256 over
 * "{webhook-id}.{webhook-timestamp}.{raw body}" with the base64 key after the
 * `whsec_` prefix; `webhook-signature` carries space-separated `v1,<base64>`.
 */
export function verifyLinqWebhook(input: {
  secret: string | undefined;
  headers: LinqWebhookHeaders;
  rawBody: string;
  nowSeconds: number;
}): LinqVerification {
  if (!input.secret || !input.secret.startsWith('whsec_'))
    return { ok: false, code: 'SECRET_NOT_CONFIGURED' };
  const id = one(input.headers['webhook-id']);
  const ts = one(input.headers['webhook-timestamp']);
  const sig = one(input.headers['webhook-signature']);
  if (!id || !ts || !sig) return { ok: false, code: 'HEADERS_MISSING' };
  if (!/^[0-9]{1,12}$/.test(ts))
    return { ok: false, code: 'TIMESTAMP_INVALID' };
  const timestamp = Number(ts);
  if (Math.abs(input.nowSeconds - timestamp) > LINQ_REPLAY_WINDOW_SECONDS)
    return { ok: false, code: 'TIMESTAMP_OUT_OF_WINDOW' };
  let key: Buffer;
  try {
    key = Buffer.from(input.secret.slice('whsec_'.length), 'base64');
  } catch {
    return { ok: false, code: 'SECRET_NOT_CONFIGURED' };
  }
  if (key.length < 16) return { ok: false, code: 'SECRET_NOT_CONFIGURED' };
  const expected = createHmac('sha256', key)
    .update(`${id}.${ts}.${input.rawBody}`)
    .digest();
  const matched = sig
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .some((s) => {
      const given = Buffer.from(s.slice(3), 'base64');
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
  return matched
    ? { ok: true, webhookId: id, timestamp }
    : { ok: false, code: 'SIGNATURE_INVALID' };
}

export function signLinqWebhookForTest(
  secret: string,
  id: string,
  ts: number,
  body: string,
) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

const HandleSchema = z.looseObject({
  handle: z.string().optional(),
  id: z.string().optional(),
  is_me: z.boolean().optional(),
  status: z.string().optional(),
});
const PartSchema = z.looseObject({
  type: z.string(),
  value: z.string().optional(),
});
const EnvelopeV3Schema = z.looseObject({
  event_type: z.string(),
  event_id: z.string().optional(),
  created_at: z.string().optional(),
  data: z.looseObject({}).catchall(z.unknown()),
});
const MessageV2026Schema = z.looseObject({
  id: z.string(),
  chat: z.looseObject({ id: z.string(), is_group: z.boolean().optional() }),
  direction: z.string().optional(),
  sender_handle: HandleSchema.optional(),
  parts: z.array(PartSchema).optional(),
  sent_at: z.string().nullable().optional(),
  reply_to: z.unknown().optional(),
});
const MessageV2025Schema = z.looseObject({
  chat_id: z.string(),
  from: z.string().optional(),
  from_handle: z.string().optional(),
  is_from_me: z.boolean().optional(),
  is_group: z.boolean().optional(),
  message: z.looseObject({
    id: z.string(),
    parts: z.array(PartSchema).optional(),
  }),
});
const ParticipantSchema = z.looseObject({
  chat_id: z.string(),
  handle: z.string().optional(),
  participant: HandleSchema.optional(),
  added_at: z.string().optional(),
  removed_at: z.string().optional(),
});
const ChatCreatedSchema = z.looseObject({
  id: z.string(),
  display_name: z.string().nullable().optional(),
  is_group: z.boolean().optional(),
  created_at: z.string().optional(),
});

const seconds = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
};
const textOf = (parts: z.output<typeof PartSchema>[] | undefined) =>
  (parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.value === 'string')
    .map((p) => p.value)
    .join('\n')
    .slice(0, 10_000);

export type LinqAdapterOptions = {
  apiKey?: string;
  webhookSecret?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Text that addresses the agent in a Linq-managed group besides /commands. */
  mentionWords?: readonly string[];
  limiter?: OutboundLimiter;
  maxAttempts?: number;
  sleep?: Sleep;
};

export class LinqV3Adapter implements ChannelAdapter {
  readonly channel = 'linq' as const;
  private readonly limiter: OutboundLimiter;
  private readonly wait: Sleep;
  constructor(private readonly options: LinqAdapterOptions) {
    this.wait = options.sleep ?? defaultSleep;
    this.limiter =
      options.limiter ??
      new OutboundLimiter({
        perChatIntervalMs: 1_000,
        globalIntervalMs: 100,
        sleep: this.wait,
      });
  }

  verify(headers: LinqWebhookHeaders, rawBody: string, nowSeconds: number) {
    return verifyLinqWebhook({
      secret: this.options.webhookSecret,
      headers,
      rawBody,
      nowSeconds,
    });
  }

  /** `webhookId` is the Standard Webhooks id: the dedupe key across Linq retries. */
  normalize(
    raw: unknown,
    webhookId: string,
    receivedAt: number,
  ): ChannelEvent[] {
    const parsed = EnvelopeV3Schema.safeParse(raw);
    if (!parsed.success) return [];
    const { event_type: type, data } = parsed.data;
    const eventId = `webhook:${webhookId}`.slice(0, 200);
    const words = (this.options.mentionWords ?? ['synq']).map((w) =>
      w.toLowerCase(),
    );
    const env = (
      chatId: string,
      isGroup: boolean,
      handle: string | null,
      timestamp: number,
      messageId: string | null,
    ): Envelope => ({
      channel: 'linq',
      eventId,
      externalGroupId: chatId.slice(0, 200),
      chatKind: isGroup ? 'GROUP' : 'DIRECT',
      externalUserId: handle ? handle.slice(0, 200) : null,
      messageId,
      body: '',
      timestamp,
      replyTo: null,
      interaction: {
        kind: 'SYSTEM',
        addressedToBot: false,
        command: null,
        args: '',
        callbackData: null,
      },
      attachments: [],
      verifiedSender: {
        transport: 'WEBHOOK_HMAC',
        providerUserId: handle,
        displayName: handle,
        isBot: false,
      },
    });
    if (type === 'message.received') {
      const v26 = MessageV2026Schema.safeParse(data);
      const v25 = v26.success ? null : MessageV2025Schema.safeParse(data);
      let e: Envelope;
      let body: string;
      if (v26.success) {
        const m = v26.data;
        if (m.direction === 'outbound' || m.sender_handle?.is_me) return [];
        body = textOf(m.parts);
        e = env(
          m.chat.id,
          m.chat.is_group ?? false,
          m.sender_handle?.handle ?? null,
          seconds(m.sent_at, receivedAt),
          m.id,
        );
      } else if (v25?.success) {
        const m = v25.data;
        if (m.is_from_me) return [];
        body = textOf(m.message.parts);
        e = env(
          m.chat_id,
          m.is_group ?? false,
          m.from_handle ?? m.from ?? null,
          receivedAt,
          m.message.id,
        );
      } else return [];
      const trimmed = body.trim();
      const command = /^\/([A-Za-z0-9_]{1,32})\b/.exec(trimmed);
      const mention = words.some((w) =>
        new RegExp(`(^|\\W)@?${w}(\\W|$)`, 'i').test(trimmed),
      );
      return [
        {
          type: 'MESSAGE_RECEIVED',
          envelope: {
            ...e,
            body,
            interaction: {
              kind: command ? 'COMMAND' : mention ? 'MENTION' : 'TEXT',
              addressedToBot: !!command || mention || e.chatKind === 'DIRECT',
              command: command ? command[1]!.toLowerCase() : null,
              args: command
                ? trimmed.slice(command[0].length).trim().slice(0, 4096)
                : '',
              callbackData: null,
            },
          },
        },
      ];
    }
    if (type === 'participant.added' || type === 'participant.removed') {
      const p = ParticipantSchema.safeParse(data);
      if (!p.success) return [];
      const handle = p.data.participant?.handle ?? p.data.handle;
      if (!handle) return [];
      const at = seconds(p.data.added_at ?? p.data.removed_at, receivedAt);
      const e = env(p.data.chat_id, true, null, at, null);
      const members = [
        {
          externalUserId: handle.slice(0, 200),
          displayName: handle,
          isBot: p.data.participant?.is_me ?? false,
        },
      ];
      const interaction = { ...e.interaction, kind: 'MEMBERSHIP' as const };
      return [
        type === 'participant.added'
          ? { type: 'MEMBER_JOINED', envelope: { ...e, interaction }, members }
          : { type: 'MEMBER_LEFT', envelope: { ...e, interaction }, members },
      ];
    }
    if (type === 'chat.created') {
      const c = ChatCreatedSchema.safeParse(data);
      if (!c.success || !c.data.is_group) return [];
      return [
        {
          type: 'GROUP_CREATED',
          envelope: env(
            c.data.id,
            true,
            null,
            seconds(c.data.created_at, receivedAt),
            null,
          ),
          title: c.data.display_name ?? null,
        },
      ];
    }
    return [];
  }

  async send(
    chatId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    if (!this.options.apiKey)
      throw new ChannelDeliveryError(
        'CHANNEL_UNAVAILABLE',
        0,
        'linq api key not configured',
      );
    const texts = [message.text.slice(0, 10_000)];
    const links = (message.buttons ?? []).map((b) => b.url.slice(0, 2048));
    let last: DeliveryResult = { messageId: '' };
    for (const [i, part] of [
      ...texts.map((value) => ({ type: 'text', value })),
      ...links.map((value) => ({ type: 'link', value })),
    ].entries())
      last = await this.post(
        chatId,
        part,
        message.idempotencyKey ? `${message.idempotencyKey}:${i}` : undefined,
      );
    return last;
  }

  private post(
    chatId: string,
    part: { type: string; value: string },
    idempotencyKey?: string,
  ) {
    const doFetch = this.options.fetch ?? fetch;
    const url = `${(this.options.baseUrl ?? LINQ_DEFAULT_BASE_URL).replace(/\/$/, '')}/chats/${encodeURIComponent(chatId)}/messages`;
    const maxAttempts = this.options.maxAttempts ?? 3;
    return this.limiter.run(chatId, async () => {
      for (let attempt = 1; ; attempt++) {
        let status = 0;
        let retryAfter: number | null = null;
        try {
          const response = await doFetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.options.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                parts: [part],
                ...(idempotencyKey
                  ? { idempotency_key: idempotencyKey.slice(0, 255) }
                  : {}),
              },
            }),
            signal: AbortSignal.timeout(20_000),
          });
          status = response.status;
          if (response.ok) {
            const body = (await response.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            const id =
              body.id ??
              (body.message as Record<string, unknown> | undefined)?.id;
            return { messageId: typeof id === 'string' ? id : '' };
          }
          const ra = Number(response.headers.get('retry-after'));
          retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null;
        } catch {
          status = 0;
        }
        const retryable = status === 0 || status === 429 || status >= 500;
        if (!retryable)
          throw new ChannelDeliveryError(
            'PROVIDER_REJECTED',
            attempt,
            `linq status ${status}`,
          );
        if (attempt >= maxAttempts)
          throw new ChannelDeliveryError(
            status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
            attempt,
            `linq status ${status}`,
          );
        await this.wait(Math.min(retryAfter ?? 2 ** attempt, 60) * 1000);
      }
    });
  }
}
