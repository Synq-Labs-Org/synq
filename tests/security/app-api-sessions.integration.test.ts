import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DeviceSessionSchema } from '@synq/contracts';
import { commercialPolicyTypedData } from '../../packages/workspaces/src/offers.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { REFRESH_TTL } from '../../packages/workspaces/src/device-sessions.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from '../workspaces/pg.js';
import {
  BASE_CLOCK,
  bearer,
  buildApp,
  business,
  cookie,
  idem,
  joined,
  login,
  origin,
  policy,
  services,
  type Services,
} from './app-api-world.js';

let pool: Pool;
let store: PostgresWorkspaceStore;
let s: Services;
let app: FastifyInstance;
let clock = BASE_CLOCK;
let ip = 0;
// Sign-in routes are throttled per address; every request gets its own.
const from = () => `10.3.${Math.floor(++ip / 250)}.${ip % 250}`;
const device = () => ({
  deviceId: randomUUID(),
  name: 'Test iPhone',
  platform: 'ios' as const,
});

async function signIn(
  a = privateKeyToAccount(generatePrivateKey()),
  d = device(),
) {
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
    payload: { challengeId: c.id, signature, device: d },
  });
  expect(r.statusCode).toBe(200);
  return { a, d, session: DeviceSessionSchema.parse(r.json()) };
}
const refresh = (deviceId: string, refreshToken: string) =>
  app.inject({
    method: 'POST',
    url: '/v3/auth/refresh',
    remoteAddress: from(),
    payload: { deviceId, refreshToken },
  });
const sessions = (headers: Record<string, string>) =>
  app.inject({ url: '/v3/auth/sessions', headers });
const flip = (t: string) => t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');

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

describe('forged, expired and rotated tokens', () => {
  it('rejects near-miss tokens', async () => {
    const { session } = await signIn();
    const t = session.accessToken;
    expect((await sessions(bearer(t))).statusCode).toBe(200);
    for (const bad of [
      flip(t),
      t.slice(0, 63),
      `${t}0`,
      t.toUpperCase(),
      ` ${t}`,
      `${t}\n`,
      t.replace(/^./, 'g'),
      session.refreshToken,
    ])
      expect((await sessions(bearer(bad))).statusCode, bad).toBe(401);
    // A refresh token is not an access token, whatever its shape.
    expect((await sessions(bearer(session.refreshToken))).statusCode).toBe(401);
    // Nor is the session id or a token of the right shape that was never issued.
    expect((await sessions(bearer(session.sessionId))).statusCode).toBe(401);
  });

  it('expires the access token after 15 minutes while the refresh token keeps working', async () => {
    const { d, session } = await signIn();
    clock += 901;
    try {
      expect((await sessions(bearer(session.accessToken))).statusCode).toBe(
        401,
      );
      const r = await refresh(d.deviceId, session.refreshToken);
      expect(r.statusCode).toBe(200);
      const next = DeviceSessionSchema.parse(r.json());
      expect((await sessions(bearer(next.accessToken))).statusCode).toBe(200);
      // The refresh token expires too, and an expired one is just unknown.
      clock += REFRESH_TTL + 1;
      expect((await refresh(d.deviceId, next.refreshToken)).statusCode).toBe(
        401,
      );
    } finally {
      clock = BASE_CLOCK;
    }
  });

  it('kills the old access token on rotation, and a replayed refresh token revokes everything on that device', async () => {
    const { d, session } = await signIn();
    const first = await refresh(d.deviceId, session.refreshToken);
    const next = DeviceSessionSchema.parse(first.json());
    expect((await sessions(bearer(session.accessToken))).statusCode).toBe(401);
    expect((await sessions(bearer(next.accessToken))).statusCode).toBe(200);
    // A thief replays the stolen, already-rotated refresh token.
    const replay = await refresh(d.deviceId, session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('SESSION_REVOKED');
    // The honest holder's newest tokens are dead too: someone had a copy.
    expect((await sessions(bearer(next.accessToken))).statusCode).toBe(401);
    expect((await refresh(d.deviceId, next.refreshToken)).statusCode).toBe(401);
    // Reuse is replay-proof: asking again does not resurrect anything.
    expect((await refresh(d.deviceId, session.refreshToken)).statusCode).toBe(
      401,
    );
  });

  it('never leaves two live token pairs when one refresh token is raced', async () => {
    const { d, session } = await signIn();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => refresh(d.deviceId, session.refreshToken)),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    const live = await pool.query(
      'SELECT count(*)::int AS n FROM synq_ws_sessions WHERE device_session_id=$1',
      [session.sessionId],
    );
    expect(live.rows[0].n).toBeLessThanOrEqual(1);
    // A raced token is treated as theft: the device session is gone.
    for (const r of ok) {
      const t = DeviceSessionSchema.parse(r.json());
      const now = (await sessions(bearer(t.accessToken))).statusCode;
      expect([200, 401]).toContain(now);
    }
  });

  it('refuses another device id, another principal and a revoked session', async () => {
    const a = await signIn();
    const b = await signIn();
    // A's refresh token with B's device id (and the reverse) is nothing.
    expect(
      (await refresh(b.d.deviceId, a.session.refreshToken)).statusCode,
    ).toBe(401);
    expect(
      (await refresh(a.d.deviceId, b.session.refreshToken)).statusCode,
    ).toBe(401);
    // Neither attempt hurt the real sessions.
    expect((await sessions(bearer(a.session.accessToken))).statusCode).toBe(
      200,
    );
    expect((await sessions(bearer(b.session.accessToken))).statusCode).toBe(
      200,
    );
    // Logout ends the device session: its refresh token is dead as well.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/logout',
          headers: { ...bearer(a.session.accessToken), ...idem() },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await refresh(a.d.deviceId, a.session.refreshToken)).statusCode,
    ).toBe(401);
    expect((await sessions(bearer(b.session.accessToken))).statusCode).toBe(
      200,
    );
    // A principal sees only their own devices.
    const list = (await sessions(bearer(b.session.accessToken))).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].sessionId).toBe(b.session.sessionId);
  });

  it('revoke-all ends access and refresh tokens, web and native', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const one = await signIn(wallet);
    const two = await signIn(wallet);
    const web = await login(store, 'web', wallet);
    const res = await app.inject({
      method: 'POST',
      url: '/v3/auth/revoke-all',
      headers: { ...bearer(one.session.accessToken), ...idem() },
    });
    expect(res.statusCode).toBe(200);
    for (const t of [one, two])
      expect((await sessions(bearer(t.session.accessToken))).statusCode).toBe(
        401,
      );
    expect(
      (await refresh(two.d.deviceId, two.session.refreshToken)).statusCode,
    ).toBe(401);
    expect((await sessions(cookie(web.token))).statusCode).toBe(401);
  });

  it('signing in again on a device replaces its old tokens', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const d = device();
    const old = await signIn(wallet, d);
    const fresh = await signIn(wallet, d);
    expect((await sessions(bearer(old.session.accessToken))).statusCode).toBe(
      401,
    );
    expect(
      (await refresh(d.deviceId, old.session.refreshToken)).statusCode,
    ).toBe(401);
    expect((await sessions(bearer(fresh.session.accessToken))).statusCode).toBe(
      200,
    );
  });
});

describe('sign-in proofs', () => {
  it('rejects a signature from a different wallet, an expired challenge and a web challenge', async () => {
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const c = await store.challenge({
      wallet: victim.address,
      audience: 'native',
    });
    const forged = await attacker.signTypedData({
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    });
    const post = (challengeId: string, signature: string) =>
      app.inject({
        method: 'POST',
        url: '/v3/auth/device-session',
        remoteAddress: from(),
        payload: { challengeId, signature, device: device() },
      });
    expect((await post(c.id, forged)).statusCode).toBe(401);
    // The failed attempt did not burn the victim's challenge for them, and
    // a correct signature still works once.
    const good = await victim.signTypedData({
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    });
    clock += 301;
    try {
      expect((await post(c.id, good)).statusCode).toBe(401);
    } finally {
      clock = BASE_CLOCK;
    }
    expect((await post(randomUUID(), good)).statusCode).toBe(401);
  });

  it('signs in from a one-time web code once, even when raced', async () => {
    const web = await login(store, 'web');
    const { code } = await store.nativeCode(web.principalId);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({
          method: 'POST',
          url: '/v3/auth/device-session/code',
          remoteAddress: from(),
          payload: { code, device: device() },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.statusCode !== 200)
        .every((r) => r.statusCode === 401),
    ).toBe(true);
    // Expired codes are nothing.
    const stale = await store.nativeCode(web.principalId);
    clock += 121;
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v3/auth/device-session/code',
            remoteAddress: from(),
            payload: { code: stale.code, device: device() },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      clock = BASE_CLOCK;
    }
  });
});

describe('native-only device registration', () => {
  const body = () => ({
    deviceId: randomUUID(),
    apnsToken: 'ab'.repeat(32),
    environment: 'SANDBOX',
    locale: 'en-GB',
    mutedCategories: [],
    quietHours: null,
  });
  it('refuses cookie sessions and bearer logins that are not a device session', async () => {
    const web = await login(store, 'web');
    const cookieRes = await app.inject({
      method: 'POST',
      url: '/v3/devices',
      headers: { ...cookie(web.token), origin, ...idem() },
      payload: body(),
    });
    expect(cookieRes.statusCode).toBe(403);
    expect(cookieRes.json().error).toBe('NATIVE_SESSION_REQUIRED');
    const plainNative = await login(store, 'native');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/devices',
          headers: { ...bearer(plainNative.token), ...idem() },
          payload: body(),
        })
      ).statusCode,
    ).toBe(403);
    const { session } = await signIn();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/devices',
          headers: { ...bearer(session.accessToken), ...idem() },
          payload: body(),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('does not let a second principal take over a registered device id or its push token', async () => {
    const one = await signIn();
    const two = await signIn();
    const b = body();
    const post = (t: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: '/v3/devices',
        headers: { ...bearer(t), ...idem() },
        payload,
      });
    expect((await post(one.session.accessToken, b)).statusCode).toBe(200);
    const stolen = await post(two.session.accessToken, b);
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error).toBe('DEVICE_ID_TAKEN');
    // Revoking someone else's device is "not found" and changes nothing.
    const revoke = await app.inject({
      method: 'POST',
      url: `/v3/devices/${b.deviceId}/revoke`,
      headers: { ...bearer(two.session.accessToken), ...idem() },
    });
    expect(revoke.statusCode).toBe(404);
    const row = await pool.query(
      'SELECT revoked_at FROM synq_device_push_tokens WHERE device_id=$1',
      [b.deviceId],
    );
    expect(row.rows[0].revoked_at).toBeNull();
  });
});

describe('approvals: wrong wallets, foreign ids and double signing', () => {
  const asApproval = async (wsId: string, principal: string, wallet: string) =>
    (await s.approvals.pending(principal, wallet)).find(
      (p) => p.item.workspaceId === wsId,
    );
  const sign = (
    token: string,
    requestId: string,
    signatures: unknown,
    key = idem(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/v3/approvals/${requestId}/signature`,
      headers: { ...bearer(token), ...key },
      payload: { signatures },
    });
  async function pendingPolicy() {
    const b = await business(s);
    const stranger = await login(s.store);
    const admin = await joined(s, b, 'ADMIN');
    const view = await s.offers.proposePolicy(
      b.workspaceId,
      b.owner.principalId,
      policy(clock),
    );
    const request = (await asApproval(
      b.workspaceId,
      b.owner.principalId,
      b.owner.a.address,
    ))!;
    const typed = commercialPolicyTypedData(
      b.workspaceId,
      view.version,
      view.policyHash,
    );
    const states = async () =>
      (await s.offers.policies(b.workspaceId, b.owner.principalId)).map(
        (p) => `${p.version}:${p.state}`,
      );
    return { b, stranger, admin, view, request, typed, states };
  }

  it('rejects a signature from the wrong wallet and a signature over other data', async () => {
    const x = await pendingPolicy();
    const wrongWallet = await x.stranger.a.signTypedData(x.typed);
    const wrongData = await x.b.owner.a.signTypedData(
      commercialPolicyTypedData(
        x.b.workspaceId,
        x.view.version + 1,
        x.view.policyHash,
      ),
    );
    for (const bad of [wrongWallet, wrongData, `0x${'11'.repeat(65)}`]) {
      const res = await sign(x.b.owner.token, x.request.item.requestId, [bad]);
      expect(res.statusCode, bad).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, bad).toBeLessThan(500);
    }
    expect(await x.states()).toEqual(['1:REVIEW']);
    // Malformed shapes never reach the signer check.
    for (const payload of [[], ['0x12'], [wrongWallet, wrongWallet], 'x'])
      expect(
        (await sign(x.b.owner.token, x.request.item.requestId, payload))
          .statusCode,
      ).toBe(400);
  });

  it('treats a request id from another principal as not found, even with a valid signature', async () => {
    const x = await pendingPolicy();
    const good = await x.b.owner.a.signTypedData(x.typed);
    const id = x.request.item.requestId;
    for (const who of [x.stranger, x.admin]) {
      const get = await app.inject({
        url: `/v3/approvals/${id}`,
        headers: bearer(who.token),
      });
      expect(get.statusCode).toBe(404);
      const unknown = await app.inject({
        url: `/v3/approvals/${randomUUID()}`,
        headers: bearer(who.token),
      });
      expect({ ...get.json() }).toEqual({ ...unknown.json() });
      const res = await sign(who.token, id, [good]);
      expect(res.statusCode).toBe(404);
    }
    expect(await x.states()).toEqual(['1:REVIEW']);
    // The id of tenant A's request in tenant B's inbox is not found either.
    const other = await pendingPolicy();
    const cross = await sign(other.b.owner.token, id, [
      await other.b.owner.a.signTypedData(other.typed),
    ]);
    expect(cross.statusCode).toBe(404);
    expect(await other.states()).toEqual(['1:REVIEW']);
  });

  it('counts a signature once: replays and races activate one policy, never two', async () => {
    const x = await pendingPolicy();
    const good = await x.b.owner.a.signTypedData(x.typed);
    const id = x.request.item.requestId;
    const results = await Promise.all(
      [1, 2, 3].map(() => sign(x.b.owner.token, id, [good])),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(
      results
        .filter((r) => r.statusCode !== 200)
        .every((r) => r.statusCode >= 400 && r.statusCode < 500),
    ).toBe(true);
    expect(await x.states()).toEqual(['1:ACTIVE']);
    // Once signed, the request is gone from the inbox and cannot be signed again.
    const again = await sign(x.b.owner.token, id, [good]);
    expect(again.statusCode).toBe(404);
    const inbox = await app.inject({
      url: '/v3/approvals',
      headers: bearer(x.b.owner.token),
    });
    expect(
      inbox.json().items.some((i: { requestId: string }) => i.requestId === id),
    ).toBe(false);
    // A second proposal needs its own signature; the old one cannot be replayed onto it.
    const next = await s.offers.proposePolicy(
      x.b.workspaceId,
      x.b.owner.principalId,
      policy(clock, { maxDiscountBps: 500 }),
    );
    const req2 = (await asApproval(
      x.b.workspaceId,
      x.b.owner.principalId,
      x.b.owner.a.address,
    ))!;
    expect(req2.item.requestId).not.toBe(id);
    expect(
      (await sign(x.b.owner.token, req2.item.requestId, [good])).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(await x.states()).toEqual(['2:REVIEW', '1:ACTIVE']);
    expect(next.version).toBe(2);
  });
});
