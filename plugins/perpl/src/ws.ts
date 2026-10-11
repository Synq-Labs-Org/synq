import type { PerplNetworkConfig } from '@synq/chain-registry';
import {
  NonceSource,
  ServerClock,
  wsSignInFrame,
  type PerplRequestSigner,
} from './auth.js';
import { PerplError } from './errors.js';
import { OrderTracker, type OrderSpec } from './orders.js';
import {
  AccountSchema,
  FillSchema,
  OrderSchema,
  PositionSchema,
  StatusSchema,
  type PerplAccount,
  type PerplFill,
  type PerplOrder,
  type PerplPosition,
} from './schemas.js';

export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
const defaultFactory: WsFactory = (url) =>
  new WebSocket(url) as unknown as WsLike;

export const RECONNECT_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
] as const;
export const MARKET_DATA_MAX_SUBSCRIPTIONS = 16;
const OPEN = 1;

export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];
  constructor(
    readonly perMinute: number,
    private readonly now: () => number,
  ) {}
  waitMs(): number {
    const t = this.now();
    while (this.stamps.length && t - this.stamps[0]! >= 60_000)
      this.stamps.shift();
    return this.stamps.length < this.perMinute
      ? 0
      : 60_000 - (t - this.stamps[0]!);
  }
  take(): void {
    this.stamps.push(this.now());
  }
}

export type CloseInfo = {
  code: number;
  reason: string;
  reconnectInMs: number | null;
};
type Listener<T> = (value: T) => void;
class Emitter<E extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();
  on<K extends keyof E>(event: K, fn: Listener<E[K]>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn as Listener<never>);
    this.listeners.set(event, set);
    return () => set.delete(fn as Listener<never>);
  }
  emit<K extends keyof E>(event: K, value: E[K]): void {
    for (const fn of this.listeners.get(event) ?? [])
      (fn as Listener<E[K]>)(value);
  }
}

type BaseEvents = {
  open: { attempt: number };
  ready: { reconnect: boolean };
  // Emitted once the replacement connection is ready after a reconnect or a
  // sequence gap: messages may have been lost, so consumers must reconcile
  // from REST before trusting local state.
  resync: { reason: 'reconnect' | 'gap' };
  gap: { expected: number; got: number };
  close: CloseInfo;
  frame: Record<string, unknown>;
  error: PerplError;
};

export type StreamOptions = {
  network: PerplNetworkConfig;
  factory?: WsFactory;
  timers?: Timers;
  maxAuthFailures?: number;
  url?: string;
};

abstract class PerplSocket<E extends BaseEvents> extends Emitter<E> {
  protected ws: WsLike | null = null;
  protected lastSn: number | undefined;
  protected readonly timers: Timers;
  protected readonly limiter: SlidingWindowLimiter;
  private readonly factory: WsFactory;
  private readonly queue: string[] = [];
  private flushTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private attempt = 0;
  private everReady = false;
  private resyncReason: 'reconnect' | 'gap' = 'reconnect';
  private stopped = true;
  private authFailures = 0;
  private readonly maxAuthFailures: number;
  readonly url: string;
  connections = 0;

  constructor(
    protected readonly network: PerplNetworkConfig,
    path: string,
    perMinute: number,
    options: StreamOptions,
  ) {
    super();
    this.factory = options.factory ?? defaultFactory;
    this.timers = options.timers ?? realTimers;
    this.limiter = new SlidingWindowLimiter(perMinute, () => this.timers.now());
    this.maxAuthFailures = options.maxAuthFailures ?? 3;
    this.url = options.url ?? `${network.wsUrl}${path}`;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    if (this.flushTimer) this.timers.clearTimeout(this.flushTimer);
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.queue.length = 0;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'client close');
    this.onSocketClosed(1000, 'client close');
  }

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  private open(): void {
    const ws = this.factory(this.url);
    this.ws = ws;
    this.connections++;
    this.lastSn = undefined;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.emit('open', { attempt: this.attempt });
      void this.onOpen().catch((error: unknown) =>
        this.emit(
          'error',
          error instanceof PerplError
            ? error
            : new PerplError('WS_CLOSED', 'open handler', undefined, {
                cause: error,
              }),
        ),
      );
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame === null || typeof frame !== 'object') return;
      this.dispatch(frame as Record<string, unknown>);
    };
    ws.onerror = () => undefined;
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleClose(event.code, event.reason ?? '');
    };
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (frame.mt === 100 && typeof frame.sn === 'number') {
      if (this.lastSn !== undefined && frame.sn !== this.lastSn + 1) {
        const expected = this.lastSn + 1;
        this.emit('gap', { expected, got: frame.sn });
        this.forceReconnect('sequence gap', 'gap');
        return;
      }
      this.lastSn = frame.sn;
    }
    this.emit('frame', frame);
    this.handleFrame(frame);
  }

  protected markReady(): void {
    const reconnect = this.everReady;
    this.everReady = true;
    this.attempt = 0;
    this.authFailures = 0;
    this.emit('ready', { reconnect });
    if (reconnect) this.emit('resync', { reason: this.resyncReason });
    this.resyncReason = 'reconnect';
  }

  forceReconnect(
    reason: string,
    cause: 'gap' | 'reconnect' = 'reconnect',
  ): void {
    this.resyncReason = cause;
    const ws = this.ws;
    this.ws = null;
    ws?.close(4000, reason);
    this.handleClose(4000, reason);
  }

  private handleClose(code: number, reason: string): void {
    this.onSocketClosed(code, reason);
    if (this.stopped) {
      this.emit('close', { code, reason, reconnectInMs: null });
      return;
    }
    if (code === 3401) {
      this.authFailures++;
      if (this.authFailures > this.maxAuthFailures) {
        this.stopped = true;
        this.emit('close', { code, reason, reconnectInMs: null });
        this.emit('error', new PerplError('WS_AUTH_FAILED', reason));
        return;
      }
    }
    const delay =
      code === 1001 || code === 4000 || code === 3401
        ? 0
        : (RECONNECT_DELAYS_MS[
            Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
          ] ?? 60_000);
    this.attempt++;
    this.emit('close', { code, reason, reconnectInMs: delay });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  protected send(frame: object, priority = false): void {
    const text = JSON.stringify(frame);
    if (priority) this.queue.unshift(text);
    else this.queue.push(text);
    this.flush();
  }

  private flush(): void {
    if (this.flushTimer) return;
    while (this.queue.length && this.isOpen) {
      const wait = this.limiter.waitMs();
      if (wait > 0) {
        this.flushTimer = this.timers.setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, wait);
        return;
      }
      this.limiter.take();
      this.ws!.send(this.queue.shift()!);
    }
  }

  protected abstract onOpen(): Promise<void>;
  protected abstract handleFrame(frame: Record<string, unknown>): void;
  protected onSocketClosed(_code: number, _reason: string): void {}
}

type MarketEvents = BaseEvents & {
  subscription: { stream: string; code: number; error?: string };
};

export class PerplMarketDataStream extends PerplSocket<MarketEvents> {
  private readonly streams = new Set<string>();
  constructor(options: StreamOptions) {
    super(options.network, '/ws/v1/market-data', 10, options);
    this.streams.add(`heartbeat@${options.network.chainId}`);
  }
  subscriptions(): string[] {
    return [...this.streams];
  }
  subscribe(streams: readonly string[]): void {
    const next = new Set([...this.streams, ...streams]);
    if (next.size > MARKET_DATA_MAX_SUBSCRIPTIONS)
      throw new PerplError(
        'SUBSCRIPTION_LIMIT',
        `${next.size} > ${MARKET_DATA_MAX_SUBSCRIPTIONS}`,
      );
    const added = streams.filter((s) => !this.streams.has(s));
    for (const s of added) this.streams.add(s);
    if (added.length && this.isOpen)
      this.send({
        mt: 5,
        subs: added.map((stream) => ({ stream, subscribe: true })),
      });
  }
  unsubscribe(streams: readonly string[]): void {
    const removed = streams.filter((s) => this.streams.delete(s));
    if (removed.length && this.isOpen)
      this.send({
        mt: 5,
        subs: removed.map((stream) => ({ stream, subscribe: false })),
      });
  }
  protected async onOpen(): Promise<void> {
    this.send({
      mt: 5,
      subs: [...this.streams].map((stream) => ({ stream, subscribe: true })),
    });
  }
  protected handleFrame(frame: Record<string, unknown>): void {
    if (frame.mt === 6 && Array.isArray(frame.subs)) {
      let ok = false;
      for (const sub of frame.subs as {
        stream?: string;
        status?: { code?: number; error?: string };
      }[]) {
        const code = sub.status?.code ?? 0;
        if (code === 0) ok = true;
        else {
          if (sub.stream) this.streams.delete(sub.stream);
          this.emit('subscription', {
            stream: sub.stream ?? '',
            code,
            ...(sub.status?.error ? { error: sub.status.error } : {}),
          });
        }
      }
      if (ok) this.markReady();
    }
  }
}

export type StatusAck = { code: number; error?: string };
type Inflight = {
  spec: OrderSpec;
  resolve: (status: StatusAck) => void;
  reject: (error: PerplError) => void;
  timer: unknown;
};
type TradingEvents = BaseEvents & {
  account: PerplAccount;
  orders: PerplOrder[];
  fills: PerplFill[];
  positions: { snapshot: boolean; positions: PerplPosition[] };
  inflightLost: { spec: OrderSpec; reason: string };
};

export type TradingStreamOptions = StreamOptions & {
  signer: PerplRequestSigner;
  clock?: ServerClock;
  nonces?: NonceSource;
  statusTimeoutMs?: number;
  pingIntervalMs?: number;
};

export class PerplTradingStream extends PerplSocket<TradingEvents> {
  readonly orders = new OrderTracker();
  private readonly signer: PerplRequestSigner;
  private readonly clock: ServerClock;
  private readonly nonces: NonceSource;
  private readonly inflight = new Map<number, Inflight>();
  private readonly seenFills = new Set<string>();
  private readonly statusTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private outSn = 0;
  private pingTimer: unknown = null;
  accounts = new Map<number, PerplAccount>();

  constructor(options: TradingStreamOptions) {
    super(
      options.network,
      '/ws/v1/trading',
      options.network.label === 'MAINNET' ? 120 : 60,
      options,
    );
    this.signer = options.signer;
    this.clock = options.clock ?? new ServerClock();
    this.nonces = options.nonces ?? new NonceSource();
    this.statusTimeoutMs = options.statusTimeoutMs ?? 15_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
  }

  protected async onOpen(): Promise<void> {
    const timestamp = this.clock.now();
    const frame = await wsSignInFrame(this.signer, {
      chainId: this.network.chainId,
      timestamp,
      nonce: this.nonces.next(timestamp),
    });
    this.send(frame, true);
    this.schedulePing();
  }

  private schedulePing(): void {
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null;
      if (!this.isOpen) return;
      this.send({ mt: 1, t: this.timers.now() });
      this.schedulePing();
    }, this.pingIntervalMs);
  }

  placeOrder(spec: OrderSpec): Promise<StatusAck> {
    if (this.network.profile !== 'sandbox/monad-testnet')
      return Promise.reject(
        new PerplError('PROFILE_MISMATCH', 'mainnet orders disabled'),
      );
    if (!this.isOpen)
      return Promise.reject(new PerplError('WS_CLOSED', 'trading socket'));
    const sn = ++this.outSn;
    return new Promise<StatusAck>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.inflight.delete(sn)) return;
        this.emit('inflightLost', { spec, reason: 'status timeout' });
        reject(new PerplError('UNKNOWN_OUTCOME', `no mt:3 for rq ${spec.rq}`));
      }, this.statusTimeoutMs);
      this.inflight.set(sn, { spec, resolve, reject, timer });
      this.send({ mt: 22, sn, ...spec });
    });
  }

  pendingCount(): number {
    return this.inflight.size;
  }

  protected onSocketClosed(code: number, reason: string): void {
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = null;
    for (const [sn, entry] of this.inflight) {
      this.inflight.delete(sn);
      this.timers.clearTimeout(entry.timer);
      this.emit('inflightLost', { spec: entry.spec, reason: `close ${code}` });
      entry.reject(
        new PerplError(
          'UNKNOWN_OUTCOME',
          `socket closed (${code} ${reason}) with rq ${entry.spec.rq} in flight`,
        ),
      );
    }
  }

  protected handleFrame(frame: Record<string, unknown>): void {
    switch (frame.mt) {
      case 19: {
        if (typeof frame.sn === 'number') this.lastSn = frame.sn;
        for (const raw of Array.isArray(frame.as) ? frame.as : []) {
          const account = AccountSchema.safeParse(raw);
          if (account.success) {
            this.accounts.set(account.data.id, account.data);
            this.emit('account', account.data);
          }
        }
        this.markReady();
        return;
      }
      case 21: {
        const account = AccountSchema.safeParse(frame);
        if (account.success) {
          this.accounts.set(account.data.id, account.data);
          this.emit('account', account.data);
        }
        return;
      }
      case 3: {
        const cid = typeof frame.cid === 'number' ? frame.cid : undefined;
        const status = StatusSchema.safeParse(frame.status);
        if (cid === undefined || !status.success) return;
        const entry = this.inflight.get(cid);
        if (!entry) return;
        this.inflight.delete(cid);
        this.timers.clearTimeout(entry.timer);
        entry.resolve({
          code: status.data.code,
          ...(status.data.error ? { error: status.data.error } : {}),
        });
        return;
      }
      case 23:
      case 24: {
        const fresh: PerplOrder[] = [];
        for (const raw of Array.isArray(frame.d) ? frame.d : []) {
          const order = OrderSchema.safeParse(raw);
          if (order.success && this.orders.ingest(order.data))
            fresh.push(order.data);
        }
        if (fresh.length) this.emit('orders', fresh);
        return;
      }
      case 25: {
        const fresh: PerplFill[] = [];
        for (const raw of Array.isArray(frame.d) ? frame.d : []) {
          const fill = FillSchema.safeParse(raw);
          if (!fill.success) continue;
          const key = fillKey(fill.data);
          if (this.seenFills.has(key)) continue;
          this.seenFills.add(key);
          fresh.push(fill.data);
        }
        if (fresh.length) this.emit('fills', fresh);
        return;
      }
      case 26:
      case 27: {
        const positions: PerplPosition[] = [];
        for (const raw of Array.isArray(frame.d) ? frame.d : []) {
          const p = PositionSchema.safeParse(raw);
          if (p.success) positions.push(p.data);
        }
        this.emit('positions', { snapshot: frame.mt === 26, positions });
        return;
      }
      default:
        return;
    }
  }
}

export function fillKey(fill: PerplFill): string {
  return [
    fill.acc,
    fill.oid,
    fill.at.b ?? '',
    fill.at.tx ?? '',
    fill.at.l ?? '',
    fill.s,
  ].join(':');
}
