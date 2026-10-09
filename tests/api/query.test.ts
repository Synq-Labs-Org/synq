import { it, expect } from 'vitest';
import { createApi } from '../../apps/api/src/server.js';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  RedisSnapshotCache,
  type RedisConnection,
} from '../../packages/read-model/src/index.js';
import { chainId, config, groupId, lifecycle } from '../read-model/fixtures.js';

class MapRedis implements RedisConnection {
  data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
}

it('serves /v1/world and /v1/groups/:groupId/state from the cached read model with freshness', async () => {
  const store = new MemoryProjectionStore(chainId);
  const cfg = config();
  await new Projector(store, cfg).applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: lifecycle(),
  });
  let headCalls = 0;
  const head = new ChainHeadObserver(
    {
      getBlockNumber: async () => (headCalls++, 120n),
      getChainId: async () => chainId,
    },
    chainId,
    { ttlMs: 60_000 },
  );
  const api = createApi({
    readModel: {
      snapshots: new RedisSnapshotCache(
        new MapRedis(),
        new ProjectionReader(store, cfg),
      ),
      head,
      maxLagBlocks: 5,
    },
  });
  try {
    const world = await api.inject({ url: '/v1/world' });
    expect(world.statusCode).toBe(200);
    expect(world.json()).toMatchObject({
      sourceChainId: chainId,
      indexedThroughBlock: 110,
      freshness: { observedHead: 120, lagBlocks: 10, status: 'STALE' },
      groups: [{ groupId, accountingStatus: 'OPEN' }],
    });
    const state = await api.inject({ url: `/v1/groups/${groupId}/state` });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      snapshot: {
        indexedThroughBlock: 110,
        group: { treasury: [{ balance: '750000' }] },
      },
      freshness: { indexedThroughBlock: 110, status: 'STALE' },
    });
    expect(headCalls).toBe(1);
    expect(
      (await api.inject({ url: '/v1/groups/not-a-hash/state' })).statusCode,
    ).toBe(400);
    expect(
      (await api.inject({ url: `/v1/groups/0x${'ab'.repeat(32)}/state` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.inject({ method: 'POST', url: '/dev/execute', payload: {} }))
        .statusCode,
    ).toBe(404);
  } finally {
    await api.close();
  }
});
