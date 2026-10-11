import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { CHAT_A, GROUP_A, GROUP_B, fixture } from './harness.js';

const chatTexts = (f: ReturnType<typeof fixture>, chat: string) =>
  f.adapter.sent.filter((m) => m.chat === chat).map((m) => m.message.text);

describe('pending chat links expire', () => {
  it('a squatter cannot hold a new chat past the pending TTL', async () => {
    const f = fixture(1_800_000_000, {
      chatLinkQuorum: 2,
      pendingLinkTtlSeconds: 3600,
    });
    await f.link(CHAT_A, '666', GROUP_B, 'principal_carol');
    expect(
      (await f.link(CHAT_A, '111', GROUP_A, 'principal_alice')).outcome.status,
    ).toBe('GROUP_LINK_CONFLICT');
    f.clock.t += 3601;
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '666' }))).code,
    ).toBe('GROUP_LINK_EXPIRED');
    const retry = await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(retry.outcome.status).toBe('LINKED');
    expect(await f.store.groupLink('telegram', CHAT_A)).toMatchObject({
      groupId: GROUP_A,
      status: 'PENDING',
    });
  });

  it('an expired pending link cannot be activated by late confirmations', async () => {
    const f = fixture(1_800_000_000, {
      chatLinkQuorum: 2,
      pendingLinkTtlSeconds: 3600,
    });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const { code } = await f.issueCode(CHAT_A, '222');
    await f.gateway.redeemLinkCode({
      code,
      groupId: GROUP_A,
      principalId: 'principal_bob',
    });
    f.clock.t += 3601;
    await f.confirm('222');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '222' }))).code,
    ).toBe('GROUP_LINK_EXPIRED');
  });
});

describe('unlink', () => {
  it('/unlink is honoured only from a chat creator or administrator and removes every link in the chat', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(
      (await f.gateway.handle(f.message('/unlink', { userId: '111' }))).code,
    ).toBe('UNLINK_ADMIN_ONLY');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'ACTIVE',
    );
    f.adapter.admins.add(`${CHAT_A}:999`);
    expect(
      (await f.gateway.handle(f.message('/unlink', { userId: '999' }))).code,
    ).toBe('UNLINKED');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'REVOKED',
    );
    expect((await f.store.userLink('telegram', CHAT_A, '111'))?.status).toBe(
      'REVOKED',
    );
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '111' }))).code,
    ).toBe('GROUP_NOT_LINKED');
    expect(
      (await f.link(CHAT_A, '111', GROUP_A, 'principal_alice')).outcome.status,
    ).toBe('LINKED');
  });

  it('a member of the bound group can unlink from the authenticated web path; others cannot', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const app = Fastify();
    await app.register(channelRoutes, {
      gateway: f.gateway,
      now: () => f.clock.t,
      memberSession: async (token, groupId) =>
        token === 'bob' && groupId === GROUP_A
          ? { memberId: 'member_1', principalId: 'principal_bob' }
          : token === 'carol' && groupId === GROUP_B
            ? { memberId: 'member_0', principalId: 'principal_carol' }
            : null,
    });
    const unlink = (token: string | null, groupId: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/channels/links/unlink',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: JSON.stringify({
          groupId,
          channel: 'telegram',
          externalGroupId: CHAT_A,
        }),
      });
    expect((await unlink(null, GROUP_A)).statusCode).toBe(401);
    expect((await unlink('carol', GROUP_B)).json()).toEqual({
      error: 'NOT_LINKED',
    });
    expect((await unlink('bob', GROUP_A)).json()).toEqual({
      status: 'UNLINKED',
    });
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'REVOKED',
    );
    expect(chatTexts(f, CHAT_A).at(-1)).toMatch(/^Unlinked by a member/);
    await app.close();
  });
});

describe('chat-admin gating', () => {
  it('a chat cannot activate without a confirmed member who is a chat administrator', async () => {
    const f = fixture(1_800_000_000, {
      chatLinkQuorum: 2,
      requireChatAdmin: true,
    });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    await f.link(CHAT_A, '222', GROUP_A, 'principal_bob');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
    expect(chatTexts(f, CHAT_A).at(-1)).toMatch(/including a chat admin/);
  });

  it('activates once a chat administrator is among the confirming members', async () => {
    const f = fixture(1_800_000_000, {
      chatLinkQuorum: 2,
      requireChatAdmin: true,
    });
    f.adapter.admins.add(`${CHAT_A}:222`);
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    await f.link(CHAT_A, '222', GROUP_A, 'principal_bob');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'ACTIVE',
    );
    expect((await f.store.userLink('telegram', CHAT_A, '222'))?.chatAdmin).toBe(
      true,
    );
  });

  it('/wallet and /contribute always show the bound treasury and the unlink pointer', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    for (const cmd of ['/wallet', '/contribute']) {
      await f.gateway.handle(f.message(cmd, { userId: '111' }));
      expect(f.adapter.last()?.text).toContain(`0x${'5a'.repeat(20)}`);
      expect(f.adapter.last()?.text).toContain('/unlink');
    }
  });
});

describe('slow Brain calls', () => {
  it('a redelivery after the lease expires cannot run the Brain twice for one event', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    let release!: () => void;
    let runs = 0;
    f.ports.brain = async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
      return { text: 'done', proposals: [] };
    };
    const event = f.message('/propose keep 5 aside', { userId: '111' });
    const first = f.gateway.handle(event);
    await new Promise((r) => setTimeout(r, 10));
    f.clock.t += 121;
    const again = await f.gateway.handle({
      ...event,
      envelope: { ...event.envelope, timestamp: f.clock.t },
    });
    expect(again.code).toBe('BRAIN_ALREADY_RUN_FOR_EVENT');
    release();
    expect((await first).code).toBe('BRAIN');
    expect(runs).toBe(1);
  });
});
