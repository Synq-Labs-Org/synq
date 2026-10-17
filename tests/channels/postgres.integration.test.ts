import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresChannelStore } from '@synq/channels/postgres';
import { freshChannelDatabase } from './db.js';
import { testDatabaseUrl } from '../durable/pg.js';

const url = testDatabaseUrl('SYNQ_CHANNELS_DATABASE_URL', 'synq_channels_test');
let pool: pg.Pool;
let store: PostgresChannelStore;
const NOW = 1_800_000_000;

beforeAll(async () => {
  pool = await freshChannelDatabase(url);
  store = new PostgresChannelStore(pool);
  await store.migrate();
  await store.migrate();
});
afterAll(async () => {
  await pool?.end();
});

const code = (hash: string, over = {}) => ({
  codeHash: hash,
  channel: 'telegram' as const,
  externalGroupId: '-100',
  externalUserId: '111',
  displayName: '@alice',
  createdAt: NOW,
  expiresAt: NOW + 900,
  ...over,
});

const redeem = (
  codeHash: string,
  groupId: string,
  principalId: string,
  token = `t_${codeHash}`,
) =>
  store.redeemLinkCode({
    codeHash,
    groupId,
    principalId,
    confirmTokenHash: token,
    now: NOW + 1,
    pendingExpiresBefore: 0,
  });

describe('postgres channel store', () => {
  it('claims events durably, retries released or abandoned claims, never completed ones', async () => {
    expect(await store.claimEvent('telegram', 'update:1', NOW, 120)).toBe(true);
    expect(await store.claimEvent('telegram', 'update:1', NOW + 10, 120)).toBe(
      false,
    );
    expect(await store.claimEvent('linq', 'update:1', NOW, 120)).toBe(true);
    await store.releaseEvent('telegram', 'update:1');
    expect(await store.claimEvent('telegram', 'update:1', NOW + 20, 120)).toBe(
      true,
    );
    expect(await store.claimEvent('telegram', 'update:1', NOW + 200, 120)).toBe(
      true,
    );
    await store.completeEvent('telegram', 'update:1', NOW + 201);
    await store.releaseEvent('telegram', 'update:1');
    expect(
      await new PostgresChannelStore(pool).claimEvent(
        'telegram',
        'update:1',
        NOW + 9999,
        120,
      ),
    ).toBe(false);
  });

  it('redeems a link code exactly once under concurrency into PENDING links', async () => {
    await store.createLinkCode(code('h1'));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => redeem('h1', '0xg1', 'p_alice')),
    );
    expect(results.filter((r) => r.status === 'LINKED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'CODE_CONSUMED')).toHaveLength(5);
    expect(await store.groupLink('telegram', '-100')).toMatchObject({
      groupId: '0xg1',
      status: 'PENDING',
    });
    expect(await store.userLink('telegram', '-100', '111')).toMatchObject({
      principalId: 'p_alice',
      status: 'PENDING',
    });
    expect(await store.groupLinks()).toEqual([]);
  });

  it('confirms only with the right chat user and token, and activates the chat at quorum', async () => {
    expect(
      await store.confirmUserLink({
        channel: 'telegram',
        externalUserId: '999',
        confirmTokenHash: 't_h1',
        now: NOW,
        chatAdmin: false,
      }),
    ).toBeNull();
    expect(
      await store.confirmUserLink({
        channel: 'telegram',
        externalUserId: '111',
        confirmTokenHash: 'wrong',
        now: NOW,
        chatAdmin: false,
      }),
    ).toBeNull();
    expect(
      (
        await store.confirmUserLink({
          channel: 'telegram',
          externalUserId: '111',
          confirmTokenHash: 't_h1',
          now: NOW,
          chatAdmin: false,
        })
      )?.status,
    ).toBe('ACTIVE');
    expect(
      await store.confirmUserLink({
        channel: 'telegram',
        externalUserId: '111',
        confirmTokenHash: 't_h1',
        now: NOW,
        chatAdmin: false,
      }),
    ).toBeNull();
    expect(
      (
        await store.activateGroupLink('telegram', '-100', 2, NOW, {
          requireChatAdmin: false,
          pendingExpiresBefore: 0,
        })
      )?.status,
    ).toBe('PENDING');
    await store.createLinkCode(code('h2', { externalUserId: '222' }));
    expect((await redeem('h2', '0xg1', 'p_bob')).status).toBe('LINKED');
    await store.confirmUserLink({
      channel: 'telegram',
      externalUserId: '222',
      confirmTokenHash: 't_h2',
      now: NOW,
      chatAdmin: false,
    });
    expect(
      (
        await store.activateGroupLink('telegram', '-100', 2, NOW, {
          requireChatAdmin: false,
          pendingExpiresBefore: 0,
        })
      )?.status,
    ).toBe('ACTIVE');
    expect(
      (await store.groupLinks('0xg1')).map((g) => g.externalGroupId),
    ).toEqual(['-100']);
  });

  it('rejects expired codes, cross-group relinks and in-chat user rebinding', async () => {
    await store.createLinkCode(code('h3', { expiresAt: NOW }));
    expect((await redeem('h3', '0xg1', 'p_alice')).status).toBe('CODE_EXPIRED');
    await store.createLinkCode(code('h4', { externalUserId: '333' }));
    expect((await redeem('h4', '0xg2', 'p_carol')).status).toBe(
      'GROUP_LINK_CONFLICT',
    );
    expect((await store.linkCode('h4'))?.consumedAt).toBeNull();
    await store.createLinkCode(code('h5'));
    expect((await redeem('h5', '0xg1', 'p_bob')).status).toBe(
      'USER_LINK_CONFLICT',
    );
    expect((await redeem('nope', '0xg1', 'p_bob')).status).toBe('CODE_INVALID');
    await store.createLinkCode(code('h6', { externalGroupId: '-200' }));
    expect((await redeem('h6', '0xg2', 'p_bob')).status).toBe('LINKED');
  });

  it('revokes users per chat and claims notifications once', async () => {
    await store.revokeUser('telegram', '-200', '111', NOW);
    expect((await store.userLink('telegram', '-200', '111'))?.status).toBe(
      'REVOKED',
    );
    expect((await store.userLink('telegram', '-100', '111'))?.status).toBe(
      'ACTIVE',
    );
    expect(
      await store.claimNotification('telegram', '-100', 'receipt:1', NOW),
    ).toBe(true);
    expect(
      await store.claimNotification('telegram', '-100', 'receipt:1', NOW),
    ).toBe(false);
    await store.releaseNotification('telegram', '-100', 'receipt:1');
    expect(
      await store.claimNotification('telegram', '-100', 'receipt:1', NOW),
    ).toBe(true);
    await store.recordDeliveryFailure({
      channel: 'telegram',
      externalGroupId: '-100',
      reason: 'x'.repeat(900),
      attempts: 3,
      at: NOW,
    });
    const rows = await pool.query(
      'SELECT length(reason) AS n FROM synq_channel_delivery_failure',
    );
    expect(Number(rows.rows[0].n)).toBe(500);
  });

  it('expires squatted pending chats, gates activation on a chat admin, and unlinks a chat', async () => {
    await store.createLinkCode(
      code('s1', { externalGroupId: '-300', externalUserId: '666' }),
    );
    expect((await redeem('s1', '0xevil', 'p_mallory')).status).toBe('LINKED');
    await store.createLinkCode(
      code('s2', {
        externalGroupId: '-300',
        externalUserId: '111',
        expiresAt: NOW + 20_000,
      }),
    );
    expect((await redeem('s2', '0xg1', 'p_alice')).status).toBe(
      'GROUP_LINK_CONFLICT',
    );
    const late = (h: string, user: string, principal: string) =>
      store.redeemLinkCode({
        codeHash: h,
        groupId: '0xg1',
        principalId: principal,
        confirmTokenHash: `t_${h}`,
        now: NOW + 10_000,
        pendingExpiresBefore: NOW + 10_000 - 3600,
      });
    expect((await late('s2', '111', 'p_alice')).status).toBe('LINKED');
    expect((await store.userLink('telegram', '-300', '666'))?.status).toBe(
      'REVOKED',
    );
    await store.confirmUserLink({
      channel: 'telegram',
      externalUserId: '111',
      confirmTokenHash: 't_s2',
      now: NOW + 10_001,
      chatAdmin: false,
    });
    await store.createLinkCode(
      code('s3', {
        externalGroupId: '-300',
        externalUserId: '222',
        expiresAt: NOW + 20_000,
      }),
    );
    expect((await late('s3', '222', 'p_bob')).status).toBe('LINKED');
    await store.confirmUserLink({
      channel: 'telegram',
      externalUserId: '222',
      confirmTokenHash: 't_s3',
      now: NOW + 10_002,
      chatAdmin: false,
    });
    const gate = {
      requireChatAdmin: true,
      pendingExpiresBefore: NOW + 10_002 - 3600,
    };
    expect(
      (await store.activateGroupLink('telegram', '-300', 2, NOW + 10_002, gate))
        ?.status,
    ).toBe('PENDING');
    await store.setChatAdmin('telegram', '-300', '222', true);
    expect(
      (await store.activateGroupLink('telegram', '-300', 2, NOW + 10_003, gate))
        ?.status,
    ).toBe('ACTIVE');
    expect(
      (await store.revokeGroupLink('telegram', '-300', NOW + 10_004))?.status,
    ).toBe('REVOKED');
    expect((await store.userLink('telegram', '-300', '111'))?.status).toBe(
      'REVOKED',
    );
    expect(
      (await store.groupLinks('0xg1')).map((g) => g.externalGroupId),
    ).toEqual(['-100']);
  });
});
