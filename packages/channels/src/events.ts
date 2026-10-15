import { z } from 'zod';
import type { InteractiveCard } from '@synq/schemas';

export const CHANNEL_IDS = [
  'telegram',
  'linq',
  'whatsapp',
  'imessage',
] as const;
export const ChannelIdSchema = z.enum(CHANNEL_IDS);
export type ChannelId = z.output<typeof ChannelIdSchema>;

const ExternalIdSchema = z.string().min(1).max(200);
export const GUEST_REFERENCE_MAX_CHARS = 1000;

export const InteractionSchema = z.strictObject({
  kind: z.enum([
    'COMMAND',
    'MENTION',
    'REPLY_TO_BOT',
    'TEXT',
    'CALLBACK',
    'MEMBERSHIP',
    'SYSTEM',
  ]),
  addressedToBot: z.boolean(),
  command: z.string().max(64).nullable(),
  args: z.string().max(4096),
  callbackData: z.string().max(256).nullable(),
});
export type Interaction = z.output<typeof InteractionSchema>;

export const VerifiedSenderSchema = z.strictObject({
  transport: z.enum([
    'WEBHOOK_SECRET_TOKEN',
    'WEBHOOK_HMAC',
    'BOT_API_POLL',
    'IMESSAGE_BRIDGE',
    'FIXTURE',
  ]),
  providerUserId: ExternalIdSchema.nullable(),
  displayName: z.string().max(200).nullable(),
  isBot: z.boolean(),
});
export type VerifiedSender = z.output<typeof VerifiedSenderSchema>;

export const AttachmentSchema = z.strictObject({
  kind: z.enum(['IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'LINK', 'OTHER']),
  ref: z.string().max(2048),
});

/** Provider-neutral inbound envelope. Text here is untrusted user content. */
export const EnvelopeSchema = z.strictObject({
  channel: ChannelIdSchema,
  eventId: ExternalIdSchema,
  externalGroupId: ExternalIdSchema,
  chatKind: z.enum(['GROUP', 'DIRECT']),
  externalUserId: ExternalIdSchema.nullable(),
  messageId: ExternalIdSchema.nullable(),
  body: z.string().max(10_000),
  timestamp: z.number().int().nonnegative(),
  replyTo: ExternalIdSchema.nullable(),
  interaction: InteractionSchema,
  attachments: z.array(AttachmentSchema).max(20),
  verifiedSender: VerifiedSenderSchema,
  /** The sender forwarded someone else's content; it is not their own words. */
  forwarded: z.boolean().optional(),
});
export type Envelope = z.output<typeof EnvelopeSchema>;

/**
 * The one message a guest invocation may carry as context (the message the
 * caller replied to). Evidence with provenance, never proof of agreement.
 */
export const GuestReferenceSchema = z.strictObject({
  source: z.literal('REPLY_TO_MESSAGE'),
  messageId: ExternalIdSchema,
  externalUserId: ExternalIdSchema.nullable(),
  isBot: z.boolean(),
  timestamp: z.number().int().nonnegative().nullable(),
  text: z.string().max(GUEST_REFERENCE_MAX_CHARS),
  truncated: z.boolean(),
  /** sha256 of the full text as received, so a later copy can be checked. */
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GuestReference = z.output<typeof GuestReferenceSchema>;

const MemberRefSchema = z.strictObject({
  externalUserId: ExternalIdSchema,
  displayName: z.string().max(200).nullable(),
  isBot: z.boolean(),
});

export const ChannelEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('MESSAGE_RECEIVED'),
    envelope: EnvelopeSchema,
  }),
  z.strictObject({
    type: z.literal('GROUP_CREATED'),
    envelope: EnvelopeSchema,
    title: z.string().max(200).nullable(),
  }),
  z.strictObject({
    type: z.literal('MEMBER_JOINED'),
    envelope: EnvelopeSchema,
    members: z.array(MemberRefSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('MEMBER_LEFT'),
    envelope: EnvelopeSchema,
    members: z.array(MemberRefSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('ACTION_REQUESTED'),
    envelope: EnvelopeSchema,
    callbackId: ExternalIdSchema,
  }),
  /**
   * A guest-mode invocation from a chat the bot is not a member of. It
   * carries the triggering message and at most one referenced message: no
   * history, no membership, no subscription. Answered once, never by
   * sendMessage.
   */
  z.strictObject({
    type: z.literal('GUEST_QUERY'),
    envelope: EnvelopeSchema,
    /** The bot that received it (e.g. `bot:<id>`); guest query ids are scoped to it. */
    receiver: ExternalIdSchema,
    guestQueryId: z.string().min(1).max(256),
    reference: GuestReferenceSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('APPROVAL_LINK_OPENED'),
    channel: ChannelIdSchema,
    externalGroupId: ExternalIdSchema,
    intentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    principalId: z.string().min(1).max(200),
    at: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('MESSAGE_DELIVERY_FAILED'),
    channel: ChannelIdSchema,
    externalGroupId: ExternalIdSchema,
    reason: z.string().max(500),
    attempts: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
  }),
]);
export type ChannelEvent = z.output<typeof ChannelEventSchema>;
export type ChannelEventType = ChannelEvent['type'];

export type OutboundButton = { label: string; url: string };
/** A provider callback button; it may refresh read-only state, never approve. */
export type OutboundCallback = { label: string; data: string };
export type OutboundMessage = {
  text: string;
  buttons?: readonly OutboundButton[];
  callbacks?: readonly OutboundCallback[];
  /** The canonical card this message renders, for adapters with richer surfaces. */
  card?: InteractiveCard;
  replyTo?: string | null;
  idempotencyKey?: string;
};
export type DeliveryResult = { messageId: string };

export class ChannelDeliveryError extends Error {
  constructor(
    readonly code:
      | 'RATE_LIMITED'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_REJECTED'
      | 'CHANNEL_UNAVAILABLE',
    readonly attempts: number,
    message: string = code,
  ) {
    super(message);
    this.name = 'ChannelDeliveryError';
  }
}

export interface ChannelAdapter {
  readonly channel: ChannelId;
  send(
    externalGroupId: string,
    message: OutboundMessage,
  ): Promise<DeliveryResult>;
  acknowledgeAction?(callbackId: string, text: string): Promise<void>;
  /** The single reply to a guest invocation; adapters without guest mode omit it. */
  answerGuest?(
    guestQueryId: string,
    message: OutboundMessage,
  ): Promise<{ inlineMessageId: string }>;
  /** What the bot can receive in a group (privacy mode limits it); absent means addressed-only. */
  groupVisibility?(
    externalGroupId: string,
  ): Promise<'ALL_MESSAGES' | 'ADDRESSED_ONLY'>;
  /** URL that opens a private chat with the bot carrying `payload`; null if unsupported. */
  deepLink?(payload: string): string | null;
  /** The user's role in the chat as the provider reports it; absent if unsupported. */
  chatRole?(
    externalGroupId: string,
    externalUserId: string,
  ): Promise<'OWNER' | 'ADMIN' | 'MEMBER' | 'NONE'>;
}
