import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresChannelStore } from '@synq/channels/postgres';
import { freshChannelDatabase } from './db.js';

const url =
  process.env.SYNQ_CHANNELS_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_channels_test';
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

describe('postgres channel store', () => {
  it('dedupes events durably by (channel, eventId)', async () => {
    expect(await store.recordEvent('telegram', 'update:1', NOW)).toBe(true);
    expect(await store.recordEvent('telegram', 'update:1', NOW)).toBe(false);
    expect(await store.recordEvent('linq', 'update:1', NOW)).toBe(true);
    expect(
      await new PostgresChannelStore(pool).recordEvent(
        'telegram',
        'update:1',
        NOW,
      ),
    ).toBe(false);
  });

  it('redeems a link code exactly once under concurrency', async () => {
    await store.createLinkCode(code('h1'));
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.redeemLinkCode({
          codeHash: 'h1',
          groupId: '0xg1',
          principalId: 'p_alice',
          now: NOW + 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'LINKED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'CODE_CONSUMED')).toHaveLength(5);
    expect(await store.groupLink('telegram', '-100')).toMatchObject({
      groupId: '0xg1',
      status: 'ACTIVE',
    });
    expect(await store.userLink('telegram', '111')).toMatchObject({
      principalId: 'p_alice',
    });
    expect((await store.linkCode('h1'))?.consumedAt).toBe(NOW + 1);
  });

  it('rejects expired codes, cross-group relinks and user rebinding', async () => {
    await store.createLinkCode(code('h2', { expiresAt: NOW }));
    expect(
      (
        await store.redeemLinkCode({
          codeHash: 'h2',
          groupId: '0xg1',
          principalId: 'p_alice',
          now: NOW,
        })
      ).status,
    ).toBe('CODE_EXPIRED');
    await store.createLinkCode(code('h3', { externalUserId: '222' }));
    expect(
      (
        await store.redeemLinkCode({
          codeHash: 'h3',
          groupId: '0xg2',
          principalId: 'p_bob',
          now: NOW,
        })
      ).status,
    ).toBe('GROUP_LINK_CONFLICT');
    expect((await store.linkCode('h3'))?.consumedAt).toBeNull();
    await store.createLinkCode(code('h4', { externalGroupId: '-200' }));
    expect(
      (
        await store.redeemLinkCode({
          codeHash: 'h4',
          groupId: '0xg2',
          principalId: 'p_bob',
          now: NOW,
        })
      ).status,
    ).toBe('USER_LINK_CONFLICT');
    expect(
      (
        await store.redeemLinkCode({
          codeHash: 'nope',
          groupId: '0xg2',
          principalId: 'p_bob',
          now: NOW,
        })
      ).status,
    ).toBe('CODE_INVALID');
    await store.createLinkCode(code('h5', { externalUserId: '222' }));
    expect(
      (
        await store.redeemLinkCode({
          codeHash: 'h5',
          groupId: '0xg1',
          principalId: 'p_bob',
          now: NOW,
        })
      ).status,
    ).toBe('LINKED');
    expect(
      (await store.groupLinks('0xg1')).map((g) => g.externalGroupId),
    ).toEqual(['-100']);
  });

  it('revokes users and claims notifications once', async () => {
    await store.revokeUser('telegram', '222', NOW);
    expect((await store.userLink('telegram', '222'))?.status).toBe('REVOKED');
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
});
