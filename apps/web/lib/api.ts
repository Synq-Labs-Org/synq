import type { z } from 'zod';
import { ApiErrorSchema } from '@synq/schemas';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

async function call<S extends z.ZodType>(
  method: 'GET' | 'POST',
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      method === 'POST'
        ? {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          }
        : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(json);
    throw new ApiFailure(
      response.status,
      error.success ? error.data.error : 'UNKNOWN',
      error.success
        ? error.data.message
        : `Request failed (${response.status})`,
    );
  }
  return schema.parse(json);
}

export const api = {
  get: <S extends z.ZodType>(path: string, schema: S) =>
    call('GET', path, schema),
  post: <S extends z.ZodType>(path: string, schema: S, body: unknown) =>
    call('POST', path, schema, body),
};

export function describeError(error: unknown): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error
  )
    return `${String(error.code)}: ${String(error.message)}`;
  return 'Unexpected error';
}
