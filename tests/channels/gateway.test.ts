import { describe, expect, it } from 'vitest';
import { parseCommand, parseSendArgs } from '@synq/channels';
import { CHAT_A, CHAT_B, GROUP_A, GROUP_B, fixture } from './harness.js';

const HASH = (b: string) => `0x${b.repeat(32)}`;

describe('channel gateway linking', () => {
  it('links a chat and a chat user only through a one-time code redeemed by an authenticated member', async () => {
    const f = fixture();
    const { outcome, code } = await f.link(
      CHAT_A,
      '111',
      GROUP_A,
      'principal_alice',
    );
    expect(outcome.status).toBe('LINKED');
    expect(f.adapter.last()?.text).toMatch(/Linked: member_0/);
    expect(
      (
        await f.gateway.redeemLinkCode({
          code,
          groupId: GROUP_A,
          principalId: 'principal_alice',
        })
      ).status,
    ).toBe('CODE_CONSUMED');
    const balance = await f.gateway.handle(f.message('/balance'));
    expect(balance).toMatchObject({ status: 'HANDLED', code: 'BALANCE' });
    expect(f.adapter.last()?.text).toContain('free 9.000000');
  });

  it('stores only a hash of the link code and expires it', async () => {
    const f = fixture();
    const { code } = await f.issueCode(CHAT_A, '111');
    expect([...f.store.codes.keys()].some((k) => k.includes(code))).toBe(false);
    f.clock.t += 901;
    expect(
      (
        await f.gateway.redeemLinkCode({
          code,
          groupId: GROUP_A,
          principalId: 'principal_alice',
        })
      ).status,
    ).toBe('CODE_EXPIRED');
  });

  it('a chat already linked to one group cannot be relinked to another (cross-group)', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const second = await f.link(CHAT_A, '333', GROUP_B, 'principal_carol');
    expect(second.outcome.status).toBe('GROUP_LINK_CONFLICT');
  });

  it('a non-member cannot redeem a code for a group', async () => {
    const f = fixture();
    const { outcome } = await f.link(CHAT_A, '111', GROUP_A, 'principal_carol');
    expect(outcome.status).toBe('CODE_INVALID');
    expect(await f.store.groupLink('telegram', CHAT_A)).toBeNull();
  });

  it('a chat user already bound to one principal cannot be rebound to another', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const again = await f.link(CHAT_B, '111', GROUP_B, 'principal_carol');
    expect(again.outcome.status).toBe('USER_LINK_CONFLICT');
  });
});

describe('private link binding', () => {
  it('never shows a redeemable web code in the group, only a private deep link', async () => {
    const f = fixture();
    await f.gateway.handle(f.message('/synq'));
    const reply = f.adapter.last()!;
    expect(reply.text).not.toContain('/channels/link');
    expect(reply.buttons?.[0]?.url).toMatch(
      /^https:\/\/t\.me\/synq_bot\?start=[A-Za-z0-9_-]{32}$/,
    );
    expect(f.adapter.sent.at(-1)!.chat).toBe(CHAT_A);
  });

  it("another member opening someone else's deep link gets nothing, and the owner still can", async () => {
    const f = fixture();
    const stolen = await f.issueCode(CHAT_A, '111', '222');
    expect(stolen.outcome.code).toBe('START_NOT_YOURS');
    expect(stolen.code).toBe('');
    expect(stolen.dm?.chat).toBe('222');
    const own = await f.gateway.handle(
      f.message(`/start ${stolen.start}`, {
        externalGroupId: '111',
        chatKind: 'DIRECT',
        userId: '111',
      }),
    );
    expect(own.code).toBe('LINK_CODE_ISSUED');
    expect(f.adapter.sent.at(-1)!.chat).toBe('111');
    const replay = await f.gateway.handle(
      f.message(`/start ${stolen.start}`, {
        externalGroupId: '111',
        chatKind: 'DIRECT',
        userId: '111',
      }),
    );
    expect(replay.code).toBe('START_INVALID');
  });

  it('with Telegram Login required, a member cannot redeem a code issued to another chat user', async () => {
    const f = fixture(1_800_000_000, { requireTelegramProof: true });
    const { code } = await f.issueCode(CHAT_A, '111');
    const redeem = (provenExternalUserId?: string) =>
      f.gateway.redeemLinkCode({
        code,
        groupId: GROUP_A,
        principalId: 'principal_bob',
        ...(provenExternalUserId ? { provenExternalUserId } : {}),
      });
    expect((await redeem()).status).toBe('EXTERNAL_PROOF_REQUIRED');
    expect((await redeem('222')).status).toBe('EXTERNAL_IDENTITY_MISMATCH');
    expect(await f.store.userLink('telegram', '111')).toBeNull();
    expect((await redeem('111')).status).toBe('LINKED');
  });

  it('refuses to link on a channel without private delivery', async () => {
    const f = fixture();
    (f.adapter as { deepLink?: unknown }).deepLink = undefined;
    expect((await f.gateway.handle(f.message('/synq'))).code).toBe(
      'PRIVATE_LINK_UNAVAILABLE',
    );
    expect(f.store.codes.size).toBe(0);
  });
});

describe('channel gateway adversarial ingress', () => {
  it('ignores financial commands from an unlinked group without replying', async () => {
    const f = fixture();
    const out = await f.gateway.handle(f.message('/send 1 bob'));
    expect(out).toMatchObject({
      status: 'UNAUTHORIZED',
      code: 'GROUP_NOT_LINKED',
      delivered: 0,
    });
    expect(f.adapter.sent).toHaveLength(0);
  });

  it('refuses a chat identity that is not wallet-linked, even with a spoofed display name', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const spoof = f.message('/send 1 bob', {
      userId: '999',
      verifiedSender: {
        transport: 'FIXTURE',
        providerUserId: '999',
        displayName: '@alice',
        isBot: false,
      },
    });
    expect(await f.gateway.handle(spoof)).toMatchObject({
      status: 'UNAUTHORIZED',
      code: 'USER_NOT_LINKED',
    });
  });

  it('ignores bot senders and messages without a sender', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const bot = f.message('/balance', {
      verifiedSender: {
        transport: 'FIXTURE',
        providerUserId: '111',
        displayName: null,
        isBot: true,
      },
    });
    expect((await f.gateway.handle(bot)).code).toBe('NOT_A_HUMAN_SENDER');
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: null }))).code,
    ).toBe('NOT_A_HUMAN_SENDER');
  });

  it('dedupes a replayed or duplicate event by (channel, eventId)', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    const event = f.message('/balance');
    expect((await f.gateway.handle(event)).status).toBe('HANDLED');
    const before = f.adapter.sent.length;
    expect((await f.gateway.handle(event)).status).toBe('DUPLICATE');
    expect(f.adapter.sent.length).toBe(before);
  });

  it('drops delayed, stale or future-dated messages', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(
      (
        await f.gateway.handle(
          f.message('/send 1 bob', { timestamp: f.clock.t - 3600 }),
        )
      ).status,
    ).toBe('STALE');
    expect(
      (
        await f.gateway.handle(
          f.message('/send 1 bob', { timestamp: f.clock.t + 3600 }),
        )
      ).status,
    ).toBe('STALE');
  });

  it('refuses a member removed from the Synq group, and revokes the link when they leave the chat', async () => {
    const f = fixture();
    await f.link(CHAT_A, '222', GROUP_A, 'principal_bob');
    f.members.get(GROUP_A)!.delete('principal_bob');
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '222' }))).code,
    ).toBe('NOT_A_MEMBER');
    f.members.get(GROUP_A)!.set('principal_bob', 'member_1');
    await f.gateway.handle({
      type: 'MEMBER_LEFT',
      envelope: f.message('').envelope,
      members: [{ externalUserId: '222', displayName: null, isBot: false }],
    });
    expect((await f.store.userLink('telegram', '222'))?.status).toBe('REVOKED');
    expect(
      (await f.gateway.handle(f.message('/balance', { userId: '222' }))).code,
    ).toBe('USER_NOT_LINKED');
  });

  it('never treats chat text or callback buttons as approvals', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    f.approvals.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        draftDigest: HASH('22'),
        label: 'Send 1 AUSD',
        counted: 0,
        required: 2,
        status: 'PENDING',
      },
    ]);
    for (const text of ['yes', '@synq_bot approve', 'YES!', '👍'])
      expect((await f.gateway.handle(f.message(text))).code).toBe(
        'CHAT_TEXT_NOT_APPROVAL',
      );
    const forged = f.message('approve:0x22');
    const callback = await f.gateway.handle({
      type: 'ACTION_REQUESTED',
      callbackId: 'cb1',
      envelope: {
        ...forged.envelope,
        interaction: {
          kind: 'CALLBACK',
          addressedToBot: true,
          command: null,
          args: '',
          callbackData: `approve:${HASH('22')}`,
        },
      },
    });
    expect(callback).toMatchObject({
      status: 'REFUSED',
      code: 'CALLBACK_NOT_AN_APPROVAL',
    });
    expect(f.adapter.acks).toEqual(['cb1']);
    expect(f.brainCalls).toHaveLength(0);
    expect((await f.ports.approvals(GROUP_A))[0]!.counted).toBe(0);
  });

  it('shows each chat only its own group approvals (cross-group isolation)', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    await f.link(CHAT_B, '333', GROUP_B, 'principal_carol');
    f.approvals.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        draftDigest: HASH('22'),
        label: 'Send A',
        counted: 1,
        required: 2,
        status: 'PENDING',
      },
    ]);
    await f.gateway.handle(
      f.message('/status', { externalGroupId: CHAT_B, userId: '333' }),
    );
    expect(f.adapter.last()?.text).toBe('No pending approvals.');
    expect(
      (
        await f.gateway.handle(
          f.message('/status', { externalGroupId: CHAT_B, userId: '111' }),
        )
      ).code,
    ).toBe('NOT_A_MEMBER');
  });

  it('posts approval counts and receipts once each, and retries after a provider outage', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    f.adapter.sent = [];
    f.approvals.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        draftDigest: HASH('22'),
        label: 'Send 1 AUSD',
        counted: 1,
        required: 2,
        status: 'PENDING',
      },
    ]);
    f.adapter.failing = true;
    expect(await f.gateway.notify()).toEqual({ delivered: 0, failed: 1 });
    expect(f.store.failures).toHaveLength(1);
    expect(
      f.events.some((e) => e.event.type === 'MESSAGE_DELIVERY_FAILED'),
    ).toBe(true);
    f.adapter.failing = false;
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    expect(f.adapter.last()?.text).toContain('1/2 verified passkey approvals');
    expect(f.adapter.last()?.buttons?.[0]?.url).toBe(
      `https://synq.example/intents/${HASH('11')}`,
    );
    f.receipts.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        transactionHash: HASH('33'),
        state: 'CONFIRMED',
        label: 'Send 1 AUSD',
        executionMode: 'REAL_TESTNET',
      },
    ]);
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    expect(await f.gateway.notify()).toEqual({ delivered: 0, failed: 0 });
    expect(f.adapter.last()?.buttons?.[0]?.url).toBe(
      `https://testnet.monadexplorer.com/tx/${HASH('33')}`,
    );
  });

  it('turns /send into a passkey-confirmation link and never into an execution', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(
      (await f.gateway.handle(f.message('/send 1.5 AUSD to bob'))).code,
    ).toBe('SEND_LINK');
    const url = new URL(f.adapter.last()!.buttons![0]!.url);
    expect(url.pathname).toBe('/send');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      groupId: GROUP_A,
      recipientId: 'member:member_1',
      amount: '1.5',
    });
    expect((await f.gateway.handle(f.message('/send 1 mallory'))).code).toBe(
      'RECIPIENT_UNKNOWN',
    );
    expect((await f.gateway.handle(f.message('/send -1 bob'))).code).toBe(
      'SEND_ARGS_INVALID',
    );
  });

  it('passes addressed natural language to the Brain with the authenticated member only', async () => {
    const f = fixture();
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    expect(
      (
        await f.gateway.handle(
          f.message('chit chat', {
            interaction: {
              kind: 'TEXT',
              addressedToBot: false,
              command: null,
              args: '',
              callbackData: null,
            },
          }),
        )
      ).code,
    ).toBe('NOT_ADDRESSED');
    await f.gateway.handle(f.message('@synq_bot what is our balance?'));
    expect(f.brainCalls).toEqual([
      expect.objectContaining({
        groupId: GROUP_A,
        memberId: 'member_0',
        principalId: 'principal_alice',
        text: 'what is our balance?',
        intent: 'ASK',
      }),
    ]);
  });

  it('refuses financial use from direct messages', async () => {
    const f = fixture();
    expect(
      (await f.gateway.handle(f.message('/balance', { chatKind: 'DIRECT' })))
        .code,
    ).toBe('GROUP_CHAT_REQUIRED');
  });
});

describe('command parsing', () => {
  it('handles bot suffixes and exact amounts', () => {
    expect(parseCommand('/balance@synq_bot', 'synq_bot')).toEqual({
      kind: 'COMMAND',
      name: 'balance',
      args: '',
    });
    expect(parseCommand('/balance@other_bot', 'synq_bot')).toBeNull();
    expect(parseSendArgs('0.000001 alice')).toEqual({
      amount: '0.000001',
      recipient: 'alice',
    });
    expect(parseSendArgs('1e6 alice')).toBeNull();
    expect(parseSendArgs('0 alice')).toBeNull();
  });
});
