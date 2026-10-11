import type { ChannelId } from './events.js';
import { WHATSAPP_UNAVAILABLE_REASON } from './whatsapp.js';

export type ChannelCapability = {
  channel: ChannelId;
  status: 'AVAILABLE' | 'CREDENTIALS_MISSING' | 'UNAVAILABLE';
  evidence: 'REAL_PROVIDER' | 'FIXTURE_ONLY' | 'NONE';
  groupModel: string;
  ingress: string[];
  features: string[];
  reason: string | null;
};

export function channelCapabilities(
  env: Readonly<Record<string, string | undefined>>,
): ChannelCapability[] {
  const has = (name: string) => (env[name] ?? '').trim().length > 0;
  return [
    {
      channel: 'telegram',
      status: has('TELEGRAM_BOT_TOKEN') ? 'AVAILABLE' : 'CREDENTIALS_MISSING',
      evidence: has('TELEGRAM_BOT_TOKEN') ? 'REAL_PROVIDER' : 'FIXTURE_ONLY',
      groupModel:
        'Bot added to any Telegram group; privacy mode limits it to commands, mentions and replies',
      ingress: ['WEBHOOK_SECRET_TOKEN', 'BOT_API_POLL'],
      features: [
        'commands',
        'mentions',
        'url-buttons',
        'receipts',
        'approval-count',
      ],
      reason: has('TELEGRAM_BOT_TOKEN')
        ? null
        : 'TELEGRAM_BOT_TOKEN not configured',
    },
    {
      channel: 'linq',
      status:
        has('LINQ_API_KEY') && has('LINQ_WEBHOOK_SECRET')
          ? 'AVAILABLE'
          : 'CREDENTIALS_MISSING',
      evidence: 'FIXTURE_ONLY',
      groupModel:
        'Linq-managed group chats created through POST /v3/chats from a provisioned Linq number; joining arbitrary existing iMessage groups is not claimed',
      ingress: ['WEBHOOK_HMAC'],
      features: [
        'commands',
        'mentions',
        'link-parts',
        'receipts',
        'approval-count',
      ],
      reason: has('LINQ_API_KEY')
        ? null
        : 'LINQ_API_KEY / LINQ_WEBHOOK_SECRET not configured',
    },
    {
      channel: 'whatsapp',
      status: 'UNAVAILABLE',
      evidence: 'NONE',
      groupModel: 'not supported',
      ingress: [],
      features: [],
      reason: WHATSAPP_UNAVAILABLE_REASON,
    },
  ];
}
