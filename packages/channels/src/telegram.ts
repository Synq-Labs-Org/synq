import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { InteractiveCard } from '@synq/schemas';
import {
  ChannelDeliveryError,
  GUEST_REFERENCE_MAX_CHARS,
  type ChannelAdapter,
  type ChannelEvent,
  type DeliveryResult,
  type Envelope,
  type GuestReference,
  type OutboundMessage,
} from './events.js';
import {
  OutboundLimiter,
  sleep as defaultSleep,
  type Sleep,
} from './outbound.js';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
/** Bot API 10.0 added `guest_message` (guest mode); it must be requested explicitly. */
export const TELEGRAM_ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
  'guest_message',
] as const;

/**
 * What the bot can see in a group. Privacy mode (the default) delivers only
 * commands, mentions and replies to the bot; a bot never receives messages
 * sent before it joined, whatever its settings.
 */
export type TelegramGroupVisibility = 'ALL_MESSAGES' | 'ADDRESSED_ONLY';
export type TelegramBotProfile = {
  id: number;
  username: string;
  /** getMe `can_read_all_group_messages` is false (or unknown). */
  privacyMode: boolean;
  /** getMe `supports_guest_queries`: Guest Mode enabled in BotFather. */
  guestQueries: boolean;
  groupVisibility: TelegramGroupVisibility;
};

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly httpStatus: number,
    readonly errorCode: number | null,
    readonly description: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`telegram ${method} failed: ${httpStatus} ${description}`);
    this.name = 'TelegramApiError';
  }
}

const ResponseSchema = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z.looseObject({ retry_after: z.number().optional() }).optional(),
});

/** Minimal Bot API client. The token never appears in errors or logs. */
export class TelegramBotApi {
  private readonly base: string;
  private readonly redact: (s: string) => string;
  constructor(
    private readonly options: {
      token: string;
      baseUrl?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (!/^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$/.test(options.token))
      throw new Error('TELEGRAM_TOKEN_MALFORMED');
    this.base = `${(options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${options.token}`;
    this.redact = (s) => s.split(options.token).join('<redacted>');
  }

  verifyLogin(raw: unknown, nowSeconds: number) {
    return verifyTelegramLogin(raw, this.options.token, nowSeconds);
  }

  verifyMiniAppInitData(raw: unknown, nowSeconds: number) {
    return verifyTelegramMiniAppInitData(raw, this.options.token, nowSeconds);
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const doFetch = this.options.fetch ?? fetch;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 40_000);
    let response: Response;
    try {
      response = await doFetch(`${this.base}/${method}`, {
        method: 'POST',
        ...(params instanceof FormData
          ? { body: params }
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(params),
            }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new TelegramApiError(
        method,
        0,
        null,
        this.redact(error instanceof Error ? error.name : 'NETWORK_ERROR'),
        null,
      );
    }
    let body: z.output<typeof ResponseSchema>;
    try {
      body = ResponseSchema.parse(await response.json());
    } catch {
      throw new TelegramApiError(
        method,
        response.status,
        null,
        'INVALID_RESPONSE',
        null,
      );
    }
    if (!body.ok)
      throw new TelegramApiError(
        method,
        response.status,
        body.error_code ?? null,
        this.redact(body.description ?? 'UNKNOWN').slice(0, 300),
        body.parameters?.retry_after ?? null,
      );
    return body.result as T;
  }
}

const UserSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
const GetMeSchema = UserSchema.extend({
  can_read_all_group_messages: z.boolean().optional(),
  supports_guest_queries: z.boolean().optional(),
});
const ChatSchema = z.looseObject({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
});
const EntitySchema = z.looseObject({
  type: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
});
const MessageSchema = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: ChatSchema,
  from: UserSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(EntitySchema).optional(),
  caption_entities: z.array(EntitySchema).optional(),
  reply_to_message: z
    .looseObject({
      message_id: z.number().int(),
      from: UserSchema.optional(),
      date: z.number().int().optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  forward_origin: z.unknown().optional(),
  forward_date: z.number().int().optional(),
  is_automatic_forward: z.boolean().optional(),
  /** Set on a guest message; answer it with answerGuestQuery. */
  guest_query_id: z.string().min(1).max(256).optional(),
  new_chat_members: z.array(UserSchema).optional(),
  left_chat_member: UserSchema.optional(),
  group_chat_created: z.boolean().optional(),
  supergroup_chat_created: z.boolean().optional(),
  photo: z.array(z.looseObject({ file_id: z.string() })).optional(),
  document: z.looseObject({ file_id: z.string() }).optional(),
});
const UpdateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: MessageSchema.optional(),
  guest_message: MessageSchema.optional(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: UserSchema,
      data: z.string().optional(),
      message: MessageSchema.optional(),
    })
    .optional(),
  my_chat_member: z
    .looseObject({
      chat: ChatSchema,
      from: UserSchema,
      date: z.number().int(),
      old_chat_member: z.looseObject({ status: z.string() }),
      new_chat_member: z.looseObject({ status: z.string(), user: UserSchema }),
    })
    .optional(),
});
export type TelegramUpdate = z.input<typeof UpdateSchema>;
type TgUser = z.output<typeof UserSchema>;

const displayName = (u: TgUser) =>
  u.username
    ? `@${u.username}`
    : [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 200) ||
      null;
const isLocalUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      /^127\.|^\[?::1\]?$/.test(host)
    );
  } catch {
    return true;
  }
};

export type TelegramAdapterOptions = {
  api: TelegramBotApi;
  webhookSecret?: string;
  bot?: {
    id: number;
    username: string;
    privacyMode?: boolean;
    guestQueries?: boolean;
  };
  respondToAllMessages?: boolean;
  limiter?: OutboundLimiter;
  maxAttempts?: number;
  sleep?: Sleep;
  transport?: 'WEBHOOK_SECRET_TOKEN' | 'BOT_API_POLL';
  /** Renders a card banner; when set, card messages go out as one photo with caption and buttons. */
  banners?: { render(card: InteractiveCard): Promise<Buffer> } | null;
  onBannerError?: (error: unknown) => void;
};

export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Caption up to the limit (cut at a line break when possible) and the remainder, if any. */
export function splitCaption(
  text: string,
  limit = TELEGRAM_CAPTION_LIMIT,
): { caption: string; rest: string | null } {
  if (text.length <= limit) return { caption: text, rest: null };
  const cut = text.lastIndexOf('\n', limit);
  const at = cut > limit / 2 ? cut : limit;
  return {
    caption: text.slice(0, at).trimEnd(),
    rest: text.slice(at).trim().slice(0, 4096) || null,
  };
}

const profileOf = (bot: NonNullable<TelegramAdapterOptions['bot']>) => {
  // Unknown privacy settings are treated as privacy mode: never over-claim.
  const privacyMode = bot.privacyMode ?? true;
  return {
    id: bot.id,
    username: bot.username,
    privacyMode,
    guestQueries: bot.guestQueries ?? false,
    groupVisibility: privacyMode
      ? ('ADDRESSED_ONLY' as const)
      : ('ALL_MESSAGES' as const),
  };
};

const SentGuestMessageSchema = z.looseObject({
  inline_message_id: z.string().min(1),
});

/** The replied-to message, truncated, with a hash of what Telegram delivered. */
function guestReference(
  reply: NonNullable<z.output<typeof MessageSchema>['reply_to_message']>,
): GuestReference {
  const full = reply.text ?? reply.caption ?? '';
  return {
    source: 'REPLY_TO_MESSAGE',
    messageId: String(reply.message_id),
    externalUserId: reply.from ? String(reply.from.id) : null,
    isBot: reply.from?.is_bot ?? false,
    timestamp: reply.date ?? null,
    text: full.slice(0, GUEST_REFERENCE_MAX_CHARS),
    truncated: full.length > GUEST_REFERENCE_MAX_CHARS,
    textSha256: createHash('sha256').update(full).digest('hex'),
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;
  private bot: TelegramBotProfile | null;
  private readonly limiter: OutboundLimiter;
  private readonly wait: Sleep;
  constructor(private readonly options: TelegramAdapterOptions) {
    this.bot = options.bot ? profileOf(options.bot) : null;
    this.wait = options.sleep ?? defaultSleep;
    this.limiter =
      options.limiter ??
      new OutboundLimiter({
        perChatIntervalMs: 3_000,
        globalIntervalMs: 40,
        sleep: this.wait,
      });
    if (
      options.webhookSecret !== undefined &&
      !/^[A-Za-z0-9_-]{16,256}$/.test(options.webhookSecret)
    )
      throw new Error('TELEGRAM_WEBHOOK_SECRET_INVALID');
  }

  get botUsername() {
    return this.bot?.username ?? null;
  }

  async init(): Promise<TelegramBotProfile> {
    const me = GetMeSchema.parse(await this.options.api.call('getMe'));
    if (!me.is_bot || !me.username) throw new Error('TELEGRAM_GETME_NOT_A_BOT');
    this.bot = profileOf({
      id: me.id,
      username: me.username,
      privacyMode: me.can_read_all_group_messages !== true,
      guestQueries: me.supports_guest_queries === true,
    });
    return this.bot;
  }

  /** The bot's privacy and guest settings as getMe reported them; null before init. */
  get profile(): TelegramBotProfile | null {
    return this.bot ? { ...this.bot } : null;
  }

  /**
   * What the bot can see in one group: everything new only when privacy mode
   * is off or the bot is an administrator there. Never pre-join history.
   */
  async groupVisibility(chatId: string): Promise<TelegramGroupVisibility> {
    const bot = this.bot;
    if (!bot) return 'ADDRESSED_ONLY';
    if (!bot.privacyMode) return 'ALL_MESSAGES';
    const role = await this.chatRole(chatId, String(bot.id)).catch(
      () => 'NONE' as const,
    );
    return role === 'ADMIN' || role === 'OWNER'
      ? 'ALL_MESSAGES'
      : 'ADDRESSED_ONLY';
  }

  /** getChatMember status: creator → OWNER, administrator → ADMIN. */
  async chatRole(
    chatId: string,
    userId: string,
  ): Promise<'OWNER' | 'ADMIN' | 'MEMBER' | 'NONE'> {
    if (!/^-?[0-9]{1,20}$/.test(chatId) || !/^[0-9]{1,20}$/.test(userId))
      return 'NONE';
    const member = z.looseObject({ status: z.string() }).parse(
      await this.options.api.call('getChatMember', {
        chat_id: Number(chatId),
        user_id: Number(userId),
      }),
    );
    return member.status === 'creator'
      ? 'OWNER'
      : member.status === 'administrator'
        ? 'ADMIN'
        : member.status === 'member' || member.status === 'restricted'
          ? 'MEMBER'
          : 'NONE';
  }

  deepLink(payload: string): string | null {
    if (!this.bot || !/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null;
    return `https://t.me/${this.bot.username}?start=${payload}`;
  }

  verifyLogin(raw: unknown, nowSeconds: number) {
    return this.options.api.verifyLogin(raw, nowSeconds);
  }

  verifyMiniAppInitData(raw: unknown, nowSeconds: number) {
    return this.options.api.verifyMiniAppInitData(raw, nowSeconds);
  }

  /** One-time-use key for a verified initData hash, scoped to this bot. */
  miniAppReplayKey(hash: string) {
    return `initdata:${this.bot?.id ?? 'unbound'}:${hash}`;
  }

  get botId() {
    return this.bot?.id ?? null;
  }

  verifyWebhook(header: string | string[] | undefined): boolean {
    const secret = this.options.webhookSecret;
    if (!secret || typeof header !== 'string') return false;
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(digest(header), digest(secret));
  }

  normalize(
    raw: unknown,
    transport = this.options.transport ?? 'BOT_API_POLL',
  ): ChannelEvent[] {
    const parsed = UpdateSchema.safeParse(raw);
    if (!parsed.success || !this.bot) return [];
    const update = parsed.data;
    const bot = this.bot;
    // update_id is unique per bot only: scope dedup keys to this bot.
    const eventId = `update:${bot.id}:${update.update_id}`;
    const base = (
      chat: z.output<typeof ChatSchema>,
      from: TgUser | undefined,
      date: number,
      messageId: number | null,
    ): Envelope | null => {
      if (chat.type === 'channel') return null;
      return {
        channel: 'telegram',
        eventId,
        externalGroupId: String(chat.id),
        chatKind: chat.type === 'private' ? 'DIRECT' : 'GROUP',
        externalUserId: from ? String(from.id) : null,
        messageId: messageId === null ? null : String(messageId),
        body: '',
        timestamp: date,
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
          transport,
          providerUserId: from ? String(from.id) : null,
          displayName: from ? displayName(from) : null,
          isBot: from?.is_bot ?? false,
        },
      };
    };
    if (update.callback_query) {
      const q = update.callback_query;
      const msg = q.message;
      if (!msg) return [];
      const env = base(msg.chat, q.from, msg.date, msg.message_id);
      if (!env) return [];
      return [
        {
          type: 'ACTION_REQUESTED',
          callbackId: q.id,
          envelope: {
            ...env,
            body: (q.data ?? '').slice(0, 256),
            interaction: {
              kind: 'CALLBACK',
              addressedToBot: true,
              command: null,
              args: '',
              callbackData: (q.data ?? '').slice(0, 256),
            },
          },
        },
      ];
    }
    if (update.my_chat_member) {
      const m = update.my_chat_member;
      const env = base(m.chat, m.from, m.date, null);
      const joined =
        ['left', 'kicked'].includes(m.old_chat_member.status) &&
        ['member', 'administrator'].includes(m.new_chat_member.status);
      if (!env || !joined || env.chatKind !== 'GROUP') return [];
      return [
        { type: 'GROUP_CREATED', envelope: env, title: m.chat.title ?? null },
      ];
    }
    if (update.guest_message) {
      // Guest mode: the bot is not a member here. Only this message and the
      // one it replies to arrive; no history, no later messages.
      const g = update.guest_message;
      if (!g.guest_query_id) return [];
      const env = base(g.chat, g.from, g.date, g.message_id);
      if (!env) return [];
      return [
        {
          type: 'GUEST_QUERY',
          receiver: `bot:${bot.id}`,
          guestQueryId: g.guest_query_id,
          reference: g.reply_to_message
            ? guestReference(g.reply_to_message)
            : null,
          envelope: {
            ...env,
            body: (g.text ?? g.caption ?? '').slice(0, 4096),
            replyTo: g.reply_to_message
              ? String(g.reply_to_message.message_id)
              : null,
            interaction: {
              kind: 'MENTION',
              addressedToBot: true,
              command: null,
              args: '',
              callbackData: null,
            },
          },
        },
      ];
    }
    const msg = update.message;
    if (!msg) return [];
    const env = base(msg.chat, msg.from, msg.date, msg.message_id);
    if (!env) return [];
    const member = (u: TgUser) => ({
      externalUserId: String(u.id),
      displayName: displayName(u),
      isBot: u.is_bot,
    });
    const membership = { ...env.interaction, kind: 'MEMBERSHIP' as const };
    if (msg.group_chat_created || msg.supergroup_chat_created)
      return [
        { type: 'GROUP_CREATED', envelope: env, title: msg.chat.title ?? null },
      ];
    if (msg.new_chat_members?.length) {
      if (msg.new_chat_members.some((u) => u.id === bot.id)) return [];
      return [
        {
          type: 'MEMBER_JOINED',
          envelope: { ...env, interaction: membership },
          members: msg.new_chat_members.map(member),
        },
      ];
    }
    if (msg.left_chat_member)
      return [
        {
          type: 'MEMBER_LEFT',
          envelope: { ...env, interaction: membership },
          members: [member(msg.left_chat_member)],
        },
      ];
    const text = (msg.text ?? msg.caption ?? '').slice(0, 4096);
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const command = entities.find(
      (e) => e.type === 'bot_command' && e.offset === 0,
    );
    const commandText = command ? text.slice(1, command.length) : null;
    const [commandName, commandTarget] = commandText?.split('@') ?? [];
    const mention = entities.some(
      (e) =>
        e.type === 'mention' &&
        text.slice(e.offset + 1, e.offset + e.length).toLowerCase() ===
          bot.username.toLowerCase(),
    );
    const replyToBot = msg.reply_to_message?.from?.id === bot.id;
    const commandForUs =
      command !== undefined &&
      (commandTarget === undefined ||
        commandTarget.toLowerCase() === bot.username.toLowerCase());
    const addressed =
      commandForUs ||
      mention ||
      replyToBot ||
      env.chatKind === 'DIRECT' ||
      this.options.respondToAllMessages === true;
    return [
      {
        type: 'MESSAGE_RECEIVED',
        envelope: {
          ...env,
          ...(msg.forward_origin !== undefined ||
          msg.forward_date !== undefined ||
          msg.is_automatic_forward === true
            ? { forwarded: true }
            : {}),
          body: text,
          replyTo: msg.reply_to_message
            ? String(msg.reply_to_message.message_id)
            : null,
          interaction: {
            kind: command
              ? 'COMMAND'
              : mention
                ? 'MENTION'
                : replyToBot
                  ? 'REPLY_TO_BOT'
                  : 'TEXT',
            addressedToBot: addressed,
            command: commandName
              ? commandName.toLowerCase().slice(0, 64)
              : null,
            args: command
              ? text.slice(command.length).trim().slice(0, 4096)
              : '',
            callbackData: null,
          },
          attachments: [
            ...(msg.photo?.length
              ? [{ kind: 'IMAGE' as const, ref: msg.photo.at(-1)!.file_id }]
              : []),
            ...(msg.document
              ? [{ kind: 'FILE' as const, ref: msg.document.file_id }]
              : []),
          ],
        },
      },
    ];
  }

  async send(
    chatId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult> {
    if (!/^-?[0-9]{1,20}$/.test(chatId))
      throw new ChannelDeliveryError('PROVIDER_REJECTED', 0, 'invalid chat id');
    const buttons = (message.buttons ?? []).filter((b) => !isLocalUrl(b.url));
    const inline = (message.buttons ?? []).filter((b) => isLocalUrl(b.url));
    const callbacks = (message.callbacks ?? []).filter(
      (c) => Buffer.byteLength(c.data) <= 64,
    );
    const text = [message.text, ...inline.map((b) => `${b.label}: ${b.url}`)]
      .join('\n')
      .slice(0, 4096);
    const replyParameters =
      message.replyTo && /^[0-9]+$/.test(message.replyTo)
        ? {
            message_id: Number(message.replyTo),
            allow_sending_without_reply: true,
          }
        : null;
    const keyboard =
      buttons.length || callbacks.length
        ? {
            inline_keyboard: [
              ...buttons.map((b) => [
                { text: b.label.slice(0, 64), url: b.url },
              ]),
              ...callbacks.map((c) => [
                { text: c.label.slice(0, 64), callback_data: c.data },
              ]),
            ],
          }
        : null;
    const params: Record<string, unknown> = {
      chat_id: Number(chatId),
      text,
      link_preview_options: { is_disabled: true },
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };
    const sendText = async () => {
      const sent = z
        .looseObject({ message_id: z.number().int() })
        .parse(
          await this.retrying(() =>
            this.options.api.call('sendMessage', params),
          ),
        );
      return { messageId: String(sent.message_id) };
    };
    return this.limiter.run(chatId, async () => {
      const card = message.card;
      const banners = this.options.banners;
      if (!card || !banners) return sendText();
      let photo: Buffer;
      try {
        photo = await banners.render(card);
      } catch (error) {
        this.options.onBannerError?.(error);
        return sendText();
      }
      const { caption, rest } = splitCaption(text);
      const form = new FormData();
      form.set('chat_id', chatId);
      form.set('caption', caption);
      form.set(
        'photo',
        new Blob([new Uint8Array(photo)], { type: 'image/png' }),
        `${card.cardId}.png`,
      );
      if (keyboard) form.set('reply_markup', JSON.stringify(keyboard));
      if (replyParameters)
        form.set('reply_parameters', JSON.stringify(replyParameters));
      let messageId: string;
      // A network failure (status 0, e.g. timeout) may have delivered the
      // photo: never retry it and never post the text fallback after it, or
      // the chat could show the same card twice.
      const attempt = { uncertain: null as ChannelDeliveryError | null };
      try {
        const sent = z.looseObject({ message_id: z.number().int() }).parse(
          await this.retrying(async () => {
            try {
              return await this.options.api.call('sendPhoto', form);
            } catch (error) {
              if (error instanceof TelegramApiError && error.httpStatus === 0)
                throw (attempt.uncertain = new ChannelDeliveryError(
                  'PROVIDER_UNAVAILABLE',
                  1,
                  `DELIVERY_UNCERTAIN: ${error.description}`,
                ));
              throw error;
            }
          }),
        );
        messageId = String(sent.message_id);
      } catch (error) {
        this.options.onBannerError?.(error);
        if (attempt.uncertain) throw attempt.uncertain;
        return sendText();
      }
      if (rest)
        await this.retrying(() =>
          this.options.api.call('sendMessage', {
            chat_id: Number(chatId),
            text: rest,
            link_preview_options: { is_disabled: true },
          }),
        ).catch((error: unknown) => this.options.onBannerError?.(error));
      return { messageId };
    });
  }

  /** Retries 429/5xx/network failures with backoff; maps failures to ChannelDeliveryError. */
  private async retrying<T>(task: () => Promise<T>): Promise<T> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await task();
      } catch (error) {
        if (!(error instanceof TelegramApiError)) throw error;
        const retryable =
          error.httpStatus === 429 ||
          error.httpStatus === 0 ||
          error.httpStatus >= 500;
        if (!retryable)
          throw new ChannelDeliveryError(
            'PROVIDER_REJECTED',
            attempt,
            error.description,
          );
        if (attempt >= maxAttempts)
          throw new ChannelDeliveryError(
            error.httpStatus === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
            attempt,
            error.description,
          );
        const waitSeconds =
          error.httpStatus === 429
            ? Math.min(Math.max(error.retryAfterSeconds ?? 1, 1), 60)
            : Math.min(2 ** attempt, 30);
        await this.wait(waitSeconds * 1000);
      }
    }
  }

  /**
   * The one reply to a guest query, posted by Telegram as the bot into the
   * caller's chat via answerGuestQuery (never sendMessage: the bot is not a
   * member there). A network failure is not retried: it may have posted.
   */
  async answerGuest(
    guestQueryId: string,
    message: OutboundMessage,
  ): Promise<{ inlineMessageId: string }> {
    if (!/^[\x21-\x7e]{1,256}$/.test(guestQueryId))
      throw new ChannelDeliveryError(
        'PROVIDER_REJECTED',
        0,
        'invalid guest query id',
      );
    const buttons = (message.buttons ?? []).filter(
      (b) => !isLocalUrl(b.url) && b.url.startsWith('https://'),
    );
    const result = {
      type: 'article',
      id: createHash('sha256').update(guestQueryId).digest('hex').slice(0, 32),
      title: 'Synq',
      input_message_content: {
        message_text: message.text.slice(0, 4096),
        link_preview_options: { is_disabled: true },
      },
      ...(buttons.length
        ? {
            reply_markup: {
              inline_keyboard: buttons
                .slice(0, 3)
                .map((b) => [{ text: b.label.slice(0, 64), url: b.url }]),
            },
          }
        : {}),
    };
    return this.limiter.run(`guest:${guestQueryId}`, async () => {
      const sent = SentGuestMessageSchema.parse(
        await this.retrying(async () => {
          try {
            return await this.options.api.call('answerGuestQuery', {
              guest_query_id: guestQueryId,
              result,
            });
          } catch (error) {
            if (error instanceof TelegramApiError && error.httpStatus === 0)
              throw new ChannelDeliveryError(
                'PROVIDER_UNAVAILABLE',
                1,
                `DELIVERY_UNCERTAIN: ${error.description}`,
              );
            throw error;
          }
        }),
      );
      return { inlineMessageId: sent.inline_message_id };
    });
  }

  async acknowledgeAction(callbackId: string, text: string) {
    await this.options.api.call('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: text.slice(0, 200),
      show_alert: true,
    });
  }

  /** Long polling for local live runs without public HTTPS. At-least-once; the gateway dedupes. */
  async poll(input: {
    handle: (event: ChannelEvent) => Promise<unknown>;
    signal: AbortSignal;
    timeoutSeconds?: number;
    onError?: (error: unknown) => void;
    onBatch?: (count: number) => Promise<void> | void;
  }) {
    let offset: number | undefined;
    let backoff = 1;
    while (!input.signal.aborted) {
      let updates: unknown[];
      try {
        updates = z.array(z.unknown()).parse(
          await this.options.api.call(
            'getUpdates',
            {
              ...(offset !== undefined ? { offset } : {}),
              timeout: input.timeoutSeconds ?? 25,
              allowed_updates: TELEGRAM_ALLOWED_UPDATES,
            },
            input.signal,
          ),
        );
        backoff = 1;
      } catch (error) {
        if (input.signal.aborted) break;
        input.onError?.(error);
        const retry =
          error instanceof TelegramApiError && error.retryAfterSeconds
            ? error.retryAfterSeconds
            : backoff;
        backoff = Math.min(backoff * 2, 30);
        await this.wait(retry * 1000, input.signal);
        continue;
      }
      let failed = false;
      for (const raw of updates) {
        const id = z
          .looseObject({ update_id: z.number().int() })
          .safeParse(raw);
        if (!id.success) continue;
        try {
          for (const event of this.normalize(raw, 'BOT_API_POLL'))
            await input.handle(event);
        } catch (error) {
          // Keep the offset: Telegram redelivers this update and the gateway's
          // released claim lets it be processed again.
          input.onError?.(error);
          failed = true;
          break;
        }
        offset = id.data.update_id + 1;
      }
      await input.onBatch?.(updates.length);
      if (failed) {
        await this.wait(backoff * 1000, input.signal);
        backoff = Math.min(backoff * 2, 30);
      }
    }
  }
}

export const TelegramLoginSchema = z.strictObject({
  id: z.union([z.number().int(), z.string().regex(/^[0-9]{1,20}$/)]),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().max(2048).optional(),
  auth_date: z.union([z.number().int(), z.string().regex(/^[0-9]{1,12}$/)]),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TelegramLogin = z.input<typeof TelegramLoginSchema>;

/**
 * Telegram Login verification: HMAC-SHA256 over the sorted "key=value" lines
 * with SHA-256(bot token) as the key. Returns the proven user id or null.
 */
export function verifyTelegramLogin(
  raw: unknown,
  botToken: string,
  nowSeconds: number,
  maxAgeSeconds = 600,
): string | null {
  const parsed = TelegramLoginSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { hash, ...fields } = parsed.data;
  const authDate = Number(fields.auth_date);
  if (nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > 60)
    return null;
  const check = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? String(fields.id)
    : null;
}

export function signTelegramLoginForTest(
  fields: Omit<TelegramLogin, 'hash'>,
  botToken: string,
): TelegramLogin {
  const check = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  return {
    ...fields,
    hash: createHmac('sha256', secret).update(check).digest('hex'),
  };
}

export type TelegramMiniAppIdentity = {
  telegramUserId: string;
  authDate: number;
  queryId: string | null;
  chatType: string | null;
  chatInstance: string | null;
  startParam: string | null;
  /** The initData hash; callers use it to refuse a replayed initData. */
  hash: string;
};

const MiniAppUserSchema = z.looseObject({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
});

/** HMAC-SHA256(key = "WebAppData", message = bot token), per core.telegram.org/bots/webapps. */
const miniAppSecret = (botToken: string) =>
  createHmac('sha256', 'WebAppData').update(botToken).digest();
const miniAppCheckString = (fields: [string, string][]) =>
  [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

/**
 * Validates Telegram.WebApp.initData: the hash must equal
 * HMAC-SHA256(data-check-string, HMAC-SHA256("WebAppData", token)) and
 * auth_date must be recent. Returns the proven user or null.
 */
export function verifyTelegramMiniAppInitData(
  raw: unknown,
  botToken: string,
  nowSeconds: number,
  maxAgeSeconds = 3600,
): TelegramMiniAppIdentity | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192)
    return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const fields: [string, string][] = [];
  const seen = new Set<string>();
  let hash: string | null = null;
  for (const [key, value] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === 'hash') hash = value;
    else fields.push([key, value]);
  }
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const get = (k: string) => fields.find(([key]) => key === k)?.[1] ?? null;
  const authRaw = get('auth_date');
  if (!authRaw || !/^[0-9]{1,12}$/.test(authRaw)) return null;
  const authDate = Number(authRaw);
  if (nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > 60)
    return null;
  const expected = createHmac('sha256', miniAppSecret(botToken))
    .update(miniAppCheckString(fields))
    .digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let user: z.output<typeof MiniAppUserSchema>;
  try {
    const parsed = MiniAppUserSchema.safeParse(JSON.parse(get('user') ?? ''));
    if (!parsed.success || parsed.data.is_bot === true) return null;
    user = parsed.data;
  } catch {
    return null;
  }
  return {
    telegramUserId: String(user.id),
    authDate,
    queryId: get('query_id'),
    chatType: get('chat_type'),
    chatInstance: get('chat_instance'),
    startParam: get('start_param'),
    hash,
  };
}

/** Builds an initData string signed like Telegram does; tests only. */
export function signTelegramMiniAppInitDataForTest(
  fields: Record<string, string>,
  botToken: string,
): string {
  const entries = Object.entries(fields);
  const hash = createHmac('sha256', miniAppSecret(botToken))
    .update(miniAppCheckString(entries))
    .digest('hex');
  return new URLSearchParams([...entries, ['hash', hash]]).toString();
}
