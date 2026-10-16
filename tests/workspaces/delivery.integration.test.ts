import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ChannelDeliveryError, type ChannelAdapter } from '@synq/channels';
import { PostgresDeliveryQueue } from '@synq/channels/durable-delivery';
import { workspacePool } from './pg.js';
import { testDatabaseUrl } from '../durable/pg.js';
let pool: Pool;
let now = 2_000_000_000;
const queue = () => new PostgresDeliveryQueue(pool, () => now);
beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl(
      'SYNQ_WORKSPACE_DELIVERY_TEST_DATABASE_URL',
      'synq_m2_workspace_delivery',
    ),
  );
  await queue().migrate();
});
afterAll(async () => {
  await pool?.end();
});
const event = () => ({
  eventId: randomUUID(),
  workspaceId: randomUUID(),
  channel: 'telegram' as const,
  destination: String(Math.floor(Math.random() * 100000) + 1),
  message: { text: 'Arc testnet payout reconciled.' },
});
describe('G13 durable delivery — LOCAL_FIXTURE', () => {
  it('migrates up/down and deduplicates a stable money event across concurrent relays', async () => {
    await queue().migrate(0);
    await queue().migrate();
    const e = event();
    const ids = await Promise.all([queue().enqueue(e), queue().enqueue(e)]);
    expect(ids[0]).toBe(ids[1]);
    await expect(
      queue().enqueue({ ...e, message: { text: 'Different amount' } }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    let sent = 0;
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      send: async () => ({ messageId: String(++sent) }),
    };
    await Promise.all([
      queue().pump(adapter, async () => true),
      queue().pump(adapter, async () => true),
    ]);
    expect(sent).toBe(1);
    expect((await queue().status(e.workspaceId))[0]?.state).toBe('SENT');
    expect(await queue().pump(adapter, async () => true)).toBe(false);
  });
  it('retries explicit non-delivery and withholds an unproven or revoked destination', async () => {
    const e = event();
    await queue().enqueue(e);
    let attempts = 0;
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      send: async () => {
        if (++attempts === 1) throw new ChannelDeliveryError('RATE_LIMITED', 1);
        return { messageId: 'delivered' };
      },
    };
    await queue().pump(adapter, async () => true);
    expect((await queue().status(e.workspaceId))[0]?.state).toBe('RETRY');
    now += 31;
    await queue().pump(adapter, async () => true);
    expect((await queue().status(e.workspaceId))[0]?.state).toBe('SENT');
    const revoked = event();
    await queue().enqueue(revoked);
    await queue().pump(adapter, async () => false);
    expect(attempts).toBe(2);
    expect((await queue().status(revoked.workspaceId))[0]?.state).toBe(
      'REVOKED',
    );
  });
  it('never blindly retries a network timeout that may have delivered', async () => {
    const e = event();
    await queue().enqueue(e);
    let sent = 0;
    const adapter: ChannelAdapter = {
      channel: 'telegram',
      send: async () => {
        sent++;
        throw new Error('connection dropped after provider accepted');
      },
    };
    await queue().pump(adapter, async () => true);
    expect((await queue().status(e.workspaceId))[0]?.state).toBe('UNKNOWN');
    now += 3600;
    expect(await queue().pump(adapter, async () => true)).toBe(false);
    expect(sent).toBe(1);
  });
  it('holds expired in-flight leases after a process crash instead of duplicating a receipt', async () => {
    const e = event(),
      id = await queue().enqueue(e);
    await pool.query(
      "UPDATE synq_durable_delivery SET state='SENDING',lease=$2,lease_until=$3 WHERE id=$1",
      [id, randomUUID(), now - 1],
    );
    let sent = 0;
    await queue().pump(
      {
        channel: 'telegram',
        send: async () => ({ messageId: String(++sent) }),
      },
      async () => true,
    );
    expect(sent).toBe(0);
    expect((await queue().status(e.workspaceId))[0]?.state).toBe('UNKNOWN');
  });
});
