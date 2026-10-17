import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CardBannerRenderer,
  CardLinkIssuer,
  ChannelGateway,
  ChatContextService,
  IMessageBridge,
  IMessageChannelAdapter,
  LinqV3Adapter,
  imessageConfigFromEnv,
  pollAllowlistedChats,
  TelegramAdapter,
  TelegramBotApi,
  WhatsAppAdapter,
  whatsappConfigFromEnv,
  type ChannelAdapter,
  type ChannelPorts,
} from '@synq/channels';
import {
  PostgresChannelStore,
  PostgresChatContextStore,
  type ChannelSqlPool,
} from '@synq/channels/postgres';
import type { SendRecord } from '@synq/funding';
import { channelRoutes } from './channel-routes.js';
import {
  MONAD_TESTNET_EXPLORER_TX,
  productionChannelPorts,
  runChannelNotifier,
  type ChannelApprovalSource,
  type ChannelExecutionSource,
} from './channel-runtime.js';
import type { SendRouteDeps } from './send-routes.js';
import type { MandateProposalService } from './mandate-proposals.js';

const ChannelEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  SYNQ_TELEGRAM_MODE: z.enum(['off', 'webhook', 'poll']).optional(),
  SYNQ_TELEGRAM_ALL_MESSAGES: z.enum(['0', '1']).default('0'),
  SYNQ_WEB_BASE_URL: z.string().url().optional(),
  SYNQ_EXPLORER_TX_URL: z.string().url().default(MONAD_TESTNET_EXPLORER_TX),
  LINQ_API_KEY: z.string().optional(),
  LINQ_WEBHOOK_SECRET: z.string().optional(),
  LINQ_BASE_URL: z.string().url().optional(),
  SYNQ_TELEGRAM_LOGIN_REQUIRED: z.enum(['0', '1']).default('0'),
  SYNQ_TELEGRAM_REQUIRE_CHAT_ADMIN: z.enum(['0', '1']).default('1'),
  SYNQ_CHAT_LINK_PENDING_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(86_400),
  SYNQ_CHANNEL_CARDS: z.enum(['0', '1']).default('1'),
  SYNQ_CARD_BANNERS: z.enum(['0', '1']).default('1'),
  SYNQ_CARD_LINK_KEY: z.string().min(32).optional(),
  SYNQ_CARD_LINK_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(7 * 86_400)
    .default(43_200),
  SYNQ_CHANNEL_NOTIFY_MS: z.coerce.number().int().min(1000).default(5000),
  /**
   * Consented chat memory (/memory); off keeps no chat messages at all.
   * Off by default: the Brain does not yet read stored context.
   */
  SYNQ_CHANNEL_MEMORY: z.enum(['0', '1']).default('0'),
  SYNQ_CHANNEL_MEMORY_PURGE_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(600_000),
});

/** Whether consented chat memory is on for this deployment (default off). */
export function channelMemoryEnabled(
  env: Readonly<Record<string, string | undefined>>,
) {
  return ChannelEnvSchema.parse(env).SYNQ_CHANNEL_MEMORY === '1';
}

export type ChannelLog = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

/** Registers chat ingress on the production API; returns null when no channel is configured. */
export async function registerChannels(input: {
  app: FastifyInstance;
  env: NodeJS.ProcessEnv;
  origin: string;
  pool: ChannelSqlPool;
  send: Omit<SendRouteDeps, 'store'>;
  sends: { list(groupId: string): Promise<SendRecord[]> };
  approvals: ChannelApprovalSource;
  executed?: ChannelExecutionSource;
  executionMode: 'REAL_TESTNET' | 'SIMULATION';
  workspaceOnboarding?: boolean;
  workspaceMessage?: ChannelPorts['workspaceMessage'];
  leadStart?: ChannelPorts['leadStart'];
  leadMessage?: ChannelPorts['leadMessage'];
  brain?: ChannelPorts['brain'];
  mandateProposals?: Pick<MandateProposalService, 'list' | 'counted'>;
  log: ChannelLog;
  fetch?: typeof fetch;
  telegramBaseUrl?: string;
}) {
  const env = ChannelEnvSchema.parse(input.env);
  const telegramMode =
    env.SYNQ_TELEGRAM_MODE ??
    (env.TELEGRAM_BOT_TOKEN
      ? env.TELEGRAM_WEBHOOK_SECRET
        ? 'webhook'
        : 'poll'
      : 'off');
  const linqEnabled = Boolean(env.LINQ_WEBHOOK_SECRET);
  const imessage = imessageConfigFromEnv(input.env, input.fetch);
  const whatsappConfig = whatsappConfigFromEnv(input.env);
  if (telegramMode === 'off' && !linqEnabled && !imessage && !whatsappConfig)
    return null;
  const store = new PostgresChannelStore(input.pool);
  await store.migrate();
  const contextStore =
    env.SYNQ_CHANNEL_MEMORY === '1'
      ? new PostgresChatContextStore(input.pool)
      : null;
  await contextStore?.migrate();
  const context = contextStore ? new ChatContextService(contextStore) : null;
  const adapters: ChannelAdapter[] = [];
  let telegram: TelegramAdapter | undefined;
  if (telegramMode !== 'off') {
    if (!env.TELEGRAM_BOT_TOKEN)
      throw new Error('Invalid channel configuration: TELEGRAM_BOT_TOKEN');
    if (telegramMode === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET)
      throw new Error('Invalid channel configuration: TELEGRAM_WEBHOOK_SECRET');
    telegram = new TelegramAdapter({
      api: new TelegramBotApi({
        token: env.TELEGRAM_BOT_TOKEN,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.telegramBaseUrl ? { baseUrl: input.telegramBaseUrl } : {}),
      }),
      ...(env.TELEGRAM_WEBHOOK_SECRET
        ? { webhookSecret: env.TELEGRAM_WEBHOOK_SECRET }
        : {}),
      respondToAllMessages: env.SYNQ_TELEGRAM_ALL_MESSAGES === '1',
      ...(env.SYNQ_CHANNEL_CARDS === '1' && env.SYNQ_CARD_BANNERS === '1'
        ? {
            banners: new CardBannerRenderer(),
            onBannerError: (error: unknown) =>
              input.log('card banner fallback', {
                error: String(error).slice(0, 200),
              }),
          }
        : {}),
      transport:
        telegramMode === 'webhook' ? 'WEBHOOK_SECRET_TOKEN' : 'BOT_API_POLL',
    });
    const bot = await telegram.init();
    input.log('telegram bot ready', {
      username: bot.username,
      mode: telegramMode,
      privacyMode: bot.privacyMode,
      guestQueries: bot.guestQueries,
    });
    adapters.push(telegram);
  }
  const linq = linqEnabled
    ? new LinqV3Adapter({
        ...(env.LINQ_API_KEY ? { apiKey: env.LINQ_API_KEY } : {}),
        webhookSecret: env.LINQ_WEBHOOK_SECRET,
        ...(env.LINQ_BASE_URL ? { baseUrl: env.LINQ_BASE_URL } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      })
    : undefined;
  if (linq) adapters.push(linq);
  const whatsapp = whatsappConfig
    ? WhatsAppAdapter.fromConfig(whatsappConfig, {
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(env.SYNQ_CHANNEL_CARDS === '1' && env.SYNQ_CARD_BANNERS === '1'
          ? {
              banners: new CardBannerRenderer(),
              onBannerError: (error: unknown) =>
                input.log('card banner fallback', {
                  channel: 'whatsapp',
                  error: String(error).slice(0, 200),
                }),
            }
          : {}),
        onDrop: (reason) => input.log('whatsapp message dropped', { reason }),
      })
    : undefined;
  if (whatsapp) {
    adapters.push(whatsapp);
    input.log('whatsapp cloud api configured', {
      allowedWaIds: whatsappConfig!.allowedWaIds.length,
    });
  }
  const imessageAdapter = imessage
    ? new IMessageChannelAdapter({
        transport: imessage.transport,
        botHandle: imessage.botHandle,
        ...(env.SYNQ_CHANNEL_CARDS === '1' && env.SYNQ_CARD_BANNERS === '1'
          ? { banners: new CardBannerRenderer() }
          : {}),
      })
    : undefined;
  if (imessageAdapter) adapters.push(imessageAdapter);
  const now = () => Math.floor(Date.now() / 1000);
  const webBaseUrl = env.SYNQ_WEB_BASE_URL ?? input.origin;
  const cardLinks = env.SYNQ_CARD_LINK_KEY
    ? new CardLinkIssuer({
        key: env.SYNQ_CARD_LINK_KEY,
        webBaseUrl,
        now,
        ttlSeconds: env.SYNQ_CARD_LINK_TTL_SECONDS,
      })
    : null;
  const gateway = new ChannelGateway({
    store,
    adapters,
    ports: {
      ...productionChannelPorts({
        send: input.send,
        sends: input.sends,
        approvals: input.approvals,
        ...(input.executed ? { executed: input.executed } : {}),
        executionMode: input.executionMode,
        ...(input.brain ? { brain: input.brain } : {}),
        ...(input.mandateProposals
          ? { mandateProposals: input.mandateProposals }
          : {}),
      }),
      ...(input.workspaceMessage
        ? { workspaceMessage: input.workspaceMessage }
        : {}),
      ...(input.leadStart ? { leadStart: input.leadStart } : {}),
      ...(input.leadMessage ? { leadMessage: input.leadMessage } : {}),
    },
    webBaseUrl,
    workspaceOnboarding: input.workspaceOnboarding,
    explorerTxUrl: env.SYNQ_EXPLORER_TX_URL,
    now,
    ...(env.SYNQ_CHANNEL_CARDS === '1' ? { cards: { links: cardLinks } } : {}),
    ...(telegram?.botUsername
      ? { botUsernames: { telegram: telegram.botUsername } }
      : {}),
    requireChatAdmin: {
      telegram: env.SYNQ_TELEGRAM_REQUIRE_CHAT_ADMIN === '1',
    },
    pendingLinkTtlSeconds: env.SYNQ_CHAT_LINK_PENDING_TTL_SECONDS,
    ...(context ? { context } : {}),
    requireExternalProof: {
      telegram: env.SYNQ_TELEGRAM_LOGIN_REQUIRED === '1',
    },
    onEvent: (event, outcome) =>
      input.log('channel event', {
        type: event.type,
        channel: 'envelope' in event ? event.envelope.channel : event.channel,
        status: outcome.status,
        code: outcome.code,
      }),
  });
  const bridge =
    imessage && imessageAdapter
      ? new IMessageBridge({
          transport: imessage.transport,
          adapter: imessageAdapter,
          gateway,
          allowedChats: imessage.allowedChats,
          mentionWords: imessage.mentionWords,
          log: (message, fields) => input.log(message, fields),
        })
      : undefined;
  if (imessage)
    input.log('imessage bridge configured', {
      transport: imessage.transport.name,
      allowedChats: imessage.allowedChats.length,
    });
  const memberAccess = input.send.memberAccess;
  await input.app.register(channelRoutes, {
    gateway,
    ...(telegramMode === 'webhook' && telegram ? { telegram } : {}),
    ...(linq ? { linq } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    memberSession: async (token, groupId) =>
      memberAccess ? memberAccess.session(token, groupId) : null,
    now,
    ...(telegram && telegram.botId !== null
      ? {
          telegramLogin: {
            botId: telegram.botId,
            required: env.SYNQ_TELEGRAM_LOGIN_REQUIRED === '1',
            verify: (raw: unknown, at: number) =>
              telegram!.verifyLogin(raw, at),
            verifyInitData: (raw: unknown, at: number) =>
              telegram!.verifyMiniAppInitData(raw, at),
            consumeInitData: (hash: string, at: number) =>
              store.claimNotification(
                'telegram',
                'miniapp',
                telegram!.miniAppReplayKey(hash),
                at,
              ),
            releaseInitData: (hash: string) =>
              store.releaseNotification(
                'telegram',
                'miniapp',
                telegram!.miniAppReplayKey(hash),
              ),
          },
          telegramProbe: () => telegram!.profile,
        }
      : {}),
    env: input.env,
    ...(bridge && imessage
      ? {
          imessage: {
            bridge,
            transport: imessage.transport,
            webhookToken: imessage.webhookToken,
          },
        }
      : {}),
  });
  const controller = new AbortController();
  const loops: Promise<unknown>[] = [];
  const start = () => {
    loops.push(
      runChannelNotifier(
        gateway,
        controller.signal,
        env.SYNQ_CHANNEL_NOTIFY_MS,
        (error) =>
          input.log('channel notifier error', {
            error: String(error).slice(0, 200),
          }),
      ),
    );
    if (context)
      loops.push(
        runContextPurge(
          context,
          now,
          controller.signal,
          env.SYNQ_CHANNEL_MEMORY_PURGE_MS,
          (deleted) =>
            deleted && input.log('channel memory purged', { deleted }),
          (error) =>
            input.log('channel memory purge error', {
              error: String(error).slice(0, 200),
            }),
        ),
      );
    if (bridge && imessage) {
      loops.push(bridge.supervise(controller.signal));
      if (imessage.transport.name === 'beeper')
        loops.push(
          pollAllowlistedChats(
            bridge,
            controller.signal,
            imessage.pollMs,
            (error) =>
              input.log('imessage poll error', {
                error: String(error).slice(0, 200),
              }),
          ),
        );
    }
    if (telegramMode === 'poll' && telegram)
      loops.push(
        telegram.poll({
          signal: controller.signal,
          handle: (event) => gateway.handle(event),
          onError: (error) =>
            input.log('telegram poll error', {
              error: String(error).slice(0, 200),
            }),
        }),
      );
  };
  const stop = async () => {
    controller.abort();
    await Promise.allSettled(loops);
  };
  return {
    gateway,
    store,
    context,
    telegram,
    linq,
    whatsapp,
    imessage: bridge,
    telegramMode,
    start,
    stop,
  };
}

/** Enforces chat-memory retention: deletes expired messages on an interval. */
export async function runContextPurge(
  context: Pick<ChatContextService, 'purge'>,
  now: () => number,
  signal: AbortSignal,
  intervalMs: number,
  onPurged: (deleted: number) => void,
  onError: (error: unknown) => void,
) {
  while (!signal.aborted) {
    try {
      onPurged(await context.purge(now()));
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
