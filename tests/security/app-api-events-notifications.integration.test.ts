import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DeviceSessionSchema } from '@synq/contracts';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import {
  NOTIFICATION_TITLES,
  notificationEventId,
  type PushSender,
} from '../../packages/workspaces/src/notifications.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from '../workspaces/pg.js';
import {
  BASE_CLOCK,
  bearer,
  buildApp,
  business,
  idem,
  joined,
  login,
  origin,
  services,
  telegramLead,
  type Person,
  type Services,
} from './app-api-world.js';

let pool: Pool;
let store: PostgresWorkspaceStore;
let s: Services;
let app: FastifyInstance;
const clock = BASE_CLOCK;
let ip = 0;
const from = () => `10.4.${Math.floor(++ip / 250)}.${ip % 250}`;

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  s = await services(store);
  app = buildApp(s);
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const event = (key: string, over: Record<string, unknown> = {}) => ({
  semanticKey: key,
  kind: 'DECISION' as const,
  actor: 'DETERMINISTIC' as const,
  status: 'AUTHORIZED' as const,
  summary: 'Allowed one payment within the lease.',
  sourceKind: 'KERNEL',
  proofLevel: 'NOT_VERIFIED' as const,
  correlationId: 'corr',
  ...over,
});
const poll = async (p: Person, cursor?: string) => {
  const r = await app.inject({
    url: `/v3/events/since${cursor === undefined ? '' : `?cursor=${cursor}`}`,
    headers: bearer(p.token),
  });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    items: {
      cursor: string;
      type: string;
      workspaceId: string | null;
      entityId: string | null;
      eventId: string;
    }[];
  };
};
const sse = async (
  p: Person,
  cursor: string,
  extra: Record<string, string> = {},
) => {
  const r = await app.inject({
    url: `/v3/events?cursor=${cursor}`,
    headers: { ...bearer(p.token), ...extra },
  });
  expect(r.statusCode).toBe(200);
  const frames = r.body
    .split('\n\n')
    .filter((f) => f.includes('event: '))
    .map((f) => ({
      id: /^id: (\d+)$/m.exec(f)![1]!,
      type: /^event: (\w+)$/m.exec(f)![1]!,
      data: JSON.parse(/^data: (.*)$/m.exec(f)![1]!) as {
        workspaceId: string | null;
        entityId: string | null;
      },
    }));
  return { body: r.body, frames };
};

describe('event stream isolation', () => {
  it('never shows another tenant’s events, on poll or on the stream', async () => {
    const a = await business(s, undefined, 'Tenant A');
    const b = await business(s, undefined, 'Tenant B');
    const head = await s.events.head();
    const runA = await s.events.run(a.workspaceId, 'src:a', {
      title: 'a',
      trigger: 'OTHER',
    });
    const runB = await s.events.run(b.workspaceId, 'src:b', {
      title: 'b',
      trigger: 'OTHER',
    });
    await s.events.record(runA, event('a1'));
    await s.events.record(runB, event('b1'));
    await s.events.publish(
      'LEAD_MESSAGE',
      { workspaceId: b.workspaceId },
      randomUUID(),
    );
    await s.events.publish(
      'NOTIFICATION',
      { principalId: b.owner.principalId },
      randomUUID(),
    );
    const mine = await poll(a.owner, head);
    expect(mine.items.map((i) => i.entityId)).toEqual([runA]);
    expect(mine.items.every((i) => i.workspaceId === a.workspaceId)).toBe(true);
    const live = await sse(a.owner, head);
    expect(live.frames.map((f) => f.data.entityId)).toEqual([runA]);
    for (const leak of [b.workspaceId, runB, b.owner.principalId])
      expect(live.body).not.toContain(leak);
    // A forged cursor from the future, a negative one and junk reveal nothing.
    expect((await poll(a.owner, '99999999999999999999')).items).toEqual([]);
    for (const bad of ['-1', '1.5', 'abc', '1e3', `${head};DROP`, ''])
      expect(
        (
          await app.inject({
            url: `/v3/events/since?cursor=${encodeURIComponent(bad)}`,
            headers: bearer(a.owner.token),
          })
        ).statusCode,
        bad,
      ).toBe(400);
    // Last-Event-ID from a header works the same as the query cursor.
    const viaHeader = await app.inject({
      url: '/v3/events',
      headers: { ...bearer(a.owner.token), 'last-event-id': head },
    });
    expect(viaHeader.body).toContain(runA);
  });

  it('replays from any cursor without gaps or duplicates', async () => {
    const a = await business(s);
    const head = await s.events.head();
    const run = await s.events.run(a.workspaceId, 'src:r', {
      title: 'r',
      trigger: 'OTHER',
    });
    for (const k of ['e1', 'e2', 'e3', 'e4'])
      await s.events.record(run, event(k));
    // The same semantic event recorded again (a producer retry) adds nothing.
    await s.events.record(run, event('e2'));
    const all = await poll(a.owner, head);
    expect(all.items).toHaveLength(4);
    const cursors = all.items.map((i) => BigInt(i.cursor));
    expect(new Set(cursors.map(String)).size).toBe(4);
    expect([...cursors].sort((x, y) => (x < y ? -1 : 1))).toEqual(cursors);
    expect(new Set(all.items.map((i) => i.eventId)).size).toBe(4);
    for (let i = 0; i < all.items.length; i++) {
      const rest = await poll(a.owner, all.items[i]!.cursor);
      expect(rest.items.map((x) => x.cursor)).toEqual(
        all.items.slice(i + 1).map((x) => x.cursor),
      );
      const live = await sse(a.owner, all.items[i]!.cursor);
      expect(live.frames.map((f) => f.id)).toEqual(
        rest.items.map((x) => x.cursor),
      );
    }
    // Two parallel readers see the same ordered ids.
    const [x, y] = await Promise.all([
      poll(a.owner, head),
      poll(a.owner, head),
    ]);
    expect(x.items.map((i) => i.cursor)).toEqual(y.items.map((i) => i.cursor));
  });

  it('stops delivering a workspace to a removed member, including events from before the removal', async () => {
    const a = await business(s);
    const member = await joined(s, a, 'ADMIN');
    const head = await s.events.head();
    const run = await s.events.run(a.workspaceId, 'src:rm', {
      title: 'rm',
      trigger: 'OTHER',
    });
    await s.events.record(run, event('rm1'));
    expect((await poll(member, head)).items).toHaveLength(1);
    await pool.query(
      'DELETE FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
      [a.workspaceId, member.principalId],
    );
    await s.events.record(run, event('rm2'));
    await s.events.publish(
      'LEAD_MESSAGE',
      { workspaceId: a.workspaceId },
      randomUUID(),
    );
    expect((await poll(member, head)).items).toEqual([]);
    const live = await sse(member, head);
    expect(live.frames).toEqual([]);
    expect(live.body).not.toContain(a.workspaceId);
    // The workspace is gone from their world, and rejoining is a new invite.
    expect(
      (
        await app.inject({
          url: `/v3/workspaces/${a.workspaceId}/agent-runs`,
          headers: bearer(member.token),
        })
      ).statusCode,
    ).toBe(404);
    // The owner still sees everything.
    expect((await poll(a.owner, head)).items.length).toBeGreaterThanOrEqual(3);
  });

  it('ends the stream when the session ends', async () => {
    const a = await business(s);
    const head = await s.events.head();
    await store.logout(a.owner.token);
    const r = await app.inject({
      url: `/v3/events?cursor=${head}`,
      headers: bearer(a.owner.token),
    });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('event:');
  });

  it('shows each role only the events about things it may read', async () => {
    const a = await business(s);
    const admin = await joined(s, a, 'ADMIN');
    const member = await joined(s, a, 'MEMBER');
    const viewer = await joined(s, a, 'VIEWER');
    const head = await s.events.head();
    const run = await s.events.run(a.workspaceId, 'src:roles', {
      title: 'x',
      trigger: 'OTHER',
    });
    await s.events.record(run, event('role1'));
    const leadId = randomUUID();
    await s.events.publish(
      'LEAD_MESSAGE',
      { workspaceId: a.workspaceId },
      leadId,
    );
    await s.events.publish(
      'LEAD_UPDATED',
      { workspaceId: a.workspaceId },
      leadId,
    );
    await s.events.publish(
      'OFFER_UPDATED',
      { workspaceId: a.workspaceId },
      leadId,
    );
    const types = async (p: Person) =>
      (await poll(p, head)).items.map((i) => i.type).sort();
    // Staff read leads and offers; members read agent runs; viewers read neither.
    expect(await types(a.owner)).toEqual([
      'AGENT_EVENT',
      'LEAD_MESSAGE',
      'LEAD_UPDATED',
      'OFFER_UPDATED',
    ]);
    expect(await types(admin)).toEqual(await types(a.owner));
    expect(await types(member)).toEqual(['AGENT_EVENT']);
    expect(await types(viewer)).toEqual([]);
    // Lead ids never reach a role that cannot open the lead.
    for (const p of [member, viewer])
      expect((await sse(p, head)).body).not.toContain(leadId);
  });
});

describe('push notifications', () => {
  const sent: { token: string; message: Record<string, string> }[] = [];
  const sender: PushSender = {
    capability: () => ({ status: 'AVAILABLE', reason: 'test' }),
    send: async (d, m) => {
      sent.push({ token: d.token, message: { ...m } });
      return { status: 200 };
    },
  };
  const register = (
    p: Person,
    token: string,
    over: Record<string, unknown> = {},
  ) => {
    const body = {
      deviceId: randomUUID(),
      apnsToken: token,
      environment: 'SANDBOX' as const,
      locale: 'en-GB',
      mutedCategories: [],
      quietHours: null,
      ...over,
    };
    return s.notifications.registerDevice(p.principalId, body).then(() => body);
  };
  const tokenOf = () => randomBytes(32).toString('hex');
  const mine = (token: string) => sent.filter((x) => x.token === token);

  it('sends only a generic title, category, event id and path: never lead labels, amounts or addresses', async () => {
    const b = await business(s, undefined, 'Hidden Studio Name');
    const lead = await telegramLead(s, b);
    const detail = await s.leads.detail(
      b.workspaceId,
      b.owner.principalId,
      lead.leadId,
    );
    const token = tokenOf();
    await register(b.owner, token);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    // Things that must never leave in a push, taken from real rows.
    const secrets = [
      detail.lead.label,
      'Hidden Studio Name',
      b.owner.a.address,
      b.owner.a.address.toLowerCase(),
      recipient,
      '1250.50',
      '1250500000',
      'USDC',
    ];
    for (const category of Object.keys(
      NOTIFICATION_TITLES,
    ) as (keyof typeof NOTIFICATION_TITLES)[])
      await s.notifications.notify(
        {
          eventId: notificationEventId('PUSH-LEAK', category, lead.leadId),
          category,
          workspaceId: b.workspaceId,
          deepLink: `/w/${b.workspaceId}/inbox/${lead.leadId}`,
        },
        [b.owner.principalId],
      );
    const result = await s.notifications.pump(sender, { batch: 100 });
    expect(result.sent).toBeGreaterThanOrEqual(
      Object.keys(NOTIFICATION_TITLES).length,
    );
    const got = mine(token);
    expect(got).toHaveLength(Object.keys(NOTIFICATION_TITLES).length);
    for (const g of got) {
      expect(Object.keys(g.message).sort()).toEqual([
        'category',
        'eventId',
        'link',
        'title',
      ]);
      expect(g.message.title).toBe(
        NOTIFICATION_TITLES[
          g.message.category as keyof typeof NOTIFICATION_TITLES
        ],
      );
      const flat = JSON.stringify(g.message);
      for (const secret of secrets) expect(flat, secret).not.toContain(secret);
    }
  });

  it('refuses deep links that could leave the app or carry data', async () => {
    const p = await login(store);
    for (const link of [
      '//evil.example/x',
      '//evil',
      '//evil/path',
      '///',
      '/\\evil.example',
      'https://evil.example',
      '/w/../../x',
      '/..//evil',
      '/a?label=Acme',
      '/a#1250.50',
      '/a b',
      `/${'a'.repeat(250)}`,
      '',
    ])
      await expect(
        s.notifications.notify(
          {
            eventId: notificationEventId('LINK', link),
            category: 'NEW_LEAD',
            workspaceId: null,
            deepLink: link,
          },
          [p.principalId],
        ),
        link,
      ).rejects.toMatchObject({ code: 'INVALID_DEEP_LINK' });
  });

  it('sends nothing to a device that was revoked, before or after the notification', async () => {
    const b = await business(s);
    const p = b.owner;
    const queuedFirst = await register(p, tokenOf());
    const revokedFirst = await register(p, tokenOf());
    const live = await register(p, tokenOf());
    const revoke = (deviceId: string) =>
      s.notifications.revokeDevice(p.principalId, deviceId);
    await revoke(revokedFirst.deviceId);
    const [id] = await s.notifications.notify(
      {
        eventId: notificationEventId('REVOKED', randomUUID()),
        category: 'NEW_LEAD',
        workspaceId: b.workspaceId,
        deepLink: `/w/${b.workspaceId}/inbox`,
      },
      [p.principalId],
    );
    // A pending push is cancelled by a later revoke.
    await revoke(queuedFirst.deviceId);
    await s.notifications.pump(sender, { batch: 100 });
    expect(mine(revokedFirst.apnsToken)).toEqual([]);
    expect(mine(queuedFirst.apnsToken)).toEqual([]);
    expect(mine(live.apnsToken)).toHaveLength(1);
    const states = await s.notifications.deliveries(id!);
    expect(states.filter((d) => d.state === 'SENT')).toHaveLength(1);
    // Re-registering a revoked token under another principal never wakes the first.
    const other = await login(store);
    const stolen = tokenOf();
    const first = await register(p, stolen);
    await register(other, stolen);
    const row = await pool.query(
      'SELECT revoked_at FROM synq_device_push_tokens WHERE device_id=$1',
      [first.deviceId],
    );
    expect(row.rows[0].revoked_at).not.toBeNull();
    await s.notifications.notify(
      {
        eventId: notificationEventId('REVOKED2', randomUUID()),
        category: 'NEW_LEAD',
        workspaceId: b.workspaceId,
        deepLink: `/w/${b.workspaceId}/inbox`,
      },
      [p.principalId],
    );
    await s.notifications.pump(sender, { batch: 100 });
    expect(mine(stolen)).toEqual([]);
  });

  it('stops pushing to a phone after its session is logged out, revoked or replayed', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const newSession = async () => {
      const c = await store.challenge({
        wallet: wallet.address,
        audience: 'native',
      });
      const signature = await wallet.signTypedData({
        ...loginTypedData(c),
        message: {
          ...loginTypedData(c).message,
          wallet: c.wallet as `0x${string}`,
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
    };
    const registerVia = async (accessToken: string) => {
      const token = tokenOf();
      const res = await app.inject({
        method: 'POST',
        url: '/v3/devices',
        headers: { ...bearer(accessToken), ...idem() },
        payload: {
          deviceId: randomUUID(),
          apnsToken: token,
          environment: 'SANDBOX',
          locale: 'en-GB',
          mutedCategories: [],
          quietHours: null,
        },
      });
      expect(res.statusCode).toBe(200);
      return token;
    };
    const principalId = (
      await store.session((await newSession()).accessToken, 'native')
    ).principalId;
    const notify = async () => {
      await s.notifications.notify(
        {
          eventId: notificationEventId('SESSION-END', randomUUID()),
          category: 'NEW_LEAD',
          workspaceId: null,
          deepLink: '/approvals',
        },
        [principalId],
      );
      await s.notifications.pump(sender, { batch: 100 });
    };
    // 1. Logout.
    const one = await newSession();
    const tokenOne = await registerVia(one.accessToken);
    await notify();
    expect(mine(tokenOne)).toHaveLength(1);
    const out = await app.inject({
      method: 'POST',
      url: '/v3/auth/logout',
      headers: { ...bearer(one.accessToken), ...idem() },
    });
    expect(out.statusCode).toBe(200);
    await notify();
    expect(mine(tokenOne)).toHaveLength(1);
    // 2. Revoke all, which also covers devices the caller is not using.
    const two = await newSession();
    const three = await newSession();
    const tokenTwo = await registerVia(two.accessToken);
    const tokenThree = await registerVia(three.accessToken);
    await notify();
    expect(mine(tokenTwo)).toHaveLength(1);
    expect(mine(tokenThree)).toHaveLength(1);
    await app.inject({
      method: 'POST',
      url: '/v3/auth/revoke-all',
      headers: { ...bearer(two.accessToken), ...idem() },
    });
    await notify();
    expect(mine(tokenTwo)).toHaveLength(1);
    expect(mine(tokenThree)).toHaveLength(1);
    // 3. A replayed refresh token revokes the session, and its pushes with it.
    const four = await newSession();
    const tokenFour = await registerVia(four.accessToken);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v3/auth/refresh',
      remoteAddress: from(),
      payload: {
        deviceId: (
          await pool.query(
            'SELECT device_id FROM synq_ws_device_sessions WHERE id=$1',
            [four.sessionId],
          )
        ).rows[0].device_id,
        refreshToken: four.refreshToken,
      },
    });
    expect(refreshed.statusCode).toBe(200);
    await app.inject({
      method: 'POST',
      url: '/v3/auth/refresh',
      remoteAddress: from(),
      payload: {
        deviceId: (
          await pool.query(
            'SELECT device_id FROM synq_ws_device_sessions WHERE id=$1',
            [four.sessionId],
          )
        ).rows[0].device_id,
        refreshToken: four.refreshToken,
      },
    });
    await notify();
    expect(mine(tokenFour)).toEqual([]);
  });

  it('keeps one principal’s notifications and devices from another', async () => {
    const a = await business(s);
    const b = await business(s);
    const tokenA = tokenOf();
    const tokenB = tokenOf();
    await register(a.owner, tokenA);
    await register(b.owner, tokenB);
    const [idA] = await s.notifications.notify(
      {
        eventId: notificationEventId('ISO', randomUUID()),
        category: 'FUND_PROPOSAL',
        workspaceId: a.workspaceId,
        deepLink: `/w/${a.workspaceId}/inbox`,
      },
      [a.owner.principalId],
    );
    await s.notifications.pump(sender, { batch: 100 });
    expect(mine(tokenA)).toHaveLength(1);
    expect(mine(tokenB)).toEqual([]);
    // B cannot read or mark A's notification.
    const list = await app.inject({
      url: '/v3/notifications',
      headers: bearer(b.owner.token),
    });
    expect(JSON.stringify(list.json())).not.toContain(idA);
    await app.inject({
      method: 'POST',
      url: '/v3/notifications/read',
      headers: { ...bearer(b.owner.token), ...idem() },
      payload: { notificationIds: [idA] },
    });
    const still = await s.notifications.list(a.owner.principalId);
    expect(still.items[0]!.readAt).toBeNull();
  });
});
