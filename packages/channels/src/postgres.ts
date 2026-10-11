import { ChannelIdSchema, type ChannelId } from './events.js';
import type {
  ChannelStore,
  DeliveryFailure,
  GroupLink,
  LinkCodeRecord,
  LinkCodeView,
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

const MIGRATION = `
CREATE TABLE IF NOT EXISTS synq_channel_event (
  channel text NOT NULL, event_id text NOT NULL, received_at bigint NOT NULL,
  PRIMARY KEY (channel, event_id));
CREATE TABLE IF NOT EXISTS synq_channel_group_link (
  channel text NOT NULL, external_group_id text NOT NULL, group_id text NOT NULL,
  linked_by_principal_id text NOT NULL, linked_at bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  PRIMARY KEY (channel, external_group_id));
CREATE INDEX IF NOT EXISTS synq_channel_group_link_group ON synq_channel_group_link (group_id);
CREATE TABLE IF NOT EXISTS synq_channel_user_link (
  channel text NOT NULL, external_user_id text NOT NULL, principal_id text NOT NULL,
  linked_at bigint NOT NULL, status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  PRIMARY KEY (channel, external_user_id));
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
const status = (v: unknown): 'ACTIVE' | 'REVOKED' =>
  v === 'ACTIVE' ? 'ACTIVE' : 'REVOKED';
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
  externalUserId: String(r.external_user_id),
  principalId: String(r.principal_id),
  linkedAt: Number(r.linked_at),
  status: status(r.status),
});

export class PostgresChannelStore implements ChannelStore {
  constructor(private readonly pool: ChannelSqlPool) {}

  async migrate() {
    await this.pool.query(MIGRATION);
  }
  async recordEvent(c: ChannelId, eventId: string, at: number) {
    const r = await this.pool.query(
      'INSERT INTO synq_channel_event (channel, event_id, received_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [c, eventId, at],
    );
    return r.rowCount === 1;
  }
  async groupLink(c: ChannelId, externalGroupId: string) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_group_link WHERE channel=$1 AND external_group_id=$2',
      [c, externalGroupId],
    );
    return r.rows[0] ? groupRow(r.rows[0]) : null;
  }
  async groupLinks(groupId?: string) {
    const r =
      groupId === undefined
        ? await this.pool.query(
            "SELECT * FROM synq_channel_group_link WHERE status='ACTIVE' ORDER BY linked_at",
          )
        : await this.pool.query(
            "SELECT * FROM synq_channel_group_link WHERE status='ACTIVE' AND group_id=$1 ORDER BY linked_at",
            [groupId],
          );
    return r.rows.map(groupRow);
  }
  async userLink(c: ChannelId, externalUserId: string) {
    const r = await this.pool.query(
      'SELECT * FROM synq_channel_user_link WHERE channel=$1 AND external_user_id=$2',
      [c, externalUserId],
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
  async redeemLinkCode(input: {
    codeHash: string;
    groupId: string;
    principalId: string;
    now: number;
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
      const externalGroupId = String(code.external_group_id);
      const externalUserId = String(code.external_user_id);
      const existingGroup = (
        await client.query(
          'SELECT * FROM synq_channel_group_link WHERE channel=$1 AND external_group_id=$2 FOR UPDATE',
          [c, externalGroupId],
        )
      ).rows[0];
      if (
        existingGroup?.status === 'ACTIVE' &&
        existingGroup.group_id !== input.groupId
      )
        return done({ status: 'GROUP_LINK_CONFLICT' });
      const existingUser = (
        await client.query(
          'SELECT * FROM synq_channel_user_link WHERE channel=$1 AND external_user_id=$2 FOR UPDATE',
          [c, externalUserId],
        )
      ).rows[0];
      if (
        existingUser?.status === 'ACTIVE' &&
        existingUser.principal_id !== input.principalId
      )
        return done({ status: 'USER_LINK_CONFLICT' });
      await client.query(
        'UPDATE synq_channel_link_code SET consumed_at=$2 WHERE code_hash=$1',
        [input.codeHash, input.now],
      );
      const group = (
        await client.query(
          `INSERT INTO synq_channel_group_link (channel, external_group_id, group_id, linked_by_principal_id, linked_at, status)
           VALUES ($1,$2,$3,$4,$5,'ACTIVE')
           ON CONFLICT (channel, external_group_id) DO UPDATE SET
             group_id=EXCLUDED.group_id, linked_by_principal_id=EXCLUDED.linked_by_principal_id,
             linked_at=EXCLUDED.linked_at, status='ACTIVE'
           WHERE synq_channel_group_link.status <> 'ACTIVE'
           RETURNING *`,
          [c, externalGroupId, input.groupId, input.principalId, input.now],
        )
      ).rows[0];
      const user = (
        await client.query(
          `INSERT INTO synq_channel_user_link (channel, external_user_id, principal_id, linked_at, status)
           VALUES ($1,$2,$3,$4,'ACTIVE')
           ON CONFLICT (channel, external_user_id) DO UPDATE SET
             principal_id=EXCLUDED.principal_id, linked_at=EXCLUDED.linked_at, status='ACTIVE'
           WHERE synq_channel_user_link.status <> 'ACTIVE'
           RETURNING *`,
          [c, externalUserId, input.principalId, input.now],
        )
      ).rows[0];
      await client.query('COMMIT');
      return {
        status: 'LINKED',
        group: groupRow(group ?? existingGroup!),
        user: userRow(user ?? existingUser!),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async revokeUser(c: ChannelId, externalUserId: string, _at?: number) {
    await this.pool.query(
      "UPDATE synq_channel_user_link SET status='REVOKED' WHERE channel=$1 AND external_user_id=$2",
      [c, externalUserId],
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
