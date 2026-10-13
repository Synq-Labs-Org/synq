import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { InteractiveCard } from '@synq/schemas';
import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelEvent,
  type DeliveryResult,
  type Envelope,
  type OutboundButton,
  type OutboundMessage,
} from './events.js';
import {
  OutboundLimiter,
  sleep as defaultSleep,
  type Sleep,
} from './outbound.js';
import { splitCaption } from './telegram.js';

/*
 * Official WhatsApp Business Cloud API (Meta Graph API) adapter. Shapes follow
 * developers.facebook.com/docs/whatsapp/cloud-api (checked 2026-10-13):
 *   POST /{version}/{phone-number-id}/messages   text, image, interactive
 *        (type "button": ≤3 reply buttons, title ≤20, id ≤256, body ≤1024,
 *        image header by media id; type "cta_url": one URL button,
 *        display_text ≤20, body ≤1024, media header by public link only)
 *   POST /{version}/{phone-number-id}/media      multipart PNG upload → { id }
 *   Webhooks: GET hub.mode/hub.verify_token/hub.challenge handshake; POST
 *        signed with X-Hub-Signature-256: sha256=HMAC-SHA256(app secret, body).
 * Every chat here is 1:1: interactive messages are not available in Cloud
 * API groups. Buttons open review pages or send read-only/non-binding
 * replies; the gateway refuses any button reply as an approval.
 */

export const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
export const WHATSAPP_GRAPH_VERSION = 'v25.0';
export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';
export const WHATSAPP_BUTTON_TITLE_LIMIT = 20;
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;
export const WHATSAPP_CAPTION_LIMIT = 1024;
export const WHATSAPP_TEXT_LIMIT = 4096;
export const WHATSAPP_MAX_REPLY_BUTTONS = 3;

export const WHATSAPP_GROUPS_NOTE =
  'Synq uses WhatsApp 1:1 only. Cloud API groups require an Official Business Account, hold at most 8 participants who join by invite link, cannot add the business to existing user groups, and do not support interactive messages. Unofficial WhatsApp libraries are not used.';
/** Kept for callers that report the channel without configuration. */
export const WHATSAPP_UNAVAILABLE_REASON = `BLOCKED_EXTERNAL: SYNQ_WHATSAPP_TOKEN, SYNQ_WHATSAPP_PHONE_NUMBER_ID, SYNQ_WHATSAPP_APP_SECRET, SYNQ_WHATSAPP_VERIFY_TOKEN and SYNQ_WHATSAPP_ALLOWED_WA_IDS are not configured; nothing has been run against Meta. ${WHATSAPP_GROUPS_NOTE}`;

export const WHATSAPP_ENV = [
  'SYNQ_WHATSAPP_TOKEN',
  'SYNQ_WHATSAPP_PHONE_NUMBER_ID',
  'SYNQ_WHATSAPP_APP_SECRET',
  'SYNQ_WHATSAPP_VERIFY_TOKEN',
  'SYNQ_WHATSAPP_ALLOWED_WA_IDS',
] as const;

const WA_ID = /^[0-9]{6,20}$/;
const PHONE_NUMBER_ID = /^[0-9]{5,25}$/;
const WAMID = /^wamid\.[A-Za-z0-9+/=_-]{1,250}$/;

export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  allowedWaIds: readonly string[];
  baseUrl?: string;
  version?: string;
};

/**
 * null when no SYNQ_WHATSAPP_* variable is set; throws on a partial or
 * malformed configuration (names only, never values).
 */
export function whatsappConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WhatsAppConfig | null {
  const v = (name: string) => (env[name] ?? '').trim();
  if (WHATSAPP_ENV.every((name) => !v(name))) return null;
  const missing = WHATSAPP_ENV.filter((name) => !v(name));
  if (missing.length)
    throw new Error(`Invalid WhatsApp configuration: ${missing.join(', ')}`);
  const allowedWaIds = v('SYNQ_WHATSAPP_ALLOWED_WA_IDS')
    .split(',')
    .map((s) => s.trim().replace(/^\+/, ''))
    .filter(Boolean);
  if (!allowedWaIds.length || !allowedWaIds.every((id) => WA_ID.test(id)))
    throw new Error(
      'Invalid WhatsApp configuration: SYNQ_WHATSAPP_ALLOWED_WA_IDS',
    );
  if (!PHONE_NUMBER_ID.test(v('SYNQ_WHATSAPP_PHONE_NUMBER_ID')))
    throw new Error(
      'Invalid WhatsApp configuration: SYNQ_WHATSAPP_PHONE_NUMBER_ID',
    );
  if (v('SYNQ_WHATSAPP_VERIFY_TOKEN').length < 16)
    throw new Error(
      'Invalid WhatsApp configuration: SYNQ_WHATSAPP_VERIFY_TOKEN',
    );
  const version = v('SYNQ_WHATSAPP_GRAPH_VERSION');
  const baseUrl = v('SYNQ_WHATSAPP_GRAPH_BASE_URL');
  return {
    token: v('SYNQ_WHATSAPP_TOKEN'),
    phoneNumberId: v('SYNQ_WHATSAPP_PHONE_NUMBER_ID'),
    appSecret: v('SYNQ_WHATSAPP_APP_SECRET'),
    verifyToken: v('SYNQ_WHATSAPP_VERIFY_TOKEN'),
    allowedWaIds,
    ...(version ? { version } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export class WhatsAppApiError extends Error {
  constructor(
    readonly endpoint: 'messages' | 'media',
    readonly httpStatus: number,
    readonly errorCode: number | null,
    readonly description: string,
  ) {
    super(`whatsapp ${endpoint} failed: ${httpStatus} ${description}`);
    this.name = 'WhatsAppApiError';
  }
}

const ErrorBodySchema = z.looseObject({
  error: z
    .looseObject({
      message: z.string().optional(),
      code: z.number().int().optional(),
      error_data: z.looseObject({ details: z.string().optional() }).optional(),
    })
    .optional(),
});
const SendResponseSchema = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string() })).min(1),
});
const MediaResponseSchema = z.looseObject({ id: z.string().min(1) });

/** Minimal Graph API client. The access token never appears in errors or logs. */
export class WhatsAppCloudApi {
  private readonly base: string;
  private readonly redact: (s: string) => string;
  constructor(
    private readonly options: {
      token: string;
      phoneNumberId: string;
      baseUrl?: string;
      version?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (!/^[\x21-\x7e]{16,1024}$/.test(options.token))
      throw new Error('WHATSAPP_TOKEN_MALFORMED');
    if (!PHONE_NUMBER_ID.test(options.phoneNumberId))
      throw new Error('WHATSAPP_PHONE_NUMBER_ID_MALFORMED');
    const version = options.version ?? WHATSAPP_GRAPH_VERSION;
    if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(version))
      throw new Error('WHATSAPP_GRAPH_VERSION_MALFORMED');
    this.base = `${(options.baseUrl ?? WHATSAPP_GRAPH_BASE_URL).replace(/\/$/, '')}/${version}/${options.phoneNumberId}`;
    this.redact = (s) => s.split(options.token).join('<redacted>');
  }

  private async post(
    endpoint: 'messages' | 'media',
    body: Record<string, unknown> | FormData,
  ): Promise<unknown> {
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.base}/${endpoint}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body instanceof FormData
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      throw new WhatsAppApiError(
        endpoint,
        0,
        null,
        this.redact(error instanceof Error ? error.name : 'NETWORK_ERROR'),
      );
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const err = ErrorBodySchema.safeParse(json);
      const e = err.success ? err.data.error : undefined;
      throw new WhatsAppApiError(
        endpoint,
        response.status,
        e?.code ?? null,
        this.redact(
          [e?.message, e?.error_data?.details].filter(Boolean).join(': ') ||
            'UNKNOWN',
        ).slice(0, 300),
      );
    }
    return json;
  }

  /** POST /messages; returns the accepted message id (wamid). */
  async sendMessage(payload: Record<string, unknown>): Promise<string> {
    const parsed = SendResponseSchema.safeParse(
      await this.post('messages', {
        messaging_product: 'whatsapp',
        ...payload,
      }),
    );
    if (!parsed.success)
      throw new WhatsAppApiError('messages', 200, null, 'INVALID_RESPONSE');
    return parsed.data.messages[0]!.id;
  }

  /** POST /media (multipart); returns the media id used in image payloads. */
  async uploadPng(png: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', 'image/png');
    form.set(
      'file',
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
      filename,
    );
    const parsed = MediaResponseSchema.safeParse(
      await this.post('media', form),
    );
    if (!parsed.success)
      throw new WhatsAppApiError('media', 200, null, 'INVALID_RESPONSE');
    return parsed.data.id;
  }
}

/** HMAC-SHA256 of the raw body with the app secret, as `sha256=<hex>`. */
export function signWhatsAppWebhook(appSecret: string, rawBody: string) {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Constant-time check of `X-Hub-Signature-256` over the exact request bytes.
 * The body must be the raw payload as received, never re-serialized JSON.
 */
export function verifyWhatsAppSignature(input: {
  appSecret: string | undefined;
  rawBody: string;
  header: string | string[] | undefined;
}): boolean {
  if (!input.appSecret || typeof input.header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(input.header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', input.appSecret)
    .update(input.rawBody, 'utf8')
    .digest();
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const ContactSchema = z.looseObject({
  wa_id: z.string(),
  profile: z.looseObject({ name: z.string().optional() }).optional(),
});
const InboundMessageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string().regex(/^[0-9]{1,12}$/),
  type: z.string(),
  group_id: z.unknown().optional(),
  context: z
    .looseObject({ id: z.string().optional(), from: z.string().optional() })
    .optional(),
  text: z.looseObject({ body: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string(),
      button_reply: z
        .looseObject({ id: z.string(), title: z.string().optional() })
        .optional(),
    })
    .optional(),
  button: z
    .looseObject({
      payload: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
});
const WebhookSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      id: z.string().optional(),
      changes: z.array(
        z.looseObject({
          field: z.string(),
          value: z.looseObject({
            messaging_product: z.string().optional(),
            metadata: z
              .looseObject({ phone_number_id: z.string().optional() })
              .optional(),
            contacts: z.array(ContactSchema).optional(),
            messages: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});
export type WhatsAppWebhook = z.input<typeof WebhookSchema>;

export type WhatsAppDrop =
  | 'WRONG_PHONE_NUMBER_ID'
  | 'NOT_ALLOWLISTED'
  | 'GROUP_MESSAGE'
  | 'UNSUPPORTED_TYPE'
  | 'MALFORMED';

const isPublicHttps = (url: string) => {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname !== 'localhost' &&
      !u.hostname.endsWith('.localhost') &&
      !/^127\.|^\[?::1\]?$/.test(u.hostname)
    );
  } catch {
    return false;
  }
};
const title = (s: string) =>
  s.length <= WHATSAPP_BUTTON_TITLE_LIMIT
    ? s
    : `${s.slice(0, WHATSAPP_BUTTON_TITLE_LIMIT - 1)}…`;

export type WhatsAppAdapterOptions = {
  /** Absent: the channel is BLOCKED_EXTERNAL and every send is refused. */
  api?: WhatsAppCloudApi | null;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  /** Only these wa_ids are messaged or listened to. */
  allowedWaIds?: readonly string[];
  limiter?: OutboundLimiter;
  maxAttempts?: number;
  sleep?: Sleep;
  /** Renders a card banner; when set, card messages carry the PNG uploaded through /media. */
  banners?: { render(card: InteractiveCard): Promise<Buffer> } | null;
  onBannerError?: (error: unknown) => void;
  onDrop?: (reason: WhatsAppDrop) => void;
};

/** Graph error codes Meta documents as "retry later" or temporary. */
const RETRYABLE_CODES = new Set([
  2, 4, 80007, 130429, 131000, 131016, 131056, 133004,
]);

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  private readonly limiter: OutboundLimiter;
  private readonly wait: Sleep;
  private readonly allowed: ReadonlySet<string>;
  constructor(private readonly options: WhatsAppAdapterOptions = {}) {
    this.wait = options.sleep ?? defaultSleep;
    this.limiter =
      options.limiter ??
      new OutboundLimiter({
        perChatIntervalMs: 1_000,
        globalIntervalMs: 50,
        sleep: this.wait,
      });
    this.allowed = new Set(options.allowedWaIds ?? []);
  }

  static fromConfig(
    config: WhatsAppConfig,
    extra: Omit<
      WhatsAppAdapterOptions,
      'api' | 'phoneNumberId' | 'appSecret' | 'verifyToken' | 'allowedWaIds'
    > & { fetch?: typeof fetch } = {},
  ) {
    const { fetch: f, ...rest } = extra;
    return new WhatsAppAdapter({
      ...rest,
      api: new WhatsAppCloudApi({
        token: config.token,
        phoneNumberId: config.phoneNumberId,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.version ? { version: config.version } : {}),
        ...(f ? { fetch: f } : {}),
      }),
      phoneNumberId: config.phoneNumberId,
      appSecret: config.appSecret,
      verifyToken: config.verifyToken,
      allowedWaIds: config.allowedWaIds,
    });
  }

  get status(): 'AVAILABLE' | 'BLOCKED_EXTERNAL' {
    return this.options.api &&
      this.options.appSecret &&
      this.options.verifyToken &&
      this.allowed.size
      ? 'AVAILABLE'
      : 'BLOCKED_EXTERNAL';
  }

  /** GET handshake: the challenge to echo, or null (answer 403). */
  verifyChallenge(query: Record<string, unknown>): string | null {
    const token = this.options.verifyToken;
    const mode = query['hub.mode'];
    const given = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      !token ||
      mode !== 'subscribe' ||
      typeof given !== 'string' ||
      typeof challenge !== 'string' ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(challenge)
    )
      return null;
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(digest(given), digest(token)) ? challenge : null;
  }

  verifySignature(rawBody: string, header: string | string[] | undefined) {
    return verifyWhatsAppSignature({
      appSecret: this.options.appSecret,
      rawBody,
      header,
    });
  }

  /**
   * Maps a verified webhook to channel events. The event id is the wamid, so
   * Meta's retries dedupe in the gateway's durable event claims.
   */
  normalize(raw: unknown): ChannelEvent[] {
    const parsed = WebhookSchema.safeParse(raw);
    if (!parsed.success) return [];
    const drop = (r: WhatsAppDrop) => this.options.onDrop?.(r);
    const events: ChannelEvent[] = [];
    for (const entry of parsed.data.entry)
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (
          value.messaging_product !== 'whatsapp' ||
          !this.options.phoneNumberId ||
          value.metadata?.phone_number_id !== this.options.phoneNumberId
        ) {
          if (value.messages?.length) drop('WRONG_PHONE_NUMBER_ID');
          continue;
        }
        const names = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
        );
        for (const rawMessage of value.messages ?? []) {
          const m = InboundMessageSchema.safeParse(rawMessage);
          if (!m.success || !WA_ID.test(m.data.from)) {
            drop('MALFORMED');
            continue;
          }
          const event = this.event(m.data, names.get(m.data.from) ?? null);
          if (typeof event === 'string') drop(event);
          else events.push(event);
        }
      }
    return events;
  }

  private event(
    m: z.output<typeof InboundMessageSchema>,
    name: string | null,
  ): ChannelEvent | WhatsAppDrop {
    if (m.group_id !== undefined) return 'GROUP_MESSAGE';
    if (!this.allowed.has(m.from)) return 'NOT_ALLOWLISTED';
    const envelope: Envelope = {
      channel: 'whatsapp',
      eventId: `wamid:${m.id}`.slice(0, 200),
      externalGroupId: m.from,
      chatKind: 'DIRECT',
      externalUserId: m.from,
      messageId: m.id.slice(0, 200),
      body: '',
      timestamp: Number(m.timestamp),
      replyTo: m.context?.id ? m.context.id.slice(0, 200) : null,
      interaction: {
        kind: 'TEXT',
        addressedToBot: true,
        command: null,
        args: '',
        callbackData: null,
      },
      attachments: [],
      verifiedSender: {
        transport: 'WEBHOOK_HMAC',
        providerUserId: m.from,
        displayName: name ? name.slice(0, 200) : null,
        isBot: false,
      },
    };
    const reply =
      m.type === 'interactive' && m.interactive?.type === 'button_reply'
        ? m.interactive.button_reply?.id
        : m.type === 'button'
          ? m.button?.payload
          : undefined;
    if (reply !== undefined) {
      const data = reply.slice(0, 256);
      return {
        type: 'ACTION_REQUESTED',
        callbackId: `${m.from}:${m.id}`.slice(0, 200),
        envelope: {
          ...envelope,
          body: data,
          interaction: {
            kind: 'CALLBACK',
            addressedToBot: true,
            command: null,
            args: '',
            callbackData: data,
          },
        },
      };
    }
    if (m.type !== 'text' || !m.text) return 'UNSUPPORTED_TYPE';
    const body = m.text.body.slice(0, WHATSAPP_TEXT_LIMIT);
    const trimmed = body.trim();
    const command = /^\/([A-Za-z0-9_]{1,32})\b/.exec(trimmed);
    return {
      type: 'MESSAGE_RECEIVED',
      envelope: {
        ...envelope,
        body,
        interaction: {
          kind: command ? 'COMMAND' : 'TEXT',
          addressedToBot: true,
          command: command ? command[1]!.toLowerCase() : null,
          args: command
            ? trimmed.slice(command[0].length).trim().slice(0, 4096)
            : '',
          callbackData: null,
        },
      },
    };
  }

  private recipient(waId: string) {
    if (!this.options.api || this.status !== 'AVAILABLE')
      throw new ChannelDeliveryError(
        'CHANNEL_UNAVAILABLE',
        0,
        WHATSAPP_UNAVAILABLE_REASON,
      );
    if (!WA_ID.test(waId) || !this.allowed.has(waId))
      throw new ChannelDeliveryError(
        'PROVIDER_REJECTED',
        0,
        'whatsapp recipient not allowlisted',
      );
    return { api: this.options.api, to: `+${waId}` };
  }

  async send(waId: string, message: OutboundMessage): Promise<DeliveryResult> {
    const { api, to } = this.recipient(waId);
    const urlButtons = (message.buttons ?? []).filter((b) =>
      isPublicHttps(b.url),
    );
    const [cta, ...moreLinks] = urlButtons;
    const inlineLinks: OutboundButton[] = [
      ...(message.buttons ?? []).filter((b) => !isPublicHttps(b.url)),
      ...moreLinks,
    ];
    const replies = (message.callbacks ?? [])
      .filter((c) => Buffer.byteLength(c.data) <= 256)
      .slice(0, WHATSAPP_MAX_REPLY_BUTTONS);
    const text = [
      message.text,
      ...inlineLinks.map((b) => `${b.label}: ${b.url}`),
    ]
      .join('\n')
      .slice(0, WHATSAPP_TEXT_LIMIT);
    const context =
      message.replyTo && WAMID.test(message.replyTo)
        ? { context: { message_id: message.replyTo } }
        : {};
    const base = { recipient_type: 'individual', to, ...context };
    const call = (payload: Record<string, unknown>) =>
      this.retrying(() => api.sendMessage({ ...base, ...payload }));
    const sendText = (body: string) =>
      call({ type: 'text', text: { preview_url: false, body } });
    const replyButtons = (body: string, mediaId: string | null) =>
      call({
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(mediaId
            ? { header: { type: 'image', image: { id: mediaId } } }
            : {}),
          body: { text: body },
          action: {
            buttons: uniqueTitles(replies.map((r) => r.label)).map((t, i) => ({
              type: 'reply',
              reply: { id: replies[i]!.data, title: t },
            })),
          },
        },
      });
    return this.limiter.run(waId, async () => {
      const mediaId = await this.banner(api, message.card);
      const { caption: body, rest } = splitCaption(
        text,
        WHATSAPP_INTERACTIVE_BODY_LIMIT,
      );
      let messageId: string;
      if (cta) {
        if (mediaId)
          await call({
            type: 'image',
            image: {
              id: mediaId,
              caption: (text.split('\n')[0] ?? '').slice(
                0,
                WHATSAPP_CAPTION_LIMIT,
              ),
            },
          }).catch((error: unknown) => this.options.onBannerError?.(error));
        messageId = await call({
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            body: { text: body },
            action: {
              name: 'cta_url',
              parameters: { display_text: title(cta.label), url: cta.url },
            },
          },
        });
        if (rest) await sendText(rest);
        if (replies.length)
          await replyButtons(
            'Status only. Approve on the Synq page with your passkey.',
            null,
          );
        return { messageId };
      }
      if (replies.length) {
        messageId = await replyButtons(body, mediaId);
        if (rest) await sendText(rest);
        return { messageId };
      }
      if (mediaId) {
        messageId = await call({
          type: 'image',
          image: { id: mediaId, caption: body },
        });
        if (rest) await sendText(rest);
        return { messageId };
      }
      return { messageId: await sendText(text) };
    });
  }

  /** Uploads the card banner; any failure falls back to text (null). */
  private async banner(
    api: WhatsAppCloudApi,
    card: InteractiveCard | undefined,
  ): Promise<string | null> {
    const banners = this.options.banners;
    if (!card || !banners) return null;
    try {
      const png = await banners.render(card);
      return await this.retrying(() =>
        api.uploadPng(png, `${card.cardId}.png`),
      );
    } catch (error) {
      this.options.onBannerError?.(error);
      return null;
    }
  }

  /** Answers a button reply in the same 1:1 chat, quoting the tapped message. */
  async acknowledgeAction(callbackId: string, text: string) {
    const at = callbackId.indexOf(':');
    const waId = callbackId.slice(0, at);
    const wamid = callbackId.slice(at + 1);
    if (at < 0 || !WAMID.test(wamid)) return;
    await this.send(waId, { text, replyTo: wamid });
  }

  /** Retries 429/5xx/network and Meta's documented retry-later codes. */
  private async retrying<T>(task: () => Promise<T>): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await task();
      } catch (error) {
        if (!(error instanceof WhatsAppApiError)) throw error;
        const throttled =
          error.httpStatus === 429 ||
          [4, 80007, 130429, 131056].includes(error.errorCode ?? -1);
        const retryable =
          throttled ||
          error.httpStatus === 0 ||
          error.httpStatus >= 500 ||
          RETRYABLE_CODES.has(error.errorCode ?? -1);
        const detail = `${error.errorCode ?? error.httpStatus}: ${error.description}`;
        if (!retryable)
          throw new ChannelDeliveryError('PROVIDER_REJECTED', attempt, detail);
        if (attempt >= maxAttempts)
          throw new ChannelDeliveryError(
            throttled ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
            attempt,
            detail,
          );
        await this.wait(Math.min(2 ** attempt, 30) * 1000);
      }
    }
  }
}

/** Reply button titles must be unique and at most 20 characters. */
export function uniqueTitles(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  return labels.map((label) => {
    let t = title(label);
    for (let n = 2; seen.has(t); n++)
      t = `${title(label).slice(0, WHATSAPP_BUTTON_TITLE_LIMIT - 3)} ${n}`;
    seen.add(t);
    return t;
  });
}
