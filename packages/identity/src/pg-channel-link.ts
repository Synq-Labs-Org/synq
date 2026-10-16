import type { Address, Hex } from 'viem';
import {
  applyMigrations,
  withTransaction,
  type Migration,
  type SqlPool,
} from '@synq/domain/pg';
import type {
  ChannelLinkChallenge,
  ChannelLinkRecord,
  ChannelLinkStore,
  InsertLinkResult,
  LinkAuthority,
  LinkChannel,
  LinkPurpose,
  StoredChannelChallenge,
} from './channel-link.js';
import { IdentityError } from './errors.js';

/**
 * Postgres `ChannelLinkStore`. Own migrations table:
 * `synq_identity_link_migrations`.
 *
 * - A channel proof is accepted once (primary key on its hash).
 * - A challenge is consumed once (conditional update on `consumed_at`), and
 *   at most one live challenge per (workspace, channel, user, purpose) is
 *   issued (checked under a transaction-scoped advisory lock).
 * - One active link per channel id and per wallet: partial unique indexes,
 *   so two processes completing links concurrently cannot both win.
 */
export const IDENTITY_LINK_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_channel_link_challenges (
      challenge_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      channel text NOT NULL,
      channel_user_id text NOT NULL,
      purpose text NOT NULL,
      challenge jsonb NOT NULL,
      code_hash text,
      failed_attempts int NOT NULL DEFAULT 0,
      consumed_at bigint,
      expires_at bigint NOT NULL);
    CREATE INDEX IF NOT EXISTS synq_channel_link_challenges_pending
      ON synq_channel_link_challenges (workspace_id, channel, channel_user_id, purpose)
      WHERE consumed_at IS NULL;
    CREATE TABLE IF NOT EXISTS synq_channel_link_proofs (
      proof_hash text PRIMARY KEY,
      used_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS synq_channel_links (
      link_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      channel text NOT NULL,
      channel_user_id text NOT NULL,
      wallet text NOT NULL,
      record jsonb NOT NULL,
      unlinked_at bigint,
      unlinked_by text,
      unlink_signature text);
    CREATE UNIQUE INDEX IF NOT EXISTS synq_channel_links_one_per_user
      ON synq_channel_links (workspace_id, channel, channel_user_id) WHERE unlinked_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS synq_channel_links_one_per_wallet
      ON synq_channel_links (workspace_id, channel, lower(wallet)) WHERE unlinked_at IS NULL;`,
    down: `DROP TABLE IF EXISTS synq_channel_links;
    DROP TABLE IF EXISTS synq_channel_link_proofs;
    DROP TABLE IF EXISTS synq_channel_link_challenges;`,
  },
];

export const migrateIdentityLinks = (pool: SqlPool, target?: number) =>
  applyMigrations(
    pool,
    'synq_identity_link_migrations',
    IDENTITY_LINK_MIGRATIONS,
    target,
  );

const parse = <T>(raw: unknown): T =>
  (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;

const linkOf = (r: Record<string, unknown>): ChannelLinkRecord => {
  const base = parse<ChannelLinkRecord>(r.record);
  return Object.freeze({
    ...base,
    unlinkedAt: r.unlinked_at === null ? null : Number(r.unlinked_at),
    unlinkedBy: (r.unlinked_by as LinkAuthority | null) ?? null,
    unlinkSignature: (r.unlink_signature as Hex | null) ?? null,
  });
};

const LINK_COLUMNS = 'record, unlinked_at, unlinked_by, unlink_signature';

export class PostgresChannelLinkStore implements ChannelLinkStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateIdentityLinks(this.pool);
  }

  async insertChallenge(stored: StoredChannelChallenge) {
    const c = stored.challenge;
    await withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `synq_channel_link:${c.workspaceId}/${c.channel}/${c.channelUserId}/${c.purpose}`,
      ]);
      const pending = await tx.query(
        `SELECT 1 FROM synq_channel_link_challenges
         WHERE workspace_id=$1 AND channel=$2 AND channel_user_id=$3 AND purpose=$4
           AND consumed_at IS NULL AND expires_at > $5`,
        [c.workspaceId, c.channel, c.channelUserId, c.purpose, c.issuedAt],
      );
      if (pending.rows.length)
        throw new IdentityError(
          'RATE_LIMITED',
          'a challenge for this channel user is already pending',
        );
      const r = await tx.query(
        `INSERT INTO synq_channel_link_challenges
           (challenge_id, workspace_id, channel, channel_user_id, purpose, challenge, code_hash, failed_attempts, consumed_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING challenge_id`,
        [
          c.challengeId,
          c.workspaceId,
          c.channel,
          c.channelUserId,
          c.purpose,
          JSON.stringify(c),
          stored.codeHash,
          stored.failedAttempts,
          stored.consumedAt,
          c.expiresAt,
        ],
      );
      if (!r.rows.length)
        throw new IdentityError('CHALLENGE_MISMATCH', 'duplicate challenge id');
    });
  }

  async getChallenge(id: string): Promise<StoredChannelChallenge | null> {
    const r = await this.pool.query(
      `SELECT challenge, code_hash, failed_attempts, consumed_at
       FROM synq_channel_link_challenges WHERE challenge_id=$1`,
      [id],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      challenge: Object.freeze(parse<ChannelLinkChallenge>(x.challenge)),
      codeHash: (x.code_hash as Hex | null) ?? null,
      failedAttempts: Number(x.failed_attempts),
      consumedAt: x.consumed_at === null ? null : Number(x.consumed_at),
    };
  }

  async recordFailedCode(id: string) {
    const r = await this.pool.query(
      `UPDATE synq_channel_link_challenges SET failed_attempts = failed_attempts + 1
       WHERE challenge_id=$1 RETURNING failed_attempts`,
      [id],
    );
    // Unknown challenge: report the cap so the caller locks it out.
    return r.rows[0] ? Number(r.rows[0].failed_attempts) : 3;
  }

  async consumeChallenge(id: string, now: number) {
    const r = await this.pool.query(
      `UPDATE synq_channel_link_challenges SET consumed_at=$2
       WHERE challenge_id=$1 AND consumed_at IS NULL RETURNING challenge_id`,
      [id, now],
    );
    return r.rows.length > 0;
  }

  async pendingChallenge(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
    purpose: LinkPurpose,
    now: number,
  ) {
    const r = await this.pool.query(
      `SELECT challenge FROM synq_channel_link_challenges
       WHERE workspace_id=$1 AND channel=$2 AND channel_user_id=$3 AND purpose=$4
         AND consumed_at IS NULL AND expires_at > $5 LIMIT 1`,
      [workspaceId, channel, channelUserId, purpose, now],
    );
    return r.rows[0]
      ? Object.freeze(parse<ChannelLinkChallenge>(r.rows[0].challenge))
      : null;
  }

  async consumeProof(proofHash: Hex, now: number) {
    const r = await this.pool.query(
      `INSERT INTO synq_channel_link_proofs (proof_hash, used_at) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING proof_hash`,
      [proofHash.toLowerCase(), now],
    );
    return r.rows.length > 0;
  }

  async activeByChannel(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
  ) {
    const r = await this.pool.query(
      `SELECT ${LINK_COLUMNS} FROM synq_channel_links
       WHERE workspace_id=$1 AND channel=$2 AND channel_user_id=$3 AND unlinked_at IS NULL`,
      [workspaceId, channel, channelUserId],
    );
    return r.rows[0] ? linkOf(r.rows[0]) : null;
  }

  async activeByWallet(
    workspaceId: string,
    channel: LinkChannel,
    wallet: Address,
  ) {
    const r = await this.pool.query(
      `SELECT ${LINK_COLUMNS} FROM synq_channel_links
       WHERE workspace_id=$1 AND channel=$2 AND lower(wallet)=lower($3) AND unlinked_at IS NULL`,
      [workspaceId, channel, wallet],
    );
    return r.rows[0] ? linkOf(r.rows[0]) : null;
  }

  async insertLink(record: ChannelLinkRecord): Promise<InsertLinkResult> {
    const r = await this.pool.query(
      `INSERT INTO synq_channel_links (link_id, workspace_id, channel, channel_user_id, wallet, record)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING link_id`,
      [
        record.linkId,
        record.workspaceId,
        record.channel,
        record.channelUserId,
        record.wallet,
        JSON.stringify(record),
      ],
    );
    if (r.rows.length) return 'OK';
    return (await this.activeByChannel(
      record.workspaceId,
      record.channel,
      record.channelUserId,
    ))
      ? 'CHANNEL_LINKED'
      : 'WALLET_LINKED';
  }

  async endLink(
    linkId: string,
    now: number,
    by: LinkAuthority,
    signature: Hex | null,
  ) {
    const r = await this.pool.query(
      `UPDATE synq_channel_links SET unlinked_at=$2, unlinked_by=$3, unlink_signature=$4
       WHERE link_id=$1 AND unlinked_at IS NULL RETURNING link_id`,
      [linkId, now, by, signature],
    );
    return r.rows.length > 0;
  }

  async listLinks(workspaceId: string) {
    const r = await this.pool.query(
      `SELECT ${LINK_COLUMNS} FROM synq_channel_links WHERE workspace_id=$1 ORDER BY link_id`,
      [workspaceId],
    );
    return r.rows.map(linkOf);
  }
}
