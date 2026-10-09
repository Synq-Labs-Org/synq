import { afterAll, describe, expect, it } from 'vitest';
import {
  ProjectionReader,
  Projector,
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
});
