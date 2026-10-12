export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json =>
  v && typeof v === 'object' ? (v as Json) : {};
export const arr = (v: unknown): Json[] =>
  Array.isArray(v) ? (v as Json[]) : [];
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider.toUpperCase()}_HTTP_${status}: ${detail}`.slice(0, 240));
    this.name = 'ProviderHttpError';
  }
}

export async function getJson(
  fetchImpl: HttpFetch,
  provider: string,
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Json> {
  const res = await fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = {};
  }
  if (res.status < 200 || res.status >= 300)
    throw new ProviderHttpError(
      provider,
      res.status,
      String(
        str(body.error) ??
          str(body.message) ??
          obj(arr(body.errors)[0]).message ??
          '',
      ).slice(0, 200),
    );
  return body;
}
