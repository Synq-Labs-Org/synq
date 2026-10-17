import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DeviceRegistrationSchema,
  MarkReadSchema,
  NotificationCategorySchema,
} from '@synq/contracts';
import { WorkspaceError } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * In-app notifications and push devices. A notification is one row per
 * (event, principal), so a retried producer never duplicates it. Titles are
 * generic by construction: they come from the category alone and never carry
 * a name, price, address or deal text. A push is queued once per active,
 * unmuted device and carries only the title, the category and the event id;
 * details are fetched after sign-in and a membership check. A device token
 * authenticates nothing.
 */

export const NOTIFICATION_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_user_notifications (id uuid PRIMARY KEY, event_id uuid NOT NULL, principal_id text NOT NULL, workspace_id uuid, category text NOT NULL, title text NOT NULL, deep_link text NOT NULL, created_at bigint NOT NULL, read_at bigint, UNIQUE(event_id, principal_id));
CREATE INDEX synq_user_notifications_inbox ON synq_user_notifications(principal_id, created_at DESC, id DESC);
CREATE TABLE synq_device_push_tokens (device_id uuid NOT NULL, principal_id text NOT NULL, apns_token_digest text NOT NULL, apns_token text NOT NULL, environment text NOT NULL CHECK(environment IN ('SANDBOX','PRODUCTION')), locale text NOT NULL, muted jsonb NOT NULL, quiet_hours jsonb, registered_at bigint NOT NULL, revoked_at bigint, PRIMARY KEY(principal_id, device_id));
CREATE UNIQUE INDEX synq_device_push_device ON synq_device_push_tokens(device_id);
CREATE INDEX synq_device_push_token ON synq_device_push_tokens(apns_token_digest);
CREATE TABLE synq_push_deliveries (notification_id uuid NOT NULL REFERENCES synq_user_notifications(id), device_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('PENDING','SENT','FAILED','SKIPPED')), attempts int NOT NULL DEFAULT 0, last_error text, updated_at bigint NOT NULL, PRIMARY KEY(notification_id, device_id));
CREATE INDEX synq_push_deliveries_pending ON synq_push_deliveries(state, updated_at);
`,
    down: `DROP TABLE synq_push_deliveries, synq_device_push_tokens, synq_user_notifications;`,
  },
  {
    // The device session that registered a push token, so signing that session
    // out (or revoking it) also stops the pushes.
    version: 2,
    up: `
ALTER TABLE synq_device_push_tokens ADD COLUMN device_session_id uuid;
CREATE INDEX synq_device_push_session ON synq_device_push_tokens(device_session_id);
`,
    down: `
DROP INDEX synq_device_push_session;
ALTER TABLE synq_device_push_tokens DROP COLUMN device_session_id;
`,
  },
] as const;

export type NotificationCategory = z.output<typeof NotificationCategorySchema>;

/** Generic by design (never a name, price, address or deal text). */
export const NOTIFICATION_TITLES: Record<NotificationCategory, string> = {
  NEW_LEAD: 'New enquiry',
  OFFER_ACCEPTED: 'An offer was accepted',
  CLIENT_DEPOSIT_FINALIZED: 'A deposit settled',
  AGENT_PAYMENT_FINALIZED: 'An agent payment settled',
  PAYMENT_BLOCKED: 'A payment was blocked',
  RISK_REVIEW: 'Something needs a review',
  ESCROW_DISPUTED: 'An escrow was disputed',
  CIRCLE_CONTRIBUTION_RECEIVED: 'New contribution',
  FUND_PROPOSAL: 'New fund proposal',
  APPROVAL_REQUESTED: 'Something needs your signature',
  LEASE_EXPIRING: 'A lease is expiring',
  SECURITY_PAUSE: 'Security pause',
};

export const deepLinks = {
  lead: (workspaceId: string, leadId: string) =>
    `/w/${workspaceId}/inbox/${leadId}`,
  agentRun: (workspaceId: string, runId: string) =>
    `/w/${workspaceId}/agents/${runId}`,
  circle: (circleId: string) => `/personal/circles/${circleId}`,
  approvals: () => '/approvals',
};

/** A stable event id, so a retried producer notifies once. */
export function notificationEventId(purpose: string, ...parts: string[]) {
  const h = createHash('sha256')
    .update([purpose, ...parts].join('|'))
    .digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (s: number) => new Date(s * 1000).toISOString();
// One site-relative path. A second leading slash would be a protocol-relative URL.
const DEEP_LINK = /^\/(?!\/)[A-Za-z0-9/_-]{1,200}$/;
const STAFF = ['OWNER', 'ADMIN'];

export type NotifyInput = {
  eventId: string;
  category: NotificationCategory;
  workspaceId: string | null;
  deepLink: string;
};

type QuietHours = { start: string; end: string; timeZone: string };

/** True when the current time falls inside the device's quiet hours. */
export function inQuietHours(q: QuietHours | null, nowSeconds: number) {
  if (!q) return false;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowSeconds * 1000));
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? 0);
    minutes = get('hour') * 60 + get('minute');
  } catch {
    return false;
  }
  const at = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const start = at(q.start),
    end = at(q.end);
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/** What the pump needs from a push sender. */
export type PushSender = {
  capability(): { status: 'AVAILABLE' | 'NOT_CONFIGURED'; reason: string };
  send(
    device: { token: string; environment: 'SANDBOX' | 'PRODUCTION' },
    message: {
      title: string;
      category: string;
      eventId: string;
      /** Site-relative path the app opens after sign-in and a membership check. */
      link: string;
    },
  ): Promise<{ status: number; reason?: string }>;
};

export class WorkspaceNotifications {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: {
      /** Stream marker for the principal (id only), after commit. */
      publish?: (principalId: string, notificationId: string) => Promise<void>;
    } = {},
  ) {}

  private now() {
    return this.store.now();
  }

  async migrate(target: number = NOTIFICATION_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_notifications_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_notifications_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_notifications_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...NOTIFICATION_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_notifications_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of NOTIFICATION_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_notifications_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  /**
   * Notifies each principal once per event and queues a push for each of
   * their active devices. Returns the notification ids created now (none for
   * a repeat).
   */
  async notify(input: NotifyInput, principalIds: string[]) {
    const category = NotificationCategorySchema.parse(input.category);
    const eventId = z.uuid().parse(input.eventId);
    if (!DEEP_LINK.test(input.deepLink))
      throw new WorkspaceError('INVALID_DEEP_LINK', 400);
    const title = NOTIFICATION_TITLES[category];
    const created = await this.store.transaction(async (sql) => {
      const now = this.now();
      const out: { principalId: string; id: string }[] = [];
      for (const principalId of new Set(principalIds)) {
        const ins = await sql.query(
          `INSERT INTO synq_user_notifications(id,event_id,principal_id,workspace_id,category,title,deep_link,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id,principal_id) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            eventId,
            principalId,
            input.workspaceId,
            category,
            title,
            input.deepLink,
            now,
          ],
        );
        if (!ins.rows[0]) continue;
        const id = String(ins.rows[0].id);
        out.push({ principalId, id });
        const devices = await sql.query(
          'SELECT device_id, muted, quiet_hours FROM synq_device_push_tokens WHERE principal_id=$1 AND revoked_at IS NULL',
          [principalId],
        );
        for (const d of devices.rows) {
          const muted = (d.muted as string[]).includes(category);
          const quiet = inQuietHours(d.quiet_hours as QuietHours | null, now);
          await sql.query(
            `INSERT INTO synq_push_deliveries(notification_id,device_id,state,attempts,updated_at)
             VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING`,
            [id, d.device_id, muted || quiet ? 'SKIPPED' : 'PENDING', now],
          );
        }
      }
      return out;
    });
    for (const c of created)
      // The stream is a hint to refetch; a lost marker never loses data.
      await this.options.publish?.(c.principalId, c.id).catch(() => undefined);
    return created.map((c) => c.id);
  }

  /** Notifies the owners and admins of a workspace. */
  async notifyStaff(input: NotifyInput & { workspaceId: string }) {
    const r = await this.store.pool.query(
      'SELECT principal_id FROM synq_ws_members WHERE workspace_id=$1 AND role = ANY($2::text[])',
      [input.workspaceId, STAFF],
    );
    return this.notify(
      input,
      r.rows.map((x) => String(x.principal_id)),
    );
  }

  async list(
    principalId: string,
    query: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) {
    const limit = query.limit ?? 30;
    let after: { at: number; id: string } | null = null;
    if (query.cursor) {
      const parsed = z
        .tuple([z.coerce.number().int(), z.uuid()])
        .safeParse(
          Buffer.from(query.cursor, 'base64url').toString().split('|'),
        );
      if (!parsed.success) throw new WorkspaceError('INVALID_CURSOR', 400);
      after = { at: parsed.data[0], id: parsed.data[1] };
    }
    const r = await this.store.pool.query(
      `SELECT * FROM synq_user_notifications WHERE principal_id=$1
        AND ($2::bigint IS NULL OR (created_at, id) < ($2::bigint, $3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [principalId, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const unread = await this.store.pool.query(
      'SELECT count(*)::int AS n FROM synq_user_notifications WHERE principal_id=$1 AND read_at IS NULL',
      [principalId],
    );
    const page = r.rows.slice(0, limit);
    return {
      items: page.map((x) => ({
        notificationId: String(x.id),
        eventId: String(x.event_id),
        category: x.category as NotificationCategory,
        workspaceId: x.workspace_id === null ? null : String(x.workspace_id),
        title: String(x.title),
        deepLink: String(x.deep_link),
        createdAt: iso(Number(x.created_at)),
        readAt: x.read_at === null ? null : iso(Number(x.read_at)),
      })),
      nextCursor:
        r.rows.length > limit
          ? Buffer.from(
              `${page.at(-1)!.created_at}|${page.at(-1)!.id}`,
            ).toString('base64url')
          : null,
      unreadCount: Number(unread.rows[0].n),
    };
  }

  /** Marks the principal's own notifications read; other ids are ignored. */
  async markRead(principalId: string, body: unknown) {
    const { notificationIds } = MarkReadSchema.parse(body);
    await this.store.pool.query(
      'UPDATE synq_user_notifications SET read_at=$3 WHERE principal_id=$1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
      [principalId, notificationIds, this.now()],
    );
    return { ok: true as const };
  }

  async registerDevice(
    principalId: string,
    body: unknown,
    deviceSessionId: string | null = null,
  ) {
    const d = DeviceRegistrationSchema.parse(body);
    const now = this.now();
    return this.store.transaction(async (sql) => {
      const owner = await sql.query(
        'SELECT principal_id FROM synq_device_push_tokens WHERE device_id=$1',
        [d.deviceId],
      );
      if (owner.rows[0] && owner.rows[0].principal_id !== principalId)
        throw new WorkspaceError('DEVICE_ID_TAKEN', 409);
      const tokenDigest = digest(d.apnsToken);
      // One physical device receives pushes for one principal at a time.
      await sql.query(
        `UPDATE synq_device_push_tokens SET revoked_at=$3
          WHERE apns_token_digest=$1 AND principal_id<>$2 AND revoked_at IS NULL`,
        [tokenDigest, principalId, now],
      );
      await sql.query(
        `INSERT INTO synq_device_push_tokens(device_id,principal_id,apns_token_digest,apns_token,environment,locale,muted,quiet_hours,registered_at,revoked_at,device_session_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
         ON CONFLICT(principal_id,device_id) DO UPDATE SET apns_token_digest=$3, apns_token=$4, environment=$5, locale=$6, muted=$7, quiet_hours=$8, registered_at=$9, revoked_at=NULL, device_session_id=$10`,
        [
          d.deviceId,
          principalId,
          tokenDigest,
          d.apnsToken,
          d.environment,
          d.locale,
          JSON.stringify(d.mutedCategories),
          d.quietHours === null ? null : JSON.stringify(d.quietHours),
          now,
          deviceSessionId,
        ],
      );
      return { deviceId: d.deviceId, registeredAt: iso(now) };
    });
  }

  async revokeDevice(principalId: string, deviceId: string) {
    const now = this.now();
    await this.store.transaction(async (sql) => {
      const r = await sql.query(
        `UPDATE synq_device_push_tokens SET revoked_at=COALESCE(revoked_at,$3)
          WHERE principal_id=$1 AND device_id=$2 RETURNING device_id`,
        [principalId, deviceId, now],
      );
      if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      await this.skipPending(sql, deviceId, now);
    });
    return { ok: true as const };
  }

  private async skipPending(
    sql: { query: (q: string, v: unknown[]) => Promise<unknown> },
    deviceId: string,
    now: number,
  ) {
    await sql.query(
      "UPDATE synq_push_deliveries SET state='SKIPPED', updated_at=$2 WHERE device_id=$1 AND state='PENDING'",
      [deviceId, now],
    );
  }

  /** Deliveries for one notification, for tests and diagnostics. */
  async deliveries(notificationId: string) {
    const r = await this.store.pool.query(
      'SELECT device_id, state, attempts, last_error FROM synq_push_deliveries WHERE notification_id=$1 ORDER BY device_id',
      [notificationId],
    );
    return r.rows.map((x) => ({
      deviceId: String(x.device_id),
      state: String(x.state) as 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED',
      attempts: Number(x.attempts),
      lastError: x.last_error === null ? null : String(x.last_error),
    }));
  }

  /**
   * Sends pending pushes. Does nothing (deliveries stay PENDING) while the
   * sender is not configured. Attempts are capped; HTTP 410 means the token
   * is gone, so the device is revoked.
   */
  async pump(
    sender: PushSender,
    options: {
      maxAttempts?: number;
      batch?: number;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const result = { sent: 0, failed: 0, retry: 0, revoked: 0 };
    if (sender.capability().status !== 'AVAILABLE') return result;
    const max = options.maxAttempts ?? 5;
    const now = this.now();
    // Claiming bumps attempts and updated_at, so a concurrent pump skips them.
    const claimed = await this.store.pool.query(
      `UPDATE synq_push_deliveries d SET attempts=d.attempts+1, updated_at=$1
        WHERE (d.notification_id, d.device_id) IN (
          SELECT p.notification_id, p.device_id FROM synq_push_deliveries p
           WHERE p.state='PENDING' AND p.attempts<$2
             AND (p.attempts=0 OR p.updated_at <= $1 - $3::bigint * p.attempts)
           ORDER BY p.updated_at LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING d.notification_id, d.device_id, d.attempts`,
      [now, max, options.retryAfterSeconds ?? 30, options.batch ?? 50],
    );
    for (const c of claimed.rows) {
      const info = await this.store.pool.query(
        `SELECT n.category, n.title, n.event_id, n.deep_link, t.apns_token, t.environment, t.principal_id, t.revoked_at
           FROM synq_user_notifications n
           JOIN synq_device_push_tokens t ON t.device_id=$2
          WHERE n.id=$1`,
        [c.notification_id, c.device_id],
      );
      const row = info.rows[0];
      const finish = (state: string, error: string | null) =>
        this.store.pool.query(
          'UPDATE synq_push_deliveries SET state=$3, last_error=$4, updated_at=$5 WHERE notification_id=$1 AND device_id=$2',
          [c.notification_id, c.device_id, state, error, this.now()],
        );
      if (!row || row.revoked_at !== null) {
        await finish('SKIPPED', 'device not active');
        continue;
      }
      let res: { status: number; reason?: string };
      try {
        res = await sender.send(
          {
            token: String(row.apns_token),
            environment: row.environment as 'SANDBOX' | 'PRODUCTION',
          },
          {
            title: String(row.title),
            category: String(row.category),
            eventId: String(row.event_id),
            link: String(row.deep_link),
          },
        );
      } catch {
        res = { status: 0, reason: 'TransportError' };
      }
      if (res.status === 200) {
        await finish('SENT', null);
        result.sent++;
      } else if (res.status === 410) {
        await this.store.transaction(async (sql) => {
          await sql.query(
            'UPDATE synq_device_push_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE device_id=$1',
            [c.device_id, this.now()],
          );
          await this.skipPending(sql, String(c.device_id), this.now());
        });
        await finish('FAILED', 'Unregistered');
        result.revoked++;
        result.failed++;
      } else {
        const transient =
          res.status === 0 || res.status === 429 || res.status >= 500;
        const error = `${res.status} ${res.reason ?? ''}`.trim().slice(0, 100);
        if (transient && Number(c.attempts) < max) {
          await this.store.pool.query(
            'UPDATE synq_push_deliveries SET last_error=$3 WHERE notification_id=$1 AND device_id=$2',
            [c.notification_id, c.device_id, error],
          );
          result.retry++;
        } else {
          await finish('FAILED', error);
          result.failed++;
        }
      }
    }
    return result;
  }
}
