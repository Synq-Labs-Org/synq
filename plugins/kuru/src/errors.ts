export const KURU_ERROR_CODES = [
  'UNSUPPORTED_NETWORK',
  'UNAVAILABLE_IN_NETWORK_PROFILE',
  'TOKEN_NOT_ALLOWED',
  'UNSUPPORTED_PAIR',
  'WRONG_TOKEN',
  'WRONG_CHAIN',
  'WRONG_TARGET',
  'WRONG_SPENDER',
  'APPROVAL_TOO_LARGE',
  'APPROVAL_MISMATCH',
  'CALLDATA_UNKNOWN',
  'CALLDATA_MISMATCH',
  'CALLDATA_MUTATED',
  'MAX_INPUT_BREACH',
  'MIN_OUTPUT_BREACH',
  'SLIPPAGE_EXCEEDED',
  'QUOTE_EXPIRED',
  'QUOTE_SCHEMA_CHANGED',
  'QUOTE_FAILED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'MARKET_MISSING',
  'MARKET_MISMATCH',
  'MARKET_UNHEALTHY',
  'PRECISION',
  'INVALID_AMOUNT',
  'EXECUTION_PATH_UNAVAILABLE',
  'SIMULATION_FAILED',
] as const;
export type KuruErrorCode = (typeof KURU_ERROR_CODES)[number];

export class KuruError extends Error {
  constructor(
    readonly code: KuruErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'KuruError';
  }
}

export function requireKuru(
  condition: boolean,
  code: KuruErrorCode,
  detail?: string,
): asserts condition {
  if (!condition) throw new KuruError(code, detail);
}
