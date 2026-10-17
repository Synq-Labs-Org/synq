import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ROUTES, type Route } from '@synq/contracts';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from '../workspaces/pg.js';
import {
  BASE_CLOCK,
  activePolicy,
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
  telegramLead,
  terms,
  type Business,
  type Person,
  type Services,
} from './app-api-world.js';

/*
 * Route-table sweep. Every route in ROUTES needs an entry in SPECS (a new
 * route without one fails "covers every route"). Each entry says how to call
 * it; the sweep then checks, per route:
 *   - no credentials, a forged bearer and a forged cookie get 401;
 *   - a signed-in stranger sees exactly what a nonexistent workspace/id shows;
 *   - roles the route does not allow are refused and never get a 2xx;
 *   - cookie sessions need the site's Origin on every v3 mutation, and bearer
 *     mutations need an Idempotency-Key.
 */

let pool: Pool;
let store: PostgresWorkspaceStore;
let s: Services;
let app: FastifyInstance;
let clock = BASE_CLOCK;

type Ids = Record<string, string>;
type Kind = 'public' | 'principal' | 'owned' | 'workspace' | 'planned';
type Spec = {
  kind: Kind;
  body?: (ids: Ids) => unknown;
  /** Query string appended to the URL. */
  query?: string;
};

const sig = () => `0x${randomBytes(65).toString('hex')}`;
const addr = () => privateKeyToAccount(generatePrivateKey()).address;
const lease = () => `0x${randomBytes(32).toString('hex')}`;

const SPECS: Record<string, Spec> = {
  meta: { kind: 'public' },
  'auth.deviceSession': { kind: 'public', body: () => ({}) },
  'auth.deviceSessionFromCode': { kind: 'public', body: () => ({}) },
  'auth.refresh': { kind: 'public', body: () => ({}) },
  'auth.sessions': { kind: 'principal' },
  'auth.logout': { kind: 'principal', body: () => ({}) },
  'auth.revokeAll': { kind: 'principal', body: () => ({}) },
  'me.contexts': { kind: 'principal' },
  'personal.overview': { kind: 'principal' },
  'personal.circles': { kind: 'principal' },
  'personal.circle': { kind: 'owned' },
  'workspace.overview': { kind: 'workspace' },
  'workspace.inbox': { kind: 'workspace' },
  'workspace.lead': { kind: 'workspace' },
  'workspace.leadMessage': {
    kind: 'workspace',
    body: () => ({ text: 'Hello from staff' }),
  },
  'workspace.leadTakeover': {
    kind: 'workspace',
    body: () => ({ action: 'HUMAN_TAKEOVER', expectedVersion: 0 }),
  },
  'workspace.leadInvite': {
    kind: 'workspace',
    body: () => ({ source: 'WEB', expiresInSeconds: 3600 }),
  },
  'leadInvite.redeem': { kind: 'principal', body: () => ({ token: 'x' }) },
  'workspace.offerValidate': { kind: 'workspace', body: () => ({}) },
  'workspace.leadOffer': {
    kind: 'workspace',
    body: () => ({ terms: terms() }),
  },
  'workspace.commercialPolicies': { kind: 'workspace' },
  'workspace.commercialPolicyPropose': {
    kind: 'workspace',
    body: () => policy(clock),
  },
  'workspace.agentRuns': { kind: 'workspace' },
  'workspace.agentRun': { kind: 'workspace' },
  'workspace.mandates': { kind: 'workspace' },
  'workspace.mandateRevoke': { kind: 'planned', body: () => ({}) },
  'workspace.amaneAccountRegister': {
    kind: 'workspace',
    body: () => ({ account: addr() }),
  },
  'workspace.amaneLeaseRegister': {
    kind: 'workspace',
    body: (i) => ({ accountId: i.accountId, leaseId: i.leaseId }),
  },
  'workspace.amaneJobs': { kind: 'workspace' },
  'workspace.amaneJobCreate': {
    kind: 'workspace',
    body: (i) => ({
      leaseId: i.leaseId,
      triggerKind: 'OWNER_REQUEST',
      triggerRef: `ref-${randomUUID()}`,
      amount: '100',
      purpose: 'attack',
    }),
  },
  'approvals.list': { kind: 'principal' },
  'approvals.get': { kind: 'owned' },
  'approvals.sign': {
    kind: 'owned',
    body: () => ({ signatures: [sig()] }),
  },
  'notifications.list': { kind: 'principal' },
  'notifications.read': {
    kind: 'principal',
    body: () => ({ notificationIds: [randomUUID()] }),
  },
  'devices.register': {
    kind: 'principal',
    body: () => ({
      deviceId: randomUUID(),
      apnsToken: randomBytes(32).toString('hex'),
      environment: 'SANDBOX',
      locale: 'en-GB',
      mutedCategories: [],
      quietHours: null,
    }),
  },
  'devices.revoke': { kind: 'owned', body: () => ({}) },
  'events.stream': { kind: 'principal' },
  'events.poll': { kind: 'principal' },
};

let A: Business;
let B: Business;
let real: Ids;
let ghost: Ids;
const roles = {} as Record<'ADMIN' | 'MEMBER' | 'VIEWER', Person>;
let stranger: Person;
let webUser: Person;

const pathOf = (r: Route, ids: Ids) =>
  r.path.replace(/\{(\w+)\}/g, (_m, k: string) => ids[k] ?? 'missing');

async function call(
  r: Route,
  ids: Ids,
  headers: Record<string, string> = {},
  mutationKey = true,
) {
  const spec = SPECS[r.id]!;
  // Requests are throttled per principal; each call starts a fresh window.
  await pool.query('DELETE FROM synq_ws_rate_limits');
  return app.inject({
    method: r.method,
    url: pathOf(r, ids) + (spec.query ?? ''),
    headers: {
      ...(r.method === 'POST' && mutationKey ? idem() : {}),
      ...headers,
    },
    ...(spec.body ? { payload: spec.body(ids) as object } : {}),
    remoteAddress: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
}
const shape = (res: { statusCode: number; json: () => unknown }) => {
  let error: unknown = null;
  try {
    error = (res.json() as { error?: unknown }).error ?? null;
  } catch {
    error = 'NOT_JSON';
  }
  return { status: res.statusCode, error };
};
const allowedRoles = (r: Route) =>
  (['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const).filter((x) =>
    r.roles.includes(x),
  );

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  s = await services(store);
  app = buildApp(s);
  A = await business(s, undefined, 'Tenant A');
  B = await business(s, undefined, 'Tenant B');
  stranger = B.owner;
  for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const)
    roles[role] = await joined(s, A, role);
  webUser = await login(store, 'web');

  await activePolicy(s, A, clock);
  const lead = await telegramLead(s, A);
  const sent = await s.offers.send({
    workspaceId: A.workspaceId,
    leadId: lead.leadId,
    terms: terms(),
    actor: { kind: 'AGENT' },
  });
  if (!sent.sent) throw new Error('fixture offer was not sent');
  // A second policy version waits for the owner's signature.
  const pending = await s.offers.proposePolicy(
    A.workspaceId,
    A.owner.principalId,
    policy(clock, { maxDiscountBps: 500 }),
  );
  const requests = await s.approvals.pending(
    A.owner.principalId,
    A.owner.a.address,
  );
  const request = requests.find((p) => p.item.workspaceId === A.workspaceId);
  if (!request || pending.state !== 'REVIEW')
    throw new Error('fixture approval missing');
  const run = await s.events.run(A.workspaceId, 'sweep', {
    title: 'sweep',
    trigger: 'OTHER',
  });
  const { workspace: circle } = await store.create(A.owner.principalId, {
    displayName: 'Circle A',
    kind: 'GROUP',
  });
  const deviceId = randomUUID();
  await s.notifications.registerDevice(A.owner.principalId, {
    deviceId,
    apnsToken: randomBytes(32).toString('hex'),
    environment: 'SANDBOX',
    locale: 'en-GB',
    mutedCategories: [],
    quietHours: null,
  });
  // An Amane account, lease and job for tenant A (rows only; no chain here).
  const accountId = randomUUID();
  const leaseId = lease();
  await pool.query(
    `INSERT INTO synq_amane_accounts(id,workspace_id,chain_id,account,code_hash,token,recipient,adapter_id,root,root_hash,state,created_by,created_at)
     VALUES($1,$2,31337,$3,$4,$5,$6,$7,'{}'::jsonb,$8,'ACTIVE',$9,$10)`,
    [
      accountId,
      A.workspaceId,
      addr(),
      lease(),
      addr(),
      addr(),
      lease(),
      lease(),
      A.owner.principalId,
      clock,
    ],
  );
  await pool.query(
    `INSERT INTO synq_amane_leases(lease_id,account_id,workspace_id,agent,lease,state,created_at)
     VALUES($1,$2,$3,$4,$5::jsonb,'ACTIVE',$6)`,
    [
      leaseId,
      accountId,
      A.workspaceId,
      addr(),
      JSON.stringify({ perAction: '1000', expiresAt: String(clock + 3600) }),
      clock,
    ],
  );
  real = {
    workspaceId: A.workspaceId,
    leadId: lead.leadId,
    offerId: sent.offer.offerId,
    version: '1',
    runId: run,
    leaseId,
    accountId,
    requestId: request.item.requestId,
    circleId: circle.id,
    deviceId,
  };
  ghost = Object.fromEntries(
    Object.keys(real).map((k) => [k, k === 'version' ? '1' : randomUUID()]),
  ) as Ids;
  ghost.leaseId = lease();
}, 60_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const guarded = ROUTES.filter((r) => r.auth !== 'none');

describe('route table coverage', () => {
  it('covers every route in the contract, and nothing that is not there', () => {
    expect(Object.keys(SPECS).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });

  it('fails closed on the shape of the table itself', () => {
    for (const r of ROUTES) {
      const spec = SPECS[r.id]!;
      // Anything with an id in its path is attacked as a cross-tenant id.
      if (/\{(workspaceId|circleId|requestId|deviceId)\}/.test(r.path))
        expect(['workspace', 'owned', 'planned']).toContain(spec.kind);
      if (r.auth === 'none') expect(spec.kind).toBe('public');
      if (r.method === 'POST' && r.auth !== 'none')
        expect(spec.body, r.id).toBeDefined();
    }
  });
});

describe('unauthenticated and forged callers', () => {
  const impls = guarded.filter((r) => SPECS[r.id]!.kind !== 'planned');
  it.each(impls.map((r) => [r.id, r] as const))(
    '%s refuses no credentials, forged bearers and forged cookies',
    async (_id, r) => {
      const ids = real;
      const forged = [
        {},
        bearer(randomBytes(32).toString('hex')),
        { authorization: 'Bearer ' },
        { authorization: 'Bearer not-a-token' },
        { authorization: `bearer ${randomBytes(32).toString('hex')}` },
        { authorization: `Basic ${randomBytes(8).toString('base64')}` },
        { authorization: `Bearer ${"' OR 1=1 --".padEnd(64, 'a')}` },
        cookie(randomBytes(32).toString('hex')),
        { cookie: '__Host-synq_workspace=' },
        { cookie: 'synq=1; other=2' },
        // Another cookie jar's name does not authenticate.
        { cookie: `session=${randomBytes(32).toString('hex')}` },
      ];
      for (const h of forged) {
        const res = await call(r, ids, {
          ...h,
          ...(r.method === 'POST' ? { origin } : {}),
        });
        expect(res.statusCode, JSON.stringify(h)).toBe(401);
      }
    },
  );

  it('does not accept a real token in the wrong place', async () => {
    const native = stranger.token;
    const web = webUser.token;
    const get = (h: Record<string, string>) =>
      app.inject({ url: '/v3/me/contexts', headers: h });
    expect((await get(bearer(native))).statusCode).toBe(200);
    expect((await get(cookie(web))).statusCode).toBe(200);
    // Audience is part of the session: a web token is not a bearer, nor the reverse.
    expect((await get(bearer(web))).statusCode).toBe(401);
    expect((await get(cookie(native))).statusCode).toBe(401);
    // Two cookies of the same name never pick one for you.
    expect(
      (
        await get({
          cookie: `__Host-synq_workspace=${web}; __Host-synq_workspace=${web}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('cross-tenant ids look like nothing', () => {
  const tenant = ROUTES.filter((r) =>
    ['workspace', 'owned'].includes(SPECS[r.id]!.kind),
  );
  it.each(tenant.map((r) => [r.id, r] as const))(
    '%s gives a stranger exactly the answer for a nonexistent id',
    async (_id, r) => {
      const h = bearer(stranger.token);
      const spec = SPECS[r.id]!;
      const strangerReal = await call(r, real, h);
      const strangerGhost = await call(r, ghost, h);
      expect(shape(strangerReal)).toEqual(shape(strangerGhost));
      expect(strangerReal.statusCode).toBeGreaterThanOrEqual(400);
      expect(strangerReal.statusCode).toBeLessThan(500);
      // No tenant data in the refusal.
      for (const v of Object.values(real))
        if (v.length > 8) expect(strangerReal.body).not.toContain(v);

      // The stranger's own workspace with tenant A's child ids is also nothing.
      if (
        spec.kind === 'workspace' &&
        /\{(\w+Id)\}/.test(r.path.replace('{workspaceId}', ''))
      ) {
        const mine = { ...real, workspaceId: B.workspaceId };
        const mineGhost = { ...ghost, workspaceId: B.workspaceId };
        const a = await call(r, mine, h);
        const b = await call(r, mineGhost, h);
        expect(shape(a)).toEqual(shape(b));
        expect(a.statusCode).toBeGreaterThanOrEqual(400);
      }
    },
  );

  it('proves the fixtures are real: tenant A reaches its own data', async () => {
    const h = bearer(A.owner.token);
    for (const id of [
      'workspace.overview',
      'workspace.inbox',
      'workspace.lead',
      'workspace.commercialPolicies',
      'workspace.agentRuns',
      'workspace.agentRun',
      'workspace.mandates',
      'workspace.amaneJobs',
      'personal.circle',
      'approvals.get',
    ]) {
      const r = ROUTES.find((x) => x.id === id)!;
      const res = await call(r, real, h);
      expect(res.statusCode, id).toBe(200);
    }
  });
});

describe('roles', () => {
  const workspaceRoutes = ROUTES.filter(
    (r) => SPECS[r.id]!.kind === 'workspace',
  );
  it.each(workspaceRoutes.map((r) => [r.id, r] as const))(
    '%s refuses the roles it does not list',
    async (_id, r) => {
      const allowed = allowedRoles(r);
      for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
        if (allowed.includes(role)) continue;
        const res = await call(r, real, bearer(roles[role].token));
        expect([403, 404], `${r.id} as ${role}`).toContain(res.statusCode);
        // The refusal is a bare error code: no tenant data rides along. (A
        // member may see a different refusal code from a stranger's; strangers
        // are held to the nonexistent-id answer in the cross-tenant suite.)
        expect(Object.keys(res.json()).sort()).toEqual(['error', 'message']);
        for (const v of Object.values(real))
          if (v.length > 8) expect(res.body).not.toContain(v);
      }
    },
  );

  it('does not let a role listed on a read route write', async () => {
    // A VIEWER can read the overview but not issue invites or policies.
    const viewer = bearer(roles.VIEWER.token);
    for (const id of [
      'workspace.leadInvite',
      'workspace.commercialPolicyPropose',
      'workspace.amaneJobCreate',
    ]) {
      const r = ROUTES.find((x) => x.id === id)!;
      expect([403, 404]).toContain((await call(r, real, viewer)).statusCode);
    }
  });
});

describe('cookie sessions and idempotency on mutations', () => {
  const mutations = guarded.filter(
    (r) => r.method === 'POST' && SPECS[r.id]!.kind !== 'planned',
  );
  it.each(mutations.map((r) => [r.id, r] as const))(
    '%s needs the site Origin for a cookie and an Idempotency-Key',
    async (_id, r) => {
      // A fresh session: some of these routes end the session they run on.
      const c = cookie((await login(store, 'web')).token);
      for (const o of [
        undefined,
        'https://evil.example',
        'null',
        `${origin}.evil.example`,
        `${origin}/`,
        origin.replace('https', 'http'),
        origin.toUpperCase(),
      ]) {
        const res = await call(r, real, { ...c, ...(o ? { origin: o } : {}) });
        expect(res.statusCode, `origin ${o}`).toBe(403);
        expect(res.json().error).toBe('ORIGIN_MISMATCH');
      }
      // The right origin gets past authentication (the route then decides).
      const ok = await call(r, real, { ...c, origin });
      expect(ok.statusCode).not.toBe(401);
      expect(ok.json().error ?? '').not.toBe('ORIGIN_MISMATCH');
      // A Bearer client has no ambient credential, so it needs no Origin...
      const native = await call(r, real, bearer(stranger.token));
      expect(native.json().error ?? '').not.toBe('ORIGIN_MISMATCH');
      // ...but every v3 mutation needs an Idempotency-Key, from either client.
      for (const h of [bearer(stranger.token), { ...c, origin }]) {
        for (const k of [undefined, '', 'not-a-uuid', ' '.repeat(36)]) {
          const res = await call(
            r,
            real,
            { ...h, ...(k === undefined ? {} : { 'idempotency-key': k }) },
            false,
          );
          expect(res.statusCode, `key ${String(k)}`).toBe(400);
          expect(res.json().error).toBe('IDEMPOTENCY_KEY_REQUIRED');
        }
      }
    },
  );

  it('refuses a cookie mutation whose Origin is only a prefix or substring match', async () => {
    const r = ROUTES.find((x) => x.id === 'auth.logout')!;
    for (const o of [
      `${origin}:8443`,
      `https://x${origin.slice(8)}`,
      `${origin}@evil.example`,
    ]) {
      const res = await call(r, real, { ...cookie(webUser.token), origin: o });
      expect(res.statusCode).toBe(403);
    }
    // The failed attempts did not end the session.
    expect(
      (
        await app.inject({
          url: '/v3/auth/sessions',
          headers: cookie(webUser.token),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('public routes never fail open or crash on hostile input', () => {
  const pub = ROUTES.filter((r) => SPECS[r.id]!.kind === 'public');
  const hostile: unknown[] = [
    {},
    [],
    null,
    'text',
    { __proto__: { admin: true } },
    { challengeId: randomUUID(), signature: '0x' + '0'.repeat(130) },
    { deviceId: randomUUID(), refreshToken: 'a'.repeat(64) },
    {
      code: 'a'.repeat(48),
      device: { deviceId: 'x', name: '', platform: 'x' },
    },
  ];
  it.each(
    pub.filter((r) => r.method === 'POST').map((r) => [r.id, r] as const),
  )('%s answers 4xx to garbage and never 2xx or 5xx', async (_id, r) => {
    for (const body of hostile) {
      const res = await app.inject({
        method: 'POST',
        url: r.path,
        payload: body as object,
        remoteAddress: `10.2.${Math.floor(Math.random() * 250)}.1`,
      });
      expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
  });

  it('throttles repeated anonymous attempts from one address', async () => {
    const ip = '10.9.9.9';
    await pool.query('DELETE FROM synq_ws_rate_limits');
    const codes: number[] = [];
    for (let i = 0; i < 25; i++)
      codes.push(
        (
          await app.inject({
            method: 'POST',
            url: '/v3/auth/refresh',
            payload: { deviceId: randomUUID(), refreshToken: 'b'.repeat(64) },
            remoteAddress: ip,
          })
        ).statusCode,
      );
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
  });
});
