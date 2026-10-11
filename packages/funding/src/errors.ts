export const FUNDING_ERROR_CODES = [
  'NOT_AUSD',
  'WRONG_CHAIN',
  'WRONG_TOKEN',
  'SYMBOL_SPOOF',
  'DECIMALS_MISMATCH',
  'PROFILE_MISMATCH',
  'ONCHAIN_IDENTITY_MISMATCH',
  'MAINNET_DISABLED',
  'QUOTE_EXPIRED',
  'QUOTE_INVALID',
  'DESTINATION_MISMATCH',
  'UNDERPAID',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'ROUTE_UNAVAILABLE',
  'SLIPPAGE_EXCEEDED',
  'NETWORK_MISMATCH',
  'RECIPIENT_UNKNOWN',
  'RECIPIENT_MISMATCH',
  'PREVIEW_EXPIRED',
  'PREVIEW_MISMATCH',
  'AMOUNT_INVALID',
  'AMOUNT_EXCEEDS_MANDATE',
  'INSUFFICIENT_FREE_BALANCE',
  'AUSD_GUARD_BLOCKED',
  'PROVIDER_ERROR',
  'PROVIDER_RESPONSE_INVALID',
  'CREDENTIALS_MISSING',
] as const;
export type FundingErrorCode = (typeof FUNDING_ERROR_CODES)[number];

export class FundingError extends Error {
  constructor(
    readonly code: FundingErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'FundingError';
  }
}

export function isFundingError(
  error: unknown,
  code?: FundingErrorCode,
): error is FundingError {
  return (
    error instanceof FundingError && (code === undefined || error.code === code)
  );
}
