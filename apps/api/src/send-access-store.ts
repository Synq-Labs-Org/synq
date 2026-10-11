import { z } from 'zod';
import {
  SendAccessChallengeSchema,
  type SendAccessChallenge,
} from '@synq/identity/server';
import type { FundingSqlPool } from '@synq/funding';

const SessionSchema = z.strictObject({
  challenge: SendAccessChallengeSchema,
  expiresAt: z.number().int().nonnegative(),
});
export type SendAccessSession = z.output<typeof SessionSchema>;
export interface SendAccessStore {
  prune(now: number): Promise<void>;
  challenge(id: string): Promise<SendAccessChallenge | null>;
  createChallenge(challenge: SendAccessChallenge): Promise<SendAccessChallenge>;
  consumeChallenge(id: string): Promise<boolean>;
  saveSession(hash: string, session: SendAccessSession): Promise<void>;
  session(hash: string): Promise<SendAccessSession | null>;
}

/** Development and test fixture only. Production uses PostgresSendAccessStore. */
export class DevelopmentSendAccessStore implements SendAccessStore {
  private readonly challenges = new Map<string, SendAccessChallenge>();
  private readonly sessions = new Map<string, SendAccessSession>();
  async prune(now: number) {
    for (const [id, c] of this.challenges)
      if (c.expiresAt <= now) this.challenges.delete(id);
    for (const [id, s] of this.sessions)
      if (s.expiresAt <= now) this.sessions.delete(id);
  }
  async challenge(id: string) {
    return this.challenges.get(id) ?? null;
  }
  async createChallenge(c: SendAccessChallenge) {
    const existing = [...this.challenges.values()].find(
      (o) => o.groupId === c.groupId && o.memberId === c.memberId,
    );
    if (existing) return existing;
    this.challenges.set(c.challengeId, c);
    return c;
  }
  async consumeChallenge(id: string) {
    return this.challenges.delete(id);
  }
  async saveSession(hash: string, session: SendAccessSession) {
    this.sessions.set(hash, session);
  }
  async session(hash: string) {
    return this.sessions.get(hash) ?? null;
  }
}

export class PostgresSendAccessStore implements SendAccessStore {
  constructor(private readonly pool: FundingSqlPool) {}
  async migrate() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS synq_send_access_challenges (
      challenge_id text UNIQUE NOT NULL, group_id text NOT NULL, member_id text NOT NULL,
      expires_at bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY(group_id,member_id))`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS synq_send_access_sessions (
      token_hash text PRIMARY KEY, expires_at bigint NOT NULL, data jsonb NOT NULL)`);
  }
  async prune(now: number) {
    await this.pool.query(
      'DELETE FROM synq_send_access_challenges WHERE expires_at <= $1',
      [now],
    );
    await this.pool.query(
      'DELETE FROM synq_send_access_sessions WHERE expires_at <= $1',
      [now],
    );
  }
  async challenge(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_send_access_challenges WHERE challenge_id=$1',
      [id],
    );
    return r.rows[0] ? SendAccessChallengeSchema.parse(r.rows[0].data) : null;
  }
  async createChallenge(raw: SendAccessChallenge) {
    const c = SendAccessChallengeSchema.parse(raw);
    const r = await this.pool.query(
      `INSERT INTO synq_send_access_challenges(challenge_id,group_id,member_id,expires_at,data)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(group_id,member_id) DO UPDATE
      SET challenge_id=synq_send_access_challenges.challenge_id RETURNING data`,
      [c.challengeId, c.groupId, c.memberId, c.expiresAt, JSON.stringify(c)],
    );
    return SendAccessChallengeSchema.parse(r.rows[0]!.data);
  }
  async consumeChallenge(id: string) {
    const r = await this.pool.query(
      'DELETE FROM synq_send_access_challenges WHERE challenge_id=$1 RETURNING challenge_id',
      [id],
    );
    return r.rowCount === 1;
  }
  async saveSession(hash: string, raw: SendAccessSession) {
    const session = SessionSchema.parse(raw);
    await this.pool.query(
      'INSERT INTO synq_send_access_sessions(token_hash,expires_at,data) VALUES($1,$2,$3)',
      [hash, session.expiresAt, JSON.stringify(session)],
    );
  }
  async session(hash: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_send_access_sessions WHERE token_hash=$1',
      [hash],
    );
    return r.rows[0] ? SessionSchema.parse(r.rows[0].data) : null;
  }
}
