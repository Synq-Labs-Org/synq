export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Serialises sends per chat and spaces them per chat and globally. */
export class OutboundLimiter {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastByKey = new Map<string, number>();
  private globalNext = 0;
  constructor(
    private readonly options: {
      perChatIntervalMs: number;
      globalIntervalMs: number;
      nowMs?: () => number;
      sleep?: Sleep;
    },
  ) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const nowMs = this.options.nowMs ?? Date.now;
    const wait = this.options.sleep ?? sleep;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const now = nowMs();
      const chatReady =
        (this.lastByKey.get(key) ?? -Infinity) + this.options.perChatIntervalMs;
      const at = Math.max(now, chatReady, this.globalNext);
      this.globalNext = at + this.options.globalIntervalMs;
      if (at > now) await wait(at - now);
      try {
        return await task();
      } finally {
        this.lastByKey.set(key, nowMs());
      }
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return result;
  }
}
