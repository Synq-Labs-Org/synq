import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  MemoryIdentityStore,
  MembershipService,
  PrincipalService,
  StoreMembershipDirectory,
} from '@synq/identity/server';
import {
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
  signMeraSendAccess,
} from '@synq/identity/mera-browser';
import { MemorySendStore, type FundingActivities } from '@synq/funding';
import { createSendMemberAccess } from '../../apps/api/src/send-access.js';
import {
  sendRoutes,
  type SendRouteDeps,
} from '../../apps/api/src/send-routes.js';
import { fundingRoutes } from '../../apps/api/src/funding-routes.js';
import { mandateRoutes } from '../../apps/api/src/mandate-routes.js';
import { registerWorldRoute } from '../../apps/api/src/world-route.js';
import type { MemberAccess } from '../../apps/api/src/member-scope.js';
import type { MandateProposalService } from '../../apps/api/src/mandate-proposals.js';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import {
  DeterministicAuthenticator,
  addr,
  fixtureAccounts,
  word,
} from '../identity/fixtures.js';
import { sandboxMandate } from '../api/kernel-fixture.js';

const ADMIN = 'operator-admin-token-for-tests-0123456789abcdef';

async function world(
  opts: {
    proposalRateLimit?: Parameters<
      typeof mandateRoutes
    >[1]['proposalRateLimit'];
  } = {},
) {
  let clock = 5_000;
  const identity = new MemoryIdentityStore();
  const config = {
    profile: 'sandbox/monad-testnet' as const,
    rpId: 'synq.test',
    origin: 'https://synq.test',
    now: () => clock,
  };
  const principals = new PrincipalService(identity, config);
  const membership = new MembershipService(identity, config);
  const authenticator = new DeterministicAuthenticator('member-scope-fixture');
  const enrolled = await enrollMeraPrincipal(
    {
      rpId: config.rpId,
      rpName: 'Synq',
      user: { name: 'alice', displayName: 'Alice' },
      requestChallenge: ({ signer, credential }) =>
        principals.issueEnrollmentChallenge({
          kind: 'MERA_HUMAN',
          signer,
          credential: {
            ...credential,
            transports: [...(credential.transports ?? [])],
          },
          rpId: config.rpId,
          origin: config.origin,
        }),
    },
    { webAuthnClient: authenticator },
  );
  await principals.enroll({
    challengeId: enrolled.challenge.challengeId,
    signature: enrolled.signature,
  });
  const alice = enrolled.record.signer.toLowerCase() as `0x${string}`;
  const bob = fixtureAccounts[1]!.address.toLowerCase() as `0x${string}`;
  const groups: `0x${string}`[] = [word(901), word(902)];
  const account = (g: string) => (g === groups[0] ? addr(910) : addr(920));
  for (const groupId of groups) {
    await membership.createGroup({
      groupId,
      chainGroupId: groupId,
      chainId: 10143,
      account: account(groupId),
      owners: [alice, bob],
      threshold: 2,
    });
    const join = await membership.issueJoinChallenge({
      groupId,
      memberId: 'alice',
      principalId: enrolled.record.principalId,
    });
    await membership.join({
      groupId,
      challengeId: join.challengeId,
      signature: await signMeraIdentityChallenge(enrolled.record, join, {
        webAuthnClient: authenticator,
      }),
    });
  }
  const members = [
    { memberId: 'alice', signer: alice },
    { memberId: 'bob', signer: bob },
  ];
  const context = async (g: string) =>
    groups.includes(g as `0x${string}`)
      ? {
          groupId: g,
          mandate: sandboxMandate(
            {
              groupId: g,
              chainGroupId: g as `0x${string}`,
              account: account(g),
              executor: addr(930),
              recipient: addr(931),
              members,
            },
            clock,
          ),
          members: members.map((m) => ({
            ...m,
            principalId:
              m.memberId === 'alice'
                ? enrolled.record.principalId
                : `mera:${m.signer}`,
          })),
          contacts: [],
        }
      : null;
  const access = createSendMemberAccess({
    directory: new StoreMembershipDirectory(identity),
    context,
    now: () => clock,
  });
  const planned: unknown[] = [];
  const sessions = new Map<
    string,
    { groupId: string; quote: { sourceSender: string } }
  >([
    [word(950), { groupId: groups[0]!, quote: { sourceSender: bob } }],
    [word(951), { groupId: groups[0]!, quote: { sourceSender: alice } }],
  ]);
  const activities = {
    planRoute: async (r: unknown) => {
      planned.push(r);
      return { status: 'UNROUTED', reasons: ['test'] };
    },
    authorize: async (id: string) => ({
      sessionId: id,
      state: 'USER_AUTHORIZED',
    }),
  } as unknown as FundingActivities;
  const proposals: unknown[] = [];
  const service = {
    propose: async (input: { proposedBy: unknown }) => {
      proposals.push(input.proposedBy);
      throw new Error('stop after authorization');
    },
  } as unknown as MandateProposalService;

  const api = Fastify();
  await api.register(sendRoutes, {
    store: new MemorySendStore(),
    adminToken: ADMIN,
    now: () => clock,
    memberAccess: access,
    groups: { context },
  } as unknown as SendRouteDeps);
  await api.register(fundingRoutes, {
    activities,
    sessions: {
      get: async (id: string) => (sessions.get(id) as never) ?? null,
    },
    context,
    now: () => clock,
    adminToken: ADMIN,
    memberAccess: access,
    receipt: async () => {
      throw new Error('unused');
    },
  });
  await api.register(mandateRoutes, {
    service,
    adminToken: ADMIN,
    memberAccess: access,
    clockMs: () => clock * 1000,
    ...(opts.proposalRateLimit
      ? { proposalRateLimit: opts.proposalRateLimit }
      : {}),
  });
  await api.ready();
  const v1 = createV1Api({
    store: identity,
    config,
    adminToken: ADMIN,
    executionModules: { 10143: addr(940) },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  await v1.ready();

  const signIn = async (groupId: string, scope?: string) => {
    const c = await api.inject({
      method: 'POST',
      url: '/v1/send/access/challenges',
      payload: {
        groupId,
        principalId: enrolled.record.principalId,
        ...(scope ? { scope } : {}),
      },
    });
    expect(c.statusCode).toBe(201);
    const challenge = c.json();
    const signature = await signMeraSendAccess(enrolled.record, challenge, {
      webAuthnClient: authenticator,
    });
    return { challenge, signature };
  };
  const issue = (challengeId: string, signature: string) =>
    api.inject({
      method: 'POST',
      url: '/v1/send/access',
      payload: { challengeId, signature },
    });
  const token = async (groupId: string, scope?: string) => {
    const { challenge, signature } = await signIn(groupId, scope);
    const r = await issue(challenge.challengeId, signature);
    expect(r.statusCode).toBe(201);
    return r.json().token as string;
  };
  const quote = (groupId: string, sender: string, bearer: string) =>
    api.inject({
      method: 'POST',
      url: '/v1/funding/quotes',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        requestId: 'member-scope-1',
        groupId,
        destination: {
          chainId: 10143,
          account: account(groupId),
          token: {
            chainId: 10143,
            address: addr(960),
            symbol: 'AUSD',
            decimals: 6,
          },
        },
        source: {
          token: {
            chainId: 10143,
            address: addr(960),
            symbol: 'AUSD',
            decimals: 6,
          },
          amount: '1000000',
          sender,
          refundTo: sender,
        },
        maxSlippageBps: 0,
        now: clock,
      },
    });
  return {
    api,
    v1,
    access,
    groups,
    alice,
    bob,
    token,
    signIn,
    issue,
    quote,
    planned,
    proposals,
    tick: (s: number) => (clock += s),
    close: async () => {
      await api.close();
      await v1.close();
    },
  };
}

describe('member-scoped Synq credentials (H2)', () => {
  it('a member session funds only from its own signer, only in its own group', async () => {
    const w = await world();
    try {
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      expect((await w.quote(w.groups[0]!, w.alice, t)).statusCode).toBe(422);
      expect(w.planned).toHaveLength(1);
      expect((await w.quote(w.groups[0]!, w.bob, t)).statusCode).toBe(401);
      expect((await w.quote(w.groups[1]!, w.alice, t)).statusCode).toBe(401);
      const auth = { authorization: `Bearer ${t}` };
      const own = await w.api.inject({
        method: 'POST',
        url: `/v1/funding/${word(951)}/authorize`,
        headers: auth,
      });
      expect(own.statusCode).toBe(200);
      const foreign = await w.api.inject({
        method: 'POST',
        url: `/v1/funding/${word(950)}/authorize`,
        headers: auth,
      });
      expect(foreign.statusCode).toBe(401);
      const unknown = await w.api.inject({
        method: 'GET',
        url: `/v1/funding/${word(952)}`,
        headers: auth,
      });
      expect(unknown.statusCode).toBe(401);
      expect(w.planned).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('read-only sessions cannot fund or propose', async () => {
    const w = await world();
    try {
      const t = await w.token(w.groups[0]!);
      expect((await w.quote(w.groups[0]!, w.alice, t)).statusCode).toBe(401);
      const p = await w.api.inject({
        method: 'POST',
        url: '/v1/mandate-proposals',
        headers: { authorization: `Bearer ${t}` },
        payload: { groupId: w.groups[0], mandate: {}, change: 'NEW' },
      });
      expect(p.statusCode).toBe(401);
      expect(w.proposals).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('member proposals are attributed to the member and bound to the group', async () => {
    const w = await world();
    try {
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      const post = (groupId: string) =>
        w.api.inject({
          method: 'POST',
          url: '/v1/mandate-proposals',
          headers: { authorization: `Bearer ${t}` },
          payload: { groupId, mandate: {}, change: 'NEW' },
        });
      expect((await post(w.groups[1]!)).statusCode).toBe(401);
      await expect(post(w.groups[0]!)).resolves.toBeDefined();
      expect(w.proposals).toEqual([{ memberId: 'alice', source: 'MEMBER' }]);
    } finally {
      await w.close();
    }
  });

  it('member sessions never satisfy admin-only routes', async () => {
    const w = await world();
    try {
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      const headers = {
        authorization: `Bearer ${t}`,
        'idempotency-key': 'member-scope-admin-1',
      };
      for (const [method, url, payload] of [
        [
          'POST',
          `/v1/groups/${w.groups[0]}/memberships/alice/revoke`,
          undefined,
        ],
        ['POST', `/v1/groups/${w.groups[0]}/operators`, {}],
        ['POST', `/v1/groups/${w.groups[0]}/delegations`, {}],
        ['POST', '/v1/intents', { intent: {}, risk: {}, simulation: {} }],
        ['POST', '/v1/groups', {}],
      ] as const) {
        const r = await w.v1.inject({
          method,
          url,
          headers,
          ...(payload ? { payload } : {}),
        });
        expect([401, 403]).toContain(r.statusCode);
      }
    } finally {
      await w.close();
    }
  });

  it('expired and replayed challenges are rejected', async () => {
    const w = await world();
    try {
      const once = await w.signIn(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      expect(
        (await w.issue(once.challenge.challengeId, once.signature)).statusCode,
      ).toBe(201);
      expect(
        (await w.issue(once.challenge.challengeId, once.signature)).statusCode,
      ).toBe(401);
      const late = await w.signIn(w.groups[1]!, 'MEMBER_CONTRIBUTE');
      w.tick(121);
      expect(
        (await w.issue(late.challenge.challengeId, late.signature)).statusCode,
      ).toBe(401);
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      w.tick(301);
      expect((await w.quote(w.groups[0]!, w.alice, t)).statusCode).toBe(401);
    } finally {
      await w.close();
    }
  });

  it('member proposals are rate limited per member and per group; the operator is not (N6)', async () => {
    const w = await world();
    try {
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      const post = (bearer: string, groupId = w.groups[0]!) =>
        w.api.inject({
          method: 'POST',
          url: '/v1/mandate-proposals',
          headers: { authorization: `Bearer ${bearer}` },
          payload: { groupId, mandate: {}, change: 'NEW' },
        });
      for (let i = 0; i < 5; i++)
        expect((await post(t)).statusCode).not.toBe(429);
      const limited = await post(t);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
      expect(w.proposals).toHaveLength(5);
      // The same principal in another group shares its per-member budget.
      const other = await w.token(w.groups[1]!, 'MEMBER_CONTRIBUTE');
      expect((await post(other, w.groups[1]!)).statusCode).toBe(429);
      expect((await post(ADMIN)).statusCode).not.toBe(429);
      expect(w.proposals).toHaveLength(6);
      // Budgets refill with time.
      w.tick(3600);
      const fresh = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      expect((await post(fresh)).statusCode).not.toBe(429);
    } finally {
      await w.close();
    }
  });

  it('a group-wide proposal budget caps every member of the group together', async () => {
    const w = await world({
      proposalRateLimit: {
        member: { capacity: 100, refillPerSecond: 1 },
        group: { capacity: 2, refillPerSecond: 2 / 3600 },
      },
    });
    try {
      const t = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      const post = (groupId: string) =>
        w.api.inject({
          method: 'POST',
          url: '/v1/mandate-proposals',
          headers: { authorization: `Bearer ${t}` },
          payload: { groupId, mandate: {}, change: 'NEW' },
        });
      expect((await post(w.groups[0]!)).statusCode).not.toBe(429);
      expect((await post(w.groups[0]!)).statusCode).not.toBe(429);
      expect((await post(w.groups[0]!)).statusCode).toBe(429);
      expect(w.proposals).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('the world projection admits the operator and explicit read scopes of the same group only (N2)', async () => {
    const w = await world();
    const built: string[] = [];
    const app = Fastify();
    let access: MemberAccess = w.access;
    registerWorldRoute(app, {
      adminToken: ADMIN,
      memberAccess: () => access,
      groupExists: async (g) => w.groups.includes(g as `0x${string}`),
      build: async (g) => (built.push(g), { groupId: g }),
    });
    await app.ready();
    const get = (groupId: string, bearer?: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/world/${groupId}`,
        ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
      });
    try {
      const preview = await w.token(w.groups[0]!);
      const contribute = await w.token(w.groups[0]!, 'MEMBER_CONTRIBUTE');
      expect((await get(w.groups[0]!, preview)).statusCode).toBe(200);
      expect((await get(w.groups[0]!, contribute)).statusCode).toBe(200);
      expect(
        (await get(w.groups[0]!.toUpperCase().replace('0X', '0x'), preview))
          .statusCode,
      ).toBe(200);
      expect((await get(w.groups[1]!, preview)).statusCode).toBe(401);
      expect((await get(w.groups[0]!)).statusCode).toBe(401);
      expect((await get(w.groups[0]!, 'not-a-session')).statusCode).toBe(401);
      expect((await get(w.groups[0]!, ADMIN)).statusCode).toBe(200);
      expect((await get(`0x${'ee'.repeat(32)}`, ADMIN)).statusCode).toBe(404);
      expect(built).toEqual([
        w.groups[0],
        w.groups[0],
        w.groups[0],
        w.groups[0],
      ]);
      // A session scope outside the explicit allow-list never reads the world.
      access = {
        session: async (token, groupId) => {
          const s = await w.access.session(token, groupId);
          return s ? { ...s, scope: 'SEND_ONLY' as never } : null;
        },
      };
      expect((await get(w.groups[0]!, contribute)).statusCode).toBe(401);
      expect(built).toHaveLength(4);
    } finally {
      await app.close();
      await w.close();
    }
  });
});
