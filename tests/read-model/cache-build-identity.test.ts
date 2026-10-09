import { describe, expect, it } from 'vitest';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  RedisSnapshotCache,
  type RedisConnection,
} from '../../packages/read-model/src/index.js';
import { ReadModelFreshnessProbe } from '../../packages/read-model/src/kernel-adapter.js';
import {
  account,
  address,
  chainId,
  config,
  creation,
  ev,
  funding,
  groupId,
  tx,
  word,
} from './fixtures.js';

class FakeRedis implements RedisConnection {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
}

const head = (block: number) =>
  new ChainHeadObserver(
    {
      async getBlockNumber() {
        return BigInt(block);
      },
      async getChainId() {
        return chainId;
      },
    },
    chainId,
    { ttlMs: 0 },
  );

describe('Redis snapshot cache is bound to the projection build', () => {
  it('a delete-and-rebuild that reuses generations never serves the pre-rebuild snapshot', async () => {
    const redis = new FakeRedis();
    const cfg = config();
    const a = new MemoryProjectionStore(chainId);
    const pa = new Projector(a, cfg);
    await pa.applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 102,
      events: [...creation(101), funding(102)],
    });
    await new RedisSnapshotCache(
      redis,
      new ProjectionReader(a, cfg),
    ).groupSnapshot(groupId);
    const out = ev(
      'Transfer',
      103,
      { from: account, to: address(0xbb), value: '1000000' },
      { tx: tx('out-103') },
    );
    await pa.applyWindow({
      fromBlockExclusive: 102,
      toBlockInclusive: 103,
      events: [out],
    });

    const b = new MemoryProjectionStore(chainId);
    await new Projector(b, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 103,
      events: [...creation(101), funding(102), out],
    });
    const readerB = new ProjectionReader(b, cfg);
    const truth = await readerB.groupSnapshot(groupId);
    const cacheB = new RedisSnapshotCache(redis, readerB);
    await cacheB.publishProgress();
    const served = await cacheB.groupSnapshot(groupId);
    expect(served!.build.id).toBe(truth!.build.id);
    expect(served!.stateHash).toBe(truth!.stateHash);
    expect(served).toEqual(truth);
    expect(cacheB.stats.groupHits).toBe(0);
  });

  it('a rebuilt projection that paused the account reaches the Kernel probe as paused', async () => {
    const redis = new FakeRedis();
    const cfg = config();
    const a = new MemoryProjectionStore(chainId);
    const pa = new Projector(a, cfg);
    await pa.applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 102,
      events: creation(101),
    });
    await new RedisSnapshotCache(
      redis,
      new ProjectionReader(a, cfg),
    ).groupSnapshot(groupId);
    const paused = ev(
      'Paused',
      103,
      { groupId, account },
      { tx: tx('pause-103') },
    );
    await pa.applyWindow({
      fromBlockExclusive: 102,
      toBlockInclusive: 103,
      events: [paused],
    });
    const b = new MemoryProjectionStore(chainId);
    await new Projector(b, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 103,
      events: [...creation(101), paused],
    });
    const readerB = new ProjectionReader(b, cfg);
    expect((await readerB.groupSnapshot(groupId))!.group.paused).toBe(true);
    const cache = new RedisSnapshotCache(redis, readerB);
    await cache.publishProgress();
    const observation = await new ReadModelFreshnessProbe(
      cache,
      head(103),
    ).observe({
      chainId,
      account,
      mandateId: word('mandate-1'),
      mandateVersion: 1,
      assets: [],
    });
    expect(observation.accountPaused).toBe(true);
  });

  it('a hit never restamps indexedThroughBlock with newer progress', async () => {
    const redis = new FakeRedis();
    const cfg = config();
    const store = new MemoryProjectionStore(chainId);
    const projector = new Projector(store, cfg);
    await projector.applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 102,
      events: [...creation(101), funding(102)],
    });
    const cache = new RedisSnapshotCache(
      redis,
      new ProjectionReader(store, cfg),
    );
    const cached = await cache.groupSnapshot(groupId);
    await projector.applyWindow({
      fromBlockExclusive: 102,
      toBlockInclusive: 150,
      events: [],
    });
    await cache.publishProgress();
    const hit = await cache.groupSnapshot(groupId);
    expect(cache.stats.groupHits).toBe(1);
    expect(hit).toEqual(cached);
    expect(hit!.indexedThroughBlock).toBe(102);
    expect((await cache.progress()).indexedThroughBlock).toBe(150);
  });

  it('two projection stores sharing one Redis never read each other’s entries', async () => {
    const redis = new FakeRedis();
    const cfg = config();
    const build = async (namespace: string, events = creation(101)) => {
      const store = new MemoryProjectionStore(chainId, namespace);
      await new Projector(store, cfg).applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 102,
        events,
      });
      return new RedisSnapshotCache(redis, new ProjectionReader(store, cfg));
    };
    const first = await build('schema_a', [...creation(101), funding(102)]);
    const second = await build('schema_b');
    const a = await first.groupSnapshot(groupId);
    const b = await second.groupSnapshot(groupId);
    expect(first.progressKey()).not.toBe(second.progressKey());
    expect(a!.groupRevision).toBe(b!.groupRevision);
    expect(a!.build.id).not.toBe(b!.build.id);
    expect(a!.group.treasury).not.toEqual(b!.group.treasury);
    expect(await second.groupSnapshot(groupId)).toEqual(b);
    expect(await first.groupSnapshot(groupId)).toEqual(a);
    expect((await second.progress()).build.store).toBe('schema_b');
    expect(second.stats.groupHits).toBe(1);
    expect(first.stats.groupHits).toBe(1);
  });

  it('an entry whose build identity differs from the current Postgres build is a miss', async () => {
    const redis = new FakeRedis();
    const cfg = config();
    const store = new MemoryProjectionStore(chainId);
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 102,
      events: [...creation(101), funding(102)],
    });
    const reader = new ProjectionReader(store, cfg);
    const cache = new RedisSnapshotCache(redis, reader);
    const current = (await cache.groupSnapshot(groupId))!;
    const key = cache.groupKey(current.build, groupId, current.groupRevision);
    redis.data.set(
      key,
      JSON.stringify({
        ...current,
        build: { ...current.build, id: `0x${'ab'.repeat(16)}` },
        group: { ...current.group, paused: true },
      }),
    );
    expect(await cache.groupSnapshot(groupId)).toEqual(current);
    expect(cache.stats.invalid).toBe(1);
  });
});
