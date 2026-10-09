import { describe, expect, it } from 'vitest';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  ReadModelAuthorizationAdapter,
  RedisSnapshotCache,
  assessFreshness,
  type Hex,
  type RedisConnection,
  type SnapshotSource,
} from '../../packages/read-model/src/index.js';
import { chainId, config, groupId, lifecycle, funding } from './fixtures.js';

class FakeRedis implements RedisConnection {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
}
class CountingSource implements SnapshotSource {
  progressCalls = 0;
  groupCalls = 0;
  stampCalls = 0;
  constructor(private readonly inner: SnapshotSource) {}
  get chainId() {
    return this.inner.chainId;
  }
  get scope() {
    return this.inner.scope;
  }
  checkpointStamp() {
    return this.inner.checkpointStamp();
  }
  stamp(id: Hex) {
    this.stampCalls++;
    return this.inner.stamp(id);
  }
  progress() {
    this.progressCalls++;
    return this.inner.progress();
  }
  groupSnapshot(id: Hex) {
    this.groupCalls++;
    return this.inner.groupSnapshot(id);
  }
}
async function projected() {
  const store = new MemoryProjectionStore(chainId);
  const cfg = config();
  const projector = new Projector(store, cfg);
  await projector.applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: lifecycle(),
  });
  return { store, projector, reader: new ProjectionReader(store, cfg) };
}
const head = (block: number, getChainId = chainId) => ({
  calls: 0,
  async getBlockNumber() {
    this.calls++;
    return BigInt(block);
  },
  async getChainId() {
    return getChainId;
  },
});

describe('independent head and freshness (R3)', () => {
  it('measures lag against the RPC head, never the indexer progress', async () => {
    const client = head(200);
    const observer = new ChainHeadObserver(client, chainId, {
      ttlMs: 1000,
      now: () => 5000,
    });
    const h = await observer.head();
    expect(
      assessFreshness({
        sourceChainId: chainId,
        indexedThroughBlock: 110,
        head: h,
        maxLagBlocks: 5,
        frozen: false,
      }),
    ).toMatchObject({ status: 'STALE', lagBlocks: 90, observedHead: 200 });
    expect(
      assessFreshness({
        sourceChainId: chainId,
        indexedThroughBlock: 197,
        head: h,
        maxLagBlocks: 5,
        frozen: false,
      }).status,
    ).toBe('FRESH');
    expect(
      assessFreshness({
        sourceChainId: chainId,
        indexedThroughBlock: 197,
        head: h,
        maxLagBlocks: 5,
        frozen: true,
      }).status,
    ).toBe('FROZEN');
    expect(
      assessFreshness({
        sourceChainId: chainId,
        indexedThroughBlock: 260,
        head: h,
        maxLagBlocks: 5,
        frozen: false,
      }).status,
    ).toBe('INCONSISTENT');
    await observer.head();
    expect(client.calls).toBe(1);
  });
  it('rejects a head RPC serving another chain', async () => {
    const observer = new ChainHeadObserver(head(10, 1), chainId);
    await expect(observer.head()).rejects.toThrow('INCONSISTENT_WITH_CHAIN');
  });
  it('SEC-006/SEC-018: stale index refuses authorization without a direct verifier', async () => {
    const { reader } = await projected();
    const adapter = new ReadModelAuthorizationAdapter({
      source: reader,
      head: new ChainHeadObserver(head(500), chainId),
      verifier: null,
      maxLagBlocks: 5,
    });
    await expect(adapter.readForAuthorization(groupId)).rejects.toThrow(
      'STALE_INDEX',
    );
    const fresh = new ReadModelAuthorizationAdapter({
      source: reader,
      head: new ChainHeadObserver(head(112), chainId),
      verifier: null,
      maxLagBlocks: 5,
    });
    expect((await fresh.readForAuthorization(groupId)).mode).toBe('INDEXED');
  });
});

describe('Redis read-through snapshot cache (R2)', () => {
  it('serves hits without touching the durable source and repopulates after a flush', async () => {
    const { reader } = await projected();
    const source = new CountingSource(reader);
    const redis = new FakeRedis();
    const cache = new RedisSnapshotCache(redis, source);
    const first = await cache.groupSnapshot(groupId);
    expect(source.groupCalls).toBe(1);
    const second = await cache.groupSnapshot(groupId);
    expect(second).toEqual(first);
    expect(source.groupCalls).toBe(1);
    expect(source.stampCalls).toBe(2);
    expect(cache.stats.groupHits).toBe(1);
    redis.data.clear();
    const third = await cache.groupSnapshot(groupId);
    expect(third).toEqual(first);
    expect(source.groupCalls).toBe(2);
    expect(redis.data.size).toBe(1);
  });
  it('a new projection generation changes the key, and corrupt entries are not served', async () => {
    const { reader, projector } = await projected();
    const source = new CountingSource(reader);
    const redis = new FakeRedis();
    const cache = new RedisSnapshotCache(redis, source);
    const before = await cache.groupSnapshot(groupId);
    await projector.applyWindow({
      fromBlockExclusive: 110,
      toBlockInclusive: 120,
      events: [funding(115, '5')],
    });
    await cache.publishProgress();
    const after = await cache.groupSnapshot(groupId);
    expect(after!.groupRevision).toBeGreaterThan(before!.groupRevision);
    expect(after!.group.treasury[0]!.balance).toBe('750005');
    const key = cache.groupKey(
      after!.build,
      groupId,
      after!.groupRevision,
      after!.revisionLineage!,
    );
    redis.data.set(
      key,
      JSON.stringify({
        ...after,
        group: {
          ...after!.group,
          treasury: [{ asset: '0x1', balance: 'lots', lastBlock: 1 }],
        },
      }),
    );
    const calls = source.groupCalls;
    expect(
      (await cache.groupSnapshot(groupId))!.group.treasury[0]!.balance,
    ).toBe('750005');
    expect(source.groupCalls).toBe(calls + 1);
    expect(cache.stats.invalid).toBe(1);
  });
});
