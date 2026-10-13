import { describe, expect, it } from 'vitest';
import {
  CardLinkIssuer,
  InteractiveCardService,
  REFRESH_CALLBACK,
  renderBridgeRichLink,
  renderIMessageFallback,
  renderNativeLiveLayout,
  renderTelegramCard,
  type ApprovalSummary,
} from '@synq/channels';
import {
  CardResolutionSchema,
  InteractiveCardSchema,
  ReviewPathSchema,
} from '@synq/schemas';
import {
  CARD_KEY,
  CHAT_A,
  CHAT_B,
  GROUP_A,
  GROUP_B,
  fixture,
} from './harness.js';

const HASH = (b: string) => `0x${b.repeat(32)}`;
const NOW = 1_800_000_000;
const links = (now = () => NOW) =>
  new CardLinkIssuer({
    key: CARD_KEY,
    webBaseUrl: 'https://synq.example',
    now,
    ttlSeconds: 3600,
  });
const service = (l: CardLinkIssuer | null = links()) =>
  new InteractiveCardService({
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
    now: () => NOW,
    links: l,
  });
const pending: ApprovalSummary = {
  intentHash: HASH('11'),
  draftDigest: HASH('22'),
  label: 'Send 1.5 AUSD to carol',
  counted: 1,
  required: 2,
  status: 'PENDING',
  kind: 'SEND',
  amount: { amount: '1.5', symbol: 'AUSD' },
  recipient: { label: 'carol', address: `0x${'c3'.repeat(20)}` },
};
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('interactive card service', () => {
  it('builds every card type against the canonical schema', () => {
    const s = service();
    const g = { groupId: GROUP_A, groupLabel: 'Trip fund' };
    const cards = [
      s.treasury({
        ...g,
        treasury: {
          symbol: 'AUSD',
          total: '10.000000',
          free: '9.000000',
          reserved: '1.000000',
          pending: '0',
          account: `0x${'5a'.repeat(20)}`,
          chainId: 10143,
          asOf: 'indexed block 100',
        },
        memberCount: 3,
        activity: [{ label: 'alice contributed 2 AUSD', at: 'block 98' }],
      }),
      s.approval({ ...g, approval: pending }),
      s.gift({
        ...g,
        proposalId: HASH('44'),
        occasion: "Sam's birthday",
        options: [
          {
            optionId: 'amazon10',
            product: 'Amazon US gift card',
            price: { amount: '10', symbol: 'USD' },
            delivery: 'email code',
            votes: 2,
          },
        ],
        finalOptionId: 'amazon10',
        provider: 'Reloadly sandbox',
        executionMode: 'PROVIDER_SANDBOX',
      }),
      s.hotel({
        ...g,
        proposalId: null,
        stay: 'Lisbon, 2 nights',
        options: [
          {
            optionId: 'h1',
            hotel: 'Hotel A',
            room: 'Double',
            total: { amount: '240.00', symbol: 'USD' },
            cancellation: 'free until 48h before',
            preferenceVotes: 1,
          },
        ],
        preferredOptionId: 'h1',
        provider: 'Duffel Stays sandbox',
        executionMode: 'PROVIDER_SANDBOX',
        votePath: '/groups/x/votes/h',
      }),
      s.dca({
        ...g,
        mandateId: 'dca_weekly_mon',
        asset: 'MON',
        frequency: 'weekly on Friday',
        perExecutionLimit: { amount: '20', symbol: 'AUSD' },
        cumulativeLimit: { amount: '200', symbol: 'AUSD' },
        spent: { amount: '40', symbol: 'AUSD' },
        nextExecutionAt: NOW + 86400,
        status: 'ACTIVE',
        managePath: '/mandates/dca_weekly_mon',
      }),
      s.receipt({
        ...g,
        receipt: {
          intentHash: HASH('11'),
          transactionHash: HASH('33'),
          state: 'RECONCILED',
          label: 'Send 1.5 AUSD to carol',
          executionMode: 'REAL_TESTNET',
        },
      }),
    ];
    for (const c of cards) expect(InteractiveCardSchema.parse(c)).toEqual(c);
    expect(cards.map((c) => c.type)).toEqual([
      'GROUP_TREASURY',
      'APPROVAL_PROPOSAL',
      'GROUP_GIFT',
      'HOTEL_COMPARISON',
      'DCA_MANDATE',
      'EXECUTION_RECEIPT',
    ]);
    const receipt = cards[5]!;
    expect(receipt).toMatchObject({
      executionMode: 'REAL_TESTNET',
      settlementStatus: 'SETTLED',
      explorerUrl: `https://testnet.monadexplorer.com/tx/${HASH('33')}`,
    });
    expect(cards[4]!.actions.map((a) => a.kind)).toEqual(['PAUSE', 'REVOKE']);
  });

  it('labels an unknown receipt mode with the weakest claim', () => {
    const r = service().receipt({
      groupId: GROUP_A,
      groupLabel: 'g',
      receipt: {
        intentHash: HASH('11'),
        transactionHash: HASH('33'),
        state: 'CONFIRMED',
        label: 'x',
        executionMode: 'MAINNET_LIVE',
      },
    });
    expect(r.executionMode).toBe('SIMULATION');
    expect(r.settlementStatus).toBe('PENDING');
  });

  it('puts only proposalId, groupId and a group-bound nonce in approval links, and no secrets in cards', () => {
    const card = service().approval({
      groupId: GROUP_A,
      groupLabel: 'g',
      approval: pending,
    });
    const url = card.actions[0]!.url;
    expect(Object.keys(params(url)).sort()).toEqual(['g', 'n', 'p']);
    expect(params(url)).toMatchObject({ p: HASH('11'), g: GROUP_A });
    const json = JSON.stringify(card);
    expect(json).not.toContain(CARD_KEY);
    expect(json).not.toMatch(/signature|privateKey|secret/i);
    expect(card.actions.every((a) => a.url.startsWith('https://'))).toBe(true);
  });
});

describe('card link nonces', () => {
  it('accept the issuing group and proposal only, until expiry', () => {
    let now = NOW;
    const l = links(() => now);
    const n = l.nonce({ groupId: GROUP_A, proposalId: HASH('11') });
    expect(
      l.verify({ groupId: GROUP_A, proposalId: HASH('11'), nonce: n }),
    ).toMatchObject({ ok: true, action: 'REVIEW' });
    expect(
      l.verify({
        groupId: GROUP_A.toUpperCase().replace('0X', '0x'),
        proposalId: HASH('11'),
        nonce: n,
      }).ok,
    ).toBe(true);
    expect(
      l.verify({ groupId: GROUP_B, proposalId: HASH('11'), nonce: n }),
    ).toEqual({ ok: false, code: 'LINK_INVALID' });
    expect(
      l.verify({ groupId: GROUP_A, proposalId: HASH('12'), nonce: n }),
    ).toEqual({ ok: false, code: 'LINK_INVALID' });
    const parts = n.split('.');
    parts[2] = (NOW + 99999).toString(36);
    const forged = parts.join('.');
    expect(
      l.verify({ groupId: GROUP_A, proposalId: HASH('11'), nonce: forged }),
    ).toEqual({ ok: false, code: 'LINK_INVALID' });
    expect(
      l.verify({ groupId: GROUP_A, proposalId: HASH('11'), nonce: 'nope' }),
    ).toEqual({ ok: false, code: 'LINK_MALFORMED' });
    const other = new CardLinkIssuer({
      key: 'another-key-another-key-another-key',
      webBaseUrl: 'https://synq.example',
      now: () => now,
    });
    expect(
      other.verify({ groupId: GROUP_A, proposalId: HASH('11'), nonce: n }),
    ).toEqual({ ok: false, code: 'LINK_INVALID' });
    now += 3600;
    expect(
      l.verify({ groupId: GROUP_A, proposalId: HASH('11'), nonce: n }),
    ).toEqual({ ok: false, code: 'LINK_EXPIRED' });
  });

  it('refuses short keys', () => {
    expect(
      () =>
        new CardLinkIssuer({
          key: 'short',
          webBaseUrl: 'https://x',
          now: () => 0,
        }),
    ).toThrow('CARD_LINK_KEY_TOO_SHORT');
  });
});

describe('card renderers', () => {
  const card = service().approval({
    groupId: GROUP_A,
    groupLabel: 'Trip fund',
    approval: pending,
  });

  it('render the same canonical values on every surface', () => {
    const tg = renderTelegramCard(card);
    const im = renderIMessageFallback(card);
    const bridge = renderBridgeRichLink(card);
    const native = renderNativeLiveLayout(card);
    for (const text of [tg.text, im.text, bridge.text])
      expect(text).toContain('Amount: 1.5 AUSD');
    expect(native.card).toBe(card);
    expect(tg.buttons?.map((b) => b.url)).toEqual(
      card.actions.map((a) => a.url),
    );
    expect(tg.callbacks?.[0]?.data).toMatch(REFRESH_CALLBACK);
    expect(Buffer.byteLength(tg.callbacks![0]!.data)).toBeLessThanOrEqual(64);
    expect(im.buttons).toBeUndefined();
    expect(im.text.trim().endsWith(card.actions[0]!.url)).toBe(true);
    expect(bridge.url).toBe(card.actions[0]!.url);
    expect(bridge.preview.summary).not.toContain('1.5');
    expect(native.layout.trailingCaption).toBe('1/2');
    expect(native.openUrl).toBe(card.actions[0]!.url);
    const m = params(native.messageUrl!);
    expect(m.p).toBe(HASH('11'));
    expect(JSON.parse(Buffer.from(m.card!, 'base64url').toString())).toEqual(
      card,
    );
  });

  it('give settled proposals no approval actions or refresh button', () => {
    const done = service().approval({
      groupId: GROUP_A,
      groupLabel: 'g',
      approval: { ...pending, status: 'SATISFIED', counted: 2 },
    });
    expect(done.actions).toEqual([]);
    expect(renderTelegramCard(done).callbacks).toBeUndefined();
  });
});

describe('gateway with cards', () => {
  const linked = async () => {
    const f = fixture(NOW, { cards: true });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    await f.link(CHAT_B, '333', GROUP_B, 'principal_carol');
    f.adapter.sent = [];
    return f;
  };

  it('posts approval and receipt cards with group-bound links', async () => {
    const f = await linked();
    f.approvals.set(GROUP_A, [pending]);
    expect(await f.gateway.notify()).toEqual({ delivered: 1, failed: 0 });
    const m = f.adapter.last()!;
    expect(m.card?.type).toBe('APPROVAL_PROPOSAL');
    expect(m.text).toContain('Quorum: 1/2 verified passkey approvals');
    expect(params(m.buttons![0]!.url)).toMatchObject({
      p: HASH('11'),
      g: GROUP_A,
    });
    expect(m.callbacks?.[0]?.data).toMatch(REFRESH_CALLBACK);
    expect(await f.gateway.notify()).toEqual({ delivered: 0, failed: 0 });
    f.receipts.set(GROUP_A, [
      {
        intentHash: HASH('11'),
        transactionHash: HASH('33'),
        state: 'CONFIRMED',
        label: 'Send 1.5 AUSD to carol',
        executionMode: 'REAL_TESTNET',
      },
    ]);
    await f.gateway.notify();
    expect(f.adapter.last()?.text).toContain('[REAL_TESTNET]');
  });

  it('renders /balance as a treasury card', async () => {
    const f = await linked();
    await f.gateway.handle(f.message('/balance'));
    expect(f.adapter.last()?.card?.type).toBe('GROUP_TREASURY');
    expect(f.adapter.last()?.text).toContain('Balance: 10.000000 AUSD');
  });

  it('resolves a tapped link only for a member of the bound group and the canonical proposal', async () => {
    const f = await linked();
    f.approvals.set(GROUP_A, [pending]);
    f.approvals.set(GROUP_B, [{ ...pending, intentHash: HASH('99') }]);
    await f.gateway.notify();
    const { p, g, n } = params(
      f.adapter.sent.find((s) => s.chat === CHAT_A)!.message.buttons![0]!.url,
    );
    const ok = await f.gateway.resolveCardLink({
      proposalId: p!,
      groupId: g!,
      nonce: n!,
      principalId: 'principal_alice',
    });
    expect(ok).toMatchObject({
      status: 'OK',
      memberId: 'member_0',
      reviewPath: `/intents/${HASH('11')}`,
      card: { amount: { amount: '1.5', symbol: 'AUSD' }, groupId: GROUP_A },
    });
    // A member of another group cannot use it.
    expect(
      await f.gateway.resolveCardLink({
        proposalId: p!,
        groupId: g!,
        nonce: n!,
        principalId: 'principal_carol',
      }),
    ).toEqual({ status: 'NOT_A_MEMBER' });
    // Cross-group: the same nonce presented for group B fails its MAC.
    expect(
      await f.gateway.resolveCardLink({
        proposalId: p!,
        groupId: GROUP_B,
        nonce: n!,
        principalId: 'principal_carol',
      }),
    ).toEqual({ status: 'LINK_INVALID' });
    // A valid group-B link for a proposal that only exists in group A.
    const crafted = new CardLinkIssuer({
      key: CARD_KEY,
      webBaseUrl: 'https://synq.example',
      now: () => f.clock.t,
    }).nonce({ groupId: GROUP_B, proposalId: HASH('11') });
    expect(
      await f.gateway.resolveCardLink({
        proposalId: HASH('11'),
        groupId: GROUP_B,
        nonce: crafted,
        principalId: 'principal_carol',
      }),
    ).toEqual({ status: 'PROPOSAL_NOT_FOUND' });
    // Replay after quorum: canonical state, no review path.
    f.approvals.set(GROUP_A, [{ ...pending, status: 'SATISFIED', counted: 2 }]);
    const replay = await f.gateway.resolveCardLink({
      proposalId: p!,
      groupId: g!,
      nonce: n!,
      principalId: 'principal_alice',
    });
    expect(replay).toMatchObject({
      status: 'NOT_PENDING',
      card: { status: 'SATISFIED', actions: [] },
    });
    expect('reviewPath' in replay).toBe(false);
    f.clock.t += 3600;
    expect(
      await f.gateway.resolveCardLink({
        proposalId: p!,
        groupId: g!,
        nonce: n!,
        principalId: 'principal_alice',
      }),
    ).toEqual({ status: 'LINK_EXPIRED' });
  });

  it('answers the refresh callback read-only, once per callback, and only for the chat group', async () => {
    const f = await linked();
    f.approvals.set(GROUP_A, [pending]);
    await f.gateway.notify();
    const data = f.adapter.last()!.callbacks![0]!.data;
    const tap = (chat: string, id: string, callbackData = data) => ({
      type: 'ACTION_REQUESTED' as const,
      callbackId: id,
      envelope: {
        ...f.message(callbackData, { externalGroupId: chat }).envelope,
        interaction: {
          kind: 'CALLBACK' as const,
          addressedToBot: true,
          command: null,
          args: '',
          callbackData,
        },
      },
    });
    expect(await f.gateway.handle(tap(CHAT_A, 'cb1'))).toMatchObject({
      status: 'HANDLED',
      code: 'CARD_REFRESHED',
    });
    expect(f.adapter.acks).toEqual(['cb1']);
    expect(await f.gateway.handle(tap(CHAT_A, 'cb1'))).toMatchObject({
      status: 'DUPLICATE',
    });
    expect(await f.gateway.handle(tap(CHAT_B, 'cb2'))).toMatchObject({
      status: 'REFUSED',
      code: 'CARD_NOT_IN_GROUP',
    });
    expect(await f.gateway.handle(tap('-1009', 'cb3'))).toMatchObject({
      status: 'UNAUTHORIZED',
    });
    expect(
      await f.gateway.handle(tap(CHAT_A, 'cb4', `approve:${HASH('22')}`)),
    ).toMatchObject({ status: 'REFUSED', code: 'CALLBACK_NOT_AN_APPROVAL' });
    expect(f.approvals.get(GROUP_A)![0]!.counted).toBe(1);
  });
});

describe('review paths stay on the Synq origin (L9)', () => {
  it('accepts same-origin paths and rejects protocol-relative or absolute URLs', () => {
    for (const ok of [`/intents/${HASH('11')}`, '/mandates/0xab', '/'])
      expect(ReviewPathSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      '//evil.example/x',
      '///evil.example',
      '/\\evil.example',
      'https://evil.example/x',
      'javascript:alert(1)',
      'evil.example/x',
      '',
    ])
      expect(ReviewPathSchema.safeParse(bad).success).toBe(false);
    const card = service().approval({
      groupId: GROUP_A,
      groupLabel: 'Trip fund',
      approval: pending,
    });
    expect(
      CardResolutionSchema.safeParse({
        status: 'OK',
        memberId: 'member_0',
        card,
        reviewPath: '//evil.example/x',
      }).success,
    ).toBe(false);
  });

  it('a tampered approval review path falls back to the canonical intent path', async () => {
    const f = fixture(NOW, { cards: true });
    await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
    f.adapter.sent = [];
    f.approvals.set(GROUP_A, [{ ...pending, reviewPath: '//evil.example/x' }]);
    await f.gateway.notify();
    const url = f.adapter.sent.find((s) => s.chat === CHAT_A)!.message
      .buttons![0]!.url;
    const { p, g, n } = params(url);
    const resolved = await f.gateway.resolveCardLink({
      proposalId: p!,
      groupId: g!,
      nonce: n!,
      principalId: 'principal_alice',
    });
    expect(resolved).toMatchObject({
      status: 'OK',
      reviewPath: `/intents/${HASH('11')}`,
    });
  });
});
