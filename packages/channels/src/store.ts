import type { ChannelId } from './events.js';

export type LinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';
/** Chat → Synq group binding. PENDING until two distinct confirmed members vouch for it. */
export type GroupLink = {
  channel: ChannelId;
  externalGroupId: string;
  groupId: string;
  linkedByPrincipalId: string;
  linkedAt: number;
  status: LinkStatus;
};
/** Chat user → Synq principal, scoped to one chat. PENDING until confirmed in the user's private chat. */
export type UserLink = {
  channel: ChannelId;
  externalGroupId: string;
  externalUserId: string;
  principalId: string;
  linkedAt: number;
  status: LinkStatus;
  /** The chat user was a chat creator/administrator when they confirmed. */
  chatAdmin: boolean;
};
export type LinkCodeRecord = {
  codeHash: string;
  channel: ChannelId;
  externalGroupId: string;
  externalUserId: string;
  displayName: string | null;
  createdAt: number;
  expiresAt: number;
};
export type LinkCodeView = Omit<LinkCodeRecord, 'codeHash'> & {
  consumedAt: number | null;
};
export type RedeemOutcome =
  | { status: 'LINKED'; group: GroupLink; user: UserLink }
  | {
      status:
        | 'CODE_INVALID'
        | 'CODE_EXPIRED'
        | 'CODE_CONSUMED'
        | 'GROUP_LINK_CONFLICT'
        | 'USER_LINK_CONFLICT'
        | 'EXTERNAL_PROOF_REQUIRED'
        | 'EXTERNAL_IDENTITY_MISMATCH';
    };
export type DeliveryFailure = {
  channel: ChannelId;
  externalGroupId: string;
  reason: string;
  attempts: number;
  at: number;
};

/** Durable channel state. Every method must be atomic on its own. */
export interface ChannelStore {
  /**
   * Claims an inbound event for processing: true the first time, or when a
   * previous claim was released or its lease expired without completion.
   */
  claimEvent(
    channel: ChannelId,
    eventId: string,
    now: number,
    leaseSeconds: number,
  ): Promise<boolean>;
  completeEvent(
    channel: ChannelId,
    eventId: string,
    now: number,
  ): Promise<void>;
  releaseEvent(channel: ChannelId, eventId: string): Promise<void>;
  groupLink(
    channel: ChannelId,
    externalGroupId: string,
  ): Promise<GroupLink | null>;
  /** Active chat links only. */
  groupLinks(groupId?: string): Promise<GroupLink[]>;
  userLink(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ): Promise<UserLink | null>;
  createLinkCode(record: LinkCodeRecord): Promise<void>;
  linkCode(codeHash: string): Promise<LinkCodeView | null>;
  /** Marks an unexpired, unconsumed code consumed; true only for the first caller. */
  consumeLinkCode(codeHash: string, now: number): Promise<boolean>;
  /** Consumes the code; creates a PENDING user link (and a PENDING chat link if none). */
  redeemLinkCode(input: {
    codeHash: string;
    groupId: string;
    principalId: string;
    confirmTokenHash: string;
    now: number;
    /** A PENDING chat link created at or before this time is expired and may be replaced. */
    pendingExpiresBefore: number;
  }): Promise<RedeemOutcome>;
  /** Activates a PENDING user link when its own chat user presents the confirm token. */
  confirmUserLink(input: {
    channel: ChannelId;
    externalUserId: string;
    confirmTokenHash: string;
    now: number;
    chatAdmin: boolean;
  }): Promise<UserLink | null>;
  /** PENDING → ACTIVE once `minPrincipals` distinct confirmed members of the bound group exist. */
  activateGroupLink(
    channel: ChannelId,
    externalGroupId: string,
    minPrincipals: number,
    now: number,
    options: { requireChatAdmin: boolean; pendingExpiresBefore: number },
  ): Promise<GroupLink | null>;
  setChatAdmin(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
    chatAdmin: boolean,
  ): Promise<void>;
  /** Unlinks a chat: the chat link and every member link in that chat become REVOKED. */
  revokeGroupLink(
    channel: ChannelId,
    externalGroupId: string,
    at: number,
  ): Promise<GroupLink | null>;
  revokeUser(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
    at: number,
  ): Promise<void>;
  /** True only the first time the notification key is claimed for this chat. */
  claimNotification(
    channel: ChannelId,
    externalGroupId: string,
    key: string,
    at: number,
  ): Promise<boolean>;
  releaseNotification(
    channel: ChannelId,
    externalGroupId: string,
    key: string,
  ): Promise<void>;
  recordDeliveryFailure(failure: DeliveryFailure): Promise<void>;
}

const k = (...parts: string[]) => parts.join('\u0000');

/** Test and development store; production uses PostgresChannelStore. */
export class MemoryChannelStore implements ChannelStore {
  readonly events = new Map<
    string,
    { state: 'PROCESSING' | 'DONE'; at: number }
  >();
  readonly groups = new Map<string, GroupLink>();
  readonly users = new Map<
    string,
    UserLink & { confirmTokenHash: string | null }
  >();
  readonly codes = new Map<
    string,
    LinkCodeRecord & { consumedAt: number | null }
  >();
  readonly notifications = new Set<string>();
  readonly failures: DeliveryFailure[] = [];
  /** Test hook: throw from the next claim to simulate a database outage. */
  failNextClaim = false;

  async claimEvent(
    channel: ChannelId,
    eventId: string,
    now: number,
    lease: number,
  ) {
    if (this.failNextClaim) {
      this.failNextClaim = false;
      throw new Error('DATABASE_UNAVAILABLE');
    }
    const key = k(channel, eventId);
    const e = this.events.get(key);
    if (e && (e.state === 'DONE' || now - e.at < lease)) return false;
    this.events.set(key, { state: 'PROCESSING', at: now });
    return true;
  }
  async completeEvent(channel: ChannelId, eventId: string, now: number) {
    this.events.set(k(channel, eventId), { state: 'DONE', at: now });
  }
  async releaseEvent(channel: ChannelId, eventId: string) {
    const key = k(channel, eventId);
    if (this.events.get(key)?.state === 'PROCESSING') this.events.delete(key);
  }
  async groupLink(channel: ChannelId, externalGroupId: string) {
    const g = this.groups.get(k(channel, externalGroupId));
    return g ? { ...g } : null;
  }
  async groupLinks(groupId?: string) {
    return [...this.groups.values()].filter(
      (g) =>
        g.status === 'ACTIVE' &&
        (groupId === undefined || g.groupId === groupId),
    );
  }
  async userLink(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    const u = this.users.get(k(channel, externalGroupId, externalUserId));
    if (!u) return null;
    const { confirmTokenHash: _t, ...link } = u;
    return link;
  }
  async createLinkCode(record: LinkCodeRecord) {
    if (this.codes.has(record.codeHash)) throw new Error('LINK_CODE_EXISTS');
    this.codes.set(record.codeHash, { ...record, consumedAt: null });
  }
  async linkCode(codeHash: string) {
    const c = this.codes.get(codeHash);
    if (!c) return null;
    const { codeHash: _hash, ...view } = c;
    return view;
  }
  async consumeLinkCode(codeHash: string, now: number) {
    const c = this.codes.get(codeHash);
    if (!c || c.consumedAt !== null || c.expiresAt <= now) return false;
    c.consumedAt = now;
    return true;
  }
  async redeemLinkCode(input: {
    codeHash: string;
    groupId: string;
    principalId: string;
    confirmTokenHash: string;
    now: number;
    pendingExpiresBefore: number;
  }): Promise<RedeemOutcome> {
    const code = this.codes.get(input.codeHash);
    if (!code) return { status: 'CODE_INVALID' };
    if (code.consumedAt !== null) return { status: 'CODE_CONSUMED' };
    if (code.expiresAt <= input.now) return { status: 'CODE_EXPIRED' };
    const gKey = k(code.channel, code.externalGroupId);
    const uKey = k(code.channel, code.externalGroupId, code.externalUserId);
    const stored = this.groups.get(gKey);
    const existingGroup =
      stored?.status === 'PENDING' &&
      stored.linkedAt <= input.pendingExpiresBefore
        ? undefined
        : stored;
    if (
      existingGroup &&
      existingGroup.status !== 'REVOKED' &&
      existingGroup.groupId !== input.groupId
    )
      return { status: 'GROUP_LINK_CONFLICT' };
    const priorUser = this.users.get(uKey);
    const existingUser = stored && !existingGroup ? undefined : priorUser;
    if (
      existingUser &&
      existingUser.status !== 'REVOKED' &&
      existingUser.principalId !== input.principalId
    )
      return { status: 'USER_LINK_CONFLICT' };
    code.consumedAt = input.now;
    if (stored && !existingGroup)
      for (const u of this.users.values())
        if (
          u.channel === code.channel &&
          u.externalGroupId === code.externalGroupId
        ) {
          u.status = 'REVOKED';
          u.confirmTokenHash = null;
        }
    const group: GroupLink =
      existingGroup && existingGroup.status !== 'REVOKED'
        ? existingGroup
        : {
            channel: code.channel,
            externalGroupId: code.externalGroupId,
            groupId: input.groupId,
            linkedByPrincipalId: input.principalId,
            linkedAt: input.now,
            status: 'PENDING',
          };
    const user = {
      channel: code.channel,
      externalGroupId: code.externalGroupId,
      externalUserId: code.externalUserId,
      principalId: input.principalId,
      linkedAt: input.now,
      status:
        existingUser?.status === 'ACTIVE'
          ? ('ACTIVE' as const)
          : ('PENDING' as const),
      confirmTokenHash:
        existingUser?.status === 'ACTIVE' ? null : input.confirmTokenHash,
      chatAdmin:
        existingUser?.status === 'ACTIVE' ? existingUser.chatAdmin : false,
    };
    this.groups.set(gKey, group);
    this.users.set(uKey, user);
    const { confirmTokenHash: _t, ...link } = user;
    return { status: 'LINKED', group, user: link };
  }
  async confirmUserLink(input: {
    channel: ChannelId;
    externalUserId: string;
    confirmTokenHash: string;
    now: number;
    chatAdmin: boolean;
  }) {
    for (const u of this.users.values())
      if (
        u.channel === input.channel &&
        u.externalUserId === input.externalUserId &&
        u.status === 'PENDING' &&
        u.confirmTokenHash === input.confirmTokenHash
      ) {
        u.status = 'ACTIVE';
        u.chatAdmin = input.chatAdmin;
        u.confirmTokenHash = null;
        u.linkedAt = input.now;
        const { confirmTokenHash: _t, ...link } = u;
        return link;
      }
    return null;
  }
  async activateGroupLink(
    channel: ChannelId,
    externalGroupId: string,
    minPrincipals: number,
    _now: number,
    options: { requireChatAdmin: boolean; pendingExpiresBefore: number },
  ) {
    const g = this.groups.get(k(channel, externalGroupId));
    if (!g || g.status === 'REVOKED') return null;
    if (g.status === 'PENDING') {
      if (g.linkedAt <= options.pendingExpiresBefore) return { ...g };
      const active = [...this.users.values()].filter(
        (u) =>
          u.channel === channel &&
          u.externalGroupId === externalGroupId &&
          u.status === 'ACTIVE',
      );
      const principals = new Set(active.map((u) => u.principalId));
      if (
        principals.size >= minPrincipals &&
        (!options.requireChatAdmin || active.some((u) => u.chatAdmin))
      )
        g.status = 'ACTIVE';
    }
    return { ...g };
  }
  async setChatAdmin(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
    chatAdmin: boolean,
  ) {
    const u = this.users.get(k(channel, externalGroupId, externalUserId));
    if (u) u.chatAdmin = chatAdmin;
  }
  async revokeGroupLink(channel: ChannelId, externalGroupId: string) {
    const g = this.groups.get(k(channel, externalGroupId));
    if (!g) return null;
    g.status = 'REVOKED';
    for (const u of this.users.values())
      if (u.channel === channel && u.externalGroupId === externalGroupId) {
        u.status = 'REVOKED';
        u.confirmTokenHash = null;
      }
    return { ...g };
  }
  async revokeUser(
    channel: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    const u = this.users.get(k(channel, externalGroupId, externalUserId));
    if (u) u.status = 'REVOKED';
  }
  async claimNotification(
    channel: ChannelId,
    externalGroupId: string,
    key: string,
  ) {
    const id = k(channel, externalGroupId, key);
    if (this.notifications.has(id)) return false;
    this.notifications.add(id);
    return true;
  }
  async releaseNotification(
    channel: ChannelId,
    externalGroupId: string,
    key: string,
  ) {
    this.notifications.delete(k(channel, externalGroupId, key));
  }
  async recordDeliveryFailure(failure: DeliveryFailure) {
    this.failures.push(failure);
  }
}
