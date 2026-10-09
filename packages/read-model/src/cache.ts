import { ReadModelError } from './errors.js';
import type { SnapshotSource } from './reader.js';
import type { Hex } from './tables.js';
import {
  GroupSnapshotSchema,
  ProgressSchema,
  type GroupSnapshot,
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

export class RedisSnapshotCache implements SnapshotSource {
  readonly chainId: number;
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
    for (const ttl of [options.progressTtlSeconds, options.snapshotTtlSeconds])
      if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1))
        throw new ReadModelError('CONFIG_MISMATCH', 'invalid cache TTL');
  }
  private prefix() {
    return `${this.options.namespace ?? 'synq:rm:v1'}:${this.chainId}`;
  }
  progressKey(): string {
    return `${this.prefix()}:progress`;
  }
  groupKey(groupId: string, revision: number): string {
    return `${this.prefix()}:group:${groupId.toLowerCase()}:${revision}`;
  }
  async publishProgress(): Promise<Progress> {
    const progress = await this.source.progress();
    await this.redis.set(this.progressKey(), JSON.stringify(progress), {
      EX: this.options.progressTtlSeconds ?? 5,
    });
    return progress;
  }
  async progress(): Promise<Progress> {
    const raw = await this.redis.get(this.progressKey());
    if (raw !== null) {
      const parsed = ProgressSchema.safeParse(parseJson(raw));
      if (parsed.success && parsed.data.sourceChainId === this.chainId) {
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
    const progress = await this.progress();
    const entry = progress.groups.find((g) => g.groupId === id);
    if (!entry) return null;
    const raw = await this.redis.get(this.groupKey(id, entry.revision));
    if (raw !== null) {
      const parsed = GroupSnapshotSchema.safeParse(parseJson(raw));
      if (
        parsed.success &&
        parsed.data.sourceChainId === this.chainId &&
        parsed.data.group.groupId === id &&
        parsed.data.groupRevision === entry.revision &&
        parsed.data.indexedThroughBlock <= progress.indexedThroughBlock &&
        parsed.data.group.accountingStatus === entry.accountingStatus
      ) {
        this.stats.groupHits++;
        return {
          ...parsed.data,
          indexedThroughBlock: progress.indexedThroughBlock,
          generation: progress.generation,
        };
      }
      this.stats.invalid++;
    }
    this.stats.groupMisses++;
    const fresh = await this.source.groupSnapshot(id);
    if (!fresh) return null;
    if (fresh.groupRevision !== entry.revision) await this.publishProgress();
    await this.redis.set(
      this.groupKey(id, fresh.groupRevision),
      JSON.stringify(fresh),
      { EX: this.options.snapshotTtlSeconds ?? 3600 },
    );
    return fresh;
  }
}
