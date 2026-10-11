import { FundingError } from './errors.js';
import { contentHash } from './canonical.js';
import {
  advanceSend,
  type SendPreview,
  type SendRecord,
  type SendState,
  type SendStore,
} from './send.js';
import { type FundingSession, type FundingSessionStore } from './session.js';
import {
  parseStoredFunding,
  parseStoredPreview,
  parseStoredSend,
} from './storage-schema.js';

type Row = Record<string, unknown>;
export interface FundingSqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(): void;
}
export interface FundingSqlPool {
  readonly options?: { max?: number };
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<FundingSqlClient>;
}
function conflict(error: unknown): never {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  )
    throw new FundingError(
      'IDEMPOTENCY_CONFLICT',
      'event or identity already claimed',
    );
  throw error;
}
async function transaction<T>(
  pool: FundingSqlPool,
  run: (c: FundingSqlClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await run(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    return conflict(e);
  } finally {
    c.release();
  }
}
function extendsHistory(before: readonly unknown[], after: readonly unknown[]) {
  if (
    after.length < before.length ||
    contentHash(after.slice(0, before.length)) !== contentHash(before)
  )
    throw new FundingError('IDEMPOTENCY_CONFLICT', 'stale history write');
}

export class PostgresFundingSessionStore implements FundingSessionStore {
  constructor(readonly pool: FundingSqlPool) {}
  async migrate() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS synq_funding_sessions (
      session_id text PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, group_id text NOT NULL,
      credit_id text UNIQUE, data jsonb NOT NULL)`);
  }
  async byKey(key: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_funding_sessions WHERE idempotency_key=$1',
      [key],
    );
    return r.rows[0] ? parseStoredFunding(r.rows[0].data) : null;
  }
  async get(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_funding_sessions WHERE session_id=$1',
      [id],
    );
    return r.rows[0] ? parseStoredFunding(r.rows[0].data) : null;
  }
  async open(raw: FundingSession) {
    const s = parseStoredFunding(raw);
    if (s.state !== 'QUOTED') throw new FundingError('INVALID_TRANSITION');
    return transaction(this.pool, async (c) => {
      await c.query(
        'INSERT INTO synq_funding_sessions (session_id,idempotency_key,group_id,data) VALUES($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING',
        [s.sessionId, s.idempotencyKey, s.groupId, JSON.stringify(s)],
      );
      const r = await c.query(
        'SELECT data FROM synq_funding_sessions WHERE idempotency_key=$1 FOR UPDATE',
        [s.idempotencyKey],
      );
      const existing = parseStoredFunding(r.rows[0]!.data);
      if (
        existing.groupId !== s.groupId ||
        contentHash(existing.quote) !== contentHash(s.quote)
      )
        throw new FundingError('IDEMPOTENCY_CONFLICT');
      return existing;
    });
  }
  async save(raw: FundingSession) {
    const s = parseStoredFunding(raw);
    await transaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT data FROM synq_funding_sessions WHERE session_id=$1 FOR UPDATE',
        [s.sessionId],
      );
      if (!r.rows[0]) throw new FundingError('INVALID_TRANSITION');
      const existing = parseStoredFunding(r.rows[0].data);
      if (
        existing.groupId !== s.groupId ||
        existing.idempotencyKey !== s.idempotencyKey ||
        contentHash(existing.quote) !== contentHash(s.quote)
      )
        throw new FundingError('IDEMPOTENCY_CONFLICT');
      extendsHistory(existing.history, s.history);
      await c.query(
        'UPDATE synq_funding_sessions SET data=$2,credit_id=$3 WHERE session_id=$1',
        [s.sessionId, JSON.stringify(s), s.creditId],
      );
    });
  }
  async list(groupId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_funding_sessions WHERE group_id=$1 ORDER BY session_id',
      [groupId],
    );
    return r.rows.map((x) => parseStoredFunding(x.data));
  }
}

const sendLockQueues = new WeakMap<FundingSqlPool, Promise<void>>();
export class PostgresSendStore implements SendStore {
  /** Callbacks query the shared pool, which must provide at least two connections. */
  constructor(readonly pool: FundingSqlPool) {
    if (pool.options?.max !== undefined && pool.options.max < 2)
      throw new Error('Send store requires pool capacity >= 2');
  }
  async withConfirmationLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const before = sendLockQueues.get(this.pool) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = before.then(() => gate);
    sendLockQueues.set(this.pool, queued);
    void queued.then(() => {
      if (sendLockQueues.get(this.pool) === queued)
        sendLockQueues.delete(this.pool);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        before,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new FundingError(
                  'IDEMPOTENCY_CONFLICT',
                  'confirmation queue is busy',
                ),
              ),
            30_000,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      return await this.lockedConfirmation(id, run);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }
  private async lockedConfirmation<T>(
    id: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const c = await this.pool.connect();
      let locked = false;
      try {
        const result = await c.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [id],
        );
        locked = result.rows[0]?.locked === true;
        if (locked) return await run();
      } finally {
        try {
          if (locked)
            await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
              id,
            ]);
        } finally {
          c.release();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new FundingError(
      'IDEMPOTENCY_CONFLICT',
      'confirmation is busy; reconcile before retry',
    );
  }
  async migrate() {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS synq_send_previews (preview_id text PRIMARY KEY,data jsonb NOT NULL)',
    );
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS synq_sends (send_id text PRIMARY KEY,
      preview_id text UNIQUE NOT NULL REFERENCES synq_send_previews(preview_id),
      group_id text NOT NULL, state text NOT NULL,intent_hash text UNIQUE,data jsonb NOT NULL)`);
  }
  async savePreview(raw: SendPreview) {
    const p = parseStoredPreview(raw);
    await this.pool.query(
      'INSERT INTO synq_send_previews (preview_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [p.previewId, JSON.stringify(p)],
    );
    if (contentHash(await this.preview(p.previewId)) !== contentHash(p))
      throw new FundingError('IDEMPOTENCY_CONFLICT');
  }
  async preview(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_send_previews WHERE preview_id=$1',
      [id],
    );
    return r.rows[0] ? parseStoredPreview(r.rows[0].data) : null;
  }
  async createOnce(raw: SendRecord) {
    const s = parseStoredSend(raw);
    if (s.state !== 'PREVIEWED') throw new FundingError('INVALID_TRANSITION');
    const r = await this.pool.query(
      'INSERT INTO synq_sends (send_id,preview_id,group_id,state,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING data',
      [
        s.sendId,
        s.preview.previewId,
        s.preview.groupId,
        s.state,
        JSON.stringify(s),
      ],
    );
    const record = r.rows[0]
      ? parseStoredSend(r.rows[0].data)
      : await this.get(s.sendId);
    if (!record || contentHash(record.preview) !== contentHash(s.preview))
      throw new FundingError('IDEMPOTENCY_CONFLICT');
    return { record, created: r.rows.length > 0 };
  }
  async claimConfirmation(id: string, at: number) {
    return transaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT data FROM synq_sends WHERE send_id=$1 FOR UPDATE',
        [id],
      );
      if (!r.rows[0]) return null;
      const existing = parseStoredSend(r.rows[0].data);
      if (existing.state !== 'PREVIEWED') return null;
      const claimed = advanceSend(
        existing,
        'CONFIRMING',
        at,
        'confirmation claimed',
        { confirmationProtocol: 2 },
      );
      await c.query('UPDATE synq_sends SET state=$2,data=$3 WHERE send_id=$1', [
        id,
        claimed.state,
        JSON.stringify(claimed),
      ]);
      return claimed;
    });
  }
  async releaseConfirmation(id: string, at: number) {
    await transaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT data FROM synq_sends WHERE send_id=$1 FOR UPDATE',
        [id],
      );
      if (!r.rows[0]) return;
      const record = parseStoredSend(r.rows[0].data);
      if (
        record.state !== 'CONFIRMING' ||
        record.confirmationProtocol !== 2 ||
        record.proposal !== null
      )
        return;
      const next = advanceSend(
        record,
        'PREVIEWED',
        at,
        'proposal failed before Kernel authorization',
      );
      await c.query('UPDATE synq_sends SET state=$2,data=$3 WHERE send_id=$1', [
        id,
        next.state,
        JSON.stringify(next),
      ]);
    });
  }
  async get(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_sends WHERE send_id=$1',
      [id],
    );
    return r.rows[0] ? parseStoredSend(r.rows[0].data) : null;
  }
  async byIntentHash(hash: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_sends WHERE intent_hash=$1',
      [hash],
    );
    return r.rows[0] ? parseStoredSend(r.rows[0].data) : null;
  }
  async inState(state: SendState) {
    const r = await this.pool.query(
      'SELECT data FROM synq_sends WHERE state=$1 ORDER BY send_id',
      [state],
    );
    return r.rows.map((x) => parseStoredSend(x.data));
  }
  async list(groupId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_sends WHERE group_id=$1',
      [groupId],
    );
    return r.rows.map((x) => parseStoredSend(x.data));
  }
  async save(raw: SendRecord) {
    const s = parseStoredSend(raw);
    await transaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT data FROM synq_sends WHERE send_id=$1 FOR UPDATE',
        [s.sendId],
      );
      if (!r.rows[0]) throw new FundingError('INVALID_TRANSITION');
      const existing = parseStoredSend(r.rows[0].data);
      if (contentHash(existing.preview) !== contentHash(s.preview))
        throw new FundingError('IDEMPOTENCY_CONFLICT');
      extendsHistory(existing.history, s.history);
      await c.query(
        'UPDATE synq_sends SET state=$2,intent_hash=$3,data=$4 WHERE send_id=$1',
        [s.sendId, s.state, s.intentHash, JSON.stringify(s)],
      );
    });
  }
}
