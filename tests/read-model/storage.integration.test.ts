import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient } from 'redis';
import {
  PostgresReadModel,
  RedisSnapshotCache,
} from '../../packages/read-model/src/storage.js';
import {
  binding,
  chainId,
  event,
  hash,
  proof,
  treasuryToken,
} from './fixtures.js';

describe('real Postgres and Redis persistence', () => {
  const db = new pg.Client({
    connectionString:
      process.env.SYNQ_TEST_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_test',
  });
  const redis = createClient({
    url: process.env.SYNQ_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379',
  });
  const model = new PostgresReadModel(db, chainId, treasuryToken, [binding]);
  beforeAll(async () => {
    await db.connect();
    await redis.connect();
    await model.migrate();
    await db.query(
      'TRUNCATE synq_chain_event,synq_group_projection,synq_projection_checkpoint',
    );
    await redis.flushDb();
  });
  afterAll(async () => {
    await redis.quit();
    await db.end();
  });
  it('restarts, rejects partial writes, flushes cache, deletes projection DB and deterministically rebuilds from proof', async () => {
    await model.ingest(proof(), 3);
    await model.ingest(proof(), 3);
    const restarted = new PostgresReadModel(db, chainId, treasuryToken, [
      binding,
    ]);
    const before = await restarted.snapshot(binding.groupId, 3, 1000);
    expect(before.treasuryBalance).toBe('900000');
    await db.query(
      "UPDATE synq_group_projection SET state_json=jsonb_set(state_json,'{treasuryBalance}','\"999999999999\"'::jsonb) WHERE chain_id=$1",
      [chainId],
    );
    await expect(restarted.snapshot(binding.groupId, 3, 1000)).rejects.toThrow(
      'canonical event proof',
    );
    await restarted.rebuildFromProof(proof(), 3);
    const repaired = await restarted.snapshot(binding.groupId, 3, 1000);
    expect(repaired.treasuryBalance).toBe('900000');
    await expect(
      restarted.ingest(
        [
          event('MandateRevoked', 4, {
            groupId: binding.groupId,
            account: binding.account,
            mandateId: hash(2),
            version: '9',
          }),
        ],
        4,
      ),
    ).rejects.toThrow('version');
    expect(await restarted.snapshot(binding.groupId, 3, 1000)).toEqual(
      repaired,
    );
    const cache = new RedisSnapshotCache(redis, restarted);
    const cached = await cache.snapshot(binding.groupId, 3, 1000);
    expect(await redis.dbSize()).toBe(1);
    await redis.flushDb();
    expect(await cache.snapshot(binding.groupId, 3, 1000)).toEqual(cached);
    await db.query(
      'TRUNCATE synq_chain_event,synq_group_projection,synq_projection_checkpoint',
    );
    await restarted.rebuildFromProof(proof().reverse(), 3);
    expect({
      ...(await cache.snapshot(binding.groupId, 3, 1000)),
      generation: 0,
    }).toEqual({ ...before, generation: 0 });
    await restarted.ingest(
      [
        event(
          'PauseChanged',
          3,
          { groupId: binding.groupId, account: binding.account, paused: true },
          { blockHash: hash(999) },
        ),
      ],
      3,
      3,
    );
    expect(await cache.snapshot(binding.groupId, 3, 1000)).toMatchObject({
      paused: true,
      treasuryBalance: '1000000',
      executed: {},
    });
  });
});
