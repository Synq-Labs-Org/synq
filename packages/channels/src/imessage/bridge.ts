import { createHash } from 'node:crypto';
import type { InteractiveCard } from '@synq/schemas';
import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type ChannelEvent,
  type DeliveryResult,
  type OutboundMessage,
} from '../events.js';
import type { GatewayOutcome } from '../gateway.js';
import { renderBridgeRichLink } from '../cards/render.js';
import {
  OutboundLimiter,
  sleep as defaultSleep,
  type Sleep,
} from '../outbound.js';
import {
  IMessageTransportError,
  type IMessageInbound,
  type IMessageTransport,
} from './transport.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Phone handles keep digits and a leading +; email handles are lower-cased. */
export function normalizeHandle(handle: string): string | null {
  const h = handle.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(h))
    return h.toLowerCase().slice(0, 200);
  const digits = h.replace(/[\s().-]/g, '');
  return /^\+?[0-9]{5,20}$/.test(digits) ? digits : null;
}

export type IMessageAdapterOptions = {
  transport: IMessageTransport;
  /** The bridge's own iMessage handle (dedicated Apple ID / number) for `/start` deep links. */
  botHandle?: string | null;
  limiter?: OutboundLimiter;
  maxAttempts?: number;
  /** Outbound messages per chat per minute before Synq stops replying (loop guard). */
  maxPerChatPerMinute?: number;
  echoWindowSeconds?: number;
  /** Card banner renderer; the PNG is sent before the card text where the transport supports images. */
  banners?: { render(card: InteractiveCard): Promise<Buffer> } | null;
  sleep?: Sleep;
  nowMs?: () => number;
};

/**
 * ChannelAdapter for iMessage over any IMessageTransport. Group ids are chat
 * GUIDs; a private chat is addressed by the member's handle, as the gateway
 * expects (Telegram private chat id == user id).
 */
export class IMessageChannelAdapter implements ChannelAdapter {
  readonly channel = 'imessage' as const;
  private readonly limiter: OutboundLimiter;
  private readonly wait: Sleep;
  private readonly nowMs: () => number;
  private readonly recent = new Map<string, number>();
  private readonly sentAt = new Map<string, number[]>();
  private readonly directChats = new Map<string, string>();
  constructor(private readonly options: IMessageAdapterOptions) {
    this.wait = options.sleep ?? defaultSleep;
    this.nowMs = options.nowMs ?? Date.now;
    this.limiter =
      options.limiter ??
      new OutboundLimiter({
        perChatIntervalMs: 1_500,
        globalIntervalMs: 250,
        sleep: this.wait,
      });
  }

  get transportName() {
    return this.options.transport.name;
  }

  /** Remembers the private chat a member wrote from, so replies reach that chat. */
  rememberDirectChat(handle: string, chatId: string) {
    this.directChats.set(handle, chatId);
  }

  private resolveChat(target: string): string {
    if (this.directChats.has(target)) return this.directChats.get(target)!;
    if (
      this.options.transport.name === 'bluebubbles' &&
      normalizeHandle(target)
    )
      return `iMessage;-;${target}`;
    return target;
  }

  /** True when `text` matches what Synq itself sent to this chat recently. */
  isEcho(chatId: string, text: string): boolean {
    const at = this.recent.get(`${chatId}\u0000${sha(text.trim())}`);
    return (
      at !== undefined &&
      this.nowMs() - at <= (this.options.echoWindowSeconds ?? 300) * 1000
    );
  }

  private remember(chatId: string, text: string) {
    const now = this.nowMs();
    this.recent.set(`${chatId}\u0000${sha(text.trim())}`, now);
    if (this.recent.size > 2_000)
      for (const [k, t] of this.recent)
        if (now - t > (this.options.echoWindowSeconds ?? 300) * 1000)
          this.recent.delete(k);
  }

  private underRate(chatId: string) {
    const now = this.nowMs();
    const list = (this.sentAt.get(chatId) ?? []).filter(
      (t) => now - t < 60_000,
    );
    this.sentAt.set(chatId, list);
    return list.length < (this.options.maxPerChatPerMinute ?? 8);
  }

  deepLink(payload: string): string | null {
    const handle = this.options.botHandle
      ? normalizeHandle(this.options.botHandle)
      : null;
    if (!handle || !/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null;
    return `sms:${handle}&body=${encodeURIComponent(`/start ${payload}`)}`;
  }

  /** Bubbles for one outbound message: cards become a summary plus a bare link (rich preview). */
  bubbles(message: OutboundMessage): string[] {
    if (message.card) {
      const r = renderBridgeRichLink(message.card);
      return r.url ? [r.text, r.url] : [r.text];
    }
    const links = (message.buttons ?? []).map((b) => `${b.label}: ${b.url}`);
    return [[message.text, ...links].join('\n').slice(0, 4000)];
  }

  async send(
    chatTarget: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    if (!/^[^\s]{1,300}$/.test(chatTarget))
      throw new ChannelDeliveryError('PROVIDER_REJECTED', 0, 'invalid chat id');
    const chatId = this.resolveChat(chatTarget);
    const key =
      message.idempotencyKey ??
      sha(`${chatId}:${message.text}:${this.nowMs()}`).slice(0, 32);
    let last: DeliveryResult = { messageId: '' };
    const bubbles = this.bubbles(message);
    await this.sendBanner(chatId, message, key);
    for (const [i, text] of bubbles.entries()) {
      if (!this.underRate(chatId))
        throw new ChannelDeliveryError('RATE_LIMITED', 0, 'per-chat reply cap');
      last = await this.limiter.run(chatId, () =>
        this.deliver(
          chatId,
          text,
          `${key}-${i}`,
          i === 0 ? message.replyTo : null,
        ),
      );
      this.sentAt.get(chatId)!.push(this.nowMs());
      this.remember(chatId, text);
    }
    return last;
  }

  /** Best effort: a banner that fails to render or upload never blocks the text. */
  private async sendBanner(
    chatId: string,
    message: OutboundMessage,
    key: string,
  ) {
    const card = message.card;
    const banners = this.options.banners;
    const sendImage = this.options.transport.sendImage?.bind(
      this.options.transport,
    );
    if (!card || !banners || !sendImage || !this.underRate(chatId)) return;
    try {
      const png = await banners.render(card);
      await this.limiter.run(chatId, () =>
        sendImage(chatId, {
          png,
          name: `${card.cardId}.png`,
          idempotencyKey: `${key}-img`,
        }),
      );
      this.sentAt.get(chatId)!.push(this.nowMs());
    } catch {
      // Text delivery below still carries the card.
    }
  }

  private async deliver(
    chatId: string,
    text: string,
    idempotencyKey: string,
    replyTo: string | null | undefined,
  ): Promise<DeliveryResult> {
    const max = this.options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.options.transport.send(chatId, {
          text,
          idempotencyKey,
          ...(replyTo && this.options.transport.capabilities.replies
            ? { replyToMessageId: replyTo }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof IMessageTransportError)) throw error;
        if (!error.retryable)
          throw new ChannelDeliveryError(
            'PROVIDER_REJECTED',
            attempt,
            error.message,
          );
        if (attempt >= max)
          throw new ChannelDeliveryError(
            error.httpStatus === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
            attempt,
            error.message,
          );
        await this.wait(Math.min(2 ** attempt, 30) * 1000);
      }
    }
  }
}

export type BridgeStatus =
  | 'FORWARDED'
  | 'DUPLICATE'
  | 'IGNORED_OWN_MESSAGE'
  | 'IGNORED_ECHO'
  | 'DROPPED_NOT_ALLOWLISTED'
  | 'DROPPED_DIRECT_NOT_LINK_COMMAND'
  | 'DROPPED_SENDER_RATE_LIMIT'
  | 'DROPPED_UNKNOWN_SENDER_HANDLE'
  | 'REJECTED_UNVERIFIED';
export type BridgeOutcome = {
  status: BridgeStatus;
  gateway: GatewayOutcome | null;
};

export type IMessageBridgeOptions = {
  transport: IMessageTransport;
  adapter: IMessageChannelAdapter;
  gateway: { handle(event: ChannelEvent): Promise<GatewayOutcome> };
  /** Chat GUIDs Synq may read. Every other group chat is dropped before parsing its text. */
  allowedChats: readonly string[];
  mentionWords?: readonly string[];
  maxInboundPerSenderPerMinute?: number;
  now?: () => number;
  sleep?: Sleep;
  healthIntervalMs?: number;
  /** Structured log without message text or handles. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

const LINK_COMMAND = /^\/(start|confirm)\s+[A-Za-z0-9_-]{16,64}$/;

/**
 * The Mac-side bridge: allowlisted chats only, own-message and echo
 * suppression, dedupe, server read-back for unsigned webhooks, membership
 * events, reconnect with backoff and bounded catch-up. It forwards
 * normalized events to the ChannelGateway, which owns identity, Brain
 * routing and replies.
 */
export class IMessageBridge {
  private readonly allowed: Set<string>;
  private readonly seen = new Map<string, number>();
  private readonly inbound = new Map<string, number[]>();
  private readonly lastSeenMs = new Map<string, number>();
  private readonly startedAtMs: number;
  state: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN' = 'UNKNOWN';
  constructor(private readonly options: IMessageBridgeOptions) {
    this.allowed = new Set(
      options.allowedChats.map((c) => c.trim()).filter(Boolean),
    );
    this.startedAtMs = this.now() * 1000;
  }

  private now() {
    return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  private log(event: string, fields: Record<string, unknown> = {}) {
    this.options.log?.(event, fields);
  }
  private out(status: BridgeStatus, gateway: GatewayOutcome | null = null) {
    return { status, gateway };
  }
  isAllowed(chatId: string) {
    return this.allowed.has(chatId);
  }

  private addressed(text: string) {
    const t = text.trim();
    if (t.startsWith('/')) return { kind: 'COMMAND' as const, body: t };
    const words = this.options.mentionWords ?? ['synq'];
    for (const w of words) {
      const m = new RegExp(`^@?${w}\\b[,:]?\\s*`, 'i').exec(t);
      if (m)
        return { kind: 'MENTION' as const, body: t.slice(m[0].length) || t };
      if (new RegExp(`(^|\\s)@${w}\\b`, 'i').test(t))
        return { kind: 'MENTION' as const, body: t };
    }
    return { kind: 'TEXT' as const, body: t };
  }

  async ingest(
    m: IMessageInbound,
    via: 'WEBHOOK' | 'SOCKET' | 'CATCHUP',
  ): Promise<BridgeOutcome> {
    const key = `${m.transport}:${m.messageId}`;
    const chatHash = sha(m.chatId).slice(0, 12);
    // Allowlist first: an unlisted group's content is never looked at further.
    let isGroup = m.isGroup;
    if (isGroup === null)
      isGroup = this.isAllowed(m.chatId)
        ? true
        : ((await this.options.transport
            .chatKind?.(m.chatId)
            .then((k) => (k === null ? null : k === 'GROUP'))
            .catch(() => null)) ?? null);
    if (isGroup === null) isGroup = true;
    const direct = !isGroup;
    if (!direct && !this.isAllowed(m.chatId)) {
      this.log('imessage dropped', {
        reason: 'NOT_ALLOWLISTED',
        chat: chatHash,
      });
      return this.out('DROPPED_NOT_ALLOWLISTED');
    }
    if (m.isFromMe) return this.out('IGNORED_OWN_MESSAGE');
    if (m.kind === 'MESSAGE' && this.options.adapter.isEcho(m.chatId, m.text))
      return this.out('IGNORED_ECHO');
    if (this.seen.has(key)) return this.out('DUPLICATE');
    if (direct && (m.kind !== 'MESSAGE' || !LINK_COMMAND.test(m.text.trim()))) {
      this.log('imessage dropped', {
        reason: 'DIRECT_NOT_LINK',
        chat: chatHash,
      });
      return this.out('DROPPED_DIRECT_NOT_LINK_COMMAND');
    }
    const handle = m.senderHandle ? normalizeHandle(m.senderHandle) : null;
    if (m.kind === 'MESSAGE' && !handle)
      return this.out('DROPPED_UNKNOWN_SENDER_HANDLE');
    if (
      via === 'WEBHOOK' &&
      !this.options.transport.capabilities.signedWebhooks
    ) {
      const fresh = this.options.transport.confirm
        ? await this.options.transport
            .confirm(m.messageId, m.chatId)
            .catch(() => null)
        : null;
      const sameSender =
        (fresh?.senderHandle ? normalizeHandle(fresh.senderHandle) : null) ===
        handle;
      if (
        m.kind === 'MESSAGE' &&
        (!fresh ||
          fresh.chatId !== m.chatId ||
          fresh.text !== m.text ||
          fresh.isFromMe ||
          !sameSender)
      ) {
        this.log('imessage rejected', {
          reason: 'READBACK_MISMATCH',
          chat: chatHash,
        });
        return this.out('REJECTED_UNVERIFIED');
      }
    }
    if (handle) {
      const now = this.now();
      const k = `${m.chatId}\u0000${handle}`;
      const recent = (this.inbound.get(k) ?? []).filter((t) => now - t < 60);
      if (recent.length >= (this.options.maxInboundPerSenderPerMinute ?? 10)) {
        this.inbound.set(k, recent);
        return this.out('DROPPED_SENDER_RATE_LIMIT');
      }
      recent.push(now);
      this.inbound.set(k, recent);
    }
    this.seen.set(key, this.now());
    if (this.seen.size > 10_000)
      for (const [k] of this.seen) {
        this.seen.delete(k);
        if (this.seen.size <= 8_000) break;
      }
    this.lastSeenMs.set(
      m.chatId,
      Math.max(this.lastSeenMs.get(m.chatId) ?? 0, m.timestamp * 1000),
    );
    if (direct && handle)
      this.options.adapter.rememberDirectChat(handle, m.chatId);
    const event = this.toEvent(m, handle, direct);
    if (!event) return this.out('DROPPED_UNKNOWN_SENDER_HANDLE');
    const outcome = await this.options.gateway.handle(event);
    this.log('imessage forwarded', {
      chat: chatHash,
      via,
      status: outcome.status,
      code: outcome.code,
    });
    return this.out('FORWARDED', outcome);
  }

  private toEvent(
    m: IMessageInbound,
    handle: string | null,
    direct: boolean,
  ): ChannelEvent | null {
    const base = {
      channel: 'imessage' as const,
      eventId: `${m.transport}:${m.messageId}`.slice(0, 200),
      // Private chats are addressed by handle, like Telegram's user-id private chats.
      externalGroupId: direct ? handle! : m.chatId,
      chatKind: direct ? ('DIRECT' as const) : ('GROUP' as const),
      externalUserId: handle,
      messageId: m.messageId.slice(0, 200),
      timestamp: m.timestamp,
      replyTo: m.replyToMessageId?.slice(0, 200) ?? null,
      attachments: m.attachments.map((a) => ({
        kind: a.kind,
        ref: a.ref.slice(0, 2048),
      })),
      verifiedSender: {
        transport: 'IMESSAGE_BRIDGE' as const,
        providerUserId: handle,
        displayName: m.senderName?.slice(0, 200) ?? null,
        isBot: false,
      },
    };
    if (m.kind !== 'MESSAGE') {
      const members = m.members
        .map((x) => normalizeHandle(x))
        .filter((x): x is string => !!x)
        .map((x) => ({ externalUserId: x, displayName: null, isBot: false }));
      if (!members.length) return null;
      return {
        type: m.kind === 'MEMBER_LEFT' ? 'MEMBER_LEFT' : 'MEMBER_JOINED',
        envelope: {
          ...base,
          body: '',
          interaction: {
            kind: 'MEMBERSHIP',
            addressedToBot: false,
            command: null,
            args: '',
            callbackData: null,
          },
        },
        members,
      };
    }
    const a = this.addressed(m.text);
    const command =
      a.kind === 'COMMAND' ? /^\/([A-Za-z0-9_]{1,32})/.exec(a.body) : null;
    return {
      type: 'MESSAGE_RECEIVED',
      envelope: {
        ...base,
        body: a.body.slice(0, 10_000),
        interaction: {
          kind: a.kind,
          addressedToBot: a.kind !== 'TEXT' || direct,
          command: command ? command[1]!.toLowerCase() : null,
          args: command
            ? a.body.slice(command[0].length).trim().slice(0, 4096)
            : '',
          callbackData: null,
        },
      },
    };
  }

  /** Re-reads allowlisted chats after a disconnect; never reads before the bridge started. */
  async catchUp(limitPerChat = 50) {
    const fetchSince = this.options.transport.fetchSince?.bind(
      this.options.transport,
    );
    if (!fetchSince) return 0;
    let n = 0;
    for (const chat of this.allowed) {
      const after = Math.max(this.lastSeenMs.get(chat) ?? 0, this.startedAtMs);
      const items = await fetchSince(chat, after, limitPerChat).catch(() => []);
      for (const m of items)
        if (m.chatId === chat && m.timestamp * 1000 >= after) {
          const r = await this.ingest(m, 'CATCHUP');
          if (r.status === 'FORWARDED') n++;
        }
    }
    return n;
  }

  /** Health loop: exponential backoff while down, catch-up on every reconnect. */
  async supervise(signal: AbortSignal) {
    const wait = this.options.sleep ?? defaultSleep;
    let backoff = 1;
    while (!signal.aborted) {
      const h = await this.options.transport.health();
      if (h.ok) {
        if (this.state !== 'CONNECTED') {
          this.log('imessage transport connected', {
            transport: this.options.transport.name,
          });
          const was = this.state;
          this.state = 'CONNECTED';
          if (was === 'DISCONNECTED') await this.catchUp();
        }
        backoff = 1;
        await wait(this.options.healthIntervalMs ?? 15_000, signal);
      } else {
        if (this.state !== 'DISCONNECTED')
          this.log('imessage transport disconnected', {
            transport: this.options.transport.name,
          });
        this.state = 'DISCONNECTED';
        await wait(backoff * 1000, signal);
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}
