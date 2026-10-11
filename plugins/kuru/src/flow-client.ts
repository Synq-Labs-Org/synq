import { KuruError } from './errors.js';
import { FlowTokenResponseSchema } from './flow-schema.js';
import type { Address } from './deployment.js';

export const KURU_FLOW_API = 'https://ws.kuru.io/api';
export const FLOW_MIN_INTERVAL_MS = 1100;
export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Clock = { now(): number };
export type Sleep = (ms: number) => Promise<void>;

/** Serializes calls so consecutive requests start at least `intervalMs` apart (Kuru Flow allows 1 request/second). */
export class RateLimiter {
  private nextAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly intervalMs: number,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
  ) {}
  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.nextAt - this.clock.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Math.max(this.clock.now(), this.nextAt) + this.intervalMs;
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export type FlowQuoteRequest = {
  userAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amount: bigint;
  slippageBps: number;
};

export class KuruFlowClient {
  private readonly tokens = new Map<
    string,
    { token: string; expiresAtMs: number }
  >();
  readonly limiter: RateLimiter;
  constructor(
    private readonly options: {
      fetch: HttpFetch;
      clock: Clock;
      sleep?: Sleep;
      baseUrl?: string;
      timeoutMs?: number;
    },
  ) {
    this.limiter = new RateLimiter(
      FLOW_MIN_INTERVAL_MS,
      options.clock,
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    );
  }

  private async post(
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<unknown> {
    return this.limiter.schedule(async () => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 15_000,
      );
      try {
        const response = await this.options.fetch(
          `${this.options.baseUrl ?? KURU_FLOW_API}${path}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        if (response.status === 429) throw new KuruError('RATE_LIMITED', path);
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          if (json !== null && typeof json === 'object') return json;
          throw new KuruError(
            'PROVIDER_UNAVAILABLE',
            `${path} HTTP ${response.status}`,
          );
        }
        return json;
      } catch (error) {
        if (error instanceof KuruError) throw error;
        throw new KuruError('PROVIDER_UNAVAILABLE', path);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async token(userAddress: Address): Promise<string> {
    const cached = this.tokens.get(userAddress);
    if (cached && cached.expiresAtMs - 60_000 > this.options.clock.now())
      return cached.token;
    const parsed = FlowTokenResponseSchema.safeParse(
      await this.post('/generate-token', { user_address: userAddress }),
    );
    if (!parsed.success)
      throw new KuruError('QUOTE_SCHEMA_CHANGED', 'token response');
    const expiresAtMs = parsed.data.expires_at
      ? parsed.data.expires_at * 1000
      : this.options.clock.now() + 3_600_000;
    this.tokens.set(userAddress, { token: parsed.data.token, expiresAtMs });
    return parsed.data.token;
  }

  /** A read-only quote; one bounded retry after a 429 because quoting has no side effect. */
  async quote(request: FlowQuoteRequest): Promise<unknown> {
    const jwt = await this.token(request.userAddress);
    const body = {
      userAddress: request.userAddress,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amount.toString(),
      slippageTolerance: request.slippageBps,
      autoSlippage: false,
    };
    try {
      return await this.post('/quote', body, jwt);
    } catch (error) {
      if (!(error instanceof KuruError) || error.code !== 'RATE_LIMITED')
        throw error;
      return this.post('/quote', body, jwt);
    }
  }
}
