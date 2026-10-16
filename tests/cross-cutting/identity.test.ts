import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fc from 'fast-check';
import type { Address, Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  signTelegramMiniAppInitDataForTest,
  verifyTelegramMiniAppInitData,
  type OutboundMessage,
} from '@synq/channels';
import {
  ChannelLinkService,
  MemoryChannelLinkStore,
  channelLinkTypedData,
  sendAccessTypedData,
  type ChannelProofVerifier,
} from '@synq/identity/server';
import type { DirectoryMember } from '@synq/schemas';
import { contract, token } from '@synq/chain-registry/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  InvoiceService,
  MemoryInvoiceStore,
  draftInvoice,
  issueTypedData,
  payLinkToken,
} from '@synq/invoices';
import {
  AgentRuntimeError,
  CapabilityGuard,
  NEVER_TOOLS,
  SubagentManager,
} from '@synq/agent-runtime';
import { channelRoutes } from '../../apps/api/src/channel-routes.js';
import { invoiceRoutes } from '../../apps/api/src/invoice-routes.js';
import { createSendMemberAccess } from '../../apps/api/src/send-access.js';
import { callerFor, mayFund } from '../../apps/api/src/member-scope.js';
import type { SendGroupContext } from '../../apps/api/src/send-routes.js';
import { CHAT_A, FakeAdapter, GROUP_A, fixture } from '../channels/harness.js';

/**
 * Cross-cutting IDENTITY rows (X-IDE-01..07). Real channel routes and
 * gateway (`@synq/channels`, apps/api channel-routes), real channel-wallet
 * linking (`@synq/identity` ChannelLinkService with Telegram's own Mini App
 * HMAC), real member sessions (apps/api send-access) and real invoice pay
 * links, all in memory (LOCAL_FIXTURE). No Telegram, no network.
 */

const TG_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const SECRET = 'webhook_secret_0123456789';
const NOW = 1_800_000_000;
const noWait = async () => undefined;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

async function telegramServer() {
  const f = fixture(NOW);
  const telegram = new TelegramAdapter({
    api: new TelegramBotApi({
      token: TG_TOKEN,
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 1 } }),
        )) as typeof fetch,
    }),
    bot: { id: 42, username: 'synq_bot' },
    webhookSecret: SECRET,
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
  });
  app = Fastify();
  await app.register(channelRoutes, {
    gateway: f.gateway,
    telegram,
    now: () => f.clock.t,
    memberSession: async () => null,
    env: { TELEGRAM_BOT_TOKEN: 'present' },
  });
  const update = (id: number, text: string) => ({
    update_id: id,
    message: {
      message_id: id,
      date: f.clock.t,
      chat: { id: Number(CHAT_A), type: 'supergroup' },
      from: { id: 111, is_bot: false, first_name: 'Alice' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  });
  const post = (body: unknown, headers: Record<string, string | string[]>) =>
    app!.inject({
      method: 'POST',
      url: '/v1/channels/telegram/webhook',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(body),
    });
  return { f, update, post };
}

/** Telegram Mini App proof verifier: the platform's stable id, never a handle. */
const miniAppVerifier: ChannelProofVerifier = (proof, now) => {
  const id = verifyTelegramMiniAppInitData(proof, TG_TOKEN, now);
  if (!id) return null;
  const user = JSON.parse(
    new URLSearchParams(String(proof)).get('user') ?? '{}',
  ) as { username?: string };
  return {
    channelUserId: id.telegramUserId,
    ...(user.username ? { displayHandle: user.username } : {}),
  };
};
const initData = (id: number, username: string, at = NOW - 30) =>
  signTelegramMiniAppInitDataForTest(
    {
      auth_date: String(at),
      query_id: `q_${id}_${at}`,
      user: JSON.stringify({ id, first_name: username, username }),
    },
    TG_TOKEN,
  );
function linkService(clock = { t: NOW }) {
  const dms = new Map<string, string>();
  const store = new MemoryChannelLinkStore();
  const links = new ChannelLinkService(store, {
    now: () => clock.t,
    deliverCode: async ({ channelUserId, code }) => {
      dms.set(channelUserId, code);
    },
    verifiers: { telegram: miniAppVerifier },
  });
  const request = (workspaceId: string, proof: unknown, wallet: Address) =>
    links.requestLink({
      workspaceId,
      channel: 'telegram',
      channelProof: proof,
      wallet,
    });
  return { links, store, dms, request, clock };
}

/** Real member-session minting (apps/api send-access) over a switchable directory. */
function memberSessions(groups: readonly Hex[]) {
  const account = `0x${'0a'.repeat(20)}` as Address;
  const member = privateKeyToAccount(generatePrivateKey());
  const signer = member.address.toLowerCase() as Address;
  const state = { clock: NOW, active: true, epoch: 3 };
  const directory = {
    activeMember: async (
      g: string,
      m: string,
    ): Promise<DirectoryMember | null> =>
      state.active && groups.includes(g as Hex) && m === 'alice'
        ? {
            groupId: g,
            memberId: 'alice',
            principalId: 'prn_alice',
            principalKind: 'MERA_HUMAN',
            role: 'APPROVER',
            signer,
            membershipEpoch: state.epoch,
            ownerOfAccount: true,
          }
        : null,
    membershipEpoch: async () => state.epoch,
  };
  const context = async (g: string) =>
    groups.includes(g as Hex)
      ? ({
          groupId: g,
          mandate: { account, network: { chainId: 5042002 } },
          members: [{ memberId: 'alice', principalId: 'prn_alice', signer }],
          contacts: [],
        } as unknown as SendGroupContext)
      : null;
  const access = createSendMemberAccess({
    directory,
    context,
    now: () => state.clock,
  });
  const login = async (group: Hex) => {
    const c = (await access.challenge(
      group,
      'prn_alice',
      'MEMBER_CONTRIBUTE',
    ))!;
    return access.issue(
      c.challengeId,
      await member.signTypedData(sendAccessTypedData(c)),
    );
  };
  return { access, member, state, login };
}

describe('X-IDE cross-cutting identity attacks', () => {
  it('X-IDE-01 a wrong Telegram webhook secret never mutates anything (fuzzed near-misses), the right one is processed once', async () => {
    const { f, update, post } = await telegramServer();
    const nearMisses = [
      '',
      SECRET.toUpperCase(),
      `${SECRET} `,
      ` ${SECRET}`,
      SECRET.slice(0, -1),
      `${SECRET}x`,
      SECRET.replace(/.$/, 'X'),
    ];
    let n = 0;
    for (const s of nearMisses) {
      const r = await post(update(++n, '/synq'), {
        'x-telegram-bot-api-secret-token': s,
      });
      expect(r.statusCode).toBe(401);
    }
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 64 }).filter((s) => s !== SECRET),
        async (s) => {
          const r = await post(update(++n, '/synq'), {
            'x-telegram-bot-api-secret-token': s,
          });
          expect(r.statusCode).toBe(401);
          expect(r.json()).toEqual({ error: 'WEBHOOK_SECRET_INVALID' });
        },
      ),
      { numRuns: 100 },
    );
    // Header given twice (array) is not the secret either.
    expect(
      (
        await post(update(++n, '/synq'), {
          'x-telegram-bot-api-secret-token': [SECRET, SECRET],
        })
      ).statusCode,
    ).toBe(401);
    // Nothing was claimed, linked, coded or sent for any refused delivery.
    expect(f.store.events.size).toBe(0);
    expect(f.store.codes.size).toBe(0);
    expect(f.adapter.sent).toHaveLength(0);
    const ok = await post(update(++n, '/synq'), {
      'x-telegram-bot-api-secret-token': SECRET,
    });
    expect(ok.json()).toEqual({ ok: true, outcomes: ['HANDLED'] });
    expect(f.store.events.size).toBe(1);
  });

  it('X-IDE-02 a guest reply (or any chat text) that tries to approve funds approves nothing and writes nothing', async () => {
    const f = fixture(NOW);
    const answered: { id: string; message: OutboundMessage }[] = [];
    (
      f.adapter as FakeAdapter & {
        answerGuest: (
          id: string,
          m: OutboundMessage,
        ) => Promise<{ inlineMessageId: string }>;
      }
    ).answerGuest = async (id, message) => {
      answered.push({ id, message });
      return { inlineMessageId: `inline_${id}` };
    };
    f.approvals.set(GROUP_A, [
      {
        label: 'Pay venue deposit 40 AUSD',
        counted: 1,
        required: 2,
        status: 'PENDING',
      } as never,
    ]);
    const before = JSON.stringify([...f.approvals.entries()]);
    const attempts = [
      'yes',
      'approve',
      '/approve',
      'I approve',
      '/confirm 0xabc',
      '✅',
      'LGTM',
    ];
    for (const [n, text] of attempts.entries()) {
      f.clock.t += 10;
      const envelope = f.message(text, { externalGroupId: '-100999' }).envelope;
      const outcome = await f.gateway.handle({
        type: 'GUEST_QUERY',
        envelope: { ...envelope, chatKind: 'GROUP' },
        receiver: 'bot:42',
        guestQueryId: `gq_${n}`,
        reference: null,
      });
      expect(outcome).toMatchObject({ code: 'GUEST_ANSWERED' });
      expect(answered.at(-1)!.message.text).toMatch(
        /never approve anything, and a guest reply least of all/,
      );
    }
    // Answered only through the guest path; no group message, link, code or approval change.
    expect(f.adapter.sent).toHaveLength(0);
    expect(f.store.groups.size).toBe(0);
    expect(f.store.codes.size).toBe(0);
    expect(f.brainCalls).toHaveLength(0);
    expect(JSON.stringify([...f.approvals.entries()])).toBe(before);
    // An addressed "yes" in an enrolled chat is refused as an approval as well.
    const yes = await f.gateway.handle(f.message('@synq_bot yes'));
    expect(yes).toMatchObject({ code: 'CHAT_TEXT_NOT_APPROVAL' });
    expect(JSON.stringify([...f.approvals.entries()])).toBe(before);
  });

  it('X-IDE-03 a stolen Mini App initData is accepted once; a replay or a thief without the DM code cannot link', async () => {
    const { request, links, dms } = linkService();
    const victim = privateKeyToAccount(generatePrivateKey());
    const thief = privateKeyToAccount(generatePrivateKey());
    const proof = initData(4242, 'victim');
    // The thief uses the captured initData first, with the thief's wallet.
    const stolen = await request('wsp_a', proof, thief.address);
    expect(stolen.channelUserId).toBe('4242');
    // The one-time code went to the victim's own Telegram id, not to the thief.
    expect([...dms.keys()]).toEqual(['4242']);
    const thiefSig = await thief.signTypedData(channelLinkTypedData(stolen));
    for (const guess of ['00000000', '12345678', '99999999'])
      expect(
        await errCode(
          links.completeLink({
            challengeId: stolen.challengeId,
            channelCode: guess,
            signature: thiefSig,
          }),
        ),
      ).toBe('CHALLENGE_MISMATCH');
    // Three misses burn the challenge, even for the right code.
    expect(
      await errCode(
        links.completeLink({
          challengeId: stolen.challengeId,
          channelCode: dms.get('4242')!,
          signature: thiefSig,
        }),
      ),
    ).toBe('CHALLENGE_CONSUMED');
    // Replay of the same initData, by anyone, is refused.
    for (const wallet of [thief.address, victim.address])
      expect(await errCode(request('wsp_a', proof, wallet))).toBe(
        'UNAUTHORIZED',
      );
    expect(
      await links.resolve({
        workspaceId: 'wsp_a',
        channel: 'telegram',
        channelUserId: '4242',
      }),
    ).toBeNull();
    // Stale or forged initData never proves anyone.
    expect(
      await errCode(
        request('wsp_a', initData(4242, 'v', NOW - 7200), victim.address),
      ),
    ).toBe('UNAUTHORIZED');
    expect(
      await errCode(
        request(
          'wsp_a',
          proof.replace(/hash=[0-9a-f]{4}/, 'hash=0000'),
          victim.address,
        ),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('X-IDE-04 two groups with the same display name (and a handle change) never share a wallet principal', async () => {
    const { request, links, dms, clock } = linkService();
    const ownerA = privateKeyToAccount(generatePrivateKey());
    const ownerB = privateKeyToAccount(generatePrivateKey());
    const link = async (
      ws: string,
      id: number,
      handle: string,
      acct: typeof ownerA,
    ) => {
      clock.t += 1;
      const c = await request(
        ws,
        initData(id, handle, clock.t - 5),
        acct.address,
      );
      return links.completeLink({
        challengeId: c.challengeId,
        channelCode: dms.get(String(id))!,
        signature: await acct.signTypedData(channelLinkTypedData(c)),
      });
    };
    // Both groups call their treasurer "tripfund".
    const a = await link('wsp_trip_a', 111, 'tripfund', ownerA);
    const b = await link('wsp_trip_b', 222, 'tripfund', ownerB);
    expect(a.displayHandle).toBe('tripfund');
    expect(b.displayHandle).toBe('tripfund');
    const resolve = (workspaceId: string, channelUserId: string) =>
      links.resolve({ workspaceId, channel: 'telegram', channelUserId });
    expect(await resolve('wsp_trip_a', '111')).toBe(ownerA.address);
    expect(await resolve('wsp_trip_b', '222')).toBe(ownerB.address);
    // The other group's member does not resolve here, and a handle is never an id.
    expect(await resolve('wsp_trip_a', '222')).toBeNull();
    expect(await resolve('wsp_trip_b', '111')).toBeNull();
    for (const handle of ['tripfund', '@tripfund'])
      expect(await errCode(resolve('wsp_trip_a', handle))).toBe(
        'INVALID_INPUT',
      );
    // B's user cannot unlink A's binding by name; unlink is by stable id and needs A's wallet.
    expect(
      await errCode(
        links.requestUnlink({
          workspaceId: 'wsp_trip_a',
          channel: 'telegram',
          channelUserId: '@tripfund',
        }),
      ),
    ).toBe('INVALID_INPUT');
    // Handle change: user 111 renames to "treasurer"; the binding follows the id, not the name.
    clock.t += 1;
    expect(
      await errCode(
        request(
          'wsp_trip_a',
          initData(111, 'treasurer', clock.t - 5),
          ownerB.address,
        ),
      ),
    ).toBe('PRINCIPAL_EXISTS');
    expect(await resolve('wsp_trip_a', '111')).toBe(ownerA.address);
    // Someone else (333) takes the old handle "tripfund": they inherit nothing.
    clock.t += 1;
    const squatter = privateKeyToAccount(generatePrivateKey());
    const c = await request(
      'wsp_trip_a',
      initData(333, 'tripfund', clock.t - 5),
      squatter.address,
    );
    expect(c.channelUserId).toBe('333');
    // ...and cannot claim owner A's wallet without A's signature.
    clock.t += 1;
    const claim = await request(
      'wsp_trip_b',
      initData(333, 'tripfund', clock.t - 5),
      ownerA.address,
    );
    expect(
      await errCode(
        links.completeLink({
          challengeId: claim.challengeId,
          channelCode: dms.get('333')!,
          signature: await squatter.signTypedData(channelLinkTypedData(claim)),
        }),
      ),
    ).toBe('SIGNATURE_MISMATCH');
    expect(await resolve('wsp_trip_b', '333')).toBeNull();
  });

  it('X-IDE-05 a member session (or pending session challenge) revoked before the signature is used authorizes nothing', async () => {
    // Synq has no SMS/OTP login (Privy/Dynamic are not used): member sessions
    // are minted from an EIP-712 signature by the member's active signer.
    // This exercises revocation at both points: before the challenge is signed
    // and after the session was issued but before it is used.
    const group = `0x${'a1'.repeat(32)}` as Hex;
    const { access, member, state } = memberSessions([group]);
    // 1. Revoked between challenge and signature.
    const c1 = (await access.challenge(
      group,
      'prn_alice',
      'MEMBER_CONTRIBUTE',
    ))!;
    const sig1 = await member.signTypedData(sendAccessTypedData(c1));
    state.active = false;
    expect(await access.issue(c1.challengeId, sig1)).toBeNull();
    // 2. Session issued, then the membership epoch moves (member removed and re-added) before use.
    state.active = true;
    state.clock += 200; // past the first challenge's expiry
    const c2 = (await access.challenge(
      group,
      'prn_alice',
      'MEMBER_CONTRIBUTE',
    ))!;
    const session = await access.issue(
      c2.challengeId,
      await member.signTypedData(sendAccessTypedData(c2)),
    );
    expect(session).not.toBeNull();
    const header = `Bearer ${session!.token}`;
    const deps = { adminToken: null, memberAccess: access };
    expect(mayFund(await callerFor(header, group, deps), member.address)).toBe(
      true,
    );
    state.epoch += 1;
    expect(await callerFor(header, group, deps)).toBeNull();
    expect(mayFund(await callerFor(header, group, deps), member.address)).toBe(
      false,
    );
    // 3. Revoked principal: the stored session is dead even with the old epoch restored.
    state.epoch -= 1;
    state.active = false;
    expect(await callerFor(header, group, deps)).toBeNull();
    // A consumed challenge cannot mint a second session.
    state.active = true;
    expect(
      await access.issue(
        c2.challengeId,
        await member.signTypedData(sendAccessTypedData(c2)),
      ),
    ).toBeNull();
  });

  it('X-IDE-06 a subagent asking for a temporary signer credential is refused at every layer', () => {
    const m = new SubagentManager('xide06', ['READ_MARKET', 'PROPOSE_ACTION']);
    const temporary = { maxWallClockMs: 5_000, maxToolCalls: 1 };
    for (const cap of ['SIGN', 'ISSUE_GRANT', 'WITHDRAW'] as const) {
      let k = 'OK';
      try {
        m.spawn(m.rootHandle.agentId, 'PAYMENT', [cap], temporary);
      } catch (e) {
        k = e instanceof AgentRuntimeError ? e.kind : String(e);
      }
      expect(k).toBe('CAPABILITY_ESCALATION');
    }
    expect(
      m.findings.filter(
        (f) => f.kind === 'CAPABILITY_ESCALATION' && f.severity === 'HIGH',
      ),
    ).toHaveLength(3);
    const g = new CapabilityGuard({ verifiedCounterparties: () => [] });
    g.root('sup');
    g.delegate({ parentId: 'sup', childId: 'pay', role: 'PAYMENT' });
    for (const t of [
      'signer.sign',
      'wallet.signTransaction',
      'kernel.issueGrant',
    ]) {
      expect(NEVER_TOOLS).toContain(t);
      for (const id of ['sup', 'pay']) {
        let k = 'OK';
        try {
          g.authorize(id, t);
        } catch (e) {
          k = e instanceof AgentRuntimeError ? e.kind : String(e);
        }
        expect(k).toBe('FORBIDDEN_TOOL_CALL');
      }
    }
    expect(
      g.log.filter((e) => e.action === 'REFUSED').length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('X-IDE-07 a pay link or member session from another workspace cannot read or settle this workspace’s invoice', async () => {
    const USDC = token('arc-testnet', 'USDC');
    const MEMO = contract('arc-testnet', 'MEMO').address;
    const KEY = new Uint8Array(32).fill(7);
    const svc = new InvoiceService(
      new MemoryInvoiceStore(),
      new Ledger(new MemoryLedgerStore()),
      () => NOW,
    );
    const issueFor = async (workspaceId: string, number: string, k: Hex) => {
      const who = privateKeyToAccount(k);
      const d = draftInvoice({
        workspaceId,
        number,
        issuer: {
          principalId: `p_${workspaceId}`,
          name: workspaceId,
          wallet: who.address,
          payoutAddress: who.address,
        },
        payer: { name: 'Acme', contact: null },
        asset: USDC,
        lineItems: [{ description: 'Work', quantity: 1, unitPrice: 250_000n }],
        dueDate: '2026-10-30',
        draftedBy: 'agent:invoice',
        now: NOW,
      });
      await svc.create(d);
      return (
        await svc.issue(d.invoiceId, await who.signTypedData(issueTypedData(d)))
      ).invoice;
    };
    const a = await issueFor('wsp_a', 'INV-A-1', `0x${'81'.repeat(32)}`);
    const b = await issueFor('wsp_b', 'INV-B-1', `0x${'82'.repeat(32)}`);
    app = Fastify();
    await app.register(invoiceRoutes, {
      invoices: svc,
      payLinkKey: KEY,
      client: {
        getTransactionReceipt: async () => {
          throw new Error('no receipt in this test');
        },
      } as unknown as PublicClient,
      memoContract: MEMO,
      now: () => NOW,
    });
    const tokenA = payLinkToken(KEY, a, NOW + 3600);
    const tokenB = payLinkToken(KEY, b, NOW + 3600);
    expect((await app.inject({ url: `/v1/pay/${tokenA}` })).statusCode).toBe(
      200,
    );
    // A's link re-pointed at B's invoice id, B's link with A's MAC, and a
    // link minted under another deployment's key are all refused.
    const [, ...restA] = tokenA.split('.');
    const swapped = [b.invoiceId, ...restA].join('.');
    const mixed = [...tokenB.split('.').slice(0, 3), tokenA.split('.')[3]].join(
      '.',
    );
    const foreignKey = payLinkToken(new Uint8Array(32).fill(8), b, NOW + 3600);
    for (const t of [swapped, mixed, foreignKey]) {
      const r = await app.inject({ url: `/v1/pay/${t}` });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: 'BAD_PAY_LINK' });
      const v = await app.inject({
        method: 'POST',
        url: `/v1/pay/${t}/verify`,
        payload: { txHash: `0x${'c4'.repeat(32)}` },
      });
      expect(v.statusCode).toBe(403);
    }
    expect((await svc.store.get(b.invoiceId))!.invoice.paid).toBe(0n);
    // A real member session for group A is not a session for group B, even
    // for a principal who is also a member of B.
    const groupA = `0x${'a1'.repeat(32)}` as Hex;
    const groupB = `0x${'b2'.repeat(32)}` as Hex;
    const { access, login } = memberSessions([groupA, groupB]);
    const sessionA = (await login(groupA))!;
    const deps = { adminToken: null, memberAccess: access };
    const header = `Bearer ${sessionA.token}`;
    expect(await callerFor(header, groupA, deps)).toMatchObject({
      kind: 'MEMBER',
      groupId: groupA,
    });
    expect(await callerFor(header, groupB, deps)).toBeNull();
    expect(await access.session(sessionA.token, groupB)).toBeNull();
  });
});
