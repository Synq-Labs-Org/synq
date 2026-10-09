import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createClient } from 'redis';
import {
  readEnvioProof,
  syncEnvioProjection,
} from '../../packages/read-model/src/envio.js';
import {
  PostgresReadModel,
  RedisSnapshotCache,
} from '../../packages/read-model/src/storage.js';
import { type GroupBinding } from '../../packages/read-model/src/index.js';

const artifactPath = process.env.SYNQ_ENVIO_PROOF_ARTIFACT;
const enabled = Boolean(artifactPath);
const connectionString =
  process.env.SYNQ_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_test';
const source = new pg.Client({ connectionString });
const targetDb = new pg.Client({ connectionString });
const redis = createClient({
  url: process.env.SYNQ_ENVIO_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/1',
});
beforeAll(async () => {
  if (enabled) {
    await source.connect();
    await targetDb.connect();
    await redis.connect();
  }
});
afterAll(async () => {
  if (enabled) {
    await source.end();
    await targetDb.end();
    if (redis.isOpen) await redis.quit();
  }
});
it.skipIf(!enabled)(
  'rebuilds from actual Envio-indexed Anvil receipts after SQL projection deletion and Redis flush',
  async () => {
    const artifact = JSON.parse(await readFile(artifactPath!, 'utf8')) as {
      localTestToken: `0x${string}`;
      bindings: GroupBinding[];
      checkpoint: number;
      accountBalance: string;
      transactionHash: string;
    };
    const proof = await readEnvioProof(source, 31337, 'envio');
    expect(proof.indexedThroughBlock).toBeGreaterThanOrEqual(
      artifact.checkpoint,
    );
    expect(
      proof.events.some(
        (e) =>
          e.eventName === 'GrantExecuted' &&
          e.transactionHash.toLowerCase() ===
            artifact.transactionHash.toLowerCase(),
      ),
    ).toBe(true);
    const model = new PostgresReadModel(
      targetDb,
      31337,
      artifact.localTestToken,
      artifact.bindings,
    );
    await model.migrate();
    await targetDb.query('DELETE FROM synq_chain_event WHERE chain_id=31337');
    await targetDb.query(
      'DELETE FROM synq_group_projection WHERE chain_id=31337',
    );
    await targetDb.query(
      'DELETE FROM synq_projection_checkpoint WHERE chain_id=31337',
    );
    await syncEnvioProjection(source, model, 'envio');
    const binding = artifact.bindings[0]!;
    const cache = new RedisSnapshotCache(redis, model);
    const before = await cache.snapshot(
      binding.groupId,
      proof.sourceBlock,
      1000,
    );
    expect(before.treasuryBalance).toBe(artifact.accountBalance);
    await redis.flushDb();
    await targetDb.query('DELETE FROM synq_chain_event WHERE chain_id=31337');
    await targetDb.query(
      'DELETE FROM synq_group_projection WHERE chain_id=31337',
    );
    await targetDb.query(
      'DELETE FROM synq_projection_checkpoint WHERE chain_id=31337',
    );
    await syncEnvioProjection(source, model, 'envio');
    const after = await cache.snapshot(
      binding.groupId,
      proof.sourceBlock,
      1000,
    );
    expect(after).toEqual(before);
    expect(Object.keys(after.executed)).toHaveLength(1);
  },
);
