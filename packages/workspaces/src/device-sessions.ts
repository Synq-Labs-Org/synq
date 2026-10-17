import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Hex } from 'viem';
import { z } from 'zod';
import { WorkspaceError } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * Device sessions for the native app (and any client that wants refresh).
 * Sign-in still proves wallet ownership with the login challenge; it never
 * approves money. Each device holds a short access token (a normal
 * synq_ws_sessions row, so every existing route accepts it) and a refresh
 * token that rotates on every use. Presenting a refresh token that was already
 * rotated away revokes the device session: someone else may hold a copy.
 */

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const token = () => randomBytes(32).toString('hex');

export const ACCESS_TTL = 900;
export const REFRESH_TTL = 30 * 24 * 3600;

const Device = z.strictObject({
  deviceId: z.uuid(),
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['ios', 'web']),
});
const Signed = z.strictObject({
  challengeId: z.uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  device: Device,
});
const Code = z.strictObject({
  code: z.string().regex(/^[0-9a-f]{48}$/),
  device: Device,
});
const Refresh = z.strictObject({
  deviceId: z.uuid(),
  refreshToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export class WorkspaceDeviceSessions {
  constructor(private readonly store: PostgresWorkspaceStore) {}

  private now() {
    return this.store.now();
  }

  /** Sign in with a native login challenge signed by the wallet. */
  async fromSignature(raw: unknown) {
    const body = Signed.parse(raw);
    const verified = await this.store.verifyLogin(
      body.challengeId,
      body.signature as Hex,
    );
    if (verified.challenge.audience !== 'native')
      throw new WorkspaceError('NATIVE_CHALLENGE_REQUIRED', 401);
    return this.store.transaction(async (sql) => {
      await this.store.consumeChallenge(sql, verified);
      return this.open(sql, verified.principalId, body.device);
    });
  }

  /** Sign in with a one-time code made by a signed-in web session. */
  async fromCode(raw: unknown) {
    const body = Code.parse(raw);
    return this.store.transaction(async (sql) => {
      const r = await sql.query(
        'UPDATE synq_ws_native_handoffs SET used_at=$2 WHERE digest=$1 AND used_at IS NULL AND expires_at>$2 RETURNING principal_id',
        [digest(body.code), this.now()],
      );
      if (!r.rows[0]) throw new WorkspaceError('INVALID_NATIVE_CODE', 401);
      return this.open(sql, String(r.rows[0].principal_id), body.device);
    });
  }

  private async open(
    sql: PoolClient,
    principalId: string,
    device: z.infer<typeof Device>,
  ) {
    const now = this.now();
    // One live session per device: signing in again replaces the old one.
    const old = await sql.query(
      'UPDATE synq_ws_device_sessions SET revoked_at=$3 WHERE principal_id=$1 AND device_id=$2 AND revoked_at IS NULL RETURNING id',
      [principalId, device.deviceId, now],
    );
    for (const o of old.rows)
      await sql.query(
        'DELETE FROM synq_ws_sessions WHERE device_session_id=$1',
        [o.id],
      );
    const sessionId = randomUUID();
    const refreshToken = token();
    await sql.query(
      'INSERT INTO synq_ws_device_sessions(id,principal_id,device_id,device_name,platform,refresh_digest,refresh_expires_at,created_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [
        sessionId,
        principalId,
        device.deviceId,
        device.name,
        device.platform,
        digest(refreshToken),
        now + REFRESH_TTL,
        now,
      ],
    );
    return this.issue(sql, principalId, sessionId, refreshToken, now);
  }

  private async issue(
    sql: PoolClient,
    principalId: string,
    sessionId: string,
    refreshToken: string,
    now: number,
  ) {
    const accessToken = token();
    await sql.query(
      "INSERT INTO synq_ws_sessions(digest,principal_id,audience,expires_at,device_session_id) VALUES($1,$2,'native',$3,$4)",
      [digest(accessToken), principalId, now + ACCESS_TTL, sessionId],
    );
    return {
      principalId,
      sessionId,
      accessToken,
      accessExpiresAt: iso(now + ACCESS_TTL),
      refreshToken,
      refreshExpiresAt: iso(now + REFRESH_TTL),
    };
  }

  /** Rotates the refresh token; the previous access token stops working. */
  async refresh(raw: unknown) {
    const body = Refresh.parse(raw);
    const presented = digest(body.refreshToken);
    const result = await this.store.transaction(async (sql) => {
      const now = this.now();
      const r = await sql.query(
        'SELECT id,principal_id FROM synq_ws_device_sessions WHERE refresh_digest=$1 AND device_id=$2 AND revoked_at IS NULL AND refresh_expires_at>$3 FOR UPDATE',
        [presented, body.deviceId, now],
      );
      const s = r.rows[0];
      if (!s) {
        const reused = await sql.query(
          'SELECT session_id FROM synq_ws_refresh_used WHERE digest=$1',
          [presented],
        );
        if (reused.rows[0]) {
          await this.revoke(sql, String(reused.rows[0].session_id), now);
          return 'REUSED' as const;
        }
        return 'INVALID' as const;
      }
      const next = token();
      await sql.query(
        'INSERT INTO synq_ws_refresh_used(digest,session_id,used_at) VALUES($1,$2,$3)',
        [presented, s.id, now],
      );
      await sql.query(
        'UPDATE synq_ws_device_sessions SET refresh_digest=$2, refresh_expires_at=$3, last_seen_at=$4 WHERE id=$1',
        [s.id, digest(next), now + REFRESH_TTL, now],
      );
      await sql.query(
        'DELETE FROM synq_ws_sessions WHERE device_session_id=$1',
        [s.id],
      );
      return this.issue(sql, String(s.principal_id), String(s.id), next, now);
    });
    // The revocation above must commit, so the error is raised afterwards.
    if (result === 'REUSED') throw new WorkspaceError('SESSION_REVOKED', 401);
    if (result === 'INVALID') throw new WorkspaceError('UNAUTHENTICATED', 401);
    return result;
  }

  private async revoke(sql: PoolClient, sessionId: string, now: number) {
    await sql.query(
      'UPDATE synq_ws_device_sessions SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL',
      [sessionId, now],
    );
    await sql.query('DELETE FROM synq_ws_sessions WHERE device_session_id=$1', [
      sessionId,
    ]);
    await this.dropPush(sql, 'device_session_id', sessionId, now);
  }

  /**
   * Push tokens registered by a signed-out session stop receiving pushes, and
   * their queued deliveries are skipped. (The notification tables belong to a
   * separate module that may not be installed.)
   */
  private async dropPush(
    sql: PoolClient,
    column: 'device_session_id' | 'principal_id',
    value: string,
    now: number,
  ) {
    const exists = await sql.query(
      "SELECT to_regclass('synq_device_push_tokens') AS t",
    );
    if (!exists.rows[0]?.t) return;
    const gone = await sql.query(
      `UPDATE synq_device_push_tokens SET revoked_at=$2 WHERE ${column}::text=$1 AND revoked_at IS NULL RETURNING device_id`,
      [value, now],
    );
    if (gone.rowCount)
      await sql.query(
        "UPDATE synq_push_deliveries SET state='SKIPPED', updated_at=$2 WHERE state='PENDING' AND device_id = ANY($1::uuid[])",
        [gone.rows.map((r) => String(r.device_id)), now],
      );
  }

  /** Ends the caller's session: its device session too, when it has one. */
  async logout(accessToken: string, deviceSessionId: string | null) {
    await this.store.transaction(async (sql) => {
      await sql.query('DELETE FROM synq_ws_sessions WHERE digest=$1', [
        digest(accessToken),
      ]);
      if (deviceSessionId) await this.revoke(sql, deviceSessionId, this.now());
    });
    return { ok: true as const };
  }

  /** Ends every session of the principal, web and native. */
  async revokeAll(principalId: string) {
    return this.store.transaction(async (sql) => {
      const devices = await sql.query(
        'UPDATE synq_ws_device_sessions SET revoked_at=$2 WHERE principal_id=$1 AND revoked_at IS NULL RETURNING id',
        [principalId, this.now()],
      );
      const plain = await sql.query(
        'DELETE FROM synq_ws_sessions WHERE principal_id=$1 AND device_session_id IS NULL',
        [principalId],
      );
      await sql.query('DELETE FROM synq_ws_sessions WHERE principal_id=$1', [
        principalId,
      ]);
      await this.dropPush(sql, 'principal_id', principalId, this.now());
      return { revoked: devices.rowCount! + plain.rowCount! };
    });
  }

  async list(principalId: string, current: string | null) {
    const r = await this.store.pool.query(
      'SELECT id,device_name,platform,created_at,last_seen_at FROM synq_ws_device_sessions WHERE principal_id=$1 AND revoked_at IS NULL AND refresh_expires_at>$2 ORDER BY last_seen_at DESC',
      [principalId, this.now()],
    );
    return {
      sessions: r.rows.map((s) => ({
        sessionId: String(s.id),
        deviceName: String(s.device_name),
        platform: s.platform as 'ios' | 'web',
        createdAt: iso(Number(s.created_at)),
        lastSeenAt: iso(Number(s.last_seen_at)),
        current: String(s.id) === current,
      })),
    };
  }
}
