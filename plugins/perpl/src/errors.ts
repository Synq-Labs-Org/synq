export type PerplErrorCode =
  | 'AUTH_REJECTED'
  | 'SCOPE_INSUFFICIENT'
  | 'ACCOUNT_MISSING'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'INVALID_REQUEST'
  | 'CLOCK_SKEW'
  | 'NONCE_REUSED'
  | 'MARKET_UNAVAILABLE'
  | 'MARKET_STALE'
  | 'COLLATERAL_MISMATCH'
  | 'PROFILE_MISMATCH'
  | 'WS_CLOSED'
  | 'WS_AUTH_FAILED'
  | 'WS_SEQUENCE_GAP'
  | 'SUBSCRIPTION_LIMIT'
  | 'ORDER_INVALID'
  | 'FORWARDING_DISABLED'
  | 'UNKNOWN_OUTCOME';

export class PerplError extends Error {
  constructor(
    readonly code: PerplErrorCode,
    message?: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message ? `${code}: ${message}` : code, options);
    this.name = 'PerplError';
  }
}

export function statusCode(status: number, path: string): PerplErrorCode {
  if (status === 401) return 'AUTH_REJECTED';
  if (status === 403) return 'SCOPE_INSUFFICIENT';
  if (status === 404)
    return path.startsWith('/v1/trading/') ? 'ACCOUNT_MISSING' : 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_REQUEST';
}
