import type { ChannelId } from './events.js';

export type GroupLink = {
  channel: ChannelId;
  externalGroupId: string;
  groupId: string;
  linkedByPrincipalId: string;
  linkedAt: number;
  status: 'ACTIVE' | 'REVOKED';
};
export type UserLink = {
  channel: ChannelId;
  externalUserId: string;
  principalId: string;
  linkedAt: number;
  status: 'ACTIVE' | 'REVOKED';
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
  /** True only the first time (channel, eventId) is seen. */
  recordEvent(
    channel: ChannelId,
    eventId: string,
    at: number,
  ): Promise<boolean>;
  groupLink(
    channel: ChannelId,
    externalGroupId: string,
  ): Promise<GroupLink | null>;
  groupLinks(groupId?: string): Promise<GroupLink[]>;
  userLink(
    channel: ChannelId,
    externalUserId: string,
  ): Promise<UserLink | null>;
  createLinkCode(record: LinkCodeRecord): Promise<void>;
  linkCode(codeHash: string): Promise<LinkCodeView | null>;
  /** Marks an unexpired, unconsumed code consumed; true only for the first caller. */
  consumeLinkCode(codeHash: string, now: number): Promise<boolean>;
  redeemLinkCode(input: {
    codeHash: string;
    groupId: string;
    principalId: string;
    now: number;
  }): Promise<RedeemOutcome>;
  revokeUser(
    channel: ChannelId,
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
  readonly events = new Set<string>();
  readonly groups = new Map<string, GroupLink>();
  readonly users = new Map<string, UserLink>();
  readonly codes = new Map<
    string,
    LinkCodeRecord & { consumedAt: number | null }
  >();
  readonly notifications = new Set<string>();
  readonly failures: DeliveryFailure[] = [];

  async recordEvent(channel: ChannelId, eventId: string) {
    const key = k(channel, eventId);
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }
  async groupLink(channel: ChannelId, externalGroupId: string) {
    return this.groups.get(k(channel, externalGroupId)) ?? null;
  }
  async groupLinks(groupId?: string) {
    return [...this.groups.values()].filter(
      (g) =>
        g.status === 'ACTIVE' &&
        (groupId === undefined || g.groupId === groupId),
    );
  }
  async userLink(channel: ChannelId, externalUserId: string) {
    return this.users.get(k(channel, externalUserId)) ?? null;
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
    now: number;
  }): Promise<RedeemOutcome> {
    const code = this.codes.get(input.codeHash);
    if (!code) return { status: 'CODE_INVALID' };
    if (code.consumedAt !== null) return { status: 'CODE_CONSUMED' };
    if (code.expiresAt <= input.now) return { status: 'CODE_EXPIRED' };
    const gKey = k(code.channel, code.externalGroupId);
    const uKey = k(code.channel, code.externalUserId);
    const existingGroup = this.groups.get(gKey);
    if (
      existingGroup?.status === 'ACTIVE' &&
      existingGroup.groupId !== input.groupId
    )
      return { status: 'GROUP_LINK_CONFLICT' };
    const existingUser = this.users.get(uKey);
    if (
      existingUser?.status === 'ACTIVE' &&
      existingUser.principalId !== input.principalId
    )
      return { status: 'USER_LINK_CONFLICT' };
    code.consumedAt = input.now;
    const group: GroupLink =
      existingGroup?.status === 'ACTIVE'
        ? existingGroup
        : {
            channel: code.channel,
            externalGroupId: code.externalGroupId,
            groupId: input.groupId,
            linkedByPrincipalId: input.principalId,
            linkedAt: input.now,
            status: 'ACTIVE',
          };
    const user: UserLink =
      existingUser?.status === 'ACTIVE'
        ? existingUser
        : {
            channel: code.channel,
            externalUserId: code.externalUserId,
            principalId: input.principalId,
            linkedAt: input.now,
            status: 'ACTIVE',
          };
    this.groups.set(gKey, group);
    this.users.set(uKey, user);
    return { status: 'LINKED', group, user };
  }
  async revokeUser(channel: ChannelId, externalUserId: string) {
    const u = this.users.get(k(channel, externalUserId));
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
