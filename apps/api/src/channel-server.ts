import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ChannelGateway,
  LinqV3Adapter,
  TelegramAdapter,
  TelegramBotApi,
  type ChannelAdapter,
  type ChannelPorts,
} from '@synq/channels';
import {
  PostgresChannelStore,
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
  SYNQ_CHANNEL_NOTIFY_MS: z.coerce.number().int().min(1000).default(5000),
});

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
  brain?: ChannelPorts['brain'];
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
  if (telegramMode === 'off' && !linqEnabled) return null;
  const store = new PostgresChannelStore(input.pool);
  await store.migrate();
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
      transport:
        telegramMode === 'webhook' ? 'WEBHOOK_SECRET_TOKEN' : 'BOT_API_POLL',
    });
    const bot = await telegram.init();
    input.log('telegram bot ready', {
      username: bot.username,
      mode: telegramMode,
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
  const now = () => Math.floor(Date.now() / 1000);
  const gateway = new ChannelGateway({
    store,
    adapters,
    ports: productionChannelPorts({
      send: input.send,
      sends: input.sends,
      approvals: input.approvals,
      ...(input.executed ? { executed: input.executed } : {}),
      executionMode: input.executionMode,
      ...(input.brain ? { brain: input.brain } : {}),
    }),
    webBaseUrl: env.SYNQ_WEB_BASE_URL ?? input.origin,
    explorerTxUrl: env.SYNQ_EXPLORER_TX_URL,
    now,
    ...(telegram?.botUsername
      ? { botUsernames: { telegram: telegram.botUsername } }
      : {}),
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
  const memberAccess = input.send.memberAccess;
  await input.app.register(channelRoutes, {
    gateway,
    ...(telegramMode === 'webhook' && telegram ? { telegram } : {}),
    ...(linq ? { linq } : {}),
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
          },
        }
      : {}),
    env: input.env,
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
  return { gateway, store, telegram, linq, telegramMode, start, stop };
}
