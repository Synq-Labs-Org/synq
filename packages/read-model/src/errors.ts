export const READ_MODEL_ERROR_CODES = [
  'INVALID_EVENT',
  'UNKNOWN_EVENT_VERSION',
  'UNTRUSTED_SOURCE',
  'UNKNOWN_GROUP',
  'UNBOUND_ACCOUNT_EVENT',
  'INVALID_TRANSITION',
  'NEGATIVE_BALANCE',
  'CONFLICTING_DUPLICATE',
  'GAP_DETECTED',
  'CHECKPOINT_REGRESSION',
  'CONFIG_MISMATCH',
  'INCONSISTENT_PROOF',
  'MANDATE_ARTIFACT_MISMATCH',
  'STALE_INDEX',
  'ACCOUNTING_FROZEN',
  'INCONSISTENT_WITH_CHAIN',
  'CACHE_INVALID',
  'NOT_FOUND',
  'SOURCE_UNAVAILABLE',
  'NO_VERIFICATION_TARGETS',
] as const;
export type ReadModelErrorCode = (typeof READ_MODEL_ERROR_CODES)[number];

export class ReadModelError extends Error {
  constructor(
    readonly code: ReadModelErrorCode,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'ReadModelError';
  }
}

export function fail(code: ReadModelErrorCode, detail?: string): never {
  throw new ReadModelError(code, detail);
}
