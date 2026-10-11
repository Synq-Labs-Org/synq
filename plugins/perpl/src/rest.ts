import type { z } from 'zod';
import { perplNetwork, type PerplNetworkConfig } from '@synq/chain-registry';
import {
  MAX_CLOCK_SKEW_MS,
  NonceSource,
  ServerClock,
  signRestRequest,
  type PerplRequestSigner,
} from './auth.js';
import { PerplError, statusCode } from './errors.js';
import type { OrderSpec } from './orders.js';
import {
  BatchStatusSchema,
  BookSchema,
  ContextSchema,
  FillSchema,
  HistoryPageSchema,
  OrderSchema,
  OrdersSchema,
  PositionSchema,
  PositionsSchema,
  TickerSchema,
  WalletSchema,
  type BatchStatus,
} from './schemas.js';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type RestOptions = {
  network: PerplNetworkConfig;
  fetch?: FetchLike;
  simulation?: boolean;
  signer?: PerplRequestSigner;
  clock?: ServerClock;
  nonces?: NonceSource;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
};

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000];

export class PerplRestClient {
  readonly network: PerplNetworkConfig;
  readonly clock: ServerClock;
  readonly executionMode: 'SIMULATION' | 'REAL_TESTNET' | 'MAINNET_READ_ONLY';
  private readonly fetcher: FetchLike;
  private readonly signer: PerplRequestSigner | undefined;
  private readonly nonces: NonceSource;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: readonly number[];

  constructor(options: RestOptions) {
    const official = perplNetwork(options.network.profile);
    if (
      options.network.chainId !== official.chainId ||
      options.network.exchange !== official.exchange ||
      options.network.restUrl !== official.restUrl ||
      options.network.collateral.address !== official.collateral.address
    )
      throw new PerplError('PROFILE_MISMATCH', 'unregistered REST deployment');
    this.network = official;
    if (options.simulation && !options.fetch)
      throw new PerplError(
        'INVALID_REQUEST',
        'simulation needs an isolated transport',
      );
    this.executionMode = options.simulation
      ? 'SIMULATION'
      : options.network.profile === 'sandbox/monad-testnet'
        ? 'REAL_TESTNET'
        : 'MAINNET_READ_ONLY';
    this.fetcher = options.fetch ?? (fetch as unknown as FetchLike);
    this.signer = options.signer;
    this.clock = options.clock ?? new ServerClock();
    this.nonces = options.nonces ?? new NonceSource();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
  }

  get scope() {
    return this.signer?.scope ?? null;
  }

  private async once(
    method: string,
    target: string,
    body: string,
    signed: boolean,
  ) {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (signed) {
      if (!this.signer)
        throw new PerplError('AUTH_REJECTED', 'no API key signer configured');
      const timestamp = this.clock.now();
      Object.assign(
        headers,
        await signRestRequest(this.signer, {
          chainId: this.network.chainId,
          method,
          target,
          timestamp,
          nonce: this.nonces.next(timestamp),
          body,
        }),
      );
    }
    const sentAt = Date.now();
    let response;
    try {
      response = await this.fetcher(`${this.network.restUrl}${target}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new PerplError(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'TIMEOUT'
          : 'NETWORK',
        `${method} ${target}`,
        undefined,
        { cause: error },
      );
    }
    this.clock.observeDateHeader(
      response.headers.get('date'),
      sentAt,
      Date.now(),
    );
    return { status: response.status, text: await response.text() };
  }

  async request<S extends z.ZodType>(
    schema: S,
    method: 'GET' | 'POST',
    target: string,
    options: { body?: unknown; signed?: boolean; retry?: boolean } = {},
  ): Promise<z.output<S>> {
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const signed = options.signed ?? false;
    const retry = options.retry ?? true;
    let skewRetried = false;
    for (let attempt = 1; ; attempt++) {
      const before = this.clock.offsetMs();
      const { status, text } = await this.once(method, target, body, signed);
      if (status >= 200 && status < 300) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (error) {
          throw new PerplError('INVALID_RESPONSE', target, status, {
            cause: error,
          });
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success)
          throw new PerplError(
            'INVALID_RESPONSE',
            `${target}: ${parsed.error.issues[0]?.message ?? 'schema'}`,
            status,
          );
        return parsed.data;
      }
      const code = statusCode(status, target);
      // A 401 caused by our own clock drift is retried once with a fresh
      // timestamp and nonce after re-syncing from the server Date header.
      if (
        code === 'AUTH_REJECTED' &&
        signed &&
        !skewRetried &&
        Math.abs(this.clock.offsetMs() - before) > MAX_CLOCK_SKEW_MS / 2
      ) {
        skewRetried = true;
        continue;
      }
      const retryable = code === 'RATE_LIMITED' || code === 'UNAVAILABLE';
      if (!retry || !retryable || attempt >= this.maxAttempts)
        throw new PerplError(
          code,
          `${method} ${target}: ${text.slice(0, 200)}`,
          status,
        );
      await this.sleep(
        this.backoff[Math.min(attempt - 1, this.backoff.length - 1)] ?? 1_000,
      );
    }
  }

  context() {
    return this.request(ContextSchema, 'GET', '/v1/pub/context');
  }
  ticker(marketId?: number) {
    return this.request(
      TickerSchema,
      'GET',
      marketId === undefined
        ? '/v1/market-data/ticker'
        : `/v1/market-data/${marketId}/ticker`,
    );
  }
  book(marketId: number, levels = 20) {
    if (!Number.isInteger(levels) || levels < 1 || levels > 100)
      throw new PerplError('INVALID_REQUEST', 'levels must be 1-100');
    return this.request(
      BookSchema,
      'GET',
      `/v1/market-data/${marketId}/book?levels=${levels}`,
    );
  }
  wallet() {
    return this.request(WalletSchema, 'GET', '/v1/trading/wallet', {
      signed: true,
    });
  }
  openOrders() {
    return this.request(OrdersSchema, 'GET', '/v1/trading/orders', {
      signed: true,
    });
  }
  positions() {
    return this.request(PositionsSchema, 'GET', '/v1/trading/positions', {
      signed: true,
    });
  }
  fills(count = 50) {
    return this.request(
      HistoryPageSchema(FillSchema),
      'GET',
      `/v1/trading/fills?count=${count}`,
      { signed: true },
    );
  }
  orderHistory(count = 50) {
    return this.request(
      HistoryPageSchema(OrderSchema),
      'GET',
      `/v1/trading/order-history?count=${count}`,
      { signed: true },
    );
  }
  positionHistory(count = 50) {
    return this.request(
      HistoryPageSchema(PositionSchema),
      'GET',
      `/v1/trading/position-history?count=${count}`,
      { signed: true },
    );
  }
  // At-most-once per rq is guaranteed by the exchange, so a batch refused as a
  // whole (429/503) is safe to resend. A transport timeout is surfaced as
  // TIMEOUT and must be reconciled by rq before any retry.
  submitOrders(
    orders: readonly OrderSpec[],
    sn?: number,
  ): Promise<BatchStatus> {
    if (this.network.profile !== 'sandbox/monad-testnet')
      throw new PerplError('PROFILE_MISMATCH', 'mainnet orders disabled');
    if (orders.length < 1 || orders.length > 100)
      throw new PerplError('INVALID_REQUEST', '1-100 orders per batch');
    return this.request(BatchStatusSchema, 'POST', '/v1/trading/orders', {
      signed: true,
      body: { mt: 30, ...(sn ? { sn } : {}), d: orders },
    });
  }
}
