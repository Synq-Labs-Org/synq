import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { sleep as defaultSleep, type Sleep } from '../outbound.js';
import type { IMessageBridge } from './bridge.js';
import {
  BeeperTransport,
  BlueBubblesTransport,
  type IMessageTransport,
} from './transport.js';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export const IMessageEnvSchema = z.object({
  SYNQ_IMESSAGE_TRANSPORT: z
    .enum(['off', 'bluebubbles', 'beeper'])
    .default('off'),
  SYNQ_IMESSAGE_ALLOWED_CHATS: z.string().optional(),
  SYNQ_IMESSAGE_BOT_HANDLE: z.string().optional(),
  SYNQ_IMESSAGE_MENTION_WORDS: z.string().optional(),
  SYNQ_IMESSAGE_WEBHOOK_TOKEN: z.string().optional(),
  SYNQ_IMESSAGE_POLL_MS: z.coerce.number().int().min(1000).default(3000),
  BLUEBUBBLES_URL: z.string().url().default('http://127.0.0.1:1234'),
  BLUEBUBBLES_PASSWORD: z.string().optional(),
  BEEPER_DESKTOP_URL: z.string().url().default('http://localhost:23373'),
  BEEPER_ACCESS_TOKEN: z.string().optional(),
});

export type IMessageConfig = {
  transport: IMessageTransport;
  allowedChats: string[];
  botHandle: string | null;
  mentionWords: string[];
  webhookToken: string | null;
  pollMs: number;
};

/** Builds the configured transport, or null when iMessage is off. Fails closed on an empty allowlist. */
export function imessageConfigFromEnv(
  raw: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): IMessageConfig | null {
  const env = IMessageEnvSchema.parse(raw);
  if (env.SYNQ_IMESSAGE_TRANSPORT === 'off') return null;
  const allowedChats = list(env.SYNQ_IMESSAGE_ALLOWED_CHATS);
  if (!allowedChats.length)
    throw new Error('SYNQ_IMESSAGE_ALLOWED_CHATS must list at least one chat');
  const common = {
    allowedChats,
    botHandle: env.SYNQ_IMESSAGE_BOT_HANDLE ?? null,
    mentionWords: list(env.SYNQ_IMESSAGE_MENTION_WORDS ?? 'synq').map((w) =>
      w.replace(/[^A-Za-z0-9_]/g, ''),
    ),
    pollMs: env.SYNQ_IMESSAGE_POLL_MS,
  };
  if (env.SYNQ_IMESSAGE_TRANSPORT === 'bluebubbles') {
    if (!env.BLUEBUBBLES_PASSWORD)
      throw new Error('BLUEBUBBLES_PASSWORD is required');
    const token = env.SYNQ_IMESSAGE_WEBHOOK_TOKEN ?? '';
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token))
      throw new Error(
        'SYNQ_IMESSAGE_WEBHOOK_TOKEN must be 24-128 url-safe characters',
      );
    return {
      ...common,
      webhookToken: token,
      transport: new BlueBubblesTransport({
        baseUrl: env.BLUEBUBBLES_URL,
        password: env.BLUEBUBBLES_PASSWORD,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
    };
  }
  if (!env.BEEPER_ACCESS_TOKEN)
    throw new Error('BEEPER_ACCESS_TOKEN is required');
  return {
    ...common,
    webhookToken: null,
    transport: new BeeperTransport({
      baseUrl: env.BEEPER_DESKTOP_URL,
      token: env.BEEPER_ACCESS_TOKEN,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  };
}

export function webhookTokenMatches(expected: string, given: string) {
  const d = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(d(expected), d(given));
}

/**
 * Receive loop for transports without push delivery to Synq (Beeper): polls
 * only the allowlisted chats through the authenticated local API.
 */
export async function pollAllowlistedChats(
  bridge: IMessageBridge,
  signal: AbortSignal,
  intervalMs: number,
  onError?: (error: unknown) => void,
  wait: Sleep = defaultSleep,
) {
  while (!signal.aborted) {
    if (bridge.state !== 'DISCONNECTED')
      await bridge.catchUp().catch((error) => onError?.(error));
    await wait(intervalMs, signal);
  }
}
