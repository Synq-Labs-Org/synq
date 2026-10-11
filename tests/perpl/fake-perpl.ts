import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  restCanonical,
  type FetchLike,
  type PerplRequestSigner,
} from '@synq/plugin-perpl';
import { ed25519FromSeed, ed25519Sign } from '@synq/perpl-executor';

// RFC 8032 section 7.1, test 1 (public test vector, not a credential).
const V1 = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const SEED = Buffer.from(V1, 'hex');
export function testSigner(
  scope: 'read' | 'trade' = 'trade',
  seed: Buffer = SEED,
): PerplRequestSigner & { key: KeyObject } {
  const key = ed25519FromSeed(seed);
  return {
    apiKey: `fixture-${scope}-key`,
    scope,
    key,
    sign: async (m) => ed25519Sign(key, m),
  };
}

export type FakeRoute = (req: {
  method: string;
  target: string;
  body: string;
  headers: Record<string, string>;
}) => { status: number; body: unknown; date?: string } | undefined;

// In-process Perpl REST double that verifies Ed25519 signatures exactly as the
// documented canonical string, enforces the +-30 s window and nonce
// single-use, and dispatches to scripted routes.
export class FakePerplRest {
  readonly calls: {
    method: string;
    target: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  readonly seenNonces = new Set<string>();
  serverNow = () => Date.now();
  scopes = new Map<string, 'read' | 'trade'>();
  keys = new Map<string, KeyObject>();
  routes: FakeRoute[] = [];
  constructor(
    readonly chainId: number,
    readonly base: string,
  ) {}

  register(signer: PerplRequestSigner & { key: KeyObject }): void {
    this.scopes.set(signer.apiKey, signer.scope);
    this.keys.set(signer.apiKey, createPublicKey(signer.key));
  }

  private auth(
    method: string,
    target: string,
    body: string,
    h: Record<string, string>,
  ) {
    const apiKey = h['X-API-Key'];
    if (!apiKey) return null;
    const pub = this.keys.get(apiKey);
    const ts = Number(h['X-API-Timestamp']);
    const nonce = h['X-API-Nonce'] ?? '';
    if (!pub || !Number.isSafeInteger(ts)) return 401;
    if (Math.abs(this.serverNow() - ts) > 30_000) return 401;
    if (this.seenNonces.has(nonce)) return 401;
    const canonical = restCanonical({
      chainId: this.chainId,
      method,
      target,
      timestamp: ts,
      nonce,
      body,
    });
    const ok = verify(
      null,
      Buffer.from(canonical),
      pub,
      Buffer.from(h['X-API-Signature'] ?? '', 'base64url'),
    );
    if (!ok) return 401;
    this.seenNonces.add(nonce);
    return this.scopes.get(apiKey) ?? null;
  }

  fetch: FetchLike = async (url, init) => {
    const target = url.slice(this.base.length);
    const body = init.body ?? '';
    this.calls.push({
      method: init.method,
      target,
      body,
      headers: init.headers,
    });
    const date = new Date(this.serverNow()).toUTCString();
    const respond = (status: number, payload: unknown, d = date) => ({
      status,
      headers: { get: (n: string) => (n.toLowerCase() === 'date' ? d : null) },
      text: async () =>
        typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
    const scope = this.auth(init.method, target, body, init.headers);
    if (scope === 401) return respond(401, { error: 'unauthorized' });
    if (target.startsWith('/v1/trading/') && scope === null)
      return respond(401, { error: 'unauthorized' });
    if (
      init.method === 'POST' &&
      target === '/v1/trading/orders' &&
      scope === 'read'
    )
      return respond(403, {
        mt: 31,
        status: { code: 403, error: 'api key lacks trade scope' },
      });
    for (const route of this.routes) {
      const r = route({
        method: init.method,
        target,
        body,
        headers: init.headers,
      });
      if (r) return respond(r.status, r.body, r.date ?? date);
    }
    return respond(404, { error: 'not found' });
  };
}
