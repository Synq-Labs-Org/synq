import { ReadModelError } from './errors.js';
import { FreshnessSchema, type Freshness } from './views.js';

export interface HeadClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getChainId(): Promise<number>;
}
export interface ObservedHead {
  block: number;
  observedAt: number;
}

export class ChainHeadObserver {
  private cached: ObservedHead | null = null;
  private inflight: Promise<ObservedHead> | null = null;
  private chainVerified = false;
  constructor(
    private readonly client: HeadClient,
    readonly chainId: number,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  async head(): Promise<ObservedHead> {
    const ttl = this.options.ttlMs ?? 1000;
    if (this.cached && this.now() - this.cached.observedAt < ttl)
      return this.cached;
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
  private async fetch(): Promise<ObservedHead> {
    try {
      if (!this.chainVerified) {
        const id = await this.client.getChainId();
        if (id !== this.chainId)
          throw new ReadModelError(
            'INCONSISTENT_WITH_CHAIN',
            `head RPC serves chain ${id}, expected ${this.chainId}`,
          );
        this.chainVerified = true;
      }
      const block = Number(await this.client.getBlockNumber({ cacheTime: 0 }));
      if (!Number.isSafeInteger(block) || block < 0)
        throw new ReadModelError('SOURCE_UNAVAILABLE', 'invalid head');
      const observed = { block, observedAt: this.now() };
      if (this.cached && observed.block < this.cached.block)
        return { ...this.cached, observedAt: observed.observedAt };
      this.cached = observed;
      return observed;
    } catch (error) {
      if (error instanceof ReadModelError) throw error;
      throw new ReadModelError('SOURCE_UNAVAILABLE', 'head RPC unavailable', {
        cause: error,
      });
    }
  }
}

export function assessFreshness(input: {
  sourceChainId: number;
  indexedThroughBlock: number;
  head: ObservedHead;
  maxLagBlocks: number;
  frozen: boolean;
  aheadToleranceBlocks?: number;
}): Freshness {
  const tolerance = input.aheadToleranceBlocks ?? 2;
  const lag = Math.max(0, input.head.block - input.indexedThroughBlock);
  const status = input.frozen
    ? 'FROZEN'
    : input.indexedThroughBlock > input.head.block + tolerance
      ? 'INCONSISTENT'
      : lag > input.maxLagBlocks
        ? 'STALE'
        : 'FRESH';
  return FreshnessSchema.parse({
    sourceChainId: input.sourceChainId,
    indexedThroughBlock: input.indexedThroughBlock,
    observedHead: input.head.block,
    observedAt: input.head.observedAt,
    lagBlocks: lag,
    maxLagBlocks: input.maxLagBlocks,
    status,
  });
}
