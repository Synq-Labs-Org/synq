import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Hex } from 'viem';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';
import { durablePool, testDatabaseUrl } from '../durable/pg.js';

const origin = 'https://synq.test';
let pool: Pool;
let store: PostgresWorkspaceStore;
let clock = 2_000_000_000;
const account = () => privateKeyToAccount(generatePrivateKey());
async function login(a = account(), audience: 'web' | 'native' = 'native') {
  const challenge = await store.challenge({ wallet: a.address, audience });
  const signature = await a.signTypedData({
    ...loginTypedData(challenge),
    message: {
      ...loginTypedData(challenge).message,
      wallet: getAddress(challenge.wallet),
      expiresAt: BigInt(challenge.expiresAt),
    },
  });
  return {
    a,
    challenge,
    signature,
    ...(await store.login(challenge.id, signature)),
  };
}
beforeAll(async () => {
  pool = await durablePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  await Promise.all([store.migrate(), store.migrate()]);
});
afterAll(async () => {
  await pool?.end();
});

describe('G1 durable workspace isolation and membership', () => {
  it('reverses and reapplies versioned migrations on an isolated database', async () => {
    const migrationPool = await durablePool(
      testDatabaseUrl(
        'SYNQ_WORKSPACES_MIGRATION_DATABASE_URL',
        'synq_m2_workspaces_migrations',
      ),
    );
    try {
      const migrations = new PostgresWorkspaceStore(migrationPool, origin);
      await migrations.migrate();
      await migrations.migrate(0);
      expect(
        (
          await migrationPool.query(
            "SELECT to_regclass('synq_workspaces') AS name",
          )
        ).rows[0].name,
      ).toBeNull();
      await migrations.migrate();
      expect(
        (
          await migrationPool.query(
            'SELECT version FROM synq_workspaces_migrations',
          )
        ).rows.map((r) => r.version),
      ).toEqual([1]);
    } finally {
      await migrationPool.end();
    }
  });

  it('recovers an invitation after losing the connection with partial membership writes', async () => {
    const a = await login();
    const b = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Crash recovery',
      kind: 'GROUP',
    });
    const invitation = await store.invite(w.id, a.principalId, {
      role: 'MEMBER',
    });
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN');
      await sql.query(
        "INSERT INTO synq_ws_members(workspace_id,principal_id,wallet,role,joined_at) VALUES($1,$2,$3,'MEMBER',$4)",
        [w.id, b.principalId, b.a.address.toLowerCase(), clock],
      );
      await sql.query(
        'UPDATE synq_ws_invites SET consumed_by=$1 WHERE digest=$2',
        [
          b.principalId,
          createHash('sha256').update(invitation.token).digest('hex'),
        ],
      );
    } finally {
      sql.release(true);
    }
    const restarted = new PostgresWorkspaceStore(pool, origin, () => clock);
    expect((await restarted.get(w.id, a.principalId)).members).toHaveLength(1);
    expect(await restarted.accept(b.principalId, invitation.token)).toEqual({
      workspaceId: w.id,
    });
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_membership_log WHERE workspace_id=$1',
          [w.id],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('isolates unrelated principals and survives store restart', async () => {
    const a = await login();
    const b = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Operating account',
      kind: 'GROUP',
    });
    expect(w).toMatchObject({
      chainId: 5042002,
      status: 'FORMING',
      vault: null,
    });
    expect(await store.list(b.principalId)).toEqual([]);
    await expect(store.get(w.id, b.principalId)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
    const restarted = new PostgresWorkspaceStore(pool, origin, () => clock);
    expect((await restarted.get(w.id, a.principalId)).members).toHaveLength(1);
    expect(await restarted.session(a.token, 'native')).toMatchObject({
      principalId: a.principalId,
    });
  });
  it('consumes an invite once under races and prevents viewer escalation', async () => {
    const a = await login();
    const b = await login();
    const c = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Operations',
      kind: 'BUSINESS',
    });
    const invite = await store.invite(w.id, a.principalId, { role: 'VIEWER' });
    const raced = await Promise.allSettled([
      store.accept(b.principalId, invite.token),
      store.accept(c.principalId, invite.token),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const members = (await store.get(w.id, a.principalId)).members;
    expect(members).toHaveLength(2);
    const viewer = members.find((m) => m.role === 'VIEWER')!;
    await expect(
      store.invite(w.id, viewer.principalId, { role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    const log = await pool.query(
      'SELECT * FROM synq_ws_membership_log WHERE workspace_id=$1',
      [w.id],
    );
    expect(log.rowCount).toBe(2);
    await expect(
      pool.query(
        "UPDATE synq_ws_membership_log SET role='OWNER' WHERE workspace_id=$1",
        [w.id],
      ),
    ).rejects.toThrow('append only');
  });
  it('rolls back membership and leaves invite usable if a transaction crashes', async () => {
    const a = await login();
    const b = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Restart test',
      kind: 'GROUP',
    });
    const invite = await store.invite(w.id, a.principalId, { role: 'MEMBER' });
    await expect(
      store.transaction(async (sql) => {
        await sql.query(
          'UPDATE synq_ws_invites SET consumed_by=$1 WHERE workspace_id=$2',
          [b.principalId, w.id],
        );
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash');
    expect(
      await new PostgresWorkspaceStore(pool, origin, () => clock).accept(
        b.principalId,
        invite.token,
      ),
    ).toEqual({ workspaceId: w.id });
  });
  it('refuses stale owner invites after custody setup starts', async () => {
    const a = await login();
    const b = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Custody',
      kind: 'GROUP',
    });
    const invite = await store.invite(w.id, a.principalId, { role: 'OWNER' });
    await pool.query(
      "UPDATE synq_workspaces SET status='LAUNCHING' WHERE id=$1",
      [w.id],
    );
    await expect(
      store.accept(b.principalId, invite.token),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_REQUIRED' });
    await expect(
      store.invite(w.id, a.principalId, { role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_REQUIRED' });
  });
  it('enforces expiry without consuming an invite', async () => {
    const a = await login();
    const b = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Expiry',
      kind: 'GROUP',
    });
    const invite = await store.invite(w.id, a.principalId, {
      role: 'MEMBER',
      expiresIn: 60,
    });
    clock += 60;
    await expect(
      store.accept(b.principalId, invite.token),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
  });
});

describe('G2 signed login and scoped sessions', () => {
  it('rejects wrong signer, concurrent replay, audience confusion and expiration', async () => {
    const a = account();
    const b = account();
    const c = await store.challenge({ wallet: a.address, audience: 'native' });
    const typed = {
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    };
    await expect(
      store.login(c.id, await b.signTypedData(typed)),
    ).rejects.toMatchObject({ code: 'INVALID_LOGIN' });
    const signature = await a.signTypedData(typed);
    const results = await Promise.allSettled([
      store.login(c.id, signature),
      store.login(c.id, signature),
    ]);
    const success = results.filter((r) => r.status === 'fulfilled');
    expect(success).toHaveLength(1);
    const session = success[0]!;
    if (session.status !== 'fulfilled') throw new Error('missing session');
    await expect(
      store.session(session.value.token, 'web'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    clock += 900;
    await expect(
      store.session(session.value.token, 'native'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(store.login(c.id, signature)).rejects.toMatchObject({
      code: 'INVALID_LOGIN',
    });
  });
  it('stores token hashes, revokes on logout, and rate limits across restarts', async () => {
    const a = await login();
    expect(
      (
        await pool.query('SELECT 1 FROM synq_ws_sessions WHERE digest=$1', [
          a.token,
        ])
      ).rowCount,
    ).toBe(0);
    await store.logout(a.token);
    await expect(store.session(a.token, 'native')).rejects.toThrow();
    const bucket = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.throttle(bucket, 3)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    await expect(
      new PostgresWorkspaceStore(pool, origin, () => clock).throttle(bucket, 3),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('rejects expired challenges and changes of origin', async () => {
    const a = account();
    const c = await store.challenge({ wallet: a.address });
    const signature = await a.signTypedData({
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    });
    await expect(
      new PostgresWorkspaceStore(pool, 'https://other.test', () => clock).login(
        c.id,
        signature,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LOGIN' });
    clock += 300;
    await expect(store.login(c.id, signature)).rejects.toMatchObject({
      code: 'INVALID_LOGIN',
    });
  });
  it('enforces API schemas, HttpOnly cookies, CSRF, native audience and tenant isolation', async () => {
    const app = Fastify();
    registerWorkspaceRoutes(app, store);
    try {
      const user = await login(account(), 'web');
      const stranger = await login();
      const cookie = `__Host-synq_workspace=${user.token}`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v2/workspaces',
            headers: { cookie },
            payload: { displayName: 'API', kind: 'GROUP' },
          })
        ).statusCode,
      ).toBe(403);
      const created = await app.inject({
        method: 'POST',
        url: '/v2/workspaces',
        headers: { cookie, origin },
        payload: { displayName: 'API', kind: 'GROUP' },
      });
      expect(created.statusCode).toBe(200);
      const id = created.json().workspace.id as string;
      expect(
        (
          await app.inject({
            url: `/v2/workspaces/${id}`,
            headers: { authorization: `Bearer ${stranger.token}` },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: '/v2/workspaces',
            headers: { authorization: `Bearer ${user.token}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url: '/v2/workspaces/not-a-uuid',
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(400);
      const a = account();
      const c = await store.challenge({ wallet: a.address });
      const signature: Hex = await a.signTypedData({
        ...loginTypedData(c),
        message: {
          ...loginTypedData(c).message,
          wallet: getAddress(c.wallet),
          expiresAt: BigInt(c.expiresAt),
        },
      });
      const session = await app.inject({
        method: 'POST',
        url: '/v2/auth/session',
        headers: { origin },
        payload: { challengeId: c.id, signature },
      });
      expect(session.statusCode).toBe(200);
      expect(session.headers['set-cookie']).toContain(
        'HttpOnly; Secure; SameSite=Strict',
      );
      expect(session.json()).not.toHaveProperty('token');
    } finally {
      await app.close();
    }
  });
});
