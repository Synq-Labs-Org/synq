import { describe, expect, it } from 'vitest';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import {
  MemoryIdentityStore,
  PrivyAdapter,
  identityChallengeTypedData,
  type IdentityStore,
} from '../../packages/identity/src/server.js';
import type { GrantPreview, IdentityChallenge } from '@synq/schemas';
import {
  addr,
  fixtureAccounts,
  makeDraft,
  testAusd,
  word,
} from '../identity/fixtures.js';
import {
  ADMIN,
  MODULE,
  approvalSignature,
  client,
  enrollViaApi,
  joinViaApi,
  origin,
  rpId,
  submission,
} from './v1-harness.js';

const groupId = word(0xa1);

export function v1App(
  store: IdentityStore = new MemoryIdentityStore(),
  clock = { now: 1000 },
  rateLimit = { capacity: 1000, refillPerSecond: 1000 },
) {
  return createV1Api({
    store,
    config: {
      profile: 'sandbox/monad-testnet',
      rpId,
      origin,
      challengeTtlSeconds: 120,
      now: () => clock.now,
    },
    adminToken: ADMIN,
    executionModules: { 10143: MODULE },
    rateLimit,
  });
}

async function seeded(clock = { now: 1000 }) {
  const app = v1App(new MemoryIdentityStore(), clock);
  const { call, admin } = client(app);
  const humans = [
    await enrollViaApi(app, 'alice'),
    await enrollViaApi(app, 'bob'),
    await enrollViaApi(app, 'carol'),
  ];
  const created = await call(
    'POST',
    '/v1/groups',
    {
      groupId,
      chainId: 10143,
      account: addr(0xacc),
      owners: humans.map((h) => h.record.signer),
      threshold: 2,
    },
    admin,
  );
  expect(created.status).toBe(201);
  for (const [i, h] of humans.entries())
    expect((await joinViaApi(app, groupId, h, `member_${i}`)).status).toBe(201);
  const draft = makeDraft();
  const registered = await call(
    'POST',
    '/v1/intents',
    { draft, asset: testAusd },
    admin,
  );
  expect(registered.status).toBe(201);
  return {
    app,
    call,
    admin,
    humans,
    draft,
    preview: registered.body.preview as GrantPreview,
  };
}

describe('/v1 API (Fastify inject, in-memory store)', () => {
  it('runs enroll → group → join → intent preview → 2-of-3 approval and exposes the resulting state', async () => {
    const { app, call, admin, humans, draft, preview } = await seeded();
    const group = await call('GET', `/v1/groups/${groupId}`);
    expect(group.body).toMatchObject({ membershipEpoch: 3, threshold: 2 });
    expect(
      (group.body.memberships as { signer: string }[]).map((m) => m.signer),
    ).toEqual(humans.map((h) => h.record.signer));
    expect(preview).toMatchObject({
      recipient: addr(0xbeef),
      token: { symbol: 'AUSD', decimals: 6, address: testAusd.address },
      amount: { raw: '12500000', display: '12.5' },
      validUntil: '999999999999',
      executor: addr(0xe1),
      verifyingContract: MODULE,
    });
    for (const i of [0, 2]) {
      const signed = await approvalSignature(
        app,
        humans[i]!,
        `member_${i}`,
        draft,
        preview,
      );
      const res = await call('POST', '/v1/approvals', submission(signed));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        signer: humans[i]!.record.signer,
        draftDigest: draft.digest,
      });
      const quorum = await call('GET', `/v1/approvals/${draft.digest}/quorum`);
      expect(quorum.body.satisfied).toBe(i === 2);
      for (const counted of quorum.body.counted as object[])
        expect(counted).not.toHaveProperty('signature');
    }
    const intent = await call('GET', `/v1/intents/${draft.grant.intentHash}`);
    expect(intent.body.status).toBe('APPROVED');
    expect(
      (await call('GET', `/v1/approvals/${draft.digest}/verified`)).status,
    ).toBe(401);
    const verified = await call(
      'GET',
      `/v1/approvals/${draft.digest}/verified`,
      undefined,
      admin,
    );
    expect(
      (verified.body.counted as { signature: string }[]).every((c) =>
        /^0x[0-9a-f]{130}$/.test(c.signature),
      ),
    ).toBe(true);
    const principal = await call(
      'GET',
      `/v1/principals/${encodeURIComponent(humans[1]!.record.principalId)}`,
    );
    expect(principal.body).toMatchObject({
      kind: 'MERA_HUMAN',
      signer: humans[1]!.record.signer,
    });
  });

  it('regression: an unauthenticated caller cannot replay harvested signatures after revocation (critic repro A)', async () => {
    const { app, call, admin, humans, draft, preview } = await seeded();
    for (const i of [0, 2]) {
      const signed = await approvalSignature(
        app,
        humans[i]!,
        `member_${i}`,
        draft,
        preview,
      );
      expect(
        (await call('POST', '/v1/approvals', submission(signed))).status,
      ).toBe(201);
    }
    const leaked = (
      await call(
        'GET',
        `/v1/approvals/${draft.digest}/verified`,
        undefined,
        admin,
      )
    ).body.counted as {
      memberId: string;
      principalId: string;
      signature: string;
    }[];
    expect(
      (
        await call(
          'POST',
          `/v1/groups/${groupId}/memberships/member_1/revoke`,
          undefined,
          admin,
        )
      ).status,
    ).toBe(200);
    const callsBefore = humans.map((h) => ({ ...h.auth.calls }));
    for (const a of leaked) {
      const c = await call('POST', '/v1/approvals/challenges', {
        draftDigest: draft.digest,
        memberId: a.memberId,
        principalId: a.principalId,
        requestedAt: 1000,
        requestSignature: a.signature,
      });
      expect(c).toMatchObject({
        status: 409,
        body: { error: 'DRAFT_INVALIDATED' },
      });
    }
    const quorum = await call('GET', `/v1/approvals/${draft.digest}/quorum`);
    expect(quorum.body).toMatchObject({
      satisfied: false,
      draftStatus: 'INVALIDATED',
      counted: [],
    });
    expect(
      (await call('GET', `/v1/intents/${draft.grant.intentHash}`)).body.status,
    ).toBe('INVALIDATED');
    expect(humans.map((h) => ({ ...h.auth.calls }))).toEqual(callsBefore);
  });

  it('requires idempotency keys, replays identical commands and rejects key reuse with another body', async () => {
    const app = v1App();
    const body = {
      kind: 'MERA_HUMAN',
      signer: addr(7),
      credential: { credentialId: 'abc' },
      rpId,
      origin,
    };
    const send = (payload: object, key?: string, ip = '10.0.0.1') =>
      app.inject({
        method: 'POST',
        url: '/v1/principals/enrollment-challenges',
        payload,
        remoteAddress: ip,
        headers: key ? { 'idempotency-key': key } : {},
      });
    expect((await send(body)).statusCode).toBe(400);
    const first = await send(body, 'key-00000001');
    const replay = await send(body, 'key-00000001');
    expect(first.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().challengeId).toBe(first.json().challengeId);
    const conflict = await send({ ...body, signer: addr(8) }, 'key-00000001');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'IDEMPOTENCY_CONFLICT',
      message: expect.any(String),
    });
    const otherCaller = await send(body, 'key-00000001', '10.0.0.2');
    expect(otherCaller.statusCode).toBe(201);
    expect(otherCaller.headers['idempotent-replay']).toBeUndefined();
    expect(otherCaller.json().challengeId).not.toBe(first.json().challengeId);
  });

  it('recovers an idempotency key left PENDING by a crashed request after its lease', async () => {
    const store = new MemoryIdentityStore();
    const clock = { now: 1000 };
    const app = v1App(store, clock);
    const body = {
      kind: 'MERA_HUMAN',
      signer: addr(9),
      credential: { credentialId: 'abd' },
      rpId,
      origin,
    };
    const { canonicalJson } =
      await import('../../packages/identity/src/server.js');
    const { createHash } = await import('node:crypto');
    const requestHash = createHash('sha256')
      .update(canonicalJson({ params: {}, body }))
      .digest('hex');
    await store.transaction((tx) =>
      tx.claimIdempotency(
        {
          scope: 'ip:127.0.0.1|POST /v1/principals/enrollment-challenges',
          key: 'crashed-key-1',
          requestHash,
          state: 'PENDING',
          statusCode: null,
          response: null,
          createdAt: 1000,
        },
        0,
      ),
    );
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/principals/enrollment-challenges',
        payload: body,
        headers: { 'idempotency-key': 'crashed-key-1' },
      });
    expect((await send()).statusCode).toBe(409);
    clock.now += 61;
    expect((await send()).statusCode).toBe(201);
  });

  it('rate-limits unauthenticated writes per caller', async () => {
    const app = v1App(
      new MemoryIdentityStore(),
      { now: 1000 },
      {
        capacity: 3,
        refillPerSecond: 0.001,
      },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/principals/enrollment-challenges',
            payload: {
              kind: 'MERA_HUMAN',
              signer: addr(100 + i),
              credential: { credentialId: `c${i}` },
              rpId,
              origin,
            },
            headers: { 'idempotency-key': `rate-key-${i}0000` },
          })
        ).statusCode,
      );
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });

  it('guards admin commands, enforces the admin credential length and maps typed errors to safe responses', async () => {
    const app = v1App();
    const { call, admin } = client(app);
    const group = {
      groupId,
      chainId: 10143,
      account: addr(0xacc),
      owners: [addr(1), addr(2)],
      threshold: 2,
    };
    expect((await call('POST', '/v1/groups', group)).status).toBe(401);
    expect(
      (
        await call('POST', '/v1/groups', group, {
          authorization: 'Bearer wrong',
        })
      ).status,
    ).toBe(401);
    expect((await call('GET', `/v1/groups/${groupId}`)).body).toEqual({
      error: 'GROUP_NOT_FOUND',
      message: 'Group not found',
    });
    expect((await call('POST', '/v1/groups', group, admin)).status).toBe(201);
    expect((await call('POST', '/v1/groups', group, admin)).status).toBe(409);
    expect(
      (await call('POST', '/v1/groups', { ...group, extra: 1 }, admin)).body,
    ).toEqual({
      error: 'INVALID_REQUEST',
      message: 'Request is invalid',
    });
    expect(
      (
        await call(
          'POST',
          '/v1/groups',
          { ...group, groupId: 'not-bytes32' },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/v1/principals/enrollment-challenges', {
          kind: 'DYNAMIC_OPERATOR',
          signer: addr(3),
          rpId,
          origin,
        })
      ).status,
    ).toBe(400);
    expect(() =>
      createV1Api({
        store: new MemoryIdentityStore(),
        config: { profile: 'sandbox/monad-testnet', rpId, origin },
        adminToken: 'too-short',
        executionModules: {},
      }),
    ).toThrow(/at least 32/);
  });

  it('rejects impersonation (SEC-008/020), reuse, revoked members and operators over HTTP', async () => {
    const { app, call, admin, humans, draft, preview } = await seeded();
    const bob = await approvalSignature(
      app,
      humans[1]!,
      'member_1',
      draft,
      preview,
    );
    await expect(
      approvalSignature(app, humans[1]!, 'member_0', draft, preview),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
    expect((await call('POST', '/v1/approvals', submission(bob))).status).toBe(
      201,
    );
    expect(
      (await call('POST', '/v1/approvals', submission(bob))).body.error,
    ).toBe('CHALLENGE_CONSUMED');
    const carol = await approvalSignature(
      app,
      humans[2]!,
      'member_2',
      draft,
      preview,
    );
    const revoked = await call(
      'POST',
      `/v1/groups/${groupId}/memberships/member_2/revoke`,
      undefined,
      admin,
    );
    expect(revoked.body.membershipEpoch).toBe(4);
    expect(
      (await call('POST', '/v1/approvals', submission(carol))).body.error,
    ).toBe('DRAFT_INVALIDATED');
    const key = fixtureAccounts[0]!;
    const opChallenge = await call(
      'POST',
      '/v1/principals/enrollment-challenges',
      {
        kind: 'MERA_HUMAN',
        signer: key.address,
        credential: { credentialId: 'op' },
        rpId,
        origin,
      },
    );
    const opSig = await key.signTypedData(
      identityChallengeTypedData(
        opChallenge.body as unknown as IdentityChallenge,
      ),
    );
    expect(
      (
        await call('POST', '/v1/principals', {
          challengeId: opChallenge.body.challengeId,
          signature: opSig,
        })
      ).status,
    ).toBe(201);
    const notOwner = await call(
      'POST',
      `/v1/groups/${groupId}/membership-challenges`,
      {
        memberId: 'intruder',
        principalId: `mera:${key.address.toLowerCase()}`,
      },
    );
    expect(notOwner.body.error).toBe('NOT_SAFE_OWNER');
    const bindHuman = await call(
      'POST',
      `/v1/groups/${groupId}/operators`,
      { memberId: 'op', principalId: humans[0]!.record.principalId },
      admin,
    );
    expect(bindHuman.body.error).toBe('PRINCIPAL_NOT_ELIGIBLE');
  });

  it('reports provider status without exposing credential values', async () => {
    const app = createV1Api({
      store: new MemoryIdentityStore(),
      config: { profile: 'sandbox/monad-testnet', rpId, origin },
      adminToken: null,
      executionModules: { 10143: MODULE },
      privy: new PrivyAdapter({
        PRIVY_APP_ID: 'app-id-value',
        PRIVY_APP_SECRET: 'super-secret-value',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: 'wallet-auth:AAAA',
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/v1/providers' });
    expect(res.json()).toEqual([
      { provider: 'privy', status: 'CONFIGURED', missing: [] },
      {
        provider: 'dynamic',
        status: 'BLOCKED',
        missing: ['DYNAMIC_ENVIRONMENT_ID', 'DYNAMIC_API_KEY'],
      },
    ]);
    expect(res.body).not.toMatch(/super-secret-value|app-id-value|wallet-auth/);
    const adminDisabled = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      payload: {},
      headers: { 'idempotency-key': 'key-00000002', authorization: 'Bearer x' },
    });
    expect(adminDisabled.statusCode).toBe(401);
  });

  it('keeps an intent pending without quorum (AUSD-009) and rejects a tampered or foreign-module draft (AUSD-006)', async () => {
    const { call, admin, draft } = await seeded();
    expect(
      (await call('GET', `/v1/intents/${draft.grant.intentHash}`)).body.status,
    ).toBe('PENDING_APPROVAL');
    const tampered = {
      ...draft,
      grant: { ...draft.grant, recipient: addr(0x666), intentHash: word(0x99) },
    };
    expect(
      await call(
        'POST',
        '/v1/intents',
        { draft: tampered, asset: testAusd },
        admin,
      ),
    ).toMatchObject({ status: 422, body: { error: 'DRAFT_INVALID' } });
    const foreign = makeDraft(
      { intentHash: word(0x98) },
      {
        domain: { ...draft.domain, verifyingContract: addr(0x7777) },
      },
    );
    expect(
      await call(
        'POST',
        '/v1/intents',
        { draft: foreign, asset: testAusd },
        admin,
      ),
    ).toMatchObject({ status: 422, body: { error: 'DRAFT_INVALID' } });
  });
});
