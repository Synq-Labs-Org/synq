import { createHash } from 'node:crypto';
import type { ChannelId, Envelope } from './events.js';

/**
 * How much chat context Synq may keep for a chat:
 * - GUEST_ONE_SHOT: a guest invocation; nothing is stored.
 * - ENROLLED_ON_DEMAND: a linked chat; commands and replies only, no memory.
 * - ENROLLED_CONTEXT: a chat admin turned memory on and it was disclosed in
 *   the chat; messages from members who opted in are kept for the retention
 *   period, for one purpose.
 */
export type ContextMode =
  | 'GUEST_ONE_SHOT'
  | 'ENROLLED_ON_DEMAND'
  | 'ENROLLED_CONTEXT';
export const CONTEXT_PURPOSE = 'GROUP_FINANCIAL_PROPOSALS' as const;
export const CONTEXT_MIN_RETENTION_SECONDS = 3_600;
export const CONTEXT_MAX_RETENTION_SECONDS = 90 * 86_400;
export const CONTEXT_DEFAULT_RETENTION_SECONDS = 30 * 86_400;
const MAX_STORED_CHARS = 4_000;

export type ContextVisibility = 'ALL_MESSAGES' | 'ADDRESSED_ONLY';

export type ChatContextPolicy = {
  channel: ChannelId;
  externalGroupId: string;
  groupId: string;
  retentionSeconds: number;
  purpose: typeof CONTEXT_PURPOSE;
  /** What the bot can actually receive in this chat when memory was turned on. */
  visibility: ContextVisibility;
  enrolledByPrincipalId: string;
  enrolledAt: number;
  /** When the disclosure was posted in the chat; nothing is stored before it. */
  disclosedAt: number | null;
};
export type ContextConsent = {
  channel: ChannelId;
  externalGroupId: string;
  externalUserId: string;
  principalId: string;
  consentedAt: number;
};
/** A stored chat message: received after consent, with provenance and an expiry. */
export type ContextMessage = {
  channel: ChannelId;
  externalGroupId: string;
  messageId: string;
  eventId: string;
  externalUserId: string;
  principalId: string;
  text: string;
  textSha256: string;
  replyTo: string | null;
  sentAt: number;
  expiresAt: number;
};

/** Durable consented memory. Every method must be atomic on its own. */
export interface ChatContextStore {
  policy(
    channel: ChannelId,
    externalGroupId: string,
  ): Promise<ChatContextPolicy | null>;
  setPolicy(policy: ChatContextPolicy): Promise<void>;
  /** Ends memory for the chat: deletes its policy, consents and every stored message. */
  clearPolicy(channel: ChannelId, externalGroupId: string): Promise<number>;
  consent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ): Promise<ContextConsent | null>;
  grantConsent(consent: ContextConsent): Promise<void>;
  /** Withdraws consent and deletes that user's stored messages; returns how many. */
  revokeConsent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ): Promise<number>;
  /** Inserts once per (channel, chat, message id); true only when inserted. */
  storeMessage(message: ContextMessage): Promise<boolean>;
  /** Unexpired messages only, oldest first. */
  messages(
    channel: ChannelId,
    externalGroupId: string,
    now: number,
    limit: number,
  ): Promise<ContextMessage[]>;
  countMessages(
    channel: ChannelId,
    externalGroupId: string,
    now: number,
    externalUserId?: string,
  ): Promise<number>;
  /** Deletes every message whose retention has ended; returns how many. */
  purgeExpired(now: number): Promise<number>;
}

export type CaptureOutcome =
  | 'STORED'
  | 'DUPLICATE'
  | 'NOT_ENROLLED'
  | 'NOT_DISCLOSED'
  | 'NO_CONSENT'
  | 'NOT_STORABLE';

export const clampRetention = (seconds: number) =>
  Math.min(
    Math.max(Math.floor(seconds), CONTEXT_MIN_RETENTION_SECONDS),
    CONTEXT_MAX_RETENTION_SECONDS,
  );

/** Consent and retention rules over a ChatContextStore. */
export class ChatContextService {
  constructor(readonly store: ChatContextStore) {}

  async mode(
    channel: ChannelId,
    externalGroupId: string,
  ): Promise<Exclude<ContextMode, 'GUEST_ONE_SHOT'>> {
    const p = await this.store.policy(channel, externalGroupId);
    return p && p.disclosedAt !== null
      ? 'ENROLLED_CONTEXT'
      : 'ENROLLED_ON_DEMAND';
  }

  /**
   * Stores one received group message only when memory is on and disclosed
   * for the chat's current Synq group, and the sender (an active linked
   * member) opted in before sending it. Everything else is dropped.
   */
  async capture(input: {
    envelope: Envelope;
    groupId: string;
    /** The sender's active linked principal in this chat, or null. */
    principalId: string | null;
  }): Promise<CaptureOutcome> {
    const e = input.envelope;
    if (
      e.chatKind !== 'GROUP' ||
      e.verifiedSender.isBot ||
      !e.externalUserId ||
      !e.messageId ||
      !['TEXT', 'MENTION', 'REPLY_TO_BOT'].includes(e.interaction.kind) ||
      !e.body.trim()
    )
      return 'NOT_STORABLE';
    const policy = await this.store.policy(e.channel, e.externalGroupId);
    if (!policy || policy.groupId !== input.groupId) return 'NOT_ENROLLED';
    if (policy.disclosedAt === null || e.timestamp < policy.disclosedAt)
      return 'NOT_DISCLOSED';
    const consent = await this.store.consent(
      e.channel,
      e.externalGroupId,
      e.externalUserId,
    );
    if (
      !consent ||
      input.principalId === null ||
      consent.principalId !== input.principalId ||
      e.timestamp < consent.consentedAt
    )
      return 'NO_CONSENT';
    const stored = await this.store.storeMessage({
      channel: e.channel,
      externalGroupId: e.externalGroupId,
      messageId: e.messageId,
      eventId: e.eventId,
      externalUserId: e.externalUserId,
      principalId: consent.principalId,
      text: e.body.slice(0, MAX_STORED_CHARS),
      textSha256: createHash('sha256').update(e.body).digest('hex'),
      replyTo: e.replyTo,
      sentAt: e.timestamp,
      expiresAt: e.timestamp + policy.retentionSeconds,
    });
    return stored ? 'STORED' : 'DUPLICATE';
  }

  /** Stored context for an enrolled chat of `groupId`; empty otherwise. */
  async contextFor(input: {
    channel: ChannelId;
    externalGroupId: string;
    groupId: string;
    now: number;
    limit?: number;
  }): Promise<ContextMessage[]> {
    const policy = await this.store.policy(
      input.channel,
      input.externalGroupId,
    );
    if (
      !policy ||
      policy.groupId !== input.groupId ||
      policy.disclosedAt === null
    )
      return [];
    return this.store.messages(
      input.channel,
      input.externalGroupId,
      input.now,
      Math.min(input.limit ?? 50, 200),
    );
  }

  purge(now: number) {
    return this.store.purgeExpired(now);
  }
}

const key = (...parts: string[]) => parts.join('\u0000');

/** Test and development store; production uses PostgresChatContextStore. */
export class MemoryChatContextStore implements ChatContextStore {
  readonly policies = new Map<string, ChatContextPolicy>();
  readonly consents = new Map<string, ContextConsent>();
  readonly stored = new Map<string, ContextMessage>();

  async policy(channel: ChannelId, externalGroupId: string) {
    const p = this.policies.get(key(channel, externalGroupId));
    return p ? { ...p } : null;
  }
  async setPolicy(policy: ChatContextPolicy) {
    this.policies.set(key(policy.channel, policy.externalGroupId), {
      ...policy,
    });
  }
  async clearPolicy(channel: ChannelId, externalGroupId: string) {
    this.policies.delete(key(channel, externalGroupId));
    for (const [k, c] of this.consents)
      if (c.channel === channel && c.externalGroupId === externalGroupId)
        this.consents.delete(k);
    return this.drop(
      (m) => m.channel === channel && m.externalGroupId === externalGroupId,
    );
  }
  async consent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    const c = this.consents.get(key(channel, externalGroupId, externalUserId));
    return c ? { ...c } : null;
  }
  async grantConsent(consent: ContextConsent) {
    const k = key(
      consent.channel,
      consent.externalGroupId,
      consent.externalUserId,
    );
    if (!this.consents.has(k)) this.consents.set(k, { ...consent });
  }
  async revokeConsent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    this.consents.delete(key(channel, externalGroupId, externalUserId));
    return this.drop(
      (m) =>
        m.channel === channel &&
        m.externalGroupId === externalGroupId &&
        m.externalUserId === externalUserId,
    );
  }
  async storeMessage(message: ContextMessage) {
    const k = key(message.channel, message.externalGroupId, message.messageId);
    if (this.stored.has(k)) return false;
    this.stored.set(k, { ...message });
    return true;
  }
  async messages(
    channel: ChannelId,
    externalGroupId: string,
    now: number,
    limit: number,
  ) {
    return [...this.stored.values()]
      .filter(
        (m) =>
          m.channel === channel &&
          m.externalGroupId === externalGroupId &&
          m.expiresAt > now,
      )
      .sort((a, b) => a.sentAt - b.sentAt)
      .slice(-limit)
      .map((m) => ({ ...m }));
  }
  async countMessages(
    channel: ChannelId,
    externalGroupId: string,
    now: number,
    externalUserId?: string,
  ) {
    return (await this.messages(channel, externalGroupId, now, 1e9)).filter(
      (m) =>
        externalUserId === undefined || m.externalUserId === externalUserId,
    ).length;
  }
  async purgeExpired(now: number) {
    return this.drop((m) => m.expiresAt <= now);
  }
  private drop(match: (m: ContextMessage) => boolean) {
    let n = 0;
    for (const [k, m] of this.stored)
      if (match(m)) {
        this.stored.delete(k);
        n++;
      }
    return n;
  }
}
