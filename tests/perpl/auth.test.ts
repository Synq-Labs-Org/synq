import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { perplNetwork } from '@synq/chain-registry';
import {
  NonceSource,
  PerplError,
  PerplRestClient,
  ServerClock,
  base64UrlNoPad,
  restCanonical,
  sha256Hex,
  signRestRequest,
  wsSignInCanonical,
  wsSignInFrame,
} from '@synq/plugin-perpl';
import {
  ed25519FromSeed,
  ed25519Sign,
  rawPublicKey,
} from '@synq/perpl-executor';
import { FakePerplRest, SEED, testSigner } from './fake-perpl.js';

const testnet = perplNetwork('sandbox/monad-testnet');
const E = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EMPTY_SHA256 = E;
const PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('Perpl Ed25519 request signing', () => {
  it('matches RFC 8032 test vector 1 for the Ed25519 primitive', () => {
    const key = ed25519FromSeed(SEED);
    expect(Buffer.from(rawPublicKey(key)).toString('hex')).toBe(PUB);
    expect(
      Buffer.from(ed25519Sign(key, new Uint8Array())).toString('hex'),
    ).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('builds the documented six-line canonical string', () => {
    const canonical = restCanonical({
      chainId: testnet.chainId,
      method: 'GET',
      target: '/v1/trading/fills?count=100',
      timestamp: 1_791_644_000_000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      body: '',
    });
    expect(canonical).toBe(
      `10143\nGET\n/v1/trading/fills?count=100\n1791644000000\nAAECAwQFBgcICQoLDA0ODw\n${EMPTY_SHA256}`,
    );
    expect(sha256Hex('abc')).toBe(ABC);
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
    expect(base64UrlNoPad(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('rejects request-targets with /api, lowercase methods and malformed nonces', () => {
    const base = {
      chainId: 1,
      method: 'GET',
      target: '/v1/pub/context',
      timestamp: 1,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      body: '',
    };
    expect(() =>
      restCanonical({ ...base, target: '/api/v1/pub/context' }),
    ).toThrow(PerplError);
    expect(() => restCanonical({ ...base, method: 'get' })).toThrow(PerplError);
    expect(() => restCanonical({ ...base, nonce: 'abc=' })).toThrow(PerplError);
  });

  it('produces headers whose signature verifies over the canonical string', async () => {
    const signer = testSigner();
    const input = {
      chainId: testnet.chainId,
      method: 'POST',
      target: '/v1/trading/orders',
      timestamp: 1_791_644_000_000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      body: '{"d":[]}',
    };
    const h = await signRestRequest(signer, input);
    expect(h['X-API-Signature']).not.toMatch(/=/);
    expect(
      verify(
        null,
        Buffer.from(restCanonical(input)),
        createPublicKey(signer.key),
        Buffer.from(h['X-API-Signature'], 'base64url'),
      ),
    ).toBe(true);
  });

  it('signs the WebSocket sign-in frame (mt:29) over the four-line canonical string', async () => {
    const signer = testSigner('read');
    const frame = await wsSignInFrame(signer, {
      chainId: testnet.chainId,
      timestamp: 1_791_644_000_000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    });
    expect(frame).toMatchObject({
      mt: 29,
      chain_id: 10143,
      api_key: 'fixture-read-key',
      timestamp: '1791644000000',
    });
    const canonical = wsSignInCanonical({
      chainId: testnet.chainId,
      timestamp: 1_791_644_000_000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    });
    expect(canonical).toBe(
      '10143\ntrading-ws-signin\n1791644000000\nAAECAwQFBgcICQoLDA0ODw',
    );
    expect(
      verify(
        null,
        Buffer.from(canonical),
        createPublicKey(signer.key),
        Buffer.from(frame.signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('never reissues a nonce inside the replay window', () => {
    const fixed = new NonceSource(() => new Uint8Array(16).fill(1));
    fixed.next(0);
    expect(() => fixed.next(1)).toThrow(/NONCE_REUSED/);
    expect(fixed.next(120_000)).toBe(
      base64UrlNoPad(new Uint8Array(16).fill(1)),
    );
    const real = new NonceSource();
    const seen = new Set(Array.from({ length: 500 }, (_, i) => real.next(i)));
    expect(seen.size).toBe(500);
  });

  it('tracks server time from the Date header to stay inside the +-30 s window', () => {
    let local = 1_000_000_000_000;
    const clock = new ServerClock(() => local);
    clock.observeDateHeader(
      new Date(local + 45_000).toUTCString(),
      local,
      local,
    );
    expect(Math.abs(clock.now() - (local + 45_000)) < 1_500).toBe(true);
    expect(clock.withinWindow(local + 45_000)).toBe(true);
    local += 10;
    expect(clock.withinWindow(local)).toBe(false);
  });
});

describe('Perpl REST client against a signature-verifying double', () => {
  const setup = (skewMs = 0) => {
    const server = new FakePerplRest(testnet.chainId, testnet.restUrl);
    server.serverNow = () => Date.now() + skewMs;
    const trade = testSigner('trade');
    const read = testSigner('read', Buffer.alloc(32, 7));
    server.register(trade);
    server.register(read);
    const wallet = {
      mt: 19,
      sn: 5,
      addr: '0x6666666666666666666666666666666666666666',
      as: [
        {
          in: 12,
          id: 1058,
          fr: false,
          fw: true,
          lfr: 0,
          b: '100000000',
          lb: '0',
        },
      ],
    };
    server.routes.push((r) =>
      r.target === '/v1/trading/wallet'
        ? { status: 200, body: wallet }
        : undefined,
    );
    const client = (signer = trade, extra = {}) =>
      new PerplRestClient({
        network: testnet,
        signer,
        fetch: server.fetch,
        transport: 'recorded',
        sleep: async () => {},
        ...extra,
      });
    return { server, trade, read, client };
  };

  it('authenticates signed reads', async () => {
    const { client } = setup();
    expect((await client().wallet()).as?.[0]?.id).toBe(1058);
  });

  it('bad timestamp: a skewed local clock is rejected, re-synced from Date and retried once', async () => {
    const { client, server } = setup(90_000);
    const c = client();
    expect((await c.wallet()).as?.[0]?.fw).toBe(true);
    expect(server.calls).toHaveLength(2);
    expect(c.clock.offsetMs()).toBeGreaterThan(80_000);
  });

  it('nonce replay is rejected by the server', async () => {
    const { client, server } = setup();
    await client().wallet();
    const first = server.calls[0]!;
    const res = await server.fetch(`${testnet.restUrl}${first.target}`, {
      method: 'GET',
      headers: first.headers,
    });
    expect(res.status).toBe(401);
  });

  it('bad signature is rejected', async () => {
    const { server } = setup();
    const rogue = {
      ...testSigner('trade', Buffer.alloc(32, 3)),
      apiKey: 'fixture-trade-key',
    };
    const c = new PerplRestClient({
      network: testnet,
      signer: rogue,
      fetch: server.fetch,
      transport: 'recorded',
      sleep: async () => {},
    });
    await expect(c.wallet()).rejects.toMatchObject({
      code: 'AUTH_REJECTED',
      status: 401,
    });
  });

  it('read-only key trading attempt is refused with SCOPE_INSUFFICIENT', async () => {
    const { client, read } = setup();
    await expect(
      client(read).submitOrders([
        {
          rq: 1,
          mkt: 64,
          acc: 1058,
          t: 2,
          p: 2500,
          s: 1,
          fl: 4,
          lv: 100,
          lb: 0,
        },
      ]),
    ).rejects.toMatchObject({ code: 'SCOPE_INSUFFICIENT' });
  });

  it('account missing (404) on trading state', async () => {
    const { client, server } = setup();
    server.routes.unshift((r) =>
      r.target === '/v1/trading/positions'
        ? { status: 404, body: { error: 'no account' } }
        : undefined,
    );
    await expect(client().positions()).rejects.toMatchObject({
      code: 'ACCOUNT_MISSING',
    });
  });

  it('rate limits back off and retry; persistent limits surface RATE_LIMITED', async () => {
    const { client, server } = setup();
    let n = 0;
    server.routes.unshift((r) =>
      r.target === '/v1/market-data/ticker'
        ? ++n < 3
          ? { status: 429, body: 'slow down' }
          : { status: 200, body: { mt: 9, sn: 1, d: {} } }
        : undefined,
    );
    const delays: number[] = [];
    const c = client(undefined, {
      sleep: async (ms: number) => void delays.push(ms),
    });
    await c.ticker();
    expect(delays).toEqual([1_000, 2_000]);
    server.routes.unshift((r) =>
      r.target === '/v1/market-data/64/ticker'
        ? { status: 503, body: 'warming' }
        : undefined,
    );
    await expect(c.ticker(64)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('times out instead of hanging and validates response shapes', async () => {
    const { server } = setup();
    const hanging = new PerplRestClient({
      transport: 'recorded',
      network: testnet,
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
          ),
        ),
    });
    await expect(hanging.context()).rejects.toMatchObject({ code: 'TIMEOUT' });
    server.routes.push((r) =>
      r.target === '/v1/pub/context'
        ? { status: 200, body: { chain: {} } }
        : undefined,
    );
    await expect(
      new PerplRestClient({
        transport: 'recorded',
        network: testnet,
        fetch: server.fetch,
      }).context(),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
