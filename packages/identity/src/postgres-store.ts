import type { ChallengeStore, ApprovalChallenge } from './index.js';
import type { SqlConnection } from '@synq/read-model/storage';

export class PostgresChallengeStore implements ChallengeStore {
  constructor(readonly db: SqlConnection) {}
  async migrate(): Promise<void> {
    await this.db.query(
      'CREATE TABLE IF NOT EXISTS synq_approval_challenge (id text PRIMARY KEY, challenge_json jsonb NOT NULL, used boolean NOT NULL DEFAULT false)',
    );
  }
  async put(challenge: ApprovalChallenge): Promise<void> {
    await this.db.query(
      'INSERT INTO synq_approval_challenge(id,challenge_json) VALUES($1,$2)',
      [challenge.challengeId, JSON.stringify(challenge)],
    );
  }
  async get(id: string): Promise<ApprovalChallenge | null> {
    const result = await this.db.query(
      'SELECT challenge_json,used FROM synq_approval_challenge WHERE id=$1',
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          ...(row.challenge_json as ApprovalChallenge),
          used: row.used === true,
        }
      : null;
  }
  async consume(id: string): Promise<boolean> {
    const result = await this.db.query(
      'UPDATE synq_approval_challenge SET used=true WHERE id=$1 AND used=false RETURNING id',
      [id],
    );
    return result.rows.length === 1;
  }
}
