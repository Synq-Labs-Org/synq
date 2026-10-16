import { createHash, randomUUID, randomInt, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, zeroAddress, type Hex } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { vaultSetupTypedData } from '@synq/kernel/arc-vault-setup';
import { WorkspaceVaultSetups } from '../../packages/workspaces/src/vault-setup.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';
import { durablePool, testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

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
  pool = await workspacePool(
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
      ).toEqual([1, 2, 3, 4]);
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
  it('hands a short-lived native session off once without persisting plaintext codes', async () => {
    const user = await login();
    const handoff = await store.nativeCode(user.principalId);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_native_handoffs WHERE digest=$1',
          [handoff.code],
        )
      ).rowCount,
    ).toBe(0);
    const results = await Promise.allSettled([
      store.redeemNativeCode(handoff.code),
      store.redeemNativeCode(handoff.code),
    ]);
    const passed = results.filter((r) => r.status === 'fulfilled');
    expect(passed).toHaveLength(1);
    if (passed[0]?.status !== 'fulfilled') throw new Error('no native session');
    expect(
      (await store.session(passed[0].value.token, 'native')).principalId,
    ).toBe(user.principalId);
    await expect(
      store.session(passed[0].value.token, 'web'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const expired = await store.nativeCode(user.principalId);
    clock += 120;
    await expect(store.redeemNativeCode(expired.code)).rejects.toMatchObject({
      code: 'INVALID_NATIVE_CODE',
    });
  });
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

describe('G1 G2 durable vault setup and sponsor ledger', () => {
  function setups() {
    const sponsor = account();
    return new WorkspaceVaultSetups(store, {
      factory: contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY').address,
      token: token('arc-testnet', 'USDC').address,
      sponsor: sponsor.address,
      operator: sponsor.address,
      guardian: zeroAddress,
      maxGasNativeWei: '40',
    });
  }
  async function prepared(
    service: WorkspaceVaultSetups,
    user?: Awaited<ReturnType<typeof login>>,
  ) {
    const u = user ?? (await login());
    const { workspace: w } = await store.create(u.principalId, {
      displayName: 'Vault formation',
      kind: 'GROUP',
    });
    const p = (await service.propose(w.id, u.principalId, {}))!;
    const signature = await u.a.signTypedData(vaultSetupTypedData(p.setup));
    await service.approve(w.id, u.principalId, signature);
    return { u, w, p };
  }
  it('freezes the owner set and accepts only setup signatures from each proposed owner', async () => {
    const a = await login();
    const b = await login();
    const viewer = await login();
    const { workspace: w } = await store.create(a.principalId, {
      displayName: 'Two owners',
      kind: 'GROUP',
    });
    await store.accept(
      b.principalId,
      (await store.invite(w.id, a.principalId, { role: 'OWNER' })).token,
    );
    await store.accept(
      viewer.principalId,
      (await store.invite(w.id, a.principalId, { role: 'VIEWER' })).token,
    );
    const service = setups();
    const proposal = (await service.propose(w.id, a.principalId, {}))!;
    expect(proposal.setup.threshold).toBe(2);
    await expect(service.view(w.id, viewer.principalId)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
    await expect(
      service.approve(w.id, a.principalId, a.signature),
    ).rejects.toMatchObject({ code: 'INVALID_SETUP_SIGNATURE' });
    await expect(
      store.invite(w.id, a.principalId, { role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'OWNER_SETUP_REQUIRED' });
    const first = await service.approve(
      w.id,
      a.principalId,
      await a.a.signTypedData(vaultSetupTypedData(proposal.setup)),
    );
    expect(first?.state).toBe('AWAITING_SIGNATURES');
    const secondSignature = await b.a.signTypedData(
      vaultSetupTypedData(proposal.setup),
    );
    expect(
      (await service.approve(w.id, b.principalId, secondSignature))?.state,
    ).toBe('READY');
    expect(
      (await service.approve(w.id, b.principalId, secondSignature))
        ?.signedOwners,
    ).toHaveLength(2);
    await expect(
      pool.query(
        "UPDATE synq_ws_vault_setups SET data=jsonb_set(data,'{threshold}','1') WHERE workspace_id=$1",
        [w.id],
      ),
    ).rejects.toThrow('immutable');
  });
  it('reserves gas atomically under concurrent creation and keeps unknown outcomes reserved', async () => {
    clock = 2_000_000_000 + randomInt(1, 100_000_000) * 86400;
    const service = setups();
    const a = await prepared(service);
    const b = await prepared(service);
    const results = await Promise.allSettled([
      service.reserveGas(a.w.id, 40n),
      service.reserveGas(b.w.id, 40n),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const day = Math.floor(clock / 86400);
    expect(
      String(
        (
          await pool.query(
            'SELECT used_wei FROM synq_ws_sponsor_days WHERE day=$1',
            [day],
          )
        ).rows[0].used_wei,
      ),
    ).toBe('40');
    const winner = results[0]!.status === 'fulfilled' ? a : b;
    const restarted = new WorkspaceVaultSetups(
      new PostgresWorkspaceStore(pool, origin, () => clock),
      service.defaults,
    );
    await restarted.reserveGas(winner.w.id, 40n);
    expect(
      String(
        (
          await pool.query(
            'SELECT used_wei FROM synq_ws_sponsor_days WHERE day=$1',
            [day],
          )
        ).rows[0].used_wei,
      ),
    ).toBe('40');
    const hash = `0x${randomBytes(32).toString('hex')}` as Hex;
    await restarted.settleGas(winner.w.id, winner.p.setupHash, hash, 7n);
    await restarted.settleGas(winner.w.id, winner.p.setupHash, hash, 7n);
    expect(
      String(
        (
          await pool.query(
            'SELECT used_wei FROM synq_ws_sponsor_days WHERE day=$1',
            [day],
          )
        ).rows[0].used_wei,
      ),
    ).toBe('7');
    await expect(
      restarted.settleGas(winner.w.id, winner.p.setupHash, hash, 6n),
    ).rejects.toMatchObject({ code: 'SPONSOR_RECONCILIATION_MISMATCH' });
    await expect(
      restarted.settleGas(winner.w.id, winner.p.setupHash, hash, -1n),
    ).rejects.toMatchObject({ code: 'SPONSOR_RECONCILIATION_MISMATCH' });
  });
  it('enforces principal creation quotas independently of the gas budget', async () => {
    clock = 2_000_000_000 + randomInt(1, 100_000_000) * 86400;
    const service = setups();
    const user = await login();
    const a = await prepared(service, user);
    const b = await prepared(service, user);
    await service.reserveGas(a.w.id, 1000n, 1);
    await expect(service.reserveGas(b.w.id, 1000n, 1)).rejects.toMatchObject({
      code: 'VAULT_CREATION_RATE_LIMIT',
    });
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_sponsor_reservations WHERE workspace_id=$1',
          [b.w.id],
        )
      ).rowCount,
    ).toBe(0);
    await service.settleGas(
      a.w.id,
      a.p.setupHash,
      `0x${randomBytes(32).toString('hex')}`,
      0n,
    );
  });
  it('carries unresolved gas reservations into a new UTC day before admitting new spend', async () => {
    clock += 10 * 86400;
    const service = setups();
    const a = await prepared(service);
    await service.reserveGas(a.w.id, 60n);
    clock += 86400;
    const b = await prepared(service);
    await expect(service.reserveGas(b.w.id, 60n)).rejects.toMatchObject({
      code: 'SPONSOR_BUDGET_EXHAUSTED',
    });
    // Failed admission rolls the rollover back; recovery of the original reservation commits it.
    await service.reserveGas(a.w.id, 60n);
    const day = Math.floor(clock / 86400);
    expect(
      String(
        (
          await pool.query(
            'SELECT used_wei FROM synq_ws_sponsor_days WHERE day=$1',
            [day],
          )
        ).rows[0].used_wei,
      ),
    ).toBe('40');
    await service.settleGas(
      a.w.id,
      a.p.setupHash,
      `0x${randomBytes(32).toString('hex')}`,
      5n,
    );
    await service.reserveGas(b.w.id, 60n);
    expect(
      String(
        (
          await pool.query(
            'SELECT used_wei FROM synq_ws_sponsor_days WHERE day=$1',
            [day],
          )
        ).rows[0].used_wei,
      ),
    ).toBe('45');
    await service.settleGas(
      b.w.id,
      b.p.setupHash,
      `0x${randomBytes(32).toString('hex')}`,
      5n,
    );
  });
  it('serves JSON-safe setup contracts and never accepts login signatures as vault approval', async () => {
    const user = await login();
    const service = setups();
    const { workspace: w } = await store.create(user.principalId, {
      displayName: 'HTTP setup',
      kind: 'PERSONAL',
    });
    const app = Fastify();
    let wakes = 0;
    registerWorkspaceRoutes(app, store, {
      setups: service,
      wake: () => {
        wakes++;
      },
    });
    const headers = { authorization: `Bearer ${user.token}` };
    try {
      const caps = await app.inject({ url: '/v2/capabilities' });
      expect(caps.json().vaultCreation.status).toBe('AVAILABLE');
      const proposed = await app.inject({
        method: 'POST',
        url: `/v2/workspaces/${w.id}/vault/setup`,
        headers,
        payload: {},
      });
      expect(proposed.statusCode).toBe(200);
      expect(typeof proposed.json().proposal.typedData.message.threshold).toBe(
        'string',
      );
      const bad = await app.inject({
        method: 'POST',
        url: `/v2/workspaces/${w.id}/vault/setup/approve`,
        headers,
        payload: { signature: user.signature },
      });
      expect(bad.statusCode).toBe(403);
      expect(wakes).toBe(0);
      const setup = (await service.record(w.id))!.setup;
      const good = await app.inject({
        method: 'POST',
        url: `/v2/workspaces/${w.id}/vault/setup/approve`,
        headers,
        payload: {
          signature: await user.a.signTypedData(vaultSetupTypedData(setup)),
        },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().proposal.state).toBe('READY');
      expect(wakes).toBe(1);
    } finally {
      await app.close();
    }
  });
});
