import { describe, expect, it } from 'vitest';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import {
  MemoryIdentityStore,
  PrivyAdapter,
  grantPreview,
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
  approvalSignature,
  client,
  enrollViaApi,
  joinViaApi,
  origin,
  rpId,
} from './v1-harness.js';

const groupId = word(0xa1);

export function v1App(
  store: IdentityStore = new MemoryIdentityStore(),
  clock = { now: 1000 },
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
    const { app, call, humans, draft, preview } = await seeded();
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
    });
    for (const i of [0, 2]) {
      const { challenge, signature } = await approvalSignature(
        app,
        humans[i]!,
        `member_${i}`,
        draft,
        preview,
      );
      const res = await call('POST', '/v1/approvals', {
        challengeId: challenge!.challengeId,
        signature,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        signer: humans[i]!.record.signer,
        draftDigest: draft.digest,
      });
      const quorum = await call('GET', `/v1/approvals/${draft.digest}/quorum`);
      expect(quorum.body.satisfied).toBe(i === 2);
    }
    const intent = await call('GET', `/v1/intents/${draft.grant.intentHash}`);
    expect(intent.body.status).toBe('APPROVED');
    const principal = await call(
      'GET',
      `/v1/principals/${encodeURIComponent(humans[1]!.record.principalId)}`,
    );
    expect(principal.body).toMatchObject({
      kind: 'MERA_HUMAN',
      signer: humans[1]!.record.signer,
    });
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
    const send = (payload: object, key?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/principals/enrollment-challenges',
        payload,
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
  });

  it('guards admin commands and maps typed errors to safe responses', async () => {
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
        await call('POST', '/v1/principals/enrollment-challenges', {
          kind: 'DYNAMIC_OPERATOR',
          signer: addr(3),
          rpId,
          origin,
        })
      ).status,
    ).toBe(400);
  });

  it('rejects impersonation (SEC-008/020), reuse, revoked members and operators over HTTP', async () => {
    const { app, call, admin, humans, draft, preview } = await seeded();
    const forAlice = await call('POST', '/v1/approvals/challenges', {
      draftDigest: draft.digest,
      memberId: 'member_0',
    });
    const bob = await approvalSignature(
      app,
      humans[1]!,
      'member_1',
      draft,
      preview,
    );
    const impersonation = await call('POST', '/v1/approvals', {
      challengeId: forAlice.body.challengeId,
      signature: bob.signature,
    });
    expect(impersonation).toMatchObject({
      status: 401,
      body: { error: 'SIGNATURE_MISMATCH' },
    });
    expect(
      (
        await call('POST', '/v1/approvals', {
          challengeId: bob.challenge!.challengeId,
          signature: bob.signature,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call('POST', '/v1/approvals', {
          challengeId: bob.challenge!.challengeId,
          signature: bob.signature,
        })
      ).body.error,
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
      (
        await call('POST', '/v1/approvals', {
          challengeId: carol.challenge!.challengeId,
          signature: carol.signature,
        })
      ).body.error,
    ).toBe('MEMBERSHIP_CHANGED');
    const quorum = await call('GET', `/v1/approvals/${draft.digest}/quorum`);
    expect(quorum.body).toMatchObject({ satisfied: false, counted: [] });

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

  it('keeps an intent pending without quorum (AUSD-009) and rejects a tampered preview draft (AUSD-006)', async () => {
    const { call, admin, draft } = await seeded();
    expect(
      (await call('GET', `/v1/intents/${draft.grant.intentHash}`)).body.status,
    ).toBe('PENDING_APPROVAL');
    const tampered = {
      ...draft,
      grant: { ...draft.grant, recipient: addr(0x666), intentHash: word(0x99) },
    };
    const res = await call(
      'POST',
      '/v1/intents',
      { draft: tampered, asset: testAusd },
      admin,
    );
    expect(res).toMatchObject({
      status: 422,
      body: { error: 'DRAFT_INVALID' },
    });
    expect(grantPreview(draft, testAusd).recipient).toBe(addr(0xbeef));
  });
});
