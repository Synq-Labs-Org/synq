import { ChannelIdSchema, type ChannelId } from './events.js';
import {
  CONTEXT_PURPOSE,
  type ChatContextPolicy,
  type ChatContextStore,
  type ContextConsent,
  type ContextMessage,
  type PolicyTerms,
  type StoreOutcome,
} from './context.js';
import type {
  ChannelStore,
  DeliveryFailure,
  GroupLink,
  LinkCodeRecord,
  LinkCodeView,
  LinkStatus,
  RedeemOutcome,
  UserLink,
} from './store.js';

type Rows = { rows: Record<string, unknown>[]; rowCount: number | null };
export interface ChannelSqlClient {
  query(sql: string, values?: unknown[]): Promise<Rows>;
  release(): void;
}
export interface ChannelSqlPool {
  query(sql: string, values?: unknown[]): Promise<Rows>;
  connect(): Promise<ChannelSqlClient>;
}

/** v2 tables: per-chat member links, PENDING chat links and leased inbound claims. */
const MIGRATION = `
CREATE TABLE IF NOT EXISTS synq_channel_inbound (
  channel text NOT NULL, event_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PROCESSING','DONE')), updated_at bigint NOT NULL,
  PRIMARY KEY (channel, event_id));
CREATE TABLE IF NOT EXISTS synq_channel_chat_link (
  channel text NOT NULL, external_group_id text NOT NULL, group_id text NOT NULL,
  linked_by_principal_id text NOT NULL, linked_at bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  PRIMARY KEY (channel, external_group_id));
CREATE INDEX IF NOT EXISTS synq_channel_chat_link_group ON synq_channel_chat_link (group_id);
CREATE TABLE IF NOT EXISTS synq_channel_member_link (
  channel text NOT NULL, external_group_id text NOT NULL, external_user_id text NOT NULL,
  principal_id text NOT NULL, linked_at bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  confirm_token_hash text UNIQUE,
  PRIMARY KEY (channel, external_group_id, external_user_id));
ALTER TABLE synq_channel_member_link ADD COLUMN IF NOT EXISTS chat_admin boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS synq_channel_link_code (
  code_hash text PRIMARY KEY, channel text NOT NULL, external_group_id text NOT NULL,
  external_user_id text NOT NULL, display_name text, created_at bigint NOT NULL,
  expires_at bigint NOT NULL, consumed_at bigint);
CREATE TABLE IF NOT EXISTS synq_channel_notification (
  channel text NOT NULL, external_group_id text NOT NULL, key text NOT NULL,
  claimed_at bigint NOT NULL, PRIMARY KEY (channel, external_group_id, key));
CREATE TABLE IF NOT EXISTS synq_channel_delivery_failure (
  id bigserial PRIMARY KEY, channel text NOT NULL, external_group_id text NOT NULL,
  reason text NOT NULL, attempts integer NOT NULL, at bigint NOT NULL);
`;

const channel = (v: unknown): ChannelId => ChannelIdSchema.parse(v);
const status = (v: unknown): LinkStatus =>
  v === 'ACTIVE' ? 'ACTIVE' : v === 'PENDING' ? 'PENDING' : 'REVOKED';
const groupRow = (r: Record<string, unknown>): GroupLink => ({
  channel: channel(r.channel),
  externalGroupId: String(r.external_group_id),
  groupId: String(r.group_id),
  linkedByPrincipalId: String(r.linked_by_principal_id),
  linkedAt: Number(r.linked_at),
  status: status(r.status),
});
const userRow = (r: Record<string, unknown>): UserLink => ({
  channel: channel(r.channel),
  externalGroupId: String(r.external_group_id),
  externalUserId: String(r.external_user_id),
  principalId: String(r.principal_id),
  linkedAt: Number(r.linked_at),
  status: status(r.status),
  chatAdmin: r.chat_admin === true,
});

export class PostgresChannelStore implements ChannelStore {
  constructor(private readonly pool: ChannelSqlPool) {}

  async migrate() {
    await this.pool.query(MIGRATION);
  }
  private async tx<T>(run: (c: ChannelSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async claimEvent(c: ChannelId, eventId: string, now: number, lease: number) {
    const r = await this.pool.query(
      `INSERT INTO synq_channel_inbound (channel, event_id, state, updated_at) VALUES ($1,$2,'PROCESSING',$3)
       ON CONFLICT (channel, event_id) DO UPDATE SET state='PROCESSING', updated_at=EXCLUDED.updated_at
       WHERE synq_channel_inbound.state='PROCESSING' AND synq_channel_inbound.updated_at <= $4`,
      [c, eventId, now, now - lease],
    );
    return r.rowCount === 1;
  }
  async completeEvent(c: ChannelId, eventId: string, now: number) {
    await this.pool.query(
      "UPDATE synq_channel_inbound SET state='DONE', updated_at=$3 WHERE channel=$1 AND event_id=$2",
      [c, eventId, now],
    );
  }
  async releaseEvent(c: ChannelId, eventId: string) {
    await this.pool.query(
      "DELETE FROM synq_channel_inbound WHERE channel=$1 AND event_id=$2 AND state='PROCESSING'",
      [c, eventId],
    );
  }
  async groupLink(c: ChannelId, externalGroupId: string) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_chat_link WHERE channel=$1 AND external_group_id=$2',
      [c, externalGroupId],
    );
    return r.rows[0] ? groupRow(r.rows[0]) : null;
  }
  async groupLinks(groupId?: string) {
    const r =
      groupId === undefined
        ? await this.pool.query(
            "SELECT * FROM synq_channel_chat_link WHERE status='ACTIVE' ORDER BY linked_at",
          )
        : await this.pool.query(
            "SELECT * FROM synq_channel_chat_link WHERE status='ACTIVE' AND group_id=$1 ORDER BY linked_at",
            [groupId],
          );
    return r.rows.map(groupRow);
  }
  async userLink(
    c: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_member_link WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3',
      [c, externalGroupId, externalUserId],
    );
    return r.rows[0] ? userRow(r.rows[0]) : null;
  }
  async createLinkCode(record: LinkCodeRecord) {
    await this.pool.query(
      'INSERT INTO synq_channel_link_code (code_hash, channel, external_group_id, external_user_id, display_name, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        record.codeHash,
        record.channel,
        record.externalGroupId,
        record.externalUserId,
        record.displayName,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }
  async linkCode(codeHash: string): Promise<LinkCodeView | null> {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_link_code WHERE code_hash=$1',
      [codeHash],
    );
    const row = r.rows[0];
    return row
      ? {
          channel: channel(row.channel),
          externalGroupId: String(row.external_group_id),
          externalUserId: String(row.external_user_id),
          displayName:
            row.display_name === null ? null : String(row.display_name),
          createdAt: Number(row.created_at),
          expiresAt: Number(row.expires_at),
          consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
        }
      : null;
  }
  async consumeLinkCode(codeHash: string, now: number) {
    const r = await this.pool.query(
      'UPDATE synq_channel_link_code SET consumed_at=$2 WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at > $2',
      [codeHash, now],
    );
    return r.rowCount === 1;
  }
  async redeemLinkCode(input: {
    codeHash: string;
    groupId: string;
    principalId: string;
    confirmTokenHash: string;
    now: number;
    pendingExpiresBefore: number;
  }): Promise<RedeemOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const done = async (outcome: RedeemOutcome) => {
        await client.query(outcome.status === 'LINKED' ? 'COMMIT' : 'ROLLBACK');
        return outcome;
      };
      const code = (
        await client.query(
          'SELECT * FROM synq_channel_link_code WHERE code_hash=$1 FOR UPDATE',
          [input.codeHash],
        )
      ).rows[0];
      if (!code) return done({ status: 'CODE_INVALID' });
      if (code.consumed_at !== null) return done({ status: 'CODE_CONSUMED' });
      if (Number(code.expires_at) <= input.now)
        return done({ status: 'CODE_EXPIRED' });
      const c = channel(code.channel);
      const chat = String(code.external_group_id);
      const user = String(code.external_user_id);
      const storedGroup = (
        await client.query(
          'SELECT * FROM synq_channel_chat_link WHERE channel=$1 AND external_group_id=$2 FOR UPDATE',
          [c, chat],
        )
      ).rows[0];
      const existingGroup =
        storedGroup?.status === 'PENDING' &&
        Number(storedGroup.linked_at) <= input.pendingExpiresBefore
          ? undefined
          : storedGroup;
      if (
        existingGroup &&
        existingGroup.status !== 'REVOKED' &&
        existingGroup.group_id !== input.groupId
      )
        return done({ status: 'GROUP_LINK_CONFLICT' });
      if (storedGroup && !existingGroup)
        await client.query(
          "UPDATE synq_channel_member_link SET status='REVOKED', confirm_token_hash=NULL WHERE channel=$1 AND external_group_id=$2",
          [c, chat],
        );
      const existingUser = (
        await client.query(
          'SELECT * FROM synq_channel_member_link WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3 FOR UPDATE',
          [c, chat, user],
        )
      ).rows[0];
      if (
        existingUser &&
        existingUser.status !== 'REVOKED' &&
        existingUser.principal_id !== input.principalId
      )
        return done({ status: 'USER_LINK_CONFLICT' });
      await client.query(
        'UPDATE synq_channel_link_code SET consumed_at=$2 WHERE code_hash=$1',
        [input.codeHash, input.now],
      );
      const group =
        existingGroup && existingGroup.status !== 'REVOKED'
          ? existingGroup
          : (
              await client.query(
                `INSERT INTO synq_channel_chat_link (channel, external_group_id, group_id, linked_by_principal_id, linked_at, status)
                 VALUES ($1,$2,$3,$4,$5,'PENDING')
                 ON CONFLICT (channel, external_group_id) DO UPDATE SET group_id=EXCLUDED.group_id,
                   linked_by_principal_id=EXCLUDED.linked_by_principal_id, linked_at=EXCLUDED.linked_at, status='PENDING'
                 RETURNING *`,
                [c, chat, input.groupId, input.principalId, input.now],
              )
            ).rows[0]!;
      const member =
        existingUser?.status === 'ACTIVE'
          ? existingUser
          : (
              await client.query(
                `INSERT INTO synq_channel_member_link (channel, external_group_id, external_user_id, principal_id, linked_at, status, confirm_token_hash)
                 VALUES ($1,$2,$3,$4,$5,'PENDING',$6)
                 ON CONFLICT (channel, external_group_id, external_user_id) DO UPDATE SET principal_id=EXCLUDED.principal_id,
                   linked_at=EXCLUDED.linked_at, status='PENDING', confirm_token_hash=EXCLUDED.confirm_token_hash, chat_admin=false
                 RETURNING *`,
                [
                  c,
                  chat,
                  user,
                  input.principalId,
                  input.now,
                  input.confirmTokenHash,
                ],
              )
            ).rows[0]!;
      await client.query('COMMIT');
      return {
        status: 'LINKED',
        group: groupRow(group),
        user: userRow(member),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async confirmUserLink(input: {
    channel: ChannelId;
    externalUserId: string;
    confirmTokenHash: string;
    now: number;
    chatAdmin: boolean;
  }) {
    const r = await this.pool.query(
      `UPDATE synq_channel_member_link SET status='ACTIVE', confirm_token_hash=NULL, linked_at=$4, chat_admin=$5
       WHERE channel=$1 AND external_user_id=$2 AND confirm_token_hash=$3 AND status='PENDING' RETURNING *`,
      [
        input.channel,
        input.externalUserId,
        input.confirmTokenHash,
        input.now,
        input.chatAdmin,
      ],
    );
    return r.rows[0] ? userRow(r.rows[0]) : null;
  }
  async activateGroupLink(
    c: ChannelId,
    externalGroupId: string,
    minPrincipals: number,
    now: number,
    options: { requireChatAdmin: boolean; pendingExpiresBefore: number },
  ) {
    return this.tx(async (client) => {
      const g = (
        await client.query(
          'SELECT * FROM synq_channel_chat_link WHERE channel=$1 AND external_group_id=$2 FOR UPDATE',
          [c, externalGroupId],
        )
      ).rows[0];
      if (!g || g.status === 'REVOKED') return null;
      if (g.status === 'ACTIVE') return groupRow(g);
      if (Number(g.linked_at) <= options.pendingExpiresBefore)
        return groupRow(g);
      const counts = (
        await client.query(
          "SELECT count(DISTINCT principal_id)::int AS n, bool_or(chat_admin) AS admin FROM synq_channel_member_link WHERE channel=$1 AND external_group_id=$2 AND status='ACTIVE'",
          [c, externalGroupId],
        )
      ).rows[0]!;
      if (
        (counts.n as number) < minPrincipals ||
        (options.requireChatAdmin && counts.admin !== true)
      )
        return groupRow(g);
      const updated = (
        await client.query(
          "UPDATE synq_channel_chat_link SET status='ACTIVE', linked_at=$3 WHERE channel=$1 AND external_group_id=$2 RETURNING *",
          [c, externalGroupId, now],
        )
      ).rows[0]!;
      return groupRow(updated);
    });
  }
  async setChatAdmin(
    c: ChannelId,
    externalGroupId: string,
    externalUserId: string,
    chatAdmin: boolean,
  ) {
    await this.pool.query(
      'UPDATE synq_channel_member_link SET chat_admin=$4 WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3',
      [c, externalGroupId, externalUserId, chatAdmin],
    );
  }
  async revokeGroupLink(c: ChannelId, externalGroupId: string, at: number) {
    return this.tx(async (client) => {
      const g = (
        await client.query(
          "UPDATE synq_channel_chat_link SET status='REVOKED', linked_at=$3 WHERE channel=$1 AND external_group_id=$2 RETURNING *",
          [c, externalGroupId, at],
        )
      ).rows[0];
      await client.query(
        "UPDATE synq_channel_member_link SET status='REVOKED', confirm_token_hash=NULL WHERE channel=$1 AND external_group_id=$2",
        [c, externalGroupId],
      );
      return g ? groupRow(g) : null;
    });
  }
  async revokeUser(
    c: ChannelId,
    externalGroupId: string,
    externalUserId: string,
    _at?: number,
  ) {
    await this.pool.query(
      "UPDATE synq_channel_member_link SET status='REVOKED', confirm_token_hash=NULL WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3",
      [c, externalGroupId, externalUserId],
    );
  }
  async claimNotification(
    c: ChannelId,
    externalGroupId: string,
    key: string,
    at: number,
  ) {
    const r = await this.pool.query(
      'INSERT INTO synq_channel_notification (channel, external_group_id, key, claimed_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [c, externalGroupId, key, at],
    );
    return r.rowCount === 1;
  }
  async releaseNotification(
    c: ChannelId,
    externalGroupId: string,
    key: string,
  ) {
    await this.pool.query(
      'DELETE FROM synq_channel_notification WHERE channel=$1 AND external_group_id=$2 AND key=$3',
      [c, externalGroupId, key],
    );
  }
  async recordDeliveryFailure(f: DeliveryFailure) {
    await this.pool.query(
      'INSERT INTO synq_channel_delivery_failure (channel, external_group_id, reason, attempts, at) VALUES ($1,$2,$3,$4,$5)',
      [f.channel, f.externalGroupId, f.reason.slice(0, 500), f.attempts, f.at],
    );
  }
}

/** Consented chat memory: per-chat versioned policy, per-user consent and expiring messages. */
const CONTEXT_MIGRATION = `
CREATE TABLE IF NOT EXISTS synq_channel_context_policy (
  channel text NOT NULL, external_group_id text NOT NULL, group_id text NOT NULL,
  retention_seconds integer NOT NULL CHECK (retention_seconds > 0),
  purpose text NOT NULL, visibility text NOT NULL CHECK (visibility IN ('ALL_MESSAGES','ADDRESSED_ONLY')),
  enrolled_by_principal_id text NOT NULL, enrolled_at bigint NOT NULL, disclosed_at bigint,
  PRIMARY KEY (channel, external_group_id));
ALTER TABLE synq_channel_context_policy ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS synq_channel_context_consent (
  channel text NOT NULL, external_group_id text NOT NULL, external_user_id text NOT NULL,
  principal_id text NOT NULL, consented_at bigint NOT NULL,
  PRIMARY KEY (channel, external_group_id, external_user_id));
ALTER TABLE synq_channel_context_consent ADD COLUMN IF NOT EXISTS policy_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS synq_channel_context_message (
  channel text NOT NULL, external_group_id text NOT NULL, message_id text NOT NULL,
  event_id text NOT NULL, external_user_id text NOT NULL, principal_id text NOT NULL,
  text text NOT NULL, text_sha256 text NOT NULL, reply_to text,
  sent_at bigint NOT NULL, expires_at bigint NOT NULL,
  PRIMARY KEY (channel, external_group_id, message_id));
CREATE INDEX IF NOT EXISTS synq_channel_context_message_expiry ON synq_channel_context_message (expires_at);
`;

const policyRow = (r: Record<string, unknown>): ChatContextPolicy => ({
  channel: channel(r.channel),
  externalGroupId: String(r.external_group_id),
  groupId: String(r.group_id),
  version: Number(r.version),
  retentionSeconds: Number(r.retention_seconds),
  purpose: CONTEXT_PURPOSE,
  visibility:
    r.visibility === 'ALL_MESSAGES' ? 'ALL_MESSAGES' : 'ADDRESSED_ONLY',
  enrolledByPrincipalId: String(r.enrolled_by_principal_id),
  enrolledAt: Number(r.enrolled_at),
  disclosedAt: r.disclosed_at === null ? null : Number(r.disclosed_at),
});
const contextRow = (r: Record<string, unknown>): ContextMessage => ({
  channel: channel(r.channel),
  externalGroupId: String(r.external_group_id),
  messageId: String(r.message_id),
  eventId: String(r.event_id),
  externalUserId: String(r.external_user_id),
  principalId: String(r.principal_id),
  text: String(r.text),
  textSha256: String(r.text_sha256),
  replyTo: r.reply_to === null ? null : String(r.reply_to),
  sentAt: Number(r.sent_at),
  expiresAt: Number(r.expires_at),
});

/**
 * Readable rows: the sender still consents (same principal), the chat's
 * policy is disclosed, and neither the stored expiry nor the current
 * retention has passed.
 */
const READABLE = `FROM synq_channel_context_message m
  JOIN synq_channel_context_policy p ON p.channel=m.channel AND p.external_group_id=m.external_group_id AND p.disclosed_at IS NOT NULL
  JOIN synq_channel_context_consent c ON c.channel=m.channel AND c.external_group_id=m.external_group_id
    AND c.external_user_id=m.external_user_id AND c.principal_id=m.principal_id
  WHERE m.channel=$1 AND m.external_group_id=$2 AND LEAST(m.expires_at, m.sent_at + p.retention_seconds) > $3`;

/**
 * Lock order everywhere: policy row, then consent row, then messages.
 * storeMessage holds FOR SHARE on both while it inserts, so a concurrent
 * opt-out, memory off or re-enrollment either waits for the insert (and
 * then deletes or caps it) or wins and the insert is refused.
 */
export class PostgresChatContextStore implements ChatContextStore {
  constructor(private readonly pool: ChannelSqlPool) {}

  async migrate() {
    await this.pool.query(CONTEXT_MIGRATION);
  }
  private async tx<T>(run: (c: ChannelSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async policy(c: ChannelId, externalGroupId: string) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_context_policy WHERE channel=$1 AND external_group_id=$2',
      [c, externalGroupId],
    );
    return r.rows[0] ? policyRow(r.rows[0]) : null;
  }
  async enroll(t: PolicyTerms) {
    return this.tx(async (client) => {
      const r = await client.query(
        `INSERT INTO synq_channel_context_policy (channel, external_group_id, group_id, retention_seconds, purpose, visibility, enrolled_by_principal_id, enrolled_at, disclosed_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,1)
         ON CONFLICT (channel, external_group_id) DO UPDATE SET group_id=EXCLUDED.group_id,
           retention_seconds=EXCLUDED.retention_seconds, purpose=EXCLUDED.purpose, visibility=EXCLUDED.visibility,
           enrolled_by_principal_id=EXCLUDED.enrolled_by_principal_id, enrolled_at=EXCLUDED.enrolled_at,
           disclosed_at=NULL, version=synq_channel_context_policy.version + 1
         RETURNING *`,
        [
          t.channel,
          t.externalGroupId,
          t.groupId,
          t.retentionSeconds,
          t.purpose,
          t.visibility,
          t.enrolledByPrincipalId,
          t.enrolledAt,
        ],
      );
      await client.query(
        'UPDATE synq_channel_context_message SET expires_at = LEAST(expires_at, sent_at + $3) WHERE channel=$1 AND external_group_id=$2',
        [t.channel, t.externalGroupId, t.retentionSeconds],
      );
      return policyRow(r.rows[0]!);
    });
  }
  async markDisclosed(
    c: ChannelId,
    externalGroupId: string,
    version: number,
    at: number,
  ) {
    const r = await this.pool.query(
      'UPDATE synq_channel_context_policy SET disclosed_at=$4 WHERE channel=$1 AND external_group_id=$2 AND version=$3',
      [c, externalGroupId, version, at],
    );
    return r.rowCount === 1;
  }
  async clearPolicy(c: ChannelId, externalGroupId: string) {
    return this.tx(async (client) => {
      const args = [c, externalGroupId];
      await client.query(
        'DELETE FROM synq_channel_context_policy WHERE channel=$1 AND external_group_id=$2',
        args,
      );
      await client.query(
        'DELETE FROM synq_channel_context_consent WHERE channel=$1 AND external_group_id=$2',
        args,
      );
      const r = await client.query(
        'DELETE FROM synq_channel_context_message WHERE channel=$1 AND external_group_id=$2',
        args,
      );
      return r.rowCount ?? 0;
    });
  }
  async consent(c: ChannelId, externalGroupId: string, externalUserId: string) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_context_consent WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3',
      [c, externalGroupId, externalUserId],
    );
    const row = r.rows[0];
    return row
      ? ({
          channel: channel(row.channel),
          externalGroupId: String(row.external_group_id),
          externalUserId: String(row.external_user_id),
          principalId: String(row.principal_id),
          policyVersion: Number(row.policy_version),
          consentedAt: Number(row.consented_at),
        } satisfies ContextConsent)
      : null;
  }
  async grantConsent(x: ContextConsent) {
    await this.pool.query(
      `INSERT INTO synq_channel_context_consent (channel, external_group_id, external_user_id, principal_id, consented_at, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (channel, external_group_id, external_user_id) DO UPDATE SET
         principal_id=EXCLUDED.principal_id, consented_at=EXCLUDED.consented_at, policy_version=EXCLUDED.policy_version
       WHERE synq_channel_context_consent.policy_version <> EXCLUDED.policy_version`,
      [
        x.channel,
        x.externalGroupId,
        x.externalUserId,
        x.principalId,
        x.consentedAt,
        x.policyVersion,
      ],
    );
  }
  async revokeConsent(
    c: ChannelId,
    externalGroupId: string,
    externalUserId: string,
  ) {
    return this.tx(async (client) => {
      const args = [c, externalGroupId, externalUserId];
      await client.query(
        'DELETE FROM synq_channel_context_consent WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3',
        args,
      );
      const r = await client.query(
        'DELETE FROM synq_channel_context_message WHERE channel=$1 AND external_group_id=$2 AND external_user_id=$3',
        args,
      );
      return r.rowCount ?? 0;
    });
  }
  async storeMessage(
    m: ContextMessage,
    guard: { groupId: string; policyVersion: number },
  ): Promise<StoreOutcome> {
    return this.tx(async (client) => {
      const policy = await client.query(
        `SELECT 1 FROM synq_channel_context_policy WHERE channel=$1 AND external_group_id=$2
           AND group_id=$3 AND version=$4 AND disclosed_at IS NOT NULL AND disclosed_at <= $5 FOR SHARE`,
        [
          m.channel,
          m.externalGroupId,
          guard.groupId,
          guard.policyVersion,
          m.sentAt,
        ],
      );
      if (!policy.rows.length) return 'REFUSED';
      const consent = await client.query(
        `SELECT 1 FROM synq_channel_context_consent WHERE channel=$1 AND external_group_id=$2
           AND external_user_id=$3 AND principal_id=$4 AND policy_version=$5 AND consented_at <= $6 FOR SHARE`,
        [
          m.channel,
          m.externalGroupId,
          m.externalUserId,
          m.principalId,
          guard.policyVersion,
          m.sentAt,
        ],
      );
      if (!consent.rows.length) return 'REFUSED';
      const r = await client.query(
        `INSERT INTO synq_channel_context_message (channel, external_group_id, message_id, event_id, external_user_id, principal_id, text, text_sha256, reply_to, sent_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [
          m.channel,
          m.externalGroupId,
          m.messageId,
          m.eventId,
          m.externalUserId,
          m.principalId,
          m.text,
          m.textSha256,
          m.replyTo,
          m.sentAt,
          m.expiresAt,
        ],
      );
      return r.rowCount === 1 ? 'STORED' : 'DUPLICATE';
    });
  }
  async messages(
    c: ChannelId,
    externalGroupId: string,
    now: number,
    limit: number,
  ) {
    const r = await this.pool.query(
      `SELECT * FROM (SELECT m.* ${READABLE}
         ORDER BY m.sent_at DESC, m.message_id DESC LIMIT $4) recent ORDER BY sent_at, message_id`,
      [c, externalGroupId, now, limit],
    );
    return r.rows.map(contextRow);
  }
  async countMessages(
    c: ChannelId,
    externalGroupId: string,
    now: number,
    externalUserId?: string,
  ) {
    const r = await this.pool.query(
      `SELECT count(*)::int AS n ${READABLE} AND ($4::text IS NULL OR m.external_user_id=$4)`,
      [c, externalGroupId, now, externalUserId ?? null],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  async purgeExpired(now: number) {
    const r = await this.pool.query(
      'DELETE FROM synq_channel_context_message WHERE expires_at <= $1',
      [now],
    );
    return r.rowCount ?? 0;
  }
}
