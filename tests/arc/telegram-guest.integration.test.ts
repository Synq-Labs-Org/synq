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
import { testDatabaseUrl } from '../durable/pg.js';

const url = testDatabaseUrl('SYNQ_CHANNELS_DATABASE_URL', 'synq_channels_test');
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
  chat: string,
  id: string,
  user: string,
  sentAt: number,
  over: Partial<ContextMessage> = {},
): ContextMessage => ({
  channel: 'telegram',
  externalGroupId: chat,
  messageId: id,
  eventId: `update:42:${id}`,
  externalUserId: user,
  principalId: `principal_${user}`,
  text: `text ${id}`,
  textSha256: 'f'.repeat(63) + '0',
  replyTo: null,
  sentAt,
  expiresAt: sentAt + DAY,
  ...over,
});

const terms = (chat: string, retentionSeconds = DAY) => ({
  channel: 'telegram' as const,
  externalGroupId: chat,
  groupId: GROUP,
  retentionSeconds,
  purpose: 'GROUP_FINANCIAL_PROPOSALS' as const,
  visibility: 'ADDRESSED_ONLY' as const,
  enrolledByPrincipalId: 'principal_111',
  enrolledAt: NOW,
});
const consentOf = (chat: string, user: string, policyVersion: number) => ({
  channel: 'telegram' as const,
  externalGroupId: chat,
  externalUserId: user,
  principalId: `principal_${user}`,
  policyVersion,
  consentedAt: NOW,
});
/** Enrolls `chat`, discloses it and records consent for `users`; returns the version. */
async function enrolled(chat: string, users: string[], retention = DAY) {
  const p = await memory.enroll(terms(chat, retention));
  expect(await memory.markDisclosed('telegram', chat, p.version, NOW)).toBe(
    true,
  );
  for (const u of users)
    await memory.grantConsent(consentOf(chat, u, p.version));
  return p.version;
}
const envelopeOf = (chat: string, user: string, id: string, at: number) => ({
  channel: 'telegram' as const,
  eventId: `update:42:${id}`,
  externalGroupId: chat,
  chatKind: 'GROUP' as const,
  externalUserId: user,
  messageId: id,
  body: `note ${id}`,
  timestamp: at,
  replyTo: null,
  interaction: {
    kind: 'MENTION' as const,
    addressedToBot: true,
    command: null,
    args: '',
    callbackData: null,
  },
  attachments: [],
  verifiedSender: {
    transport: 'FIXTURE' as const,
    providerUserId: user,
    displayName: null,
    isBot: false,
  },
});
const rawCount = async (chat: string, user?: string) =>
  Number(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM synq_channel_context_message WHERE channel=$1 AND external_group_id=$2 AND ($3::text IS NULL OR external_user_id=$3)',
        ['telegram', chat, user ?? null],
      )
    ).rows[0]!.n,
  );
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Postgres consented chat memory', () => {
  it('P04-06 stores once per message under the current terms, returns only readable rows, and deletes on opt-out, purge and memory off', async () => {
    const chat = '-2001';
    const v = await enrolled(chat, ['111']);
    expect(await memory.policy('telegram', chat)).toMatchObject({
      version: v,
      retentionSeconds: DAY,
      visibility: 'ADDRESSED_ONLY',
      disclosedAt: NOW,
    });
    expect((await memory.consent('telegram', chat, '111'))?.policyVersion).toBe(
      v,
    );
    const guard = { groupId: GROUP, policyVersion: v };
    expect(
      await memory.storeMessage(msg(chat, '1', '111', NOW + 10), guard),
    ).toBe('STORED');
    expect(
      await memory.storeMessage(msg(chat, '1', '111', NOW + 10), guard),
    ).toBe('DUPLICATE');
    // No consent, wrong version, wrong group, before disclosure: refused.
    expect(
      await memory.storeMessage(msg(chat, '2', '222', NOW + 20), guard),
    ).toBe('REFUSED');
    expect(
      await memory.storeMessage(msg(chat, '3', '111', NOW + 20), {
        ...guard,
        policyVersion: v + 1,
      }),
    ).toBe('REFUSED');
    expect(
      await memory.storeMessage(msg(chat, '4', '111', NOW + 20), {
        ...guard,
        groupId: `0x${'b2'.repeat(32)}`,
      }),
    ).toBe('REFUSED');
    expect(
      await memory.storeMessage(msg(chat, '5', '111', NOW - 1), guard),
    ).toBe('REFUSED');
    expect(
      await memory.storeMessage(
        msg(chat, '6', '111', NOW + 30, { expiresAt: NOW + 31 }),
        guard,
      ),
    ).toBe('STORED');
    expect(
      (await memory.messages('telegram', chat, NOW + 40, 50)).map(
        (m) => m.messageId,
      ),
    ).toEqual(['1']);
    expect(await memory.countMessages('telegram', chat, NOW + 40, '111')).toBe(
      1,
    );
    expect(await memory.purgeExpired(NOW + 40)).toBe(1);
    expect(await memory.revokeConsent('telegram', chat, '111')).toBe(1);
    await memory.grantConsent(consentOf(chat, '111', v));
    await memory.storeMessage(msg(chat, '7', '111', NOW + 50), guard);
    expect(await memory.clearPolicy('telegram', chat)).toBe(1);
    expect(await memory.clearPolicy('telegram', chat)).toBe(0); // idempotent
    expect(await memory.policy('telegram', chat)).toBeNull();
    expect(await memory.consent('telegram', chat, '111')).toBeNull();
  });

  it('P04-06 the read path rechecks consent: a stray row without consent is never returned', async () => {
    const chat = '-2002';
    await enrolled(chat, ['111']);
    await pool.query(
      `INSERT INTO synq_channel_context_message (channel, external_group_id, message_id, event_id, external_user_id, principal_id, text, text_sha256, reply_to, sent_at, expires_at)
       VALUES ('telegram',$1,'stray','update:stray','333','principal_333','not consented',$2,NULL,$3,$4)`,
      [chat, 'f'.repeat(64 - 1) + '0', NOW + 5, NOW + DAY],
    );
    expect(await rawCount(chat)).toBe(1);
    expect(await memory.messages('telegram', chat, NOW + 10, 50)).toEqual([]);
    expect(await memory.countMessages('telegram', chat, NOW + 10)).toBe(0);
  });

  it('P04-06 a capture racing an opt-out, memory off or new terms is refused, never left behind', async () => {
    const service = new ChatContextService(memory);
    const race = async (
      chat: string,
      steps: (client: pg.PoolClient) => Promise<void>,
    ) => {
      const v = await enrolled(chat, ['111']);
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        await steps(a); // uncommitted: the capture below still sees the old rows
        const capture = service.capture({
          envelope: envelopeOf(chat, '111', 'race', NOW + 5),
          groupId: GROUP,
          principalId: 'principal_111',
        });
        await pause(200);
        await a.query('COMMIT');
        return { v, outcome: await capture };
      } finally {
        a.release();
      }
    };
    const optout = await race('-2003', async (a) => {
      await a.query(
        "DELETE FROM synq_channel_context_consent WHERE channel='telegram' AND external_group_id='-2003' AND external_user_id='111'",
      );
      await a.query(
        "DELETE FROM synq_channel_context_message WHERE channel='telegram' AND external_group_id='-2003' AND external_user_id='111'",
      );
    });
    expect(optout.outcome).toBe('NO_CONSENT');
    expect(await rawCount('-2003')).toBe(0);
    const off = await race('-2004', async (a) => {
      for (const t of ['policy', 'consent', 'message'])
        await a.query(
          `DELETE FROM synq_channel_context_${t} WHERE channel='telegram' AND external_group_id='-2004'`,
        );
    });
    expect(off.outcome).toBe('NO_CONSENT');
    expect(await rawCount('-2004')).toBe(0);
    const reterms = await race('-2005', async (a) => {
      await a.query(
        "UPDATE synq_channel_context_policy SET version=version+1, disclosed_at=NULL WHERE channel='telegram' AND external_group_id='-2005'",
      );
    });
    expect(reterms.outcome).toBe('NO_CONSENT');
    expect(await rawCount('-2005')).toBe(0);
  });

  it('P04-06 shorter retention caps stored rows; consent to old terms does not carry over', async () => {
    const chat = '-2006';
    const v1 = await enrolled(chat, ['111'], 30 * DAY);
    await memory.storeMessage(
      msg(chat, '1', '111', NOW + 10, { expiresAt: NOW + 10 + 30 * DAY }),
      {
        groupId: GROUP,
        policyVersion: v1,
      },
    );
    const v2 = (await memory.enroll(terms(chat, DAY))).version;
    expect(v2).toBe(v1 + 1);
    // Undisclosed new terms: nothing is readable or storable yet.
    expect(await memory.messages('telegram', chat, NOW + 20, 50)).toEqual([]);
    await memory.markDisclosed('telegram', chat, v2, NOW + 20);
    expect(
      (await memory.messages('telegram', chat, NOW + 30, 50))[0]?.expiresAt,
    ).toBe(NOW + 10 + DAY);
    expect(await memory.messages('telegram', chat, NOW + 11 + DAY, 50)).toEqual(
      [],
    );
    expect(await rawCount(chat)).toBe(1);
    expect(await memory.purgeExpired(NOW + 11 + DAY)).toBeGreaterThanOrEqual(1);
    expect(await rawCount(chat)).toBe(0);
    // Longer again: the old consent (v1) cannot store under v3.
    const v3 = (await memory.enroll(terms(chat, 30 * DAY))).version;
    await memory.markDisclosed('telegram', chat, v3, NOW + 40);
    const service = new ChatContextService(memory);
    expect(
      await service.capture({
        envelope: envelopeOf(chat, '111', 'after', NOW + 50),
        groupId: GROUP,
        principalId: 'principal_111',
      }),
    ).toBe('NO_CONSENT');
    await memory.grantConsent({
      ...consentOf(chat, '111', v3),
      consentedAt: NOW + 45,
    });
    expect(
      await service.capture({
        envelope: envelopeOf(chat, '111', 'renewed', NOW + 50),
        groupId: GROUP,
        principalId: 'principal_111',
      }),
    ).toBe('STORED');
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
