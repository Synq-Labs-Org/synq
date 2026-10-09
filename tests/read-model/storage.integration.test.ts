import { afterAll, describe, expect, it } from 'vitest';
import {
  ProjectionReader,
  Projector,
  RedisSnapshotCache,
  type RedisConnection,
} from '../../packages/read-model/src/index.js';
import { PostgresProjectionStore } from '../../packages/read-model/src/storage.js';
import { chainId, config, groupId, lifecycle } from './fixtures.js';
import { dropSchemas, freshStore, testPool } from './pg.js';
import { projectionScenarios } from './scenarios.js';

const pool = testPool();
const created: string[] = [];
afterAll(async () => {
  await dropSchemas(pool, created);
  await pool.end();
});

projectionScenarios('postgres', () =>
  freshStore(pool, chainId, 'rm_ws4_test', created),
);

describe('postgres projection storage', () => {
  it('migrations are idempotent and the projection survives a store restart', async () => {
    const store = await freshStore(pool, chainId, 'rm_ws4_test', created);
    await store.migrate();
    const cfg = config();
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    const restarted = new PostgresProjectionStore(
      { pool },
      chainId,
      store.schema,
    );
    const snap = await new ProjectionReader(restarted, cfg).groupSnapshot(
      groupId,
    );
    expect(snap?.group.treasury[0]?.balance).toBe('750000');
    expect(snap?.indexedThroughBlock).toBe(110);
  });

  it('rejects tampered rows read back from Postgres instead of trusting casts', async () => {
    const store = await freshStore(pool, chainId, 'rm_ws4_test', created);
    const cfg = config();
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    await pool.query(
      `UPDATE "${store.schema}".rm_mandate_version SET call_targets='[1,2]'::jsonb`,
    );
    await expect(
      new ProjectionReader(store, cfg).groupSnapshot(groupId),
    ).rejects.toThrow('INCONSISTENT_PROOF');
    await pool.query(
      `UPDATE "${store.schema}".rm_event SET event = jsonb_set(event,'{schemaVersion}','7')`,
    );
    await expect(
      new Projector(store, cfg).applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 111,
        events: lifecycle(),
      }),
    ).rejects.toThrow('UNKNOWN_EVENT_VERSION');
  });

  it('persists a build identity that rotates on rebuild, survives restart, and keys the shared cache', async () => {
    const cfg = config();
    const data = new Map<string, string>();
    const redis: RedisConnection = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => void data.set(key, value),
    };
    const build = async () => {
      const store = await freshStore(pool, chainId, 'rm_ws4_test', created);
      await new Projector(store, cfg).applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 110,
        events: lifecycle(),
      });
      return store;
    };
    const a = await build();
    const b = await build();
    const cacheA = new RedisSnapshotCache(redis, new ProjectionReader(a, cfg));
    const cacheB = new RedisSnapshotCache(redis, new ProjectionReader(b, cfg));
    const snapA = (await cacheA.groupSnapshot(groupId))!;
    const snapB = (await cacheB.groupSnapshot(groupId))!;
    expect(snapA.build.store).toBe(`pg:${a.schema}`);
    expect(snapA.build.id).not.toBe(snapB.build.id);
    expect(cacheA.progressKey(snapA.build)).not.toBe(
      cacheB.progressKey(snapB.build),
    );
    expect(cacheB.stats.groupHits).toBe(0);
    const restarted = new ProjectionReader(
      new PostgresProjectionStore({ pool }, chainId, a.schema),
      cfg,
    );
    expect((await restarted.progress()).build.id).toBe(snapA.build.id);
    expect((await restarted.progress()).lineage).toBe(
      (await new ProjectionReader(a, cfg).progress()).lineage,
    );
    expect((await restarted.stamp(groupId))!.revisionLineage).toBe(
      snapA.revisionLineage,
    );
    expect(snapA.revisionLineage).toMatch(/^0x[0-9a-f]{64}$/);

    await a.resetProjection();
    await new Projector(a, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    const rebuilt = (await cacheA.groupSnapshot(groupId))!;
    expect(rebuilt.build.id).not.toBe(snapA.build.id);
    expect(rebuilt.groupRevision).toBe(snapA.groupRevision);
    expect(cacheA.stats.groupHits).toBe(0);
    expect(cacheA.stats.groupMisses).toBe(2);
  });

  it('backfills a random build identity for a checkpoint written before the build column existed', async () => {
    const store = await freshStore(pool, chainId, 'rm_ws4_test', created);
    const cfg = config();
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    const t = `"${store.schema}".rm_checkpoint`;
    await pool.query(`DROP TABLE "${store.schema}".rm_lineage`);
    await pool.query(`ALTER TABLE ${t} DROP COLUMN lineage`);
    await pool.query(`ALTER TABLE ${t} DROP COLUMN build_id`);
    await pool.query(
      `DELETE FROM "${store.schema}".rm_schema_migration WHERE version IN ('002-build-identity.sql','003-lineage.sql')`,
    );
    await store.migrate();
    const { rows } = await pool.query(`SELECT build_id FROM ${t}`);
    expect(rows[0]?.build_id).toMatch(/^0x[0-9a-f]{32}$/);
    expect((await new ProjectionReader(store, cfg).progress()).build.id).toBe(
      rows[0]?.build_id,
    );
    await expect(
      pool.query(`UPDATE ${t} SET build_id = 'not-a-build'`),
    ).rejects.toThrow();
  });
});
