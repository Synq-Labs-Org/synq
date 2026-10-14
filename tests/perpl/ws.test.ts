import { createPublicKey, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { perplNetwork } from '@synq/chain-registry';
import {
  MARKET_DATA_MAX_SUBSCRIPTIONS,
  PerplMarketDataStream,
  PerplTradingStream,
  RECONNECT_DELAYS_MS,
  SlidingWindowLimiter,
  wsSignInCanonical,
  type Timers,
} from '@synq/plugin-perpl';
import { testSigner } from './fake-perpl.js';

const testnet = perplNetwork('sandbox/monad-testnet');
// Real sockets, compressed backoff: every scheduled delay is recorded but runs in 5 ms.
const scheduled: number[] = [];
const fastTimers: Timers = {
  setTimeout: (fn, ms) => {
    scheduled.push(ms);
    return setTimeout(fn, Math.min(ms, 5));
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

type Conn = { socket: ServerSocket; frames: Record<string, unknown>[] };
class FakeServer {
  readonly wss = new WebSocketServer({ port: 0 });
  readonly conns: Conn[] = [];
  onFrame: (conn: Conn, frame: Record<string, unknown>) => void = () => {};
  constructor() {
    this.wss.on('connection', (socket) => {
      const conn: Conn = { socket, frames: [] };
      this.conns.push(conn);
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        conn.frames.push(frame);
        this.onFrame(conn, frame);
      });
    });
  }
  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  close() {
    for (const c of this.conns) c.socket.terminate();
    return new Promise<void>((r) => this.wss.close(() => r()));
  }
}
const send = (c: Conn, frame: object) => c.socket.send(JSON.stringify(frame));
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let server: FakeServer;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  scheduled.length = 0;
  await server?.close();
});

const wallet = (sn: number) => ({
  mt: 19,
  sn,
  addr: '0x6666666666666666666666666666666666666666',
  as: [
    { in: 12, id: 1058, fr: false, fw: true, lfr: 3, b: '100000000', lb: '0' },
  ],
});

describe('market-data WebSocket resilience', () => {
  it('subscribes, tracks heartbeat sequence, and reconnects + resubscribes on a gap', async () => {
    server = new FakeServer();
    server.onFrame = (c, f) => {
      if (f.mt === 5)
        send(c, {
          mt: 6,
          subs: (f.subs as { stream: string }[]).map((s, i) => ({
            stream: s.stream,
            sid: i + 1,
            status: { code: 0 },
          })),
        });
    };
    const md = new PerplMarketDataStream({
      network: testnet,
      url: server.url,
      timers: fastTimers,
    });
    cleanups.push(() => md.close());
    const events: string[] = [];
    md.on('gap', (g) => events.push(`gap:${g.expected}->${g.got}`));
    md.on('resync', (r) => events.push(`resync:${r.reason}`));
    md.subscribe(['market-state@10143', 'order-book@64']);
    md.connect();
    await until(() => server.conns[0]?.frames.length === 1);
    expect(server.conns[0]!.frames[0]).toEqual({
      mt: 5,
      subs: ['heartbeat@10143', 'market-state@10143', 'order-book@64'].map(
        (stream) => ({ stream, subscribe: true }),
      ),
    });
    const c0 = server.conns[0]!;
    for (const sn of [10, 11, 12]) send(c0, { mt: 100, sn, h: 1_000 + sn });
    send(c0, { mt: 100, sn: 14, h: 1_014 });
    await until(
      () => server.conns.length === 2 && server.conns[1]!.frames.length === 1,
    );
    await until(() => events.length === 2);
    expect(events).toEqual(['gap:13->14', 'resync:gap']);
    expect(server.conns[1]!.frames[0]).toEqual(c0.frames[0]);
    expect(md.connections).toBe(2);
  });

  it('enforces the 16-subscription cap locally and surfaces server 429/404 per stream', async () => {
    server = new FakeServer();
    server.onFrame = (c, f) => {
      if (f.mt === 5)
        send(c, {
          mt: 6,
          subs: (f.subs as { stream: string }[]).map((s) => ({
            stream: s.stream,
            status: s.stream.startsWith('order-book@999')
              ? { code: 404, error: 'unknown stream' }
              : s.stream === 'trades@64'
                ? { code: 429, error: 'too many subscriptions' }
                : { code: 0 },
          })),
        });
    };
    const md = new PerplMarketDataStream({
      network: testnet,
      url: server.url,
      timers: fastTimers,
    });
    cleanups.push(() => md.close());
    expect(() =>
      md.subscribe(
        Array.from(
          { length: MARKET_DATA_MAX_SUBSCRIPTIONS },
          (_, i) => `candles@${i}*60`,
        ),
      ),
    ).toThrow(/SUBSCRIPTION_LIMIT/);
    const failures: number[] = [];
    md.on('subscription', (s) => failures.push(s.code));
    md.subscribe(['order-book@999', 'trades@64', 'order-book@64']);
    md.connect();
    await until(() => failures.length === 2);
    expect(failures.sort()).toEqual([404, 429]);
    expect(md.subscriptions()).toEqual(['heartbeat@10143', 'order-book@64']);
  });

  it('backs off 1s..60s on abnormal closes, reconnects immediately on 1001', async () => {
    server = new FakeServer();
    const md = new PerplMarketDataStream({
      network: testnet,
      url: server.url,
      timers: fastTimers,
    });
    cleanups.push(() => md.close());
    const closes: (number | null)[] = [];
    md.on('close', (c) => closes.push(c.reconnectInMs));
    md.connect();
    for (let i = 0; i < 3; i++) {
      await until(() => server.conns.length === i + 1);
      server.conns[i]!.socket.close(
        i === 2 ? 1001 : 1008,
        i === 2 ? 'going away' : 'too many requests',
      );
      await until(() => closes.length === i + 1);
    }
    expect(closes).toEqual([1_000, 2_000, 0]);
    expect(RECONNECT_DELAYS_MS.at(-1)).toBe(60_000);
  });
});

describe('trading WebSocket resilience', () => {
  const trading = (extra: Record<string, unknown> = {}) => {
    const signer = testSigner('trade');
    const ws = new PerplTradingStream({
      network: testnet,
      url: server.url,
      timers: fastTimers,
      signer,
      statusTimeoutMs: 200,
      ...extra,
    });
    cleanups.push(() => ws.close());
    return { ws, signer };
  };
  const autoSignIn = (sn = 50) => {
    server.onFrame = (c, f) => {
      if (f.mt === 29) send(c, wallet(sn));
    };
  };

  it(
    'signs in with mt:29 as the first frame and re-signs with a fresh nonce after a heartbeat gap',
    { timeout: 30_000 },
    async () => {
      server = new FakeServer();
      autoSignIn();
      const { ws, signer } = trading();
      const resyncs: string[] = [];
      ws.on('resync', (r) => resyncs.push(r.reason));
      ws.connect();
      await until(() => server.conns[0]?.frames.length === 1);
      const first = server.conns[0]!.frames[0] as Record<
        string,
        string | number
      >;
      expect(first.mt).toBe(29);
      const canonical = wsSignInCanonical({
        chainId: testnet.chainId,
        timestamp: Number(first.timestamp),
        nonce: String(first.nonce),
      });
      expect(
        verify(
          null,
          Buffer.from(canonical),
          createPublicKey(signer.key),
          Buffer.from(String(first.signature), 'base64url'),
        ),
      ).toBe(true);
      await until(() => ws.accounts.get(1058)?.fw === true);
      send(server.conns[0]!, { mt: 100, sn: 51, h: 1 });
      send(server.conns[0]!, { mt: 100, sn: 53, h: 3 });
      await until(
        () => server.conns.length === 2 && server.conns[1]!.frames.length === 1,
      );
      const second = server.conns[1]!.frames[0]!;
      expect(second.mt).toBe(29);
      expect(second.nonce).not.toBe(first.nonce);
      await until(() => resyncs.length === 1);
      expect(resyncs).toEqual(['gap']);
    },
  );

  it('re-signs after 3401 and stops after repeated auth failures', async () => {
    server = new FakeServer();
    server.onFrame = (c, f) => {
      if (f.mt === 29) c.socket.close(3401, 'unauthorized');
    };
    const { ws } = trading({ maxAuthFailures: 2 });
    const errors: string[] = [];
    ws.on('error', (e) => errors.push(e.code));
    ws.connect();
    await until(() => errors.length === 1);
    expect(errors).toEqual(['WS_AUTH_FAILED']);
    expect(server.conns).toHaveLength(3);
    expect(server.conns.every((c) => c.frames[0]?.mt === 29)).toBe(true);
  });

  it('inflight failure: a close with an order in flight rejects it as UNKNOWN_OUTCOME', async () => {
    server = new FakeServer();
    autoSignIn();
    const { ws } = trading();
    const lost: number[] = [];
    ws.on('inflightLost', (l) => lost.push(l.spec.rq));
    ws.connect();
    await until(() => ws.accounts.size === 1);
    server.onFrame = (c, f) => {
      if (f.mt === 22) c.socket.close(1011, 'failed to process');
    };
    await expect(
      ws.placeOrder({
        rq: 4,
        mkt: 64,
        acc: 1058,
        t: 2,
        p: 2400,
        s: 1,
        fl: 4,
        lv: 100,
        lb: 0,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(lost).toEqual([4]);
  });

  it('order timeout: no mt:3 status within the deadline is UNKNOWN_OUTCOME, never a silent retry', async () => {
    server = new FakeServer();
    autoSignIn();
    const { ws } = trading();
    ws.connect();
    await until(() => ws.accounts.size === 1);
    await expect(
      ws.placeOrder({
        rq: 4,
        mkt: 64,
        acc: 1058,
        t: 2,
        p: 2400,
        s: 1,
        fl: 4,
        lv: 100,
        lb: 0,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    expect(server.conns[0]!.frames.filter((f) => f.mt === 22)).toHaveLength(1);
  });

  it('correlates mt:3 by cid, dedups duplicate fills and order events, and reconciles a fill delivered after reconnect', async () => {
    server = new FakeServer();
    autoSignIn();
    // The ack arrives normally here; a generous timeout keeps slow runners from
    // turning it into UNKNOWN_OUTCOME (timeouts have their own tests).
    const { ws } = trading({ statusTimeoutMs: 5_000 });
    const fills: unknown[] = [];
    ws.on('fills', (f) => fills.push(...f));
    ws.connect();
    await until(() => ws.accounts.size === 1);
    server.onFrame = (c, f) => {
      if (f.mt === 22)
        send(c, { mt: 3, sid: 100, sn: 9, cid: f.sn, status: { code: 0 } });
      if (f.mt === 29) {
        send(c, wallet(80));
        // State after reconnect: the order filled while we were away.
        send(c, {
          mt: 23,
          d: [
            {
              rq: 4,
              mkt: 64,
              acc: 1058,
              oid: 99,
              st: 4,
              t: 2,
              fs: 1,
              os: 1,
              fp: 2_401,
              at: { b: 7 },
            },
          ],
        });
      }
    };
    await expect(
      ws.placeOrder({
        rq: 4,
        mkt: 64,
        acc: 1058,
        t: 2,
        p: 2400,
        s: 1,
        fl: 4,
        lv: 100,
        lb: 0,
      }),
    ).resolves.toEqual({ code: 0 });
    const c0 = server.conns[0]!;
    send(c0, {
      mt: 24,
      d: [{ rq: 4, mkt: 64, acc: 1058, oid: 99, st: 2, t: 2, at: { b: 5 } }],
    });
    send(c0, {
      mt: 24,
      d: [{ rq: 4, mkt: 64, acc: 1058, oid: 99, st: 2, t: 2, at: { b: 5 } }],
    });
    const fill = {
      at: { b: 6, tx: 1, l: 2 },
      mkt: 64,
      acc: 1058,
      oid: 99,
      t: 2,
      l: 2,
      p: 2_401,
      s: 1,
      f: '83',
    };
    send(c0, { mt: 25, d: [fill] });
    send(c0, { mt: 25, d: [fill] });
    await until(() => fills.length === 1);
    c0.socket.close(1011, 'drop');
    await until(
      () =>
        ws.orders.outcome(4).kind === 'LIVE' &&
        (ws.orders.outcome(4) as { order: { st: number } }).order.st === 4,
    );
    expect(fills).toHaveLength(1);
  });

  it('rate limiter defers frames beyond the per-minute budget', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(10, () => t);
    for (let i = 0; i < 10; i++) {
      expect(limiter.waitMs()).toBe(0);
      limiter.take();
      t += 1_000;
    }
    expect(limiter.waitMs()).toBe(50_000);
    t = 60_000;
    expect(limiter.waitMs()).toBe(0);
  });
});
