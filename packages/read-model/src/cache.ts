import { ReadModelError } from './errors.js';
import type { SnapshotSource } from './reader.js';
import type { Hex } from './tables.js';
import {
  GroupSnapshotSchema,
  ProgressSchema,
  type BuildIdentity,
  type CheckpointStamp,
  type GroupSnapshot,
  type GroupStamp,
  type Progress,
} from './views.js';

export interface RedisConnection {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}
export interface CacheStats {
  progressHits: number;
  progressMisses: number;
  groupHits: number;
  groupMisses: number;
  invalid: number;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sameBuild(a: BuildIdentity, b: BuildIdentity): boolean {
  return a.id === b.id && a.store === b.store && a.configHash === b.configHash;
}

export class RedisSnapshotCache implements SnapshotSource {
  readonly chainId: number;
  readonly scope: string;
  readonly stats: CacheStats = {
    progressHits: 0,
    progressMisses: 0,
    groupHits: 0,
    groupMisses: 0,
    invalid: 0,
  };
  constructor(
    private readonly redis: RedisConnection,
    private readonly source: SnapshotSource,
    private readonly options: {
      progressTtlSeconds?: number;
      snapshotTtlSeconds?: number;
      namespace?: string;
    } = {},
  ) {
    this.chainId = source.chainId;
    this.scope = source.scope;
    for (const ttl of [options.progressTtlSeconds, options.snapshotTtlSeconds])
      if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1))
        throw new ReadModelError('CONFIG_MISMATCH', 'invalid cache TTL');
  }
  private prefix() {
    return `${this.options.namespace ?? 'synq:rm:v2'}:${this.chainId}:${this.scope}`;
  }
  progressKey(build: BuildIdentity): string {
    return `${this.prefix()}:build:${build.id}:progress`;
  }
  groupKey(
    build: BuildIdentity,
    groupId: string,
    revision: number,
    revisionLineage: string,
  ): string {
    return `${this.prefix()}:build:${build.id}:group:${groupId.toLowerCase()}:${revision}:${revisionLineage}`;
  }
  stamp(groupId: Hex): Promise<GroupStamp | null> {
    return this.source.stamp(groupId);
  }
  checkpointStamp(): Promise<CheckpointStamp> {
    return this.source.checkpointStamp();
  }
  async publishProgress(): Promise<Progress> {
    const progress = await this.source.progress();
    await this.redis.set(
      this.progressKey(progress.build),
      JSON.stringify(progress),
      { EX: this.options.progressTtlSeconds ?? 5 },
    );
    return progress;
  }
  async progress(): Promise<Progress> {
    const current = await this.source.checkpointStamp();
    const raw = await this.redis.get(this.progressKey(current.build));
    if (raw !== null) {
      const parsed = ProgressSchema.safeParse(parseJson(raw));
      if (
        parsed.success &&
        parsed.data.sourceChainId === this.chainId &&
        sameBuild(parsed.data.build, current.build) &&
        parsed.data.generation === current.generation &&
        parsed.data.lineage === current.lineage
      ) {
        this.stats.progressHits++;
        return parsed.data;
      }
      this.stats.invalid++;
    }
    this.stats.progressMisses++;
    return this.publishProgress();
  }
  async groupSnapshot(groupId: Hex): Promise<GroupSnapshot | null> {
    const id = groupId.toLowerCase() as Hex;
    const stamp = await this.source.stamp(id);
    if (!stamp) return null;
    if (stamp.revisionLineage === null) {
      this.stats.groupMisses++;
      return this.source.groupSnapshot(id);
    }
    const raw = await this.redis.get(
      this.groupKey(
        stamp.build,
        id,
        stamp.groupRevision,
        stamp.revisionLineage,
      ),
    );
    if (raw !== null) {
      const parsed = GroupSnapshotSchema.safeParse(parseJson(raw));
      if (
        parsed.success &&
        parsed.data.sourceChainId === this.chainId &&
        parsed.data.group.groupId === id &&
        sameBuild(parsed.data.build, stamp.build) &&
        parsed.data.groupRevision === stamp.groupRevision &&
        parsed.data.revisionLineage === stamp.revisionLineage &&
        parsed.data.generation >= parsed.data.groupRevision &&
        parsed.data.generation <= stamp.generation &&
        parsed.data.indexedThroughBlock <= stamp.indexedThroughBlock &&
        parsed.data.group.accountingStatus === stamp.accountingStatus
      ) {
        this.stats.groupHits++;
        return parsed.data;
      }
      this.stats.invalid++;
    }
    this.stats.groupMisses++;
    const fresh = await this.source.groupSnapshot(id);
    if (!fresh || fresh.revisionLineage === null) return fresh;
    await this.redis.set(
      this.groupKey(
        fresh.build,
        id,
        fresh.groupRevision,
        fresh.revisionLineage,
      ),
      JSON.stringify(fresh),
      { EX: this.options.snapshotTtlSeconds ?? 3600 },
    );
    return fresh;
  }
}
