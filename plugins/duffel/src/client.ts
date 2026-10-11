export const DUFFEL_API = 'https://api.duffel.com';
export const DUFFEL_HOST = 'api.duffel.com';
export const DUFFEL_VERSION = 'v2';

export type HttpFetch = (
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

/**
 * Outcome classes: DEFINITIVE errors prove nothing was created; AMBIGUOUS ones
 * (timeouts, 5xx, transport) on a mutation mean the provider state is unknown
 * and must be reconciled, never blindly retried.
 */
export type DuffelErrorKind =
  | 'DEFINITIVE'
  | 'AMBIGUOUS'
  | 'RATE_LIMITED'
  | 'AUTH';

export class DuffelError extends Error {
  constructor(
    readonly kind: DuffelErrorKind,
    readonly status: number | null,
    readonly code: string,
    readonly requestId: string | null,
    detail: string,
  ) {
    super(
      `DUFFEL_${kind}: ${status ?? 'NO_RESPONSE'} ${code} ${detail}`.slice(
        0,
        300,
      ),
    );
    this.name = 'DuffelError';
  }
}

export class LiveKeyRefusedError extends Error {
  constructor() {
    super('DUFFEL_LIVE_KEY_REFUSED: only duffel_test_ tokens are accepted');
    this.name = 'LiveKeyRefusedError';
  }
}

type Json = Record<string, unknown>;

export class DuffelClient {
  readonly environment = 'SANDBOX' as const;
  private readonly token: string;
  constructor(
    token: string,
    private readonly fetchImpl: HttpFetch,
    private readonly baseUrl = DUFFEL_API,
  ) {
    if (!/^duffel_test_[A-Za-z0-9_-]+$/.test(token))
      throw new LiveKeyRefusedError();
    this.token = token;
  }

  async request<T = Json>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ data: T; meta?: Json; requestId: string | null }> {
    const mutation = method === 'POST';
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Duffel-Version': DUFFEL_VERSION,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify({ data: body }) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new DuffelError(
        mutation ? 'AMBIGUOUS' : 'DEFINITIVE',
        null,
        'TRANSPORT',
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      parsed = {};
    }
    if (res.status >= 200 && res.status < 300)
      return {
        data: parsed.data as T,
        meta: parsed.meta as Json | undefined,
        requestId,
      };
    const first = Array.isArray(parsed.errors)
      ? (parsed.errors[0] as Json | undefined)
      : undefined;
    const code = String(first?.code ?? first?.type ?? 'unknown');
    const message = String(first?.message ?? '').slice(0, 160);
    const kind: DuffelErrorKind =
      res.status === 401 || res.status === 403
        ? 'AUTH'
        : res.status === 429
          ? 'RATE_LIMITED'
          : (res.status >= 500 || res.status === 408) && mutation
            ? 'AMBIGUOUS'
            : 'DEFINITIVE';
    throw new DuffelError(kind, res.status, code, requestId, message);
  }
}
