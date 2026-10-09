export type RateLimitConfig = {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
};

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxKeys: number;
  constructor(
    readonly config: RateLimitConfig,
    private readonly clockMs: () => number = Date.now,
  ) {
    if (
      !Number.isFinite(config.capacity) ||
      config.capacity < 1 ||
      !Number.isFinite(config.refillPerSecond) ||
      config.refillPerSecond <= 0
    )
      throw new Error('invalid rate limit');
    this.maxKeys = config.maxKeys ?? 50_000;
  }

  take(key: string): boolean {
    const now = this.clockMs();
    const bucket = this.buckets.get(key);
    const tokens = bucket
      ? Math.min(
          this.config.capacity,
          bucket.tokens +
            ((now - bucket.at) / 1000) * this.config.refillPerSecond,
        )
      : this.config.capacity;
    if (!bucket && this.buckets.size >= this.maxKeys) this.evict(now);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  private evict(now: number): void {
    const full = (this.config.capacity / this.config.refillPerSecond) * 1000;
    for (const [key, b] of this.buckets)
      if (now - b.at >= full) this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}
