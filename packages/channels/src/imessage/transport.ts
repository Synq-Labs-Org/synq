import { z } from 'zod';
import { ChannelDeliveryError } from '../events.js';
import type { LinqV3Adapter } from '../linq.js';

/**
 * A provider-neutral iMessage transport. Provider identifiers (chat GUIDs,
 * handles, Beeper ids) stay transport-scoped strings: they are never Synq
 * identities. Identity comes only from the ChannelGateway link flow.
 */
export type IMessageTransportName = 'bluebubbles' | 'beeper' | 'linq';

export type IMessageInbound = {
  transport: IMessageTransportName;
  kind: 'MESSAGE' | 'MEMBER_LEFT' | 'MEMBER_JOINED';
  messageId: string;
  chatId: string;
  /** null when the transport cannot tell; the bridge then decides from its allowlist. */
  isGroup: boolean | null;
  senderHandle: string | null;
  senderName: string | null;
  isFromMe: boolean;
  text: string;
  /** Unix seconds. */
  timestamp: number;
  replyToMessageId: string | null;
  attachments: {
    kind: 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'OTHER';
    ref: string;
  }[];
  /** Handles affected by a membership event. */
  members: string[];
};

export type IMessageSend = {
  text: string;
  /** Stable per logical message; retried sends reuse it. */
  idempotencyKey: string;
  replyToMessageId?: string | null;
};

export type IMessageTransportCapabilities = {
  sendToExistingGroup: boolean;
  receive: 'WEBHOOK' | 'WEBSOCKET' | 'WEBHOOK_HMAC';
  replies: boolean;
  attachments: boolean;
  createGroups: boolean;
  requiresSipDisabled: false;
  signedWebhooks: boolean;
};

export interface IMessageTransport {
  readonly name: IMessageTransportName;
  readonly capabilities: IMessageTransportCapabilities;
  health(): Promise<{ ok: boolean; detail: string }>;
  send(chatId: string, message: IMessageSend): Promise<{ messageId: string }>;
  /** Parses one pushed event (webhook body or socket frame). Unknown shapes yield []. */
  parseEvent(raw: unknown): IMessageInbound[];
  /** Re-reads a message from the server; used because some webhooks are unsigned. */
  confirm?(messageId: string, chatId: string): Promise<IMessageInbound | null>;
  /** Local setup helper: group chats whose title contains `query` (titles of other chats are not returned). */
  findChats?(query: string): Promise<{ chatId: string; title: string }[]>;
  /** Whether a chat is a group or a one-to-one chat, when events do not say. */
  chatKind?(chatId: string): Promise<'GROUP' | 'DIRECT' | null>;
  /** Messages in one (allowlisted) chat after `afterMs`, oldest first, for reconnect catch-up. */
  fetchSince?(
    chatId: string,
    afterMs: number,
    limit: number,
  ): Promise<IMessageInbound[]>;
}

export class IMessageTransportError extends Error {
  constructor(
    readonly transport: IMessageTransportName,
    readonly httpStatus: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'IMessageTransportError';
  }
}

const toSeconds = (ms: number) => Math.floor(ms / 1000);
const attachmentKind = (mime: string | null | undefined) =>
  mime?.startsWith('image/')
    ? ('IMAGE' as const)
    : mime?.startsWith('audio/')
      ? ('AUDIO' as const)
      : mime?.startsWith('video/')
        ? ('VIDEO' as const)
        : mime
          ? ('FILE' as const)
          : ('OTHER' as const);

/** macOS 26+ stores `any;-;…` chat GUIDs; AppleScript send wants the `iMessage;` service prefix. */
export function normalizeChatGuid(guid: string): string {
  return guid.replace(/^any;([+-]);/, 'iMessage;$1;');
}
export const isGroupGuid = (guid: string) => /^[A-Za-z]+;\+;/.test(guid);

async function request(
  transport: IMessageTransportName,
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  redact: (s: string) => string,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new IMessageTransportError(
      transport,
      0,
      true,
      redact(error instanceof Error ? error.name : 'NETWORK_ERROR'),
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new IMessageTransportError(
      transport,
      response.status,
      response.status === 429 || response.status >= 500,
      redact(
        `HTTP ${response.status} ${JSON.stringify(body ?? '').slice(0, 200)}`,
      ),
    );
  return body;
}

// ---------------------------------------------------------------- BlueBubbles

const BBHandle = z.looseObject({ address: z.string() }).nullable().optional();
const BBChat = z.looseObject({
  guid: z.string(),
  displayName: z.string().nullable().optional(),
});
const BBMessage = z.looseObject({
  guid: z.string().min(1).max(200),
  text: z.string().nullable().optional(),
  isFromMe: z.boolean(),
  handle: BBHandle,
  chats: z.array(BBChat).optional(),
  dateCreated: z.number(),
  threadOriginatorGuid: z.string().nullable().optional(),
  associatedMessageGuid: z.string().nullable().optional(),
  associatedMessageType: z
    .union([z.string(), z.number()])
    .nullable()
    .optional(),
  itemType: z.number().optional(),
  groupActionType: z.number().optional(),
  otherHandle: z.number().optional(),
  attachments: z
    .array(
      z.looseObject({
        guid: z.string(),
        mimeType: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const BBEvent = z.looseObject({ type: z.string(), data: z.unknown() });

export type BlueBubblesOptions = {
  /** e.g. http://127.0.0.1:1234 — keep the server bound to localhost. */
  baseUrl: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * BlueBubbles Server REST API without the Private API: send text to an
 * existing chat GUID via AppleScript, receive via webhook, read back via
 * /message/:guid and /message/query. Replies, tapbacks, typing and group
 * management need the Private API (SIP disabled) and are deliberately unused.
 */
export class BlueBubblesTransport implements IMessageTransport {
  readonly name = 'bluebubbles' as const;
  readonly capabilities: IMessageTransportCapabilities = {
    sendToExistingGroup: true,
    receive: 'WEBHOOK',
    replies: false,
    attachments: true,
    createGroups: false,
    requiresSipDisabled: false,
    signedWebhooks: false,
  };
  private readonly redact: (s: string) => string;
  constructor(private readonly options: BlueBubblesOptions) {
    if (!/^https?:\/\//.test(options.baseUrl))
      throw new Error('BLUEBUBBLES_BASE_URL_INVALID');
    if (options.password.length < 8)
      throw new Error('BLUEBUBBLES_PASSWORD_TOO_SHORT');
    this.redact = (s) =>
      s
        .split(options.password)
        .join('<redacted>')
        .split(encodeURIComponent(options.password))
        .join('<redacted>');
  }

  private url(path: string, query: Record<string, string> = {}) {
    const q = new URLSearchParams({
      ...query,
      password: this.options.password,
    });
    return `${this.options.baseUrl.replace(/\/$/, '')}/api/v1${path}?${q}`;
  }

  private call(path: string, init: RequestInit = {}, query = {}) {
    return request(
      this.name,
      this.options.fetch ?? fetch,
      this.url(path, query),
      init,
      this.redact,
      this.options.timeoutMs ?? 15_000,
    );
  }

  async health() {
    try {
      await this.call('/ping');
      const info = z
        .looseObject({
          data: z
            .looseObject({
              os_version: z.string().optional(),
              server_version: z.string().optional(),
              private_api: z.boolean().optional(),
            })
            .optional(),
        })
        .safeParse(await this.call('/server/info'));
      const d = info.success ? info.data.data : undefined;
      return {
        ok: true,
        detail: `bluebubbles ${d?.server_version ?? '?'} on macOS ${d?.os_version ?? '?'}; private api ${d?.private_api ? 'ON (unused by Synq)' : 'off'}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: this.redact(error instanceof Error ? error.message : 'error'),
      };
    }
  }

  async send(chatId: string, message: IMessageSend) {
    const body = await this.call('/message/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatGuid: normalizeChatGuid(chatId),
        tempGuid: `synq-${message.idempotencyKey}`,
        message: message.text,
        method: 'apple-script',
      }),
    });
    const sent = z
      .looseObject({ data: z.looseObject({ guid: z.string() }).optional() })
      .safeParse(body);
    return {
      messageId:
        (sent.success ? sent.data.data?.guid : undefined) ??
        `synq-${message.idempotencyKey}`,
    };
  }

  private inbound(m: z.output<typeof BBMessage>, chatHint?: string) {
    const chatId = m.chats?.[0]?.guid ?? chatHint;
    if (!chatId) return null;
    // Tapbacks and other associated messages are not commands.
    if (m.associatedMessageGuid) return null;
    return {
      transport: this.name,
      kind: 'MESSAGE' as const,
      messageId: m.guid,
      chatId: normalizeChatGuid(chatId),
      isGroup: isGroupGuid(chatId),
      senderHandle: m.isFromMe ? null : (m.handle?.address ?? null),
      senderName: null,
      isFromMe: m.isFromMe,
      text: (m.text ?? '').slice(0, 10_000),
      timestamp: toSeconds(m.dateCreated),
      replyToMessageId: m.threadOriginatorGuid ?? null,
      attachments: (m.attachments ?? []).slice(0, 20).map((a) => ({
        kind: attachmentKind(a.mimeType),
        ref: a.guid,
      })),
      members: [],
    };
  }

  parseEvent(raw: unknown): IMessageInbound[] {
    const e = BBEvent.safeParse(raw);
    if (!e.success) return [];
    if (e.data.type === 'new-message') {
      const m = BBMessage.safeParse(e.data.data);
      const i = m.success ? this.inbound(m.data) : null;
      return i ? [i] : [];
    }
    if (
      e.data.type === 'participant-removed' ||
      e.data.type === 'participant-left' ||
      e.data.type === 'participant-added'
    ) {
      const m = BBMessage.safeParse(e.data.data);
      if (!m.success) return [];
      const chatId = m.data.chats?.[0]?.guid;
      const handle = m.data.handle?.address;
      if (!chatId || !handle) return [];
      return [
        {
          ...this.inbound({ ...m.data, associatedMessageGuid: null })!,
          kind:
            e.data.type === 'participant-added'
              ? 'MEMBER_JOINED'
              : 'MEMBER_LEFT',
          text: '',
          members: [handle],
        },
      ];
    }
    return [];
  }

  async confirm(messageId: string, chatId: string) {
    if (!/^[A-Za-z0-9:;+_.@-]{1,200}$/.test(messageId)) return null;
    try {
      const body = z.looseObject({ data: BBMessage }).safeParse(
        await this.call(
          `/message/${encodeURIComponent(messageId)}`,
          {},
          {
            with: 'chats,handle,attachment',
          },
        ),
      );
      return body.success ? this.inbound(body.data.data, chatId) : null;
    } catch (error) {
      if (error instanceof IMessageTransportError && error.httpStatus === 404)
        return null;
      throw error;
    }
  }

  async fetchSince(chatId: string, afterMs: number, limit: number) {
    const body = z.looseObject({ data: z.array(z.unknown()) }).parse(
      await this.call('/message/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatGuid: normalizeChatGuid(chatId),
          after: afterMs,
          limit: Math.min(Math.max(limit, 1), 100),
          sort: 'ASC',
          with: ['chat', 'handle', 'attachment'],
        }),
      }),
    );
    return body.data.flatMap((raw) => {
      const m = BBMessage.safeParse(raw);
      const i = m.success ? this.inbound(m.data, chatId) : null;
      return i ? [i] : [];
    });
  }
}

// --------------------------------------------------------------------- Beeper

const BeeperMessage = z.looseObject({
  id: z.string().min(1).max(300),
  chatID: z.string().min(1).max(300),
  senderID: z.string().optional(),
  senderName: z.string().nullable().optional(),
  timestamp: z.string(),
  text: z.string().nullable().optional(),
  isSender: z.boolean().optional(),
  linkedMessageID: z.string().nullable().optional(),
  attachments: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        mimeType: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const BeeperWsEvent = z.looseObject({
  type: z.string(),
  chatID: z.string().optional(),
  entries: z.array(z.unknown()).optional(),
});

export type BeeperOptions = {
  /** Beeper Desktop API, local only: http://localhost:23373 */
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Beeper Desktop API (whose macOS iMessage support is built on the
 * open-source beeper/platform-imessage, which runs with SIP enabled).
 * Send via POST /v1/chats/{chatID}/messages, receive via the local
 * WebSocket (`message.upserted`), read back via GET messages.
 */
export class BeeperTransport implements IMessageTransport {
  readonly name = 'beeper' as const;
  readonly capabilities: IMessageTransportCapabilities = {
    sendToExistingGroup: true,
    receive: 'WEBSOCKET',
    replies: true,
    attachments: true,
    createGroups: false,
    requiresSipDisabled: false,
    signedWebhooks: false,
  };
  private readonly base: string;
  private readonly redact: (s: string) => string;
  constructor(private readonly options: BeeperOptions) {
    this.base = (options.baseUrl ?? 'http://localhost:23373').replace(
      /\/$/,
      '',
    );
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.base))
      throw new Error('BEEPER_DESKTOP_API_MUST_BE_LOCAL');
    if (options.token.length < 8) throw new Error('BEEPER_TOKEN_INVALID');
    this.redact = (s) => s.split(options.token).join('<redacted>');
  }

  get websocketUrl() {
    return `${this.base.replace(/^http/, 'ws')}/v1/ws`;
  }
  get authHeader() {
    return `Bearer ${this.options.token}`;
  }

  private call(path: string, init: RequestInit = {}) {
    return request(
      this.name,
      this.options.fetch ?? fetch,
      `${this.base}${path}`,
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: this.authHeader,
        },
      },
      this.redact,
      this.options.timeoutMs ?? 15_000,
    );
  }

  async health() {
    try {
      await this.call('/v1/info');
      return { ok: true, detail: 'beeper desktop api reachable' };
    } catch (error) {
      return {
        ok: false,
        detail: this.redact(error instanceof Error ? error.message : 'error'),
      };
    }
  }

  async send(chatId: string, message: IMessageSend) {
    const body = await this.call(
      `/v1/chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: message.text,
          ...(message.replyToMessageId
            ? { replyToMessageID: message.replyToMessageId }
            : {}),
        }),
      },
    );
    const sent = z
      .looseObject({ pendingMessageID: z.string() })
      .safeParse(body);
    return {
      messageId: sent.success
        ? sent.data.pendingMessageID
        : `synq-${message.idempotencyKey}`,
    };
  }

  private inbound(m: z.output<typeof BeeperMessage>): IMessageInbound {
    const ms = Date.parse(m.timestamp);
    return {
      transport: this.name,
      kind: 'MESSAGE',
      messageId: m.id,
      chatId: m.chatID,
      isGroup: null,
      senderHandle: m.isSender ? null : (m.senderID ?? null),
      senderName: m.senderName ?? null,
      isFromMe: m.isSender ?? false,
      text: (m.text ?? '').slice(0, 10_000),
      timestamp: Number.isFinite(ms) ? toSeconds(ms) : 0,
      replyToMessageId: m.linkedMessageID ?? null,
      attachments: (m.attachments ?? []).slice(0, 20).map((a, i) => ({
        kind: attachmentKind(a.mimeType),
        ref: a.id ?? `${m.id}#${i}`,
      })),
      members: [],
    };
  }

  parseEvent(raw: unknown): IMessageInbound[] {
    const e = BeeperWsEvent.safeParse(raw);
    if (!e.success || e.data.type !== 'message.upserted') return [];
    return (e.data.entries ?? []).flatMap((x) => {
      const m = BeeperMessage.safeParse(x);
      return m.success ? [this.inbound(m.data)] : [];
    });
  }

  async confirm(messageId: string, chatId: string) {
    try {
      const m = BeeperMessage.safeParse(
        await this.call(
          `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        ),
      );
      return m.success ? this.inbound(m.data) : null;
    } catch (error) {
      if (error instanceof IMessageTransportError && error.httpStatus === 404)
        return null;
      throw error;
    }
  }

  async fetchSince(chatId: string, afterMs: number, limit: number) {
    const body = z
      .looseObject({ items: z.array(z.unknown()) })
      .parse(
        await this.call(
          `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=${Math.min(Math.max(limit, 1), 100)}`,
        ),
      );
    return body.items
      .flatMap((x) => {
        const m = BeeperMessage.safeParse(x);
        return m.success ? [this.inbound(m.data)] : [];
      })
      .filter((m) => m.timestamp * 1000 >= afterMs)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async findChats(query: string) {
    const q = query.trim();
    if (q.length < 2) return [];
    const body = z
      .looseObject({
        items: z.array(
          z.looseObject({
            id: z.string(),
            title: z.string().nullable().optional(),
            type: z.string().optional(),
          }),
        ),
      })
      .safeParse(
        await this.call(`/v1/chats/search?query=${encodeURIComponent(q)}`),
      );
    if (!body.success) return [];
    return body.data.items
      .filter(
        (c) =>
          c.type === 'group' &&
          (c.title ?? '').toLowerCase().includes(q.toLowerCase()),
      )
      .map((c) => ({ chatId: c.id, title: c.title ?? '' }));
  }

  async chatKind(chatId: string) {
    try {
      const c = z
        .looseObject({ type: z.string() })
        .safeParse(await this.call(`/v1/chats/${encodeURIComponent(chatId)}`));
      return !c.success
        ? null
        : c.data.type === 'single'
          ? ('DIRECT' as const)
          : c.data.type === 'group'
            ? ('GROUP' as const)
            : null;
    } catch {
      return null;
    }
  }

  /** Subscribe frame for the Desktop API WebSocket, limited to allowlisted chats. */
  static subscribeFrame(chatIds: readonly string[]) {
    return JSON.stringify({
      type: 'subscriptions.set',
      requestID: 'synq-bridge',
      chatIDs: [...chatIds],
    });
  }
}

// ----------------------------------------------------------------------- Linq

/** The existing Linq V3 adapter behind the iMessage transport interface. */
export class LinqTransport implements IMessageTransport {
  readonly name = 'linq' as const;
  readonly capabilities: IMessageTransportCapabilities = {
    sendToExistingGroup: false,
    receive: 'WEBHOOK_HMAC',
    replies: false,
    attachments: false,
    createGroups: true,
    requiresSipDisabled: false,
    signedWebhooks: true,
  };
  constructor(
    private readonly adapter: LinqV3Adapter,
    private readonly hasApiKey: boolean,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async health() {
    return this.hasApiKey
      ? { ok: true, detail: 'linq api key configured' }
      : { ok: false, detail: 'LINQ_API_KEY not configured' };
  }

  async send(chatId: string, message: IMessageSend) {
    try {
      return await this.adapter.send(chatId, {
        text: message.text,
        idempotencyKey: message.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof ChannelDeliveryError)
        throw new IMessageTransportError(
          this.name,
          error.code === 'PROVIDER_REJECTED' ? 400 : 503,
          error.code !== 'PROVIDER_REJECTED',
          error.message,
        );
      throw error;
    }
  }

  /** `raw` must already have passed `LinqV3Adapter.verify`; `webhookId` is its Standard Webhooks id. */
  parseVerified(raw: unknown, webhookId: string): IMessageInbound[] {
    return this.adapter.normalize(raw, webhookId, this.now()).flatMap((e) => {
      if (e.type !== 'MESSAGE_RECEIVED' && e.type !== 'MEMBER_LEFT') return [];
      const env = e.envelope;
      return [
        {
          transport: this.name,
          kind: e.type === 'MEMBER_LEFT' ? 'MEMBER_LEFT' : 'MESSAGE',
          messageId: env.messageId ?? env.eventId,
          chatId: env.externalGroupId,
          isGroup: env.chatKind === 'GROUP',
          senderHandle: env.externalUserId,
          senderName: env.verifiedSender.displayName,
          isFromMe: false,
          text: env.body,
          timestamp: env.timestamp,
          replyToMessageId: env.replyTo,
          attachments: [],
          members:
            e.type === 'MEMBER_LEFT'
              ? e.members.map((m) => m.externalUserId)
              : [],
        },
      ];
    });
  }

  /** Linq webhooks need their HMAC headers; use `parseVerified` from the verified route. */
  parseEvent(): IMessageInbound[] {
    return [];
  }
}
