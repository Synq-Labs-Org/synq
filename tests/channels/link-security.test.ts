import { describe, expect, it } from 'vitest';
import { CHAT_A, CHAT_B, GROUP_A, GROUP_B, fixture } from './harness.js';

const chatTexts = (f: ReturnType<typeof fixture>, chat: string) =>
  f.adapter.sent.filter((m) => m.chat === chat).map((m) => m.message.text);

describe('chat → group binding', () => {
  it('a first redeemer cannot hijack a new chat for their own group', async () => {
    const f = fixture(1_800_000_000, { chatLinkQuorum: 2 });
    f.members.get(GROUP_B)!.set('principal_mallory2', 'member_1');
    const first = await f.link(CHAT_A, '666', GROUP_B, 'principal_carol');
    expect(first.outcome.status).toBe('LINKED');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
    expect(
      chatTexts(f, CHAT_A).some((t) =>
        /^Pending: .*treasury|^Pending: /.test(t),
      ),
    ).toBe(true);
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '666' }))).code,
    ).toBe('GROUP_LINK_PENDING');
    expect(await f.store.groupLinks()).toEqual([]);
    const victim = await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(victim.outcome.status).toBe('GROUP_LINK_CONFLICT');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
  });

  it('shows the target group and treasury in chat and activates only after two distinct confirmed members', async () => {
    const f = fixture(1_800_000_000, { chatLinkQuorum: 2 });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const pending = chatTexts(f, CHAT_A).find((t) => t.startsWith('Pending:'))!;
    expect(pending).toContain(`treasury 0x${'5a'.repeat(20)}`);
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
    const sameMemberTwice = await f.link(
      CHAT_A,
      '112',
      GROUP_A,
      'principal_alice',
    );
    expect(sameMemberTwice.outcome.status).toBe('LINKED');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'PENDING',
    );
    await f.link(CHAT_A, '222', GROUP_A, 'principal_bob');
    expect((await f.store.groupLink('telegram', CHAT_A))?.status).toBe(
      'ACTIVE',
    );
    expect(
      chatTexts(f, CHAT_A).some((t) =>
        /now speaks for Synq group .*confirmed by 2 members/.test(t),
      ),
    ).toBe(true);
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '222' }))).code,
    ).toBe('BALANCE');
  });

  it('a redeemed link does nothing until the chat user confirms from their own private chat', async () => {
    const f = fixture();
    const { code } = await f.issueCode(CHAT_A, '111');
    await f.gateway.redeemLinkCode({
      code,
      groupId: GROUP_A,
      principalId: 'principal_alice',
    });
    expect((await f.store.userLink('telegram', CHAT_A, '111'))?.status).toBe(
      'PENDING',
    );
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '111' }))).code,
    ).not.toBe('BALANCE');
  });
});

describe('attribution', () => {
  it("a stranger's messages are never attributed to a member, even with the member's confirm token", async () => {
    const f = fixture();
    const { code } = await f.issueCode(CHAT_A, '111');
    await f.gateway.redeemLinkCode({
      code,
      groupId: GROUP_A,
      principalId: 'principal_alice',
    });
    const token = f.confirmTokenFor('111');
    expect((await f.confirm('999', token)).code).toBe('CONFIRM_INVALID');
    expect((await f.store.userLink('telegram', CHAT_A, '111'))?.status).toBe(
      'PENDING',
    );
    await f.confirm('111', token);
    const spoof = f.message('/send 1 bob', {
      userId: '999',
      verifiedSender: {
        transport: 'FIXTURE',
        providerUserId: '999',
        displayName: '@alice',
        isBot: false,
      },
    });
    expect((await f.gateway.handle(spoof)).code).toBe('USER_NOT_LINKED');
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '111' }))).code,
    ).toBe('BALANCE');
  });

  it("a co-member who redeems someone else's code cannot take over their chat identity", async () => {
    const f = fixture();
    await f.link(CHAT_A, '222', GROUP_A, 'principal_bob');
    const alice = await f.issueCode(CHAT_A, '111');
    const swapped = await f.gateway.redeemLinkCode({
      code: alice.code,
      groupId: GROUP_A,
      principalId: 'principal_bob',
    });
    expect(swapped.status).toBe('LINKED');
    const dm = f.adapter.sent.filter((m) => m.chat === '111').at(-1)!.message
      .text;
    expect(dm).toContain('Synq member_1');
    expect((await f.confirm('222', f.confirmTokenFor('111'))).code).toBe(
      'CONFIRM_INVALID',
    );
    expect((await f.store.userLink('telegram', CHAT_A, '111'))?.status).toBe(
      'PENDING',
    );
    expect(
      (await f.gateway.handle(f.message('/send 1 bob', { userId: '111' })))
        .code,
    ).toBe('USER_NOT_LINKED');
  });
});

describe('membership scope', () => {
  it('leaving one chat revokes the link only in that chat', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    await f.link(CHAT_B, '111', GROUP_A, 'principal_alice');
    await f.gateway.handle({
      type: 'MEMBER_LEFT',
      envelope: f.message('', { externalGroupId: CHAT_B }).envelope,
      members: [{ externalUserId: '111', displayName: null, isBot: false }],
    });
    expect((await f.store.userLink('telegram', CHAT_B, '111'))?.status).toBe(
      'REVOKED',
    );
    expect((await f.store.userLink('telegram', CHAT_A, '111'))?.status).toBe(
      'ACTIVE',
    );
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '111' }))).code,
    ).toBe('BALANCE');
  });
});

describe('inbound dedupe', () => {
  it('an event whose processing failed is retried, not dropped', async () => {
    const f = fixture();
    const event = f.message('/synq');
    const original = f.store.createLinkCode.bind(f.store);
    let fail = true;
    f.store.createLinkCode = async (r) => {
      if (fail) {
        fail = false;
        throw new Error('DATABASE_UNAVAILABLE');
      }
      return original(r);
    };
    await expect(f.gateway.handle(event)).rejects.toThrow(
      'DATABASE_UNAVAILABLE',
    );
    expect((await f.gateway.handle(event)).code).toBe('PRIVATE_LINK_ISSUED');
    expect((await f.gateway.handle(event)).status).toBe('DUPLICATE');
  });

  it('a claim abandoned by a crash is retried after its lease, but not during it', async () => {
    const f = fixture();
    const event = f.message('/help');
    await f.store.claimEvent(
      'telegram',
      event.envelope.eventId,
      f.clock.t,
      120,
    );
    expect((await f.gateway.handle(event)).status).toBe('DUPLICATE');
    f.clock.t += 121;
    expect(
      (
        await f.gateway.handle({
          ...event,
          envelope: { ...event.envelope, timestamp: f.clock.t },
        })
      ).code,
    ).toBe('HELP');
  });
});
