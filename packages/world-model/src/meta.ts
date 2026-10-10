import type {
  FieldFreshness,
  FieldMeta,
  Observed,
  Provenance,
} from '@synq/schemas';

export function ageFreshness(
  observedAt: number | null,
  now: number,
  maxAgeSeconds: number,
): FieldFreshness {
  if (observedAt === null || observedAt > now) return 'UNKNOWN';
  return now - observedAt <= maxAgeSeconds ? 'FRESH' : 'STALE';
}
const CONFIDENCE: Record<FieldFreshness, number> = {
  FRESH: 1,
  STALE: 0.5,
  UNKNOWN: 0,
};
export function fieldMeta(input: {
  provenance: Provenance;
  source: string;
  observedAt: number | null;
  freshness: FieldFreshness;
  confidence?: number;
  reason?: string;
}): FieldMeta {
  return {
    provenance: input.provenance,
    source: input.source,
    observedAt: input.observedAt,
    freshness: input.freshness,
    confidence: input.confidence ?? CONFIDENCE[input.freshness],
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}
export function observed<T>(value: T, meta: FieldMeta): Observed<T> {
  return { value, meta };
}
export function unknownField<T>(
  value: T,
  provenance: Provenance,
  source: string,
  reason: string,
): Observed<T> {
  return observed(
    value,
    fieldMeta({
      provenance,
      source,
      observedAt: null,
      freshness: 'UNKNOWN',
      reason: reason.slice(0, 200),
    }),
  );
}
const ORDER: Record<FieldFreshness, number> = {
  FRESH: 0,
  STALE: 1,
  UNKNOWN: 2,
};
export function worstFreshness(
  values: readonly FieldFreshness[],
): FieldFreshness {
  return values.reduce<FieldFreshness>(
    (worst, v) => (ORDER[v] > ORDER[worst] ? v : worst),
    'FRESH',
  );
}
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'SOURCE_ERROR';
}
