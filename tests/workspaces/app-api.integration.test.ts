import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, zeroAddress } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { vaultSetupTypedData } from '@synq/kernel/arc-vault-setup';
import { WorkspaceVaultSetups } from '../../packages/workspaces/src/vault-setup.js';
import { AppApprovals } from '../../apps/demo/src/app-approvals.js';
import { WorkspaceLeads } from '../../packages/workspaces/src/leads.js';
import { WorkspaceOffers } from '../../packages/workspaces/src/offers.js';
import {
  InboxPageSchema,
  LeadDetailSchema,
  LeadInviteSchema,
  ApprovalPageSchema,
  SignatureResultSchema,
  SigningRequestSchema,
  WorkspaceOverviewSchema,
  ContextsSchema,
  CircleDetailSchema,
  CirclePageSchema,
  DeviceSessionSchema,
  MetaSchema,
  PersonalOverviewSchema,
  SessionListSchema,
} from '@synq/contracts';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

const origin = 'https://synq.test';
let pool: Pool;
let store: PostgresWorkspaceStore;
let app: FastifyInstance;
let clock = 2_000_000_000;
const account = () => privateKeyToAccount(generatePrivateKey());
const device = (name = 'Test iPhone') => ({
  deviceId: randomUUID(),
  name,
  platform: 'ios' as const,
});
const key = () => ({ 'idempotency-key': randomUUID() });
// Sign-in routes are throttled per IP; give each test request its own address.
let ip = 0;
const from = () => `10.0.${Math.floor(++ip / 250)}.${ip % 250}`;

async function signedChallenge(
  a = account(),
  audience: 'web' | 'native' = 'native',
) {
  const c = await store.challenge({ wallet: a.address, audience });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  return { a, challengeId: c.id, signature };
}

async function deviceSession(a = account(), d = device()) {
  const s = await signedChallenge(a);
  const r = await app.inject({
    method: 'POST',
    url: '/v3/auth/device-session',
    remoteAddress: from(),
    payload: { challengeId: s.challengeId, signature: s.signature, device: d },
  });
  expect(r.statusCode).toBe(200);
  return { a, d, session: DeviceSessionSchema.parse(r.json()) };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  await store.migrate();
  app = Fastify();
  registerWorkspaceRoutes(app, store);
  registerAppRoutes(app, {
    store,
    devices: new WorkspaceDeviceSessions(store),
  });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('v3 device sessions', () => {
  it('signs a phone in with a native challenge and lets the access token use /v2 and /v3', async () => {
    const { session } = await deviceSession();
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(session.accessToken),
        })
      ).statusCode,
    ).toBe(200);
    const sessions = SessionListSchema.parse(
      (
        await app.inject({
          url: '/v3/auth/sessions',
          headers: bearer(session.accessToken),
        })
      ).json(),
    );
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]!.current).toBe(true);
  });

  it('refuses a web-audience challenge and a replayed challenge', async () => {
    const web = await signedChallenge(account(), 'web');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/device-session',
          payload: {
            challengeId: web.challengeId,
            signature: web.signature,
            device: device(),
          },
        })
      ).statusCode,
    ).toBe(401);
    const s = await signedChallenge();
    const body = {
      challengeId: s.challengeId,
      signature: s.signature,
      device: device(),
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/device-session',
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/device-session',
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('rotates refresh tokens, kills the old access token, and revokes the session when an old refresh token comes back', async () => {
    const { d, session } = await deviceSession();
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v3/auth/refresh',
      payload: { deviceId: d.deviceId, refreshToken: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const next = DeviceSessionSchema.parse(refreshed.json());
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(session.accessToken),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(next.accessToken),
        })
      ).statusCode,
    ).toBe(200);
    // Someone replays the first refresh token: the whole device session ends.
    const replay = await app.inject({
      method: 'POST',
      url: '/v3/auth/refresh',
      payload: { deviceId: d.deviceId, refreshToken: session.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('SESSION_REVOKED');
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(next.accessToken),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/refresh',
          payload: { deviceId: d.deviceId, refreshToken: next.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('refuses a refresh token presented with another device id and expires access after 15 minutes', async () => {
    const { session } = await deviceSession();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/refresh',
          payload: {
            deviceId: randomUUID(),
            refreshToken: session.refreshToken,
          },
        })
      ).statusCode,
    ).toBe(401);
    clock += 901;
    try {
      expect(
        (
          await app.inject({
            url: '/v2/auth/me',
            headers: bearer(session.accessToken),
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      clock -= 901;
    }
  });

  it('signs in from a one-time web code exactly once', async () => {
    const a = account();
    const web = await signedChallenge(a, 'web');
    const webSession = await store.login(web.challengeId, web.signature);
    const { code } = await store.nativeCode(webSession.principalId);
    const first = await app.inject({
      method: 'POST',
      url: '/v3/auth/device-session/code',
      payload: { code, device: device() },
    });
    expect(first.statusCode).toBe(200);
    expect(DeviceSessionSchema.parse(first.json()).principalId).toBe(
      webSession.principalId,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/device-session/code',
          payload: { code, device: device() },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('replaces the old session when the same device signs in again, and revoke-all ends every session', async () => {
    const a = account();
    const d = device();
    const first = await deviceSession(a, d);
    const second = await deviceSession(a, d);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(first.session.accessToken),
        })
      ).statusCode,
    ).toBe(401);
    const other = await deviceSession(a, device('Second phone'));
    const web = await signedChallenge(a, 'web');
    const webSession = await store.login(web.challengeId, web.signature);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/revoke-all',
          headers: bearer(other.session.accessToken),
        })
      ).statusCode,
    ).toBe(400);
    const revoked = await app.inject({
      method: 'POST',
      url: '/v3/auth/revoke-all',
      headers: { ...bearer(other.session.accessToken), ...key() },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked).toBe(3);
    for (const t of [second.session.accessToken, other.session.accessToken])
      expect(
        (await app.inject({ url: '/v2/auth/me', headers: bearer(t) }))
          .statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: { cookie: `__Host-synq_workspace=${webSession.token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/refresh',
          payload: {
            deviceId: d.deviceId,
            refreshToken: second.session.refreshToken,
          },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('logs one device out without touching the others', async () => {
    const a = account();
    const one = await deviceSession(a);
    const two = await deviceSession(a, device('Other'));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v3/auth/logout',
          headers: { ...bearer(one.session.accessToken), ...key() },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(one.session.accessToken),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/v2/auth/me',
          headers: bearer(two.session.accessToken),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('v3 contexts and personal view', () => {
  it('reports implemented routes in /v3/meta', async () => {
    const meta = MetaSchema.parse(
      (await app.inject({ url: '/v3/meta' })).json(),
    );
    const status = new Map(meta.routes.map((r) => [r.id, r.status]));
    expect(status.get('personal.overview')).toBe('IMPLEMENTED');
    expect(status.get('workspace.inbox')).toBe('PLANNED');
  });

  it('lists a personal context plus business workspaces only, and circles only for members', async () => {
    const owner = await deviceSession();
    const stranger = await deviceSession();
    const pid = owner.session.principalId;
    const biz = await store.create(pid, {
      displayName: 'Example Studio',
      kind: 'BUSINESS',
    });
    const circle = await store.create(pid, {
      displayName: 'Trip circle',
      kind: 'GROUP',
    });
    await store.create(pid, { displayName: 'Savings', kind: 'PERSONAL' });

    const contexts = ContextsSchema.parse(
      (
        await app.inject({
          url: '/v3/me/contexts',
          headers: bearer(owner.session.accessToken),
        })
      ).json(),
    );
    expect(contexts.contexts.map((c) => c.kind)).toEqual([
      'PERSONAL',
      'BUSINESS',
    ]);
    expect(contexts.contexts[1]!.workspaceId).toBe(biz.workspace.id);
    expect(contexts.contexts[1]!.role).toBe('OWNER');

    const overview = PersonalOverviewSchema.parse(
      (
        await app.inject({
          url: '/v3/personal/overview',
          headers: bearer(owner.session.accessToken),
        })
      ).json(),
    );
    expect(overview.circles.map((c) => c.circleId)).toEqual([
      circle.workspace.id,
    ]);
    expect(overview.vaults.map((v) => v.displayName)).toEqual(['Savings']);
    // No chain reader configured: balances are absent and marked stale, never zero-filled.
    expect(overview.wallets[0]!.balances).toEqual([]);
    expect(overview.wallets[0]!.freshness.stale).toBe(true);

    const page = CirclePageSchema.parse(
      (
        await app.inject({
          url: '/v3/personal/circles?limit=1',
          headers: bearer(owner.session.accessToken),
        })
      ).json(),
    );
    expect(page.items).toHaveLength(1);

    const detail = await app.inject({
      url: `/v3/personal/circles/${circle.workspace.id}`,
      headers: bearer(owner.session.accessToken),
    });
    expect(detail.statusCode).toBe(200);
    const parsed = CircleDetailSchema.parse(detail.json());
    expect(parsed.members).toHaveLength(1);
    expect(parsed.capabilities.groupFunds!.status).toBe('BLOCKED');

    // A stranger, a business id and an unknown id all get the same 404.
    for (const id of [circle.workspace.id, biz.workspace.id, randomUUID()]) {
      const r = await app.inject({
        url: `/v3/personal/circles/${id}`,
        headers: bearer(stranger.session.accessToken),
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe('NOT_FOUND');
    }
    expect(
      (
        await app.inject({
          url: `/v3/personal/circles/${biz.workspace.id}`,
          headers: bearer(owner.session.accessToken),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('pages circles with an opaque cursor and rejects a forged one', async () => {
    const { session } = await deviceSession();
    for (const n of [1, 2, 3])
      await store.create(session.principalId, {
        displayName: `Circle ${n}`,
        kind: 'GROUP',
      });
    const first = CirclePageSchema.parse(
      (
        await app.inject({
          url: '/v3/personal/circles?limit=2',
          headers: bearer(session.accessToken),
        })
      ).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = CirclePageSchema.parse(
      (
        await app.inject({
          url: `/v3/personal/circles?limit=2&cursor=${first.nextCursor}`,
          headers: bearer(session.accessToken),
        })
      ).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await app.inject({
          url: '/v3/personal/circles?cursor=bm90LWEtdXVpZA',
          headers: bearer(session.accessToken),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('refuses requests without a session', async () => {
    for (const url of [
      '/v3/me/contexts',
      '/v3/personal/overview',
      '/v3/personal/circles',
      '/v3/auth/sessions',
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
  });
});

describe('v3 approvals inbox', () => {
  it('lists a vault setup waiting for this owner, gives the exact payload and records the signature', async () => {
    const sponsor = account();
    const setups = new WorkspaceVaultSetups(store, {
      factory: contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY').address,
      token: token('arc-testnet', 'USDC').address,
      sponsor: sponsor.address,
      operator: sponsor.address,
      guardian: zeroAddress,
      maxGasNativeWei: '40',
    });
    const inbox = Fastify();
    registerAppRoutes(inbox, {
      store,
      devices: new WorkspaceDeviceSessions(store),
      approvals: new AppApprovals(store, {
        setups: { service: setups, wake: () => undefined },
      }),
    });
    try {
      const a = await deviceSession();
      const b = await deviceSession();
      const viewer = await deviceSession();
      const { workspace: w } = await store.create(a.session.principalId, {
        displayName: 'Two owners',
        kind: 'GROUP',
      });
      await store.accept(
        b.session.principalId,
        (await store.invite(w.id, a.session.principalId, { role: 'OWNER' }))
          .token,
      );
      await store.accept(
        viewer.session.principalId,
        (await store.invite(w.id, a.session.principalId, { role: 'VIEWER' }))
          .token,
      );
      const proposal = (await setups.propose(w.id, a.session.principalId, {}))!;
      await setups.approve(
        w.id,
        a.session.principalId,
        await a.a.signTypedData(vaultSetupTypedData(proposal.setup)),
      );

      const list = (t: string) =>
        inbox
          .inject({ url: '/v3/approvals', headers: bearer(t) })
          .then((r) => ApprovalPageSchema.parse(r.json()));
      // A already signed and the viewer is not an owner: nothing waits for them.
      expect((await list(a.session.accessToken)).items).toHaveLength(0);
      expect((await list(viewer.session.accessToken)).items).toHaveLength(0);
      const items = (await list(b.session.accessToken)).items;
      expect(items).toHaveLength(1);
      expect(items[0]!.purpose).toBe('VAULT_SETUP');
      expect(items[0]!.approvals).toBe(1);

      const detail = SigningRequestSchema.parse(
        (
          await inbox.inject({
            url: `/v3/approvals/${items[0]!.requestId}`,
            headers: bearer(b.session.accessToken),
          })
        ).json(),
      );
      expect(detail.steps).toHaveLength(1);
      const expected = JSON.parse(
        JSON.stringify(vaultSetupTypedData(proposal.setup), (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      );
      expect(detail.steps[0]!.typedData).toEqual(expected);
      // Another principal cannot read B's request, and an unknown id looks the same.
      for (const [t, id] of [
        [viewer.session.accessToken, items[0]!.requestId],
        [b.session.accessToken, randomUUID()],
      ] as const)
        expect(
          (
            await inbox.inject({
              url: `/v3/approvals/${id}`,
              headers: bearer(t),
            })
          ).statusCode,
        ).toBe(404);

      const url = `/v3/approvals/${items[0]!.requestId}/signature`;
      const good = await b.a.signTypedData(vaultSetupTypedData(proposal.setup));
      // Wrong number of signatures, then a signature from the wrong wallet.
      expect(
        (
          await inbox.inject({
            method: 'POST',
            url,
            headers: { ...bearer(b.session.accessToken), ...key() },
            payload: { signatures: [good, good] },
          })
        ).statusCode,
      ).toBe(400);
      const forged = await viewer.a.signTypedData(
        vaultSetupTypedData(proposal.setup),
      );
      expect(
        (
          await inbox.inject({
            method: 'POST',
            url,
            headers: { ...bearer(b.session.accessToken), ...key() },
            payload: { signatures: [forged] },
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
      const signed = await inbox.inject({
        method: 'POST',
        url,
        headers: { ...bearer(b.session.accessToken), ...key() },
        payload: { signatures: [good] },
      });
      expect(signed.statusCode).toBe(200);
      expect(SignatureResultSchema.parse(signed.json())).toMatchObject({
        status: 'READY',
        approvals: 2,
      });
      expect((await list(b.session.accessToken)).items).toHaveLength(0);
    } finally {
      await inbox.close();
    }
  });

  it('shows a member the business overview and hides it from others', async () => {
    const owner = await deviceSession();
    const stranger = await deviceSession();
    const { workspace: w } = await store.create(owner.session.principalId, {
      displayName: 'Overview Co',
      kind: 'BUSINESS',
    });
    const r = await app.inject({
      url: `/v3/workspaces/${w.id}/overview`,
      headers: bearer(owner.session.accessToken),
    });
    expect(r.statusCode).toBe(200);
    const o = WorkspaceOverviewSchema.parse(r.json());
    expect(o.role).toBe('OWNER');
    expect(o.balances).toEqual([]);
    expect(o.capabilities.leadInbox!.status).toBe('NOT_CONFIGURED');
    expect(
      (
        await app.inject({
          url: `/v3/workspaces/${w.id}/overview`,
          headers: bearer(stranger.session.accessToken),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('v3 leads routes', () => {
  it('invites, lists, reads and takes over a lead through the API', async () => {
    const leads = new WorkspaceLeads(store, {
      webOrigin: origin,
      telegramBot: () => 'asksynqbot',
    });
    await leads.migrate();
    const offers = new WorkspaceOffers(store);
    await offers.migrate();
    const api = Fastify();
    registerAppRoutes(api, {
      store,
      devices: new WorkspaceDeviceSessions(store),
      leads,
      offers,
    });
    try {
      const owner = await deviceSession();
      const outsider = await deviceSession();
      const { workspace: w } = await store.create(owner.session.principalId, {
        displayName: 'Lead Co',
        kind: 'BUSINESS',
      });
      const h = bearer(owner.session.accessToken);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: `/v3/workspaces/${w.id}/lead-invites`,
            headers: h,
            payload: { source: 'TELEGRAM', expiresInSeconds: 3600 },
          })
        ).statusCode,
      ).toBe(400);
      const invite = LeadInviteSchema.parse(
        (
          await api.inject({
            method: 'POST',
            url: `/v3/workspaces/${w.id}/lead-invites`,
            headers: { ...h, ...key() },
            payload: { source: 'TELEGRAM', expiresInSeconds: 3600 },
          })
        ).json(),
      );
      expect(invite.telegramUrl).toMatch(
        /^https:\/\/t\.me\/asksynqbot\?start=lead_/,
      );
      const token = new URL(invite.telegramUrl!).searchParams.get('start')!;
      // An outside web user redeems; it stays a client, not a member.
      const redeemed = await api.inject({
        method: 'POST',
        url: '/v3/lead-invites/redeem',
        headers: { ...bearer(outsider.session.accessToken), ...key() },
        payload: { token },
      });
      expect(redeemed.statusCode).toBe(200);
      const { leadId } = redeemed.json();
      const inbox = InboxPageSchema.parse(
        (
          await api.inject({ url: `/v3/workspaces/${w.id}/inbox`, headers: h })
        ).json(),
      );
      expect(inbox.items.map((l) => l.leadId)).toEqual([leadId]);
      expect(
        (
          await api.inject({
            url: `/v3/workspaces/${w.id}/inbox`,
            headers: bearer(outsider.session.accessToken),
          })
        ).statusCode,
      ).toBe(404);
      const detail = LeadDetailSchema.parse(
        (
          await api.inject({
            url: `/v3/workspaces/${w.id}/leads/${leadId}`,
            headers: h,
          })
        ).json(),
      );
      expect(detail.handlingVersion).toBe(0);
      const takeover = (expectedVersion: number) =>
        api.inject({
          method: 'POST',
          url: `/v3/workspaces/${w.id}/leads/${leadId}/takeover`,
          headers: { ...h, ...key() },
          payload: { action: 'HUMAN_TAKEOVER', expectedVersion },
        });
      expect((await takeover(0)).statusCode).toBe(200);
      const stale = await takeover(0);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('VERSION_CONFLICT');
      const meta = MetaSchema.parse(
        (await api.inject({ url: '/v3/meta' })).json(),
      );
      expect(meta.routes.find((r) => r.id === 'workspace.inbox')!.status).toBe(
        'IMPLEMENTED',
      );
    } finally {
      await api.close();
    }
  });
});
