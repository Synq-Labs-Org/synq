import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  CardBannerRenderer,
  CardLinkIssuer,
  imessageConfigFromEnv,
} from '@synq/channels';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { CARD_KEY, GROUP_A, GROUP_B } from './harness.js';
import {
  ALICE,
  BOB,
  BOT_HANDLE,
  GROUP_CHAT,
  MALLORY,
  NOW,
  OTHER_CHAT,
  SECOND_CHAT,
  imessageFixture,
  loadFixture,
} from './imessage-harness.js';

const HASH = (b: string) => `0x${b.repeat(32)}`;

describe('iMessage bridge: allowlist and loop prevention', () => {
  it('never forwards or logs content from a chat that is not allowlisted', async () => {
    const f = imessageFixture();
    const raw = loadFixture('bluebubbles-group-other-chat.json');
    const [r] = await f.webhook(raw);
    expect(r!.status).toBe('DROPPED_NOT_ALLOWLISTED');
    expect(f.handled).toHaveLength(0);
    expect(f.server.urls.some((u) => u.includes('/message/'))).toBe(false);
    expect(JSON.stringify(f.logs)).not.toContain('family');
    expect(JSON.stringify(f.logs)).not.toContain(OTHER_CHAT);
  });

  it('ignores its own messages, tapbacks and echoes of what it sent', async () => {
    const f = imessageFixture();
    expect(
      (await f.webhook(loadFixture('bluebubbles-own-message.json')))[0]!.status,
    ).toBe('IGNORED_OWN_MESSAGE');
    expect(await f.webhook(loadFixture('bluebubbles-tapback.json'))).toEqual(
      [],
    );
    await f.say(GROUP_CHAT, ALICE, '/help');
    const reply = f.server.textsTo(GROUP_CHAT).at(-1)!;
    // The same text re-delivered without isFromMe (e.g. from a second device) is an echo.
    expect((await f.say(GROUP_CHAT, BOB, reply)).status).toBe('IGNORED_ECHO');
    expect(f.handled).toHaveLength(1);
  });

  it('caps a flood of addressed messages and the replies to it', async () => {
    const f = imessageFixture();
    const results = [];
    for (let i = 0; i < 20; i++)
      results.push((await f.say(GROUP_CHAT, ALICE, `/help ${i}`)).status);
    expect(results.filter((s) => s === 'FORWARDED')).toHaveLength(10);
    expect(
      results.filter((s) => s === 'DROPPED_SENDER_RATE_LIMIT'),
    ).toHaveLength(10);
    expect(f.server.textsTo(GROUP_CHAT).length).toBeLessThanOrEqual(8);
    expect(
      f.store.failures.some((x) => x.reason.startsWith('RATE_LIMITED')),
    ).toBe(true);
  });

  it('deduplicates a redelivered webhook', async () => {
    const f = imessageFixture();
    const raw = f.server.write(GROUP_CHAT, ALICE, '/help');
    expect((await f.webhook(raw))[0]!.status).toBe('FORWARDED');
    expect((await f.webhook(raw))[0]!.status).toBe('DUPLICATE');
    expect(f.server.textsTo(GROUP_CHAT)).toHaveLength(1);
  });

  it('drops direct messages other than link commands, so they never reach the Brain', async () => {
    const f = imessageFixture();
    const r = await f.say(`iMessage;-;${ALICE}`, ALICE, 'what is my balance');
    expect(r.status).toBe('DROPPED_DIRECT_NOT_LINK_COMMAND');
    expect(f.brainCalls).toHaveLength(0);
  });
});

describe('iMessage bridge: identity', () => {
  it('links a member only through the private /start, passkey redemption and /confirm flow', async () => {
    const f = imessageFixture();
    const l = await f.link(ALICE, 'principal_alice', GROUP_A);
    expect(l.deep).toContain(`sms:${BOT_HANDLE}&body=%2Fstart%20`);
    expect(l.redeemed.status).toBe('LINKED');
    expect(l.confirmed.gateway).toMatchObject({ code: 'LINK_CONFIRMED' });
    // The personal link code went only to Alice's private chat, never the group.
    expect(f.server.textsTo(GROUP_CHAT).join('\n')).not.toContain(
      '/channels/link?code=',
    );
    expect((await f.say(GROUP_CHAT, ALICE, '/balance')).gateway).toMatchObject({
      status: 'HANDLED',
      code: 'BALANCE',
    });
    expect(f.server.textsTo(GROUP_CHAT).at(-1)).toContain(
      'Balance: 10.000000 AUSD',
    );
  });

  it('refuses an unknown sender and a member from a different chat mapping', async () => {
    const f = imessageFixture();
    await f.link(ALICE, 'principal_alice', GROUP_A);
    expect(
      (await f.say(GROUP_CHAT, MALLORY, '/balance')).gateway,
    ).toMatchObject({
      status: 'UNAUTHORIZED',
      code: 'USER_NOT_LINKED',
    });
    // Alice is linked in GROUP_CHAT only; SECOND_CHAT is allowlisted but not linked.
    expect((await f.say(SECOND_CHAT, ALICE, '/balance')).gateway).toMatchObject(
      {
        status: 'UNAUTHORIZED',
        code: 'GROUP_NOT_LINKED',
      },
    );
    // Carol's link binds SECOND_CHAT to group B; Alice there is still not a member.
    await f.link(BOB, 'principal_carol', GROUP_B, SECOND_CHAT);
    expect((await f.say(SECOND_CHAT, ALICE, '/balance')).gateway).toMatchObject(
      {
        code: 'USER_NOT_LINKED',
      },
    );
  });

  it('rejects a forged webhook whose sender or text the server does not confirm', async () => {
    const f = imessageFixture();
    await f.link(ALICE, 'principal_alice', GROUP_A);
    const real = f.server.write(GROUP_CHAT, MALLORY, '/balance');
    const forged = {
      ...real,
      data: { ...real.data, handle: { address: ALICE } },
    };
    expect((await f.webhook(forged))[0]!.status).toBe('REJECTED_UNVERIFIED');
    const invented = {
      type: 'new-message',
      data: { ...real.data, guid: 'NOT-ON-SERVER', handle: { address: ALICE } },
    };
    expect((await f.webhook(invented))[0]!.status).toBe('REJECTED_UNVERIFIED');
    expect(f.handled.filter((h) => h.outcome.code === 'BALANCE')).toHaveLength(
      0,
    );
  });

  it('revokes a member who leaves the group chat', async () => {
    const f = imessageFixture();
    await f.link(ALICE, 'principal_alice', GROUP_A);
    const left = loadFixture('bluebubbles-participant-left.json');
    expect((await f.webhook(left))[0]!.gateway).toMatchObject({
      status: 'RECORDED',
      code: 'MEMBER_LEFT',
    });
    expect((await f.say(GROUP_CHAT, ALICE, '/balance')).gateway).toMatchObject({
      code: 'USER_NOT_LINKED',
    });
  });
});

describe('iMessage bridge: cards, delivery and reconnect', () => {
  const pending = {
    intentHash: HASH('11'),
    draftDigest: HASH('22'),
    label: 'Send 1 AUSD to carol',
    counted: 0,
    required: 2,
    status: 'PENDING' as const,
    amount: { amount: '1', symbol: 'AUSD' },
  };

  it('posts an approval card as summary plus bare link, and the link resists replay and cross-group use', async () => {
    const f = imessageFixture();
    await f.link(ALICE, 'principal_alice', GROUP_A);
    f.approvals.set(GROUP_A, [pending]);
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    const [summary, url] = f.server.textsTo(GROUP_CHAT).slice(-2);
    expect(summary).toContain('Amount: 1 AUSD');
    expect(summary).toContain('Chat replies and buttons never approve');
    const q = new URL(url!).searchParams;
    expect([...q.keys()].sort()).toEqual(['g', 'n', 'p']);
    // "yes" in the chat is not an approval.
    expect((await f.say(GROUP_CHAT, ALICE, '@synq yes')).gateway).toMatchObject(
      {
        code: 'CHAT_TEXT_NOT_APPROVAL',
      },
    );
    const link = { proposalId: q.get('p')!, nonce: q.get('n')! };
    expect(
      await f.gateway.resolveCardLink({
        ...link,
        groupId: GROUP_B,
        principalId: 'principal_carol',
      }),
    ).toEqual({ status: 'LINK_INVALID' });
    f.approvals.set(GROUP_A, [{ ...pending, counted: 2, status: 'SATISFIED' }]);
    expect(
      await f.gateway.resolveCardLink({
        ...link,
        groupId: GROUP_A,
        principalId: 'principal_alice',
      }),
    ).toMatchObject({ status: 'NOT_PENDING' });
    const other = new CardLinkIssuer({
      key: CARD_KEY,
      webBaseUrl: 'https://synq.example',
      now: () => NOW,
    });
    expect(other.verify({ ...link, groupId: GROUP_A }).ok).toBe(true);
  });

  it('records a failed delivery while the server is down and resends once after reconnect', async () => {
    const f = imessageFixture();
    await f.link(ALICE, 'principal_alice', GROUP_A);
    f.approvals.set(GROUP_A, [pending]);
    f.server.up = false;
    expect(await f.gateway.notify()).toEqual({ delivered: 0, failed: 1 });
    expect(f.store.failures.at(-1)).toMatchObject({
      channel: 'imessage',
      attempts: 3,
    });
    const controller = new AbortController();
    const supervising = f.bridge.supervise(controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(f.bridge.state).toBe('DISCONNECTED');
    // While down, Alice writes; no webhook arrives for it.
    f.clock.t += 5;
    f.server.write(GROUP_CHAT, ALICE, '/help');
    f.server.up = true;
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await supervising;
    expect(f.bridge.state).toBe('CONNECTED');
    expect(f.handled.at(-1)!.outcome.code).toBe('HELP');
    const before = f.server.sent.length;
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    expect(await f.gateway.notify()).toEqual({ delivered: 0, failed: 0 });
    expect(f.server.sent.length - before).toBe(2);
  });

  it('never catches up on messages from before the bridge started', async () => {
    const f = imessageFixture();
    f.server.write(GROUP_CHAT, ALICE, '/help', NOW - 3600);
    expect(await f.bridge.catchUp()).toBe(0);
    expect(f.handled).toHaveLength(0);
  });

  it('does not retry a provider rejection', async () => {
    const f = imessageFixture();
    f.server.rejectSends = true;
    await f.say(GROUP_CHAT, ALICE, '/help');
    expect(f.store.failures.at(-1)).toMatchObject({ attempts: 1 });
    expect(f.store.failures.at(-1)!.reason).toMatch(/^PROVIDER_REJECTED/);
  });
});

describe('iMessage runtime configuration and webhook route', () => {
  it('fails closed without an allowlist or a strong webhook token', () => {
    expect(imessageConfigFromEnv({})).toBeNull();
    expect(() =>
      imessageConfigFromEnv({
        SYNQ_IMESSAGE_TRANSPORT: 'bluebubbles',
        BLUEBUBBLES_PASSWORD: 'password123',
        SYNQ_IMESSAGE_WEBHOOK_TOKEN: 'x'.repeat(32),
      }),
    ).toThrow('SYNQ_IMESSAGE_ALLOWED_CHATS');
    expect(() =>
      imessageConfigFromEnv({
        SYNQ_IMESSAGE_TRANSPORT: 'bluebubbles',
        SYNQ_IMESSAGE_ALLOWED_CHATS: GROUP_CHAT,
        BLUEBUBBLES_PASSWORD: 'password123',
        SYNQ_IMESSAGE_WEBHOOK_TOKEN: 'short',
      }),
    ).toThrow('SYNQ_IMESSAGE_WEBHOOK_TOKEN');
    const c = imessageConfigFromEnv({
      SYNQ_IMESSAGE_TRANSPORT: 'beeper',
      SYNQ_IMESSAGE_ALLOWED_CHATS: `${GROUP_CHAT}, ${SECOND_CHAT}`,
      BEEPER_ACCESS_TOKEN: 'beeper-token-1',
    });
    expect(c?.allowedChats).toEqual([GROUP_CHAT, SECOND_CHAT]);
    expect(c?.transport.name).toBe('beeper');
  });

  it('accepts BlueBubbles webhooks only on the secret path', async () => {
    const f = imessageFixture();
    const app = Fastify();
    await app.register(channelRoutes, {
      gateway: f.gateway,
      now: () => f.clock.t,
      memberSession: async () => null,
      imessage: {
        bridge: f.bridge,
        transport: f.transport,
        webhookToken: 'T'.repeat(32),
      },
    });
    const post = (token: string, body: unknown) =>
      app.inject({
        method: 'POST',
        url: `/v1/channels/imessage/webhook/${token}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    const raw = f.server.write(GROUP_CHAT, ALICE, '/help');
    expect((await post('U'.repeat(32), raw)).statusCode).toBe(401);
    const ok = await post('T'.repeat(32), raw);
    expect(ok.json()).toEqual({ ok: true, outcomes: ['FORWARDED'] });
    await app.close();
  });
});

describe('iMessage card banners', () => {
  const pending = {
    intentHash: `0x${'11'.repeat(32)}`,
    draftDigest: `0x${'22'.repeat(32)}`,
    label: 'Send 1 AUSD to carol',
    counted: 0,
    required: 2,
    status: 'PENDING' as const,
    amount: { amount: '1', symbol: 'AUSD' },
  };

  it('attaches the banner PNG via BlueBubbles AppleScript before the card text', async () => {
    const f = imessageFixture({ banners: new CardBannerRenderer() });
    await f.link(ALICE, 'principal_alice', GROUP_A);
    f.approvals.set(GROUP_A, [pending]);
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    expect(f.server.attachments).toEqual([
      expect.objectContaining({
        chatGuid: GROUP_CHAT,
        method: 'apple-script',
        type: 'image/png',
      }),
    ]);
    expect(f.server.attachments[0]!.bytes).toBeGreaterThan(10_000);
    expect(f.server.textsTo(GROUP_CHAT).at(-2)).toContain('Amount: 1 AUSD');
  });

  it('still delivers the text when the banner fails', async () => {
    const f = imessageFixture({
      banners: {
        render: async () => {
          throw new Error('render failed');
        },
      },
    });
    await f.link(ALICE, 'principal_alice', GROUP_A);
    f.approvals.set(GROUP_A, [pending]);
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    expect(f.server.attachments).toEqual([]);
  });
});
