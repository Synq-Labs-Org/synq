import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { CHAT_A, GROUP_A, GROUP_B, fixture } from './harness.js';

const HASH = (b: string) => `0x${b.repeat(32)}`;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('POST /v1/cards/resolve', () => {
  it('requires a member session for the link group and returns the canonical proposal', async () => {
    const f = fixture(1_800_000_000, { cards: true });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    f.approvals.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        draftDigest: HASH('22'),
        label: 'Send 1 AUSD to carol',
        counted: 0,
        required: 2,
        status: 'PENDING',
        amount: { amount: '1', symbol: 'AUSD' },
      },
    ]);
    await f.gateway.notify();
    const url = new URL(f.adapter.last()!.buttons![0]!.url);
    const body = {
      proposalId: url.searchParams.get('p'),
      groupId: url.searchParams.get('g'),
      nonce: url.searchParams.get('n'),
    };
    app = Fastify();
    await app.register(channelRoutes, {
      gateway: f.gateway,
      now: () => f.clock.t,
      memberSession: async (token, groupId) =>
        token === 'alice-session' && groupId === GROUP_A
          ? { memberId: 'member_0', principalId: 'principal_alice' }
          : token === 'carol-session' && groupId === GROUP_B
            ? { memberId: 'member_0', principalId: 'principal_carol' }
            : null,
    });
    const post = (payload: unknown, token?: string) =>
      app!.inject({
        method: 'POST',
        url: '/v1/cards/resolve',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: JSON.stringify(payload),
      });
    expect((await post(body)).statusCode).toBe(401);
    const ok = await post(body, 'alice-session');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: 'OK',
      reviewPath: `/intents/${HASH('11')}`,
      card: { amount: { amount: '1', symbol: 'AUSD' } },
    });
    const cross = await post({ ...body, groupId: GROUP_B }, 'carol-session');
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toEqual({ error: 'LINK_INVALID' });
    expect(
      (await post({ ...body, nonce: 'garbage' }, 'alice-session')).statusCode,
    ).toBe(400);
  });
});
