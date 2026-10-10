import { randomUUID } from 'node:crypto';

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly path: string,
  ) {
    super(`${path} -> ${status} ${String(body.error ?? '')}`);
    this.name = 'ApiCallError';
  }
  /** Kernel decision code carried in an INTENT_REJECTED message (`...: CODE`). */
  get rejectionCode(): string | null {
    if (this.body.error !== 'INTENT_REJECTED') return null;
    const message = String(this.body.message ?? '');
    return message.split(': ').at(-1) ?? null;
  }
}

/** `true` sends the admin token; `{ bearer }` sends a member session token. */
export type ApiAuth = boolean | { bearer: string };

/** Minimal HTTP client for the Synq v1 API; POSTs carry a fresh idempotency key. */
export class SynqApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}
  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    auth: ApiAuth = false,
  ): Promise<T> {
    const bearer =
      typeof auth === 'object' ? auth.bearer : auth ? this.adminToken : null;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(method === 'POST'
          ? {
              'content-type': 'application/json',
              'idempotency-key': randomUUID(),
            }
          : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new ApiCallError(response.status, parsed, path);
    return parsed as T;
  }
  get<T = Record<string, unknown>>(path: string, auth: ApiAuth = false) {
    return this.request<T>('GET', path, undefined, auth);
  }
  post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    auth: ApiAuth = false,
  ) {
    return this.request<T>('POST', path, body, auth);
  }
}
