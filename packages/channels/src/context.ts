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
  /** Bumped on every `/memory on`: consent is given to one version of the terms. */
  version: number;
  retentionSeconds: number;
  purpose: typeof CONTEXT_PURPOSE;
  /** What the bot can actually receive in this chat when memory was turned on. */
  visibility: ContextVisibility;
  enrolledByPrincipalId: string;
  enrolledAt: number;
  /** When the disclosure was posted in the chat; nothing is stored before it. */
  disclosedAt: number | null;
};
export type PolicyTerms = Omit<ChatContextPolicy, 'version' | 'disclosedAt'>;
export type ContextConsent = {
  channel: ChannelId;
  externalGroupId: string;
  externalUserId: string;
  principalId: string;
  /** The policy version the member agreed to; a new version needs a new opt-in. */
  policyVersion: number;
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
export type StoreOutcome = 'STORED' | 'DUPLICATE' | 'REFUSED';

/** Durable consented memory. Every method must be atomic on its own. */
export interface ChatContextStore {
  policy(
    channel: ChannelId,
    externalGroupId: string,
  ): Promise<ChatContextPolicy | null>;
  /**
   * New terms for the chat: the next version, not yet disclosed. Stored
   * messages are capped at sent time + the new retention, never extended.
   */
  enroll(terms: PolicyTerms): Promise<ChatContextPolicy>;
  /** Marks `version` disclosed; false when the terms changed meanwhile. */
  markDisclosed(
    channel: ChannelId,
    externalGroupId: string,
    version: number,
    at: number,
  ): Promise<boolean>;
  /** Ends memory for the chat: deletes its policy, consents and every stored message. Idempotent. */
  clearPolicy(channel: ChannelId, externalGroupId: string): Promise<number>;
  consent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ): Promise<ContextConsent | null>;
  /** Records (or renews, for a new policy version) the member's consent. */
  grantConsent(consent: ContextConsent): Promise<void>;
  /** Withdraws consent and deletes that user's stored messages; returns how many. */
  revokeConsent(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ): Promise<number>;
  /**
   * Inserts once per (channel, chat, message id), and only while the chat's
   * disclosed policy `guard` and the sender's consent to that version exist.
   * Atomic against revokeConsent, clearPolicy and enroll.
   */
  storeMessage(
    message: ContextMessage,
    guard: { groupId: string; policyVersion: number },
  ): Promise<StoreOutcome>;
  /**
   * Unexpired messages whose sender still consents, under a disclosed
   * policy and its current retention; oldest first.
   */
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
   * for the chat's current Synq group, and the sender (an active member of
   * that group, linked in this chat) agreed to the current terms before
   * sending it. Forwarded content is never stored. The store re-checks the
   * policy and consent atomically with the insert.
   */
  async capture(input: {
    envelope: Envelope;
    groupId: string;
    /** The sender's principal when linked here and an active group member; else null. */
    principalId: string | null;
  }): Promise<CaptureOutcome> {
    const e = input.envelope;
    if (
      e.chatKind !== 'GROUP' ||
      e.verifiedSender.isBot ||
      e.forwarded === true ||
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
      consent.policyVersion !== policy.version ||
      e.timestamp < consent.consentedAt
    )
      return 'NO_CONSENT';
    const stored = await this.store.storeMessage(
      {
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
      },
      { groupId: input.groupId, policyVersion: policy.version },
    );
    return stored === 'REFUSED' ? 'NO_CONSENT' : stored;
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
  async enroll(terms: PolicyTerms) {
    const k = key(terms.channel, terms.externalGroupId);
    const policy: ChatContextPolicy = {
      ...terms,
      version: (this.policies.get(k)?.version ?? 0) + 1,
      disclosedAt: null,
    };
    this.policies.set(k, policy);
    for (const m of this.stored.values())
      if (
        m.channel === terms.channel &&
        m.externalGroupId === terms.externalGroupId
      )
        m.expiresAt = Math.min(m.expiresAt, m.sentAt + terms.retentionSeconds);
    return { ...policy };
  }
  async markDisclosed(
    channel: ChannelId,
    externalGroupId: string,
    version: number,
    at: number,
  ) {
    const p = this.policies.get(key(channel, externalGroupId));
    if (!p || p.version !== version) return false;
    p.disclosedAt = at;
    return true;
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
    const prior = this.consents.get(k);
    if (!prior || prior.policyVersion !== consent.policyVersion)
      this.consents.set(k, { ...consent });
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
  async storeMessage(
    message: ContextMessage,
    guard: { groupId: string; policyVersion: number },
  ): Promise<StoreOutcome> {
    // No await between the checks and the insert: atomic in this process.
    const p = this.policies.get(key(message.channel, message.externalGroupId));
    const c = this.consents.get(
      key(message.channel, message.externalGroupId, message.externalUserId),
    );
    if (
      !p ||
      p.groupId !== guard.groupId ||
      p.version !== guard.policyVersion ||
      p.disclosedAt === null ||
      p.disclosedAt > message.sentAt ||
      !c ||
      c.principalId !== message.principalId ||
      c.policyVersion !== guard.policyVersion ||
      c.consentedAt > message.sentAt
    )
      return 'REFUSED';
    const k = key(message.channel, message.externalGroupId, message.messageId);
    if (this.stored.has(k)) return 'DUPLICATE';
    this.stored.set(k, { ...message });
    return 'STORED';
  }
  async messages(
    channel: ChannelId,
    externalGroupId: string,
    now: number,
    limit: number,
  ) {
    const p = this.policies.get(key(channel, externalGroupId));
    if (!p || p.disclosedAt === null) return [];
    return [...this.stored.values()]
      .filter(
        (m) =>
          m.channel === channel &&
          m.externalGroupId === externalGroupId &&
          Math.min(m.expiresAt, m.sentAt + p.retentionSeconds) > now &&
          this.consents.get(key(channel, externalGroupId, m.externalUserId))
            ?.principalId === m.principalId,
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
