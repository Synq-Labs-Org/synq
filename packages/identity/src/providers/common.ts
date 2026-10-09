import { IdentityError } from '../errors.js';

export type ProviderName = 'privy' | 'dynamic';
export type ProviderStatus =
  | { provider: ProviderName; status: 'CONFIGURED' }
  | {
      provider: ProviderName;
      status: 'BLOCKED';
      missing: string[];
      reason: string;
    };

export class ProviderBlockedError extends IdentityError {
  constructor(
    readonly provider: ProviderName,
    readonly missing: readonly string[],
    readonly reason: string,
  ) {
    super('PROVIDER_BLOCKED', `${provider}: ${reason}`);
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function missingEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
) {
  return names.filter((n) => !env[n] || !env[n]!.trim());
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  throw new Error('unsupported JSON value');
}

export async function providerJson(
  provider: ProviderName,
  response: Awaited<ReturnType<FetchLike>>,
): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new IdentityError(
      'PROVIDER_ERROR',
      `${provider} HTTP ${response.status}`,
    );
  return body;
}
