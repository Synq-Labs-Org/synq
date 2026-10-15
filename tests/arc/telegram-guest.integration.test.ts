import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ChannelGateway,
  ChatContextService,
  type ChannelEvent,
  type ChannelPorts,
  type ContextMessage,
} from '@synq/channels';
import {
  PostgresChannelStore,
  PostgresChatContextStore,
} from '@synq/channels/postgres';
import { freshChannelDatabase } from '../channels/db.js';

const url =
  process.env.SYNQ_CHANNELS_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_channels_test';
const NOW = 1_800_000_000;
const DAY = 86_400;
const CHAT = '-1001';
const GROUP = `0x${'a1'.repeat(32)}`;
let pool: pg.Pool;
let channels: PostgresChannelStore;
let memory: PostgresChatContextStore;

beforeAll(async () => {
  pool = await freshChannelDatabase(url);
  await pool.query(
    'DROP TABLE IF EXISTS synq_channel_context_policy, synq_channel_context_consent, synq_channel_context_message',
  );
  channels = new PostgresChannelStore(pool);
  memory = new PostgresChatContextStore(pool);
  await channels.migrate();
  await memory.migrate();
  await memory.migrate(); // idempotent
});
afterAll(async () => {
  await pool?.end();
});

const msg = (
  id: string,
  user: string,
  sentAt: number,
  over: Partial<ContextMessage> = {},
): ContextMessage => ({
  channel: 'telegram',
  externalGroupId: CHAT,
  messageId: id,
  eventId: `update:${id}`,
  externalUserId: user,
  principalId: `principal_${user}`,
  text: `text ${id}`,
  textSha256: 'f'.repeat(63) + '0',
  replyTo: null,
  sentAt,
  expiresAt: sentAt + DAY,
  ...over,
});

describe('Postgres consented chat memory', () => {
  it('P04-06 stores once per message, returns only unexpired rows, and deletes on opt-out, purge and memory off', async () => {
    await memory.setPolicy({
      channel: 'telegram',
      externalGroupId: CHAT,
      groupId: GROUP,
      retentionSeconds: DAY,
      purpose: 'GROUP_FINANCIAL_PROPOSALS',
      visibility: 'ADDRESSED_ONLY',
      enrolledByPrincipalId: 'principal_111',
      enrolledAt: NOW,
      disclosedAt: NOW,
    });
    expect(await memory.policy('telegram', CHAT)).toMatchObject({
      retentionSeconds: DAY,
      visibility: 'ADDRESSED_ONLY',
      disclosedAt: NOW,
    });
    await memory.grantConsent({
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: '111',
      principalId: 'principal_111',
      consentedAt: NOW,
    });
    expect((await memory.consent('telegram', CHAT, '111'))?.consentedAt).toBe(
      NOW,
    );
    expect(await memory.storeMessage(msg('1', '111', NOW + 10))).toBe(true);
    expect(await memory.storeMessage(msg('1', '111', NOW + 10))).toBe(false);
    expect(await memory.storeMessage(msg('2', '222', NOW + 20))).toBe(true);
    expect(
      await memory.storeMessage(
        msg('3', '111', NOW + 30, { expiresAt: NOW + 31 }),
      ),
    ).toBe(true);
    const live = await memory.messages('telegram', CHAT, NOW + 40, 50);
    expect(live.map((m) => m.messageId)).toEqual(['1', '2']);
    expect(await memory.countMessages('telegram', CHAT, NOW + 40)).toBe(2);
    expect(await memory.countMessages('telegram', CHAT, NOW + 40, '111')).toBe(
      1,
    );
    expect(
      (await memory.messages('telegram', CHAT, NOW + 40, 1)).map(
        (m) => m.messageId,
      ),
    ).toEqual(['2']);
    expect(await memory.purgeExpired(NOW + 40)).toBe(1);
    expect(await memory.revokeConsent('telegram', CHAT, '222')).toBe(1);
    expect(await memory.countMessages('telegram', CHAT, NOW + 40)).toBe(1);
    expect(await memory.purgeExpired(NOW + 10 + DAY)).toBe(1);
    await memory.storeMessage(msg('4', '111', NOW + 50));
    expect(await memory.clearPolicy('telegram', CHAT)).toBe(1);
    expect(await memory.policy('telegram', CHAT)).toBeNull();
    expect(await memory.consent('telegram', CHAT, '111')).toBeNull();
  });

  it('P04-06 / P04-07 the gateway on Postgres keeps consented context and runs one proposal per update', async () => {
    const clock = { t: NOW + 1000 };
    await pool.query(
      `INSERT INTO synq_channel_chat_link VALUES ('telegram',$1,$2,'principal_alice',$3,'ACTIVE') ON CONFLICT DO NOTHING`,
      [CHAT, GROUP, NOW],
    );
    for (const [u, p] of [
      ['111', 'principal_alice'],
      ['222', 'principal_bob'],
    ])
      await pool.query(
        `INSERT INTO synq_channel_member_link (channel, external_group_id, external_user_id, principal_id, linked_at, status, chat_admin)
         VALUES ('telegram',$1,$2,$3,$4,'ACTIVE',$5) ON CONFLICT DO NOTHING`,
        [CHAT, u, p, NOW, u === '111'],
      );
    const sent: string[] = [];
    const brainCalls: Parameters<NonNullable<ChannelPorts['brain']>>[0][] = [];
    const gateway = new ChannelGateway({
      store: channels,
      context: new ChatContextService(memory),
      adapters: [
        {
          channel: 'telegram',
          send: async (_chat, m) => (sent.push(m.text), { messageId: '1' }),
          chatRole: async (_chat, user) =>
            user === '111' ? 'ADMIN' : 'MEMBER',
        },
      ],
      ports: {
        activeMember: async (_g, p) =>
          p === 'principal_alice'
            ? { memberId: 'member_0' }
            : p === 'principal_bob'
              ? { memberId: 'member_1' }
              : null,
        treasury: async () => null,
        mandates: async () => [],
        approvals: async () => [],
        receipts: async () => [],
        brain: async (input) => (
          brainCalls.push(input),
          { text: 'ok', proposals: [] }
        ),
      },
      webBaseUrl: 'https://synq.example',
      explorerTxUrl: 'https://explorer.example/tx/',
      now: () => clock.t,
      botUsernames: { telegram: 'synq_bot' },
      brainCooldownSeconds: 0,
    });
    let id = 5000;
    const say = (user: string, body: string, eventId = `update:${++id}`) => {
      const command = /^\/(\w+)/.exec(body);
      const event: ChannelEvent = {
        type: 'MESSAGE_RECEIVED',
        envelope: {
          channel: 'telegram',
          eventId,
          externalGroupId: CHAT,
          chatKind: 'GROUP',
          externalUserId: user,
          messageId: eventId.slice(7),
          body,
          timestamp: clock.t,
          replyTo: null,
          interaction: {
            kind: command ? 'COMMAND' : 'MENTION',
            addressedToBot: true,
            command: command?.[1] ?? null,
            args: '',
            callbackData: null,
          },
          attachments: [],
          verifiedSender: {
            transport: 'FIXTURE',
            providerUserId: user,
            displayName: null,
            isBot: false,
          },
        },
      };
      return gateway.handle(event);
    };
    await say('111', '/memory on 2');
    expect(sent.at(-1)).toContain('Synq memory is ON');
    await say('111', '/memory optin');
    clock.t += 5;
    await say('111', '@synq_bot deposit due Friday');
    await say('222', '@synq_bot I owe nothing');
    expect(await memory.countMessages('telegram', CHAT, clock.t)).toBe(1);
    const results = await Promise.all([
      say('111', '/propose pay deposit', 'update:9001'),
      say('111', '/propose pay deposit', 'update:9001'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'DUPLICATE',
      'HANDLED',
    ]);
    const proposals = brainCalls.filter((c) => c.intent === 'PROPOSE');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.context?.map((m) => m.text)).toEqual([
      '@synq_bot deposit due Friday',
    ]);
    clock.t += 2 * DAY;
    expect(await memory.purgeExpired(clock.t)).toBe(1);
  });
});
