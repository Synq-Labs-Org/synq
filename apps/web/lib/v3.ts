import type { z } from 'zod';
import { ApiErrorSchema } from '@synq/contracts';

/** What went wrong, in terms the screens act on. */
export type V3ErrorKind =
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'POLICY'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID'
  | 'NETWORK'
  | 'OTHER';

export class V3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind: V3ErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'V3Error';
  }
}

function kindOf(status: number): V3ErrorKind {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'POLICY';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status === 400) return 'INVALID';
  return 'OTHER';
}

let authLost: (() => void) | null = null;
/** The hub registers one handler so any 401 returns the viewer to sign-in. */
export function onAuthLost(handler: (() => void) | null): void {
  authLost = handler;
}

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(method === 'POST'
          ? { 'idempotency-key': crypto.randomUUID() }
          : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new V3Error(0, 'NETWORK', 'NETWORK', 'Could not reach Synq.');
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    const kind = kindOf(response.status);
    if (kind === 'AUTH') authLost?.();
    throw new V3Error(
      response.status,
      parsed.success ? parsed.data.error : 'UNKNOWN',
      kind,
      parsed.success
        ? parsed.data.message
        : `Request failed (${response.status})`,
    );
  }
  const result = schema.safeParse(json);
  if (!result.success)
    throw new V3Error(
      response.status,
      'BAD_RESPONSE',
      'OTHER',
      'Synq returned a response this page does not understand.',
    );
  return result.data;
}

export const v3 = {
  get: <S extends z.ZodType>(path: string, schema: S) =>
    request('GET', path, schema),
  post: <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
    request('POST', path, schema, body),
};

/** Plain-language message for a failed call. */
export function describeV3(error: unknown): string {
  if (error instanceof V3Error) {
    switch (error.kind) {
      case 'AUTH':
        return 'Your session ended. Sign in again.';
      case 'FORBIDDEN':
        return 'Access denied. Your role in this workspace does not allow this.';
      case 'NOT_FOUND':
        return 'Not found, or not visible to you.';
      case 'CONFLICT':
        return 'This changed while you were looking. It has been refreshed; review it and try again.';
      case 'POLICY':
        return `Blocked by policy: ${error.message}`;
      case 'UNAVAILABLE':
        return `This is not available right now: ${error.message}`;
      case 'RATE_LIMITED':
        return 'Too many requests. Wait a moment and try again.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

/** Path segment for an id; ids are UUIDs but never trust a URL. */
export const seg = (value: string) => encodeURIComponent(value);
