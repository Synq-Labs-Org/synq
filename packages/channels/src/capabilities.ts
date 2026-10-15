import type { ChannelId } from './events.js';
import {
  WHATSAPP_ENV,
  WHATSAPP_GROUPS_NOTE,
  WHATSAPP_UNAVAILABLE_REASON,
} from './whatsapp.js';

export type ChannelCapability = {
  channel: ChannelId;
  status:
    | 'AVAILABLE'
    | 'CREDENTIALS_MISSING'
    | 'UNAVAILABLE'
    | 'BLOCKED_EXTERNAL';
  evidence: 'REAL_PROVIDER' | 'FIXTURE_ONLY' | 'NONE';
  groupModel: string;
  ingress: string[];
  features: string[];
  reason: string | null;
};

/** getMe facts about the running bot; absent means unknown and nothing is claimed. */
export type TelegramProbe = {
  privacyMode: boolean;
  guestQueries: boolean;
};

export function channelCapabilities(
  env: Readonly<Record<string, string | undefined>>,
  probe: { telegram?: TelegramProbe | null } = {},
): ChannelCapability[] {
  const has = (name: string) => (env[name] ?? '').trim().length > 0;
  const tg = probe.telegram ?? null;
  // Privacy mode unless getMe said otherwise: never claim full visibility.
  const privacy = tg?.privacyMode ?? true;
  return [
    {
      channel: 'telegram',
      status: has('TELEGRAM_BOT_TOKEN') ? 'AVAILABLE' : 'CREDENTIALS_MISSING',
      evidence: has('TELEGRAM_BOT_TOKEN') ? 'REAL_PROVIDER' : 'FIXTURE_ONLY',
      groupModel: privacy
        ? 'Bot added to a Telegram group; privacy mode limits it to commands, mentions and replies (all new messages only where it is an admin). No pre-join history.'
        : 'Bot added to a Telegram group with privacy mode off: receives new group messages. No pre-join history; stored only under /memory consent.',
      ingress: ['WEBHOOK_SECRET_TOKEN', 'BOT_API_POLL'],
      features: [
        'commands',
        'mentions',
        'url-buttons',
        'receipts',
        'approval-count',
        privacy
          ? 'group-visibility:addressed-only'
          : 'group-visibility:new-messages',
        'consented-memory',
        ...(tg?.guestQueries ? ['guest-mode'] : []),
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
    (() => {
      const t = env.SYNQ_IMESSAGE_TRANSPORT ?? 'off';
      const ready =
        has('SYNQ_IMESSAGE_ALLOWED_CHATS') &&
        ((t === 'bluebubbles' &&
          has('BLUEBUBBLES_PASSWORD') &&
          has('SYNQ_IMESSAGE_WEBHOOK_TOKEN')) ||
          (t === 'beeper' && has('BEEPER_ACCESS_TOKEN')));
      return {
        channel: 'imessage' as const,
        status: ready
          ? ('AVAILABLE' as const)
          : ('CREDENTIALS_MISSING' as const),
        evidence: 'FIXTURE_ONLY' as const,
        groupModel:
          'Existing iMessage group chats on a Mac bridge (BlueBubbles or Beeper Desktop, SIP enabled); only chats listed in SYNQ_IMESSAGE_ALLOWED_CHATS are read',
        ingress:
          t === 'beeper' ? ['LOCAL_API_POLL'] : ['WEBHOOK_TOKEN_PLUS_READBACK'],
        features: [
          'commands',
          'mentions',
          'link-cards',
          'receipts',
          'approval-count',
        ],
        reason: ready
          ? null
          : 'SYNQ_IMESSAGE_TRANSPORT with its credentials and SYNQ_IMESSAGE_ALLOWED_CHATS not configured',
      };
    })(),
    (() => {
      const ready = WHATSAPP_ENV.every(has);
      return {
        channel: 'whatsapp' as const,
        status: ready ? ('AVAILABLE' as const) : ('BLOCKED_EXTERNAL' as const),
        // Shapes are checked against Meta's docs and a fake Graph API only.
        evidence: ready ? ('FIXTURE_ONLY' as const) : ('NONE' as const),
        groupModel: `1:1 chats with allowlisted wa_ids through the official Cloud API. ${WHATSAPP_GROUPS_NOTE}`,
        ingress: ['WEBHOOK_HMAC'],
        features: [
          'commands',
          'image-banners',
          'reply-buttons',
          'cta-url-buttons',
          'receipts',
        ],
        reason: ready ? null : WHATSAPP_UNAVAILABLE_REASON,
      };
    })(),
  ];
}
