import { createHash, randomBytes } from 'node:crypto';
import { PerplError } from './errors.js';

export type PerplScope = 'read' | 'trade';
export const SCOPE_MASK: Readonly<Record<PerplScope, number>> = Object.freeze({
  read: 1,
  trade: 2,
});
export const MAX_CLOCK_SKEW_MS = 30_000;
export const WS_SIGNIN_TAG = 'trading-ws-signin';

// The signing capability is injected from execution infrastructure; this
// package never sees key material.
export interface PerplRequestSigner {
  readonly apiKey: string;
  readonly scope: PerplScope;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export function base64UrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export type RestCanonicalInput = {
  chainId: number;
  method: string;
  target: string;
  timestamp: number;
  nonce: string;
  body: string;
};

export function restCanonical(input: RestCanonicalInput): string {
  if (!METHODS.has(input.method))
    throw new PerplError('INVALID_REQUEST', 'method must be uppercase HTTP');
  if (!input.target.startsWith('/v1/'))
    throw new PerplError(
      'INVALID_REQUEST',
      'request-target is the path after /api, starting with /v1/',
    );
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0)
    throw new PerplError('INVALID_REQUEST', 'timestamp must be unix ms');
  if (!NONCE.test(input.nonce))
    throw new PerplError('INVALID_REQUEST', 'nonce must be base64url');
  return [
    String(input.chainId),
    input.method,
    input.target,
    String(input.timestamp),
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function wsSignInCanonical(input: {
  chainId: number;
  timestamp: number;
  nonce: string;
}): string {
  if (!NONCE.test(input.nonce))
    throw new PerplError('INVALID_REQUEST', 'nonce must be base64url');
  return [
    String(input.chainId),
    WS_SIGNIN_TAG,
    String(input.timestamp),
    input.nonce,
  ].join('\n');
}

export class NonceSource {
  private readonly issued = new Map<string, number>();
  constructor(
    private readonly random: (size: number) => Uint8Array = randomBytes,
    private readonly retentionMs = 2 * MAX_CLOCK_SKEW_MS,
  ) {}
  next(now: number): string {
    for (const [nonce, at] of this.issued)
      if (now - at > this.retentionMs) this.issued.delete(nonce);
    const nonce = base64UrlNoPad(this.random(16));
    if (this.issued.has(nonce)) throw new PerplError('NONCE_REUSED');
    this.issued.set(nonce, now);
    return nonce;
  }
}

// Tracks the offset between the local clock and Perpl server time, learned
// from the HTTP Date header and block timestamps on responses.
export class ServerClock {
  private offset = 0;
  private observed = false;
  constructor(private readonly local: () => number = Date.now) {}
  now(): number {
    return this.local() + this.offset;
  }
  offsetMs(): number {
    return this.offset;
  }
  hasObservation(): boolean {
    return this.observed;
  }
  observe(serverMs: number, sentAt: number, receivedAt: number): void {
    if (!Number.isFinite(serverMs) || serverMs <= 0) return;
    const midpoint = sentAt + Math.floor((receivedAt - sentAt) / 2);
    this.offset = serverMs - midpoint;
    this.observed = true;
  }
  observeDateHeader(value: string | null, sentAt: number, receivedAt: number) {
    if (!value) return;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return;
    // Date has one-second resolution; only correct when the drift is material.
    const midpoint = sentAt + Math.floor((receivedAt - sentAt) / 2);
    if (Math.abs(parsed + 500 - (midpoint + this.offset)) > 2_000)
      this.observe(parsed + 500, sentAt, receivedAt);
  }
  withinWindow(timestamp: number): boolean {
    return Math.abs(this.now() - timestamp) <= MAX_CLOCK_SKEW_MS;
  }
}

export type SignedHeaders = {
  'X-API-Key': string;
  'X-API-Timestamp': string;
  'X-API-Nonce': string;
  'X-API-Signature': string;
};

export async function signRestRequest(
  signer: PerplRequestSigner,
  input: RestCanonicalInput,
): Promise<SignedHeaders> {
  const canonical = restCanonical(input);
  const signature = await signer.sign(new TextEncoder().encode(canonical));
  return {
    'X-API-Key': signer.apiKey,
    'X-API-Timestamp': String(input.timestamp),
    'X-API-Nonce': input.nonce,
    'X-API-Signature': base64UrlNoPad(signature),
  };
}

export type WsSignInFrame = {
  mt: 29;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
};

export async function wsSignInFrame(
  signer: PerplRequestSigner,
  input: { chainId: number; timestamp: number; nonce: string },
): Promise<WsSignInFrame> {
  const canonical = wsSignInCanonical(input);
  const signature = await signer.sign(new TextEncoder().encode(canonical));
  return {
    mt: 29,
    chain_id: input.chainId,
    api_key: signer.apiKey,
    timestamp: String(input.timestamp),
    nonce: input.nonce,
    signature: base64UrlNoPad(signature),
  };
}
