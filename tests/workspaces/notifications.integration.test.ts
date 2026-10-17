import { generateKeyPairSync, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import {
  DeviceRegisteredSchema,
  DeviceSessionSchema,
  NotificationPageSchema,
} from '@synq/contracts';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import {
  NOTIFICATION_TITLES,
  WorkspaceNotifications,
  notificationEventId,
  type PushSender,
} from '../../packages/workspaces/src/notifications.js';
import { ApnsSender, type ApnsRequest } from '../../apps/demo/src/apns.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { GET as aasa } from '../../apps/web/app/.well-known/apple-app-site-association/route.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

const origin = 'https://synq.test';
let clock = 2_000_000_000; // 03:33:20 UTC
let pool: Pool;
let store: PostgresWorkspaceStore;
let notes: WorkspaceNotifications;
let app: FastifyInstance;
const published: string[] = [];
let ip = 0;
const from = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;
const key = () => ({ 'idempotency-key': randomUUID() });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
// Built at runtime so no hex literal sits in the source.
const apnsToken = (n: number) => String(n).padStart(2, '0').repeat(32);

async function login() {
  const a = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: a.address, audience: 'native' });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  return store.login(c.id, signature);
}
async function webLogin() {
  const a = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: a.address, audience: 'web' });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  return store.login(c.id, signature);
}
async function deviceSession() {
  const a = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: a.address, audience: 'native' });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v3/auth/device-session',
    remoteAddress: from(),
    payload: {
      challengeId: c.id,
      signature,
      device: { deviceId: randomUUID(), name: 'Phone', platform: 'ios' },
    },
  });
  expect(r.statusCode).toBe(200);
  return DeviceSessionSchema.parse(r.json());
}
const registration = (over: Record<string, unknown> = {}) => ({
  deviceId: randomUUID(),
  apnsToken: apnsToken(Math.floor(Math.random() * 90) + 10),
  environment: 'SANDBOX' as const,
  locale: 'en-GB',
  mutedCategories: [],
  quietHours: null,
  ...over,
});
const event = (n = randomUUID()) => ({
  eventId: notificationEventId('TEST', n),
  category: 'NEW_LEAD' as const,
  workspaceId: randomUUID(),
  deepLink: '/w/abc/inbox/def',
});

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  await store.migrate();
  notes = new WorkspaceNotifications(store, {
    publish: async (p, id) => {
      published.push(`${p}:${id}`);
    },
  });
  await Promise.all([notes.migrate(), notes.migrate()]);
  app = Fastify();
  registerAppRoutes(app, {
    store,
    devices: new WorkspaceDeviceSessions(store),
    notifications: notes,
  });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('notifications', () => {
  it('notifies once per event and principal, newest first, and publishes a marker', async () => {
    const p = await login();
    const q = await login();
    const e = event();
    const first = await notes.notify(e, [p.principalId, q.principalId]);
    const again = await notes.notify(e, [p.principalId, q.principalId]);
    expect(first).toHaveLength(2);
    expect(again).toHaveLength(0);
    expect(
      published.filter((x) => x.startsWith(`${p.principalId}:`)),
    ).toHaveLength(1);
    clock += 10;
    const later = event();
    await notes.notify({ ...later, category: 'OFFER_ACCEPTED' }, [
      p.principalId,
    ]);
    const page = await notes.list(p.principalId, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(page.unreadCount).toBe(2);
    const all = await notes.list(p.principalId, {});
    expect(all.items.map((i) => i.title)).toEqual([
      NOTIFICATION_TITLES.OFFER_ACCEPTED,
      NOTIFICATION_TITLES.NEW_LEAD,
    ]);
    NotificationPageSchema.parse(all);
    const next = await notes.list(p.principalId, {
      cursor: page.nextCursor!,
      limit: 5,
    });
    expect(next.items).toHaveLength(1);
  });

  it('keeps one principal from reading or marking another principal’s notifications', async () => {
    const p = await login();
    const q = await login();
    const [id] = await notes.notify(event(), [p.principalId]);
    expect((await notes.list(q.principalId, {})).items).toHaveLength(0);
    await notes.markRead(q.principalId, { notificationIds: [id] });
    expect((await notes.list(p.principalId, {})).unreadCount).toBe(1);
    await notes.markRead(p.principalId, { notificationIds: [id] });
    const mine = await notes.list(p.principalId, {});
    expect(mine.unreadCount).toBe(0);
    expect(mine.items[0]!.readAt).not.toBeNull();
  });

  it('skips pushes for muted categories and quiet hours, and for revoked devices', async () => {
    const p = await login();
    const normal = registration();
    const muted = registration({ mutedCategories: ['NEW_LEAD'] });
    const quiet = registration({
      quietHours: { start: '00:00', end: '06:00', timeZone: 'UTC' },
    });
    const awake = registration({
      quietHours: { start: '10:00', end: '12:00', timeZone: 'UTC' },
    });
    for (const d of [normal, muted, quiet, awake])
      await notes.registerDevice(p.principalId, d);
    const [id] = await notes.notify(event(), [p.principalId]);
    const state = Object.fromEntries(
      (await notes.deliveries(id!)).map((d) => [d.deviceId, d.state]),
    );
    expect(state[normal.deviceId]).toBe('PENDING');
    expect(state[muted.deviceId]).toBe('SKIPPED');
    expect(state[quiet.deviceId]).toBe('SKIPPED');
    expect(state[awake.deviceId]).toBe('PENDING');

    await notes.revokeDevice(p.principalId, normal.deviceId);
    const [after] = await notes.notify(event(), [p.principalId]);
    expect(
      (await notes.deliveries(after!)).map((d) => d.deviceId),
    ).not.toContain(normal.deviceId);
    // Pending work for the revoked device is dropped too.
    expect(
      (await notes.deliveries(id!)).find((d) => d.deviceId === normal.deviceId)
        ?.state,
    ).toBe('SKIPPED');
  });

  it('gives a device to one principal and re-registering updates it', async () => {
    const p = await login();
    const q = await login();
    const d = registration();
    await notes.registerDevice(p.principalId, d);
    await notes.registerDevice(p.principalId, { ...d, locale: 'fr-FR' });
    await expect(notes.registerDevice(q.principalId, d)).rejects.toMatchObject({
      status: 409,
    });
    const r = await pool.query(
      'SELECT locale FROM synq_device_push_tokens WHERE device_id=$1',
      [d.deviceId],
    );
    expect(r.rows).toEqual([{ locale: 'fr-FR' }]);
    // The same phone token moving to another principal stops the first one.
    const moved = registration({ apnsToken: d.apnsToken });
    await notes.registerDevice(q.principalId, moved);
    const [id] = await notes.notify(event(), [p.principalId]);
    expect(await notes.deliveries(id!)).toHaveLength(0);
  });
});

describe('APNs delivery', () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const env = {
    SYNQ_APNS_KEY_FILE: '/nonexistent/key.p8',
    SYNQ_APNS_KEY_ID: 'KEYID12345',
    SYNQ_APNS_TEAM_ID: 'TEAMID1234',
    SYNQ_APNS_TOPIC: 'world.synqlabs.messages',
  };

  it('sends only the generic title, category and event id', async () => {
    const p = await login();
    const d = registration({ environment: 'PRODUCTION' });
    await notes.registerDevice(p.principalId, d);
    const e = event();
    const [id] = await notes.notify(
      { ...e, category: 'AGENT_PAYMENT_FINALIZED' },
      [p.principalId],
    );
    const sent: ApnsRequest[] = [];
    const sender = new ApnsSender({
      env,
      readKey: () => pem,
      now: () => clock,
      transport: async (req) => {
        sent.push(req);
        return { status: 200 };
      },
    });
    expect(sender.capability().status).toBe('AVAILABLE');
    const r = await notes.pump(sender);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const mine = sent.find((s) => s.path === `/3/device/${d.apnsToken}`)!;
    expect(mine.host).toBe('api.push.apple.com');
    expect(mine.headers['apns-topic']).toBe(env.SYNQ_APNS_TOPIC);
    expect(mine.headers.authorization).toMatch(
      /^bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    expect(JSON.parse(mine.body)).toEqual({
      aps: {
        alert: { title: 'An agent payment settled' },
        category: 'AGENT_PAYMENT_FINALIZED',
        'mutable-content': 0,
      },
      eventId: e.eventId,
      // An opaque site path the app opens after sign-in; ids only.
      link: '/w/abc/inbox/def',
    });
    for (const leak of ['Telegram lead', 'USDC', '0x', '$'])
      expect(mine.body).not.toContain(leak);
    expect((await notes.deliveries(id!))[0]!.state).toBe('SENT');
  });

  it('uses the sandbox host for sandbox devices', async () => {
    const p = await login();
    await notes.registerDevice(p.principalId, registration());
    await notes.notify(event(), [p.principalId]);
    const hosts: string[] = [];
    await notes.pump(
      new ApnsSender({
        env,
        readKey: () => pem,
        transport: async (req) => {
          hosts.push(req.host);
          return { status: 200 };
        },
      }),
    );
    expect(hosts).toContain('api.sandbox.push.apple.com');
  });

  it('revokes the device when APNs says the token is unregistered', async () => {
    const p = await login();
    const d = registration();
    await notes.registerDevice(p.principalId, d);
    const [id] = await notes.notify(event(), [p.principalId]);
    await notes.pump(
      new ApnsSender({
        env,
        readKey: () => pem,
        transport: async (req) =>
          req.path.endsWith(d.apnsToken)
            ? { status: 410, reason: 'Unregistered' }
            : { status: 200 },
      }),
    );
    const row = await pool.query(
      'SELECT revoked_at FROM synq_device_push_tokens WHERE device_id=$1',
      [d.deviceId],
    );
    expect(row.rows[0].revoked_at).not.toBeNull();
    expect((await notes.deliveries(id!))[0]).toMatchObject({
      state: 'FAILED',
      lastError: 'Unregistered',
    });
    const [next] = await notes.notify(event(), [p.principalId]);
    expect(await notes.deliveries(next!)).toHaveLength(0);
  });

  it('caps attempts on transient failures', async () => {
    const p = await login();
    await notes.registerDevice(p.principalId, registration());
    const [id] = await notes.notify(event(), [p.principalId]);
    let calls = 0;
    const sender = new ApnsSender({
      env,
      readKey: () => pem,
      transport: async () => {
        calls++;
        return { status: 503, reason: 'ServiceUnavailable' };
      },
    });
    const first = await notes.pump(sender, {
      maxAttempts: 2,
      retryAfterSeconds: 0,
    });
    expect(first.retry).toBeGreaterThanOrEqual(1);
    expect((await notes.deliveries(id!))[0]).toMatchObject({
      state: 'PENDING',
      attempts: 1,
    });
    await notes.pump(sender, { maxAttempts: 2, retryAfterSeconds: 0 });
    expect((await notes.deliveries(id!))[0]).toMatchObject({
      state: 'FAILED',
      attempts: 2,
    });
    const before = calls;
    await notes.pump(sender, { maxAttempts: 2, retryAfterSeconds: 0 });
    expect(calls).toBe(before);
  });

  it('sends nothing and keeps deliveries pending while not configured', async () => {
    const p = await login();
    await notes.registerDevice(p.principalId, registration());
    const [id] = await notes.notify(event(), [p.principalId]);
    let calls = 0;
    const sender = new ApnsSender({
      env: {},
      transport: async () => {
        calls++;
        return { status: 200 };
      },
    });
    const cap = sender.capability();
    expect(cap.status).toBe('NOT_CONFIGURED');
    expect(cap.reason).toContain('SYNQ_APNS_KEY_FILE');
    expect(await notes.pump(sender)).toEqual({
      sent: 0,
      failed: 0,
      retry: 0,
      revoked: 0,
    });
    expect(calls).toBe(0);
    expect((await notes.deliveries(id!))[0]).toMatchObject({
      state: 'PENDING',
      attempts: 0,
    });
    const unreadable = new ApnsSender({
      env,
      readKey: () => {
        throw new Error('ENOENT');
      },
    });
    expect(unreadable.capability().status).toBe('NOT_CONFIGURED');
    const stub: PushSender = unreadable;
    expect(stub.capability().reason).not.toContain('/nonexistent');
  });
});

describe('v3 notification routes', () => {
  it('refuses a web cookie session and accepts a device-session bearer for /v3/devices', async () => {
    const web = await webLogin();
    const refused = await app.inject({
      method: 'POST',
      url: '/v3/devices',
      headers: {
        cookie: `__Host-synq_workspace=${web.token}`,
        origin,
        ...key(),
      },
      payload: registration(),
    });
    expect(refused.statusCode).toBe(403);

    const s = await deviceSession();
    const body = registration();
    const ok = await app.inject({
      method: 'POST',
      url: '/v3/devices',
      headers: { ...bearer(s.accessToken), ...key() },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(DeviceRegisteredSchema.parse(ok.json()).deviceId).toBe(
      body.deviceId,
    );
    const noKey = await app.inject({
      method: 'POST',
      url: '/v3/devices',
      headers: bearer(s.accessToken),
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
  });

  it('lists, marks read and revokes through the API', async () => {
    const s = await deviceSession();
    const me = await store.session(s.accessToken, 'native');
    const [id] = await notes.notify(event(), [me.principalId]);
    const listed = await app.inject({
      url: '/v3/notifications',
      headers: bearer(s.accessToken),
    });
    expect(NotificationPageSchema.parse(listed.json()).unreadCount).toBe(1);
    const read = await app.inject({
      method: 'POST',
      url: '/v3/notifications/read',
      headers: { ...bearer(s.accessToken), ...key() },
      payload: { notificationIds: [id] },
    });
    expect(read.json()).toEqual({ ok: true });
    const d = registration();
    await app.inject({
      method: 'POST',
      url: '/v3/devices',
      headers: { ...bearer(s.accessToken), ...key() },
      payload: d,
    });
    const other = await deviceSession();
    const stranger = await app.inject({
      method: 'POST',
      url: `/v3/devices/${d.deviceId}/revoke`,
      headers: { ...bearer(other.accessToken), ...key() },
    });
    expect(stranger.statusCode).toBe(404);
    const revoked = await app.inject({
      method: 'POST',
      url: `/v3/devices/${d.deviceId}/revoke`,
      headers: { ...bearer(s.accessToken), ...key() },
    });
    expect(revoked.json()).toEqual({ ok: true });
    const meta = await app.inject({ url: '/v3/meta' });
    const status = (id: string) =>
      meta.json().routes.find((r: { id: string }) => r.id === id).status;
    expect(status('devices.register')).toBe('IMPLEMENTED');
    expect(status('notifications.list')).toBe('IMPLEMENTED');
  });
});

describe('universal links', () => {
  it('serves the association file as JSON with the app paths', async () => {
    const res = aasa();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = (await res.json()) as {
      applinks: {
        details: { appIDs: string[]; components: Record<string, string>[] }[];
      };
    };
    expect(j.applinks.details[0]!.appIDs).toEqual([
      '8NPF39H3FL.world.synqlabs.messages',
    ]);
    const parts = j.applinks.details[0]!.components as unknown as {
      '/': string;
      exclude?: boolean;
    }[];
    // Wallet and passkey ceremonies stay in the browser.
    expect(parts.filter((c) => c.exclude).map((c) => c['/'])).toEqual([
      '/pay/*',
      '/approve',
      '/workspaces*',
      '/send*',
      '/intents/*',
      '/api/*',
    ]);
    expect(parts.filter((c) => !c.exclude).map((c) => c['/'])).toEqual([
      '/w/*/inbox',
      '/w/*/inbox/*',
      '/w/*/deals/*',
      '/w/*/agents/*',
      '/personal',
      '/personal/circles/*',
      '/approve/*',
      '/approvals',
      '/notifications',
      '/fund/*',
    ]);
  });
});
