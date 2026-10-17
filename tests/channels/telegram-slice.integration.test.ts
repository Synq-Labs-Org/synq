import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { formatDecimal } from '@synq/domain';
import type { GrantDraft } from '@synq/schemas';
import {
  ChannelGateway,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  type ApprovalSummary,
  type ReceiptSummary,
} from '@synq/channels';
import { PostgresChannelStore } from '@synq/channels/postgres';
import { freshChannelDatabase } from './db.js';
import { FakeTelegram } from '../../apps/demo/src/fake-telegram.js';
import { testDatabaseUrl } from '../durable/pg.js';

process.env.SYNQ_DEMO_DATABASE_URL ??= testDatabaseUrl(
  'SYNQ_UNUSED_TEST_DATABASE_URL',
  'synq_channels_demo',
);
const CHANNEL_DB = testDatabaseUrl(
  'SYNQ_CHANNELS_SLICE_DATABASE_URL',
  'synq_channels_slice_test',
);
const CHAT = -100777;
const WEB = 'https://synq.test';
const EXPLORER = 'https://testnet.monadexplorer.com/tx/';
const noWait = async () => undefined;

type Local = Awaited<
  ReturnType<
    (typeof import('../../apps/demo/src/local.js'))['startLocalVertical']
  >
>;
let local: Local;
let pool: pg.Pool;
let telegram: FakeTelegram;
let journal: string;
let abort = new AbortController();
let polling: Promise<void>;
const pending = new Map<string, { draft: GrantDraft; label: string }>();
const receipts: ReceiptSummary[] = [];
let gateway: ChannelGateway;
let adapter: TelegramAdapter;

const waitFor = async <T>(probe: () => T | undefined | false, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > end) throw new Error('TIMEOUT');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const nowS = () => Math.floor(Date.now() / 1000);
const user = (id: number, name: string) => ({
  id,
  is_bot: false,
  first_name: name,
  username: name,
});
const say = (
  from: number,
  name: string,
  text: string,
  extra: Record<string, unknown> = {},
) => {
  const command = /^\/\S+/.exec(text);
  return telegram.push({
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: nowS(),
      chat: { id: CHAT, type: 'supergroup', title: 'Synq trip' },
      from: user(from, name),
      text,
      entities: command
        ? [{ type: 'bot_command', offset: 0, length: command[0].length }]
        : [],
      ...extra,
    },
  });
};
const lastText = () => telegram.sent.at(-1)?.text ?? '';
const sentCount = () => telegram.sent.length;
const nextReply = async (before: number) => {
  await waitFor(() => telegram.sent.length > before);
  return telegram.sent[before]!;
};

beforeAll(async () => {
  journal = mkdtempSync(join(tmpdir(), 'synq-channels-'));
  const { startLocalVertical } = await import('../../apps/demo/src/local.js');
  local = await startLocalVertical();
  telegram = new FakeTelegram();
  telegram.creators.add(`${CHAT}:1001`);
  await telegram.start();
  pool = await freshChannelDatabase(CHANNEL_DB);
  const store = new PostgresChannelStore(pool);
  await store.migrate();
  const identity = local.identity;
  const groupId = local.mandate.groupId;
  const decimals = local.decimals;
  adapter = new TelegramAdapter({
    api: new TelegramBotApi({ token: telegram.token, baseUrl: telegram.url }),
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
  });
  const bot = await adapter.init();
  gateway = new ChannelGateway({
    store,
    adapters: [adapter],
    webBaseUrl: WEB,
    explorerTxUrl: EXPLORER,
    now: nowS,
    botUsernames: { telegram: bot.username },
    brainCooldownSeconds: 0,
    ports: {
      activeMember: async (g, principalId) => {
        if (g !== groupId) return null;
        const ms = await identity.store.transaction((tx) =>
          tx.listMemberships(g),
        );
        const m = ms.find(
          (x) => x.principalId === principalId && x.status === 'ACTIVE',
        );
        return m ? { memberId: m.memberId } : null;
      },
      groupLabel: async () => 'local_group',
      treasury: async (g) => {
        if (g !== groupId) return null;
        const balance = await local.balanceOf(local.chain.account);
        const f = (v: bigint) => formatDecimal(v, decimals);
        return {
          symbol: local.asset.symbol,
          total: f(balance),
          free: f(balance),
          reserved: f(0n),
          pending: f(0n),
          account: local.chain.account,
          chainId: local.asset.chainId,
          asOf: `block ${await local.chain.client.getBlockNumber()}`,
        };
      },
      mandates: async () => [],
      approvals: async (g) => {
        const out: ApprovalSummary[] = [];
        if (g !== groupId) return out;
        for (const [digest, p] of pending) {
          const q = await identity.gateway.quorum(digest);
          out.push({
            intentHash: p.draft.grant.intentHash,
            draftDigest: digest,
            label: p.label,
            counted: q.counted.length,
            required: q.required,
            status:
              q.draftStatus === 'INVALIDATED'
                ? 'INVALIDATED'
                : q.satisfied
                  ? 'SATISFIED'
                  : 'PENDING',
          });
        }
        return out;
      },
      receipts: async (g) => (g === groupId ? receipts : []),
      sendRecipient: async (_g, q) =>
        q === 'recipient'
          ? { recipientId: 'contact:recipient', label: 'recipient' }
          : null,
    },
  });
  polling = adapter.poll({
    signal: abort.signal,
    timeoutSeconds: 1,
    handle: (e) => gateway.handle(e),
  });
}, 180_000);

afterAll(async () => {
  abort.abort();
  await polling?.catch(() => undefined);
  await telegram?.stop();
  await pool?.end();
  await local?.close();
  if (journal) rmSync(journal, { recursive: true, force: true });
});

it('Telegram group → link → balance → Send → web approvals → Kernel grant → anvil execution → receipt in chat', async () => {
  const groupId = local.mandate.groupId;
  const memberships = await local.identity.store.transaction((tx) =>
    tx.listMemberships(groupId),
  );
  const principal = (memberId: string) =>
    memberships.find((m) => m.memberId === memberId)!.principalId;

  let n = sentCount();
  telegram.push({
    my_chat_member: {
      chat: { id: CHAT, type: 'supergroup', title: 'Synq trip' },
      from: user(1001, 'alice'),
      date: nowS(),
      old_chat_member: { status: 'left' },
      new_chat_member: {
        status: 'member',
        user: { id: 4242, is_bot: true, first_name: 'Synq' },
      },
    },
  });
  expect((await nextReply(n)).text).toMatch(/type \/synq/);

  n = sentCount();
  say(1001, 'alice', '/balance');
  await new Promise((r) => setTimeout(r, 600));
  expect(sentCount()).toBe(n);

  for (const [userId, name, memberId] of [
    [1001, 'alice', 'member_0'],
    [1002, 'bob', 'member_1'],
  ] as const) {
    n = sentCount();
    say(userId, name, '/synq');
    const reply = await nextReply(n);
    expect(reply.chat_id).toBe(CHAT);
    const deep = new URL(reply.reply_markup!.inline_keyboard[0]![0]!.url);
    expect(deep.origin + deep.pathname).toBe('https://t.me/synq_test_bot');
    if (userId === 1002) {
      n = sentCount();
      say(1001, 'alice', `/start ${deep.searchParams.get('start')}`, {
        chat: { id: 1001, type: 'private' },
      });
      const refused = await nextReply(n);
      expect(refused.chat_id).toBe(1001);
      expect(refused.text).toMatch(/another member/);
    }
    n = sentCount();
    say(userId, name, `/start ${deep.searchParams.get('start')}`, {
      chat: { id: userId, type: 'private' },
    });
    const dm = await nextReply(n);
    expect(dm.chat_id).toBe(userId);
    const url = new URL(dm.reply_markup!.inline_keyboard[0]![0]!.url);
    expect(url.origin + url.pathname).toBe(`${WEB}/channels/link`);
    const outcome = await gateway.redeemLinkCode({
      code: url.searchParams.get('code')!,
      groupId,
      principalId: principal(memberId),
    });
    expect(outcome.status).toBe('LINKED');
    const ask = telegram.sent.find(
      (m) => m.chat_id === userId && m.text.includes('/confirm '),
    )!;
    expect(ask.text).toContain(memberId);
    n = sentCount();
    say(userId, name, `/confirm ${/\/confirm (\S+)/.exec(ask.text)![1]}`, {
      chat: { id: userId, type: 'private' },
    });
    await waitFor(() => telegram.sent.slice(n).some((m) => m.chat_id === CHAT));
    const chatNote = telegram.sent.slice(n).find((m) => m.chat_id === CHAT)!;
    expect(chatNote.text).toMatch(
      userId === 1001 ? /Waiting for 2 members/ : /now speaks for Synq group/,
    );
  }

  n = sentCount();
  say(1003, 'mallory', '/send 1 recipient');
  expect((await nextReply(n)).text).toMatch(/not linked/);

  n = sentCount();
  say(1001, 'alice', '/balance');
  expect((await nextReply(n)).text).toContain(
    `total ${formatDecimal(200_000_000n, local.decimals)}`,
  );

  n = sentCount();
  say(1001, 'alice', '/send 0.00000000006 recipient');
  const sendReply = await nextReply(n);
  const sendUrl = new URL(sendReply.reply_markup!.inline_keyboard[0]![0]!.url);
  expect(sendUrl.pathname).toBe('/send');
  expect(sendUrl.searchParams.get('amount')).toBe('0.00000000006');

  // The member confirms on the web page; the Send API proposes to the Kernel with no approvals.
  const proposal = await local.propose(60_000_000n, '9001');
  const request = {
    intent: proposal.intent,
    risk: proposal.risk,
    simulation: proposal.simulation,
  };
  const first = await local.kernel.authorize({ ...request, approvals: [] });
  expect(first.status).toBe('PENDING_APPROVAL');
  if (first.status !== 'PENDING_APPROVAL' || !first.draft)
    throw new Error('NO_DRAFT');
  const draft = first.draft;
  await local.assertModuleDigest(draft);
  await local.identity.gateway.registerDraft({ draft, asset: local.asset });
  pending.set(draft.digest, {
    draft,
    label: 'Send 0.00000000006 to recipient',
  });

  n = sentCount();
  await gateway.notify();
  const ask = telegram.sent[n]!;
  expect(ask.text).toContain('0/2 verified passkey approvals');
  expect(ask.reply_markup!.inline_keyboard[0]![0]!.url).toBe(
    `${WEB}/intents/${draft.grant.intentHash}`,
  );

  n = sentCount();
  say(1002, 'bob', 'yes', {
    reply_to_message: {
      message_id: 1,
      from: { id: 4242, is_bot: true, first_name: 'Synq' },
    },
  });
  expect((await nextReply(n)).text).toMatch(/never approve/);
  telegram.push({
    callback_query: {
      id: 'forged-1',
      from: user(1002, 'bob'),
      data: `approve:${draft.digest}`,
      message: {
        message_id: 5,
        date: nowS(),
        chat: { id: CHAT, type: 'supergroup' },
      },
    },
  });
  await waitFor(() => telegram.answered.includes('forged-1'));
  expect(
    (await local.identity.gateway.quorum(draft.digest)).counted,
  ).toHaveLength(0);

  await local.identity.approve(draft, [0]);
  n = sentCount();
  await gateway.notify();
  expect(telegram.sent[n]!.text).toContain('1/2 verified passkey approvals');

  await local.identity.approve(draft, [1]);
  n = sentCount();
  await gateway.notify();
  expect(telegram.sent[n]!.text).toMatch(/Quorum reached .* 2\/2/);

  const quorum = await local.identity.gateway.quorum(draft.digest);
  const decision = await local.kernel.authorize({
    ...request,
    approvals: quorum.counted,
  });
  expect(decision.status).toBe('AUTHORIZED');
  if (decision.status !== 'AUTHORIZED') throw new Error('NOT_AUTHORIZED');
  const executed = await local.execute(
    decision.grant,
    proposal.intent,
    proposal.data,
    join(journal, 'journal'),
  );
  expect(executed.observation.event?.tokenAmount).toBe('60000000');
  receipts.push({
    intentHash: decision.grant.intentHash,
    transactionHash: executed.transactionHash,
    state: 'CONFIRMED',
    label: 'Send 0.00000000006 to recipient',
    executionMode: 'SIMULATION',
  });
  n = sentCount();
  await gateway.notify();
  const receipt = telegram.sent[n]!;
  expect(receipt.text).toContain('[SIMULATION]');
  expect(receipt.reply_markup!.inline_keyboard[0]![0]!.url).toBe(
    `${EXPLORER}${executed.transactionHash}`,
  );

  const { reader } = await local.project();
  const snapshot = await reader.groupSnapshot(local.chain.chainGroupId);
  const indexed = snapshot!.group.grantsExecuted.find(
    (g) => g.intentHash === decision.grant.intentHash,
  );
  expect(indexed?.transactionHash).toBe(executed.transactionHash);
  receipts[0] = { ...receipts[0]!, state: 'RECONCILED' };
  n = sentCount();
  expect(await gateway.notify()).toEqual({ delivered: 1, failed: 0 });
  expect(lastText()).toMatch(/^Reconciled/);
  expect(await gateway.notify()).toEqual({ delivered: 0, failed: 0 });

  // A re-delivered update after a poller restart is deduped durably.
  const replayed = say(1001, 'alice', '/status');
  n = sentCount();
  await nextReply(n);
  abort.abort();
  await polling;
  abort = new AbortController();
  const restartedAt = telegram.getUpdatesOffsets.length;
  telegram.replay(replayed);
  polling = adapter.poll({
    signal: abort.signal,
    timeoutSeconds: 1,
    handle: (e) => gateway.handle(e),
  });
  await waitFor(() => telegram.getUpdatesOffsets.length > restartedAt + 1);
  expect(telegram.getUpdatesOffsets[restartedAt]).toBeUndefined();
  expect(telegram.getUpdatesOffsets[restartedAt + 1]).toBe(
    replayed.update_id + 1,
  );
  expect(sentCount()).toBe(n + 1);

  // Provider outage: delivery failure is recorded and the receipt is retried later.
  receipts.push({ ...receipts[0]!, intentHash: `0x${'ee'.repeat(32)}` });
  telegram.outage = true;
  expect(await gateway.notify()).toEqual({ delivered: 0, failed: 1 });
  const failures = await pool.query(
    'SELECT count(*)::int AS n FROM synq_channel_delivery_failure',
  );
  expect(failures.rows[0].n).toBeGreaterThan(0);
  telegram.outage = false;
  expect(await gateway.notify()).toEqual({ delivered: 1, failed: 0 });
}, 180_000);
