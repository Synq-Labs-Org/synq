import type { Address } from 'viem';

/**
 * Continuous fraud rules. Each rule is a pure function over facts the caller
 * read from the vendor master, the ledger, identity and the WorldSnapshot; it
 * returns deterministic flags with the same shape the Kernel consumes (any
 * HARD flag denies). Models never produce these flags: a model may explain
 * them, and its explanation is labelled as inference.
 */
export type RiskFlag = Readonly<{
  code: string;
  severity: 'HARD' | 'SOFT';
  detail: string;
}>;

export type PayoutAddressRecord = Readonly<{
  address: Address;
  chainId: number;
  status: 'VERIFIED' | 'PENDING' | 'REJECTED' | 'RETIRED';
  /** When the record entered its current status (unix seconds). */
  at: number;
  verifiedBy: string | null;
}>;

const lower = (a: string) => a.toLowerCase();

/** A newly verified destination is only trusted after this cooling period. */
export const DESTINATION_COOLING_SECONDS = 24 * 3600;
/** No policy (signed or not) may lower the cooling period below this. */
export const DESTINATION_COOLING_FLOOR_SECONDS = 3600;

/**
 * P20-02: a payout destination that differs from the vendor's verified
 * address needs a new, independent verification (signed challenge from the
 * previously verified wallet, or an owner confirmation through a separate
 * channel). A PENDING or REJECTED address is never trusted, and a freshly
 * verified one is held through a cooling period.
 */
export function destinationRule(input: {
  vendorName: string;
  requested: Address;
  chainId: number;
  addresses: readonly PayoutAddressRecord[];
  now: number;
  coolingSeconds?: number;
}): RiskFlag[] {
  const on = input.addresses.filter((a) => a.chainId === input.chainId);
  const verified = on.filter((a) => a.status === 'VERIFIED');
  const current = verified.at(-1) ?? null;
  const match = on.find((a) => lower(a.address) === lower(input.requested));
  if (!current)
    return [
      {
        code: 'NO_VERIFIED_DESTINATION',
        severity: 'HARD',
        detail: `${input.vendorName} has no verified payout address on chain ${input.chainId}`,
      },
    ];
  if (lower(current.address) !== lower(input.requested))
    return [
      {
        code: 'DESTINATION_CHANGED',
        severity: 'HARD',
        detail: `requested ${input.requested} differs from ${input.vendorName}'s verified ${current.address}${match ? ` (record status ${match.status})` : ' (never seen before)'}; new verification required before any payout`,
      },
    ];
  // Callers pass an owner-signed policy value; it is still clamped to the floor.
  const cooling = Math.max(
    DESTINATION_COOLING_FLOOR_SECONDS,
    Number.isFinite(input.coolingSeconds)
      ? Math.floor(input.coolingSeconds!)
      : DESTINATION_COOLING_SECONDS,
  );
  if (input.now - current.at < cooling)
    return [
      {
        code: 'DESTINATION_RECENTLY_CHANGED',
        severity: 'HARD',
        detail: `${input.vendorName}'s address was verified ${input.now - current.at}s ago; payouts wait ${cooling}s after a destination change`,
      },
    ];
  return [];
}

/**
 * Vendor anomaly: an amount far above this vendor's paid history, or the
 * first payout to a vendor, is disclosed; a large first payout is HARD.
 */
export function vendorAnomalyRule(input: {
  vendorName: string;
  amount: bigint;
  /** Amounts previously paid to this vendor (base units). */
  history: readonly bigint[];
  /** Above this multiple of the median the amount is anomalous. */
  multiple?: bigint;
  /** First payouts at or above this are HARD. */
  firstPayoutHardAt: bigint;
}): RiskFlag[] {
  if (!input.history.length)
    return [
      {
        code: 'FIRST_PAYOUT_TO_VENDOR',
        severity: input.amount >= input.firstPayoutHardAt ? 'HARD' : 'SOFT',
        detail: `no paid history for ${input.vendorName}`,
      },
    ];
  const sorted = [...input.history].sort((a, b) => (a < b ? -1 : 1));
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const k = input.multiple ?? 3n;
  if (median > 0n && input.amount > median * k)
    return [
      {
        code: 'AMOUNT_ANOMALY',
        severity: 'HARD',
        detail: `${input.amount} is more than ${k}x ${input.vendorName}'s median payout ${median}`,
      },
    ];
  return [];
}

/** Suspicious spending: payout velocity over a rolling window. */
export function velocityRule(input: {
  amount: bigint;
  recent: readonly { amount: bigint; at: number }[];
  now: number;
  windowSeconds: number;
  maxInWindow: bigint;
  maxCountInWindow: number;
}): RiskFlag[] {
  const inWindow = input.recent.filter(
    (r) => r.at > input.now - input.windowSeconds,
  );
  const total = inWindow.reduce((a, r) => a + r.amount, 0n) + input.amount;
  const flags: RiskFlag[] = [];
  if (total > input.maxInWindow)
    flags.push({
      code: 'SPEND_VELOCITY',
      severity: 'HARD',
      detail: `${total} would leave in ${input.windowSeconds}s (limit ${input.maxInWindow})`,
    });
  if (inWindow.length + 1 > input.maxCountInWindow)
    flags.push({
      code: 'PAYOUT_BURST',
      severity: 'HARD',
      detail: `${inWindow.length + 1} payouts in ${input.windowSeconds}s (limit ${input.maxCountInWindow})`,
    });
  return flags;
}

/** Owner / approver change: payouts pause after a control change. */
export function ownerChangeRule(input: {
  changes: readonly { kind: 'OWNER' | 'APPROVER' | 'QUORUM'; at: number }[];
  now: number;
  holdSeconds: number;
}): RiskFlag[] {
  const recent = input.changes.filter(
    (c) => input.now - c.at < input.holdSeconds,
  );
  return recent.length
    ? [
        {
          code: 'CONTROL_RECENTLY_CHANGED',
          severity: 'HARD',
          detail: `${recent.map((c) => c.kind).join(', ')} changed ${input.now - Math.max(...recent.map((c) => c.at))}s ago; payouts hold for ${input.holdSeconds}s`,
        },
      ]
    : [];
}

/** Stale oracle / data: a decisive input older than its max age blocks. */
export function staleDataRule(
  inputs: readonly {
    path: string;
    observedAt: number | null;
    maxAgeSeconds: number;
  }[],
  now: number,
): RiskFlag[] {
  return inputs
    .filter(
      (i) => i.observedAt === null || now - i.observedAt > i.maxAgeSeconds,
    )
    .map((i) => ({
      code: 'STALE_DATA',
      severity: 'HARD' as const,
      detail:
        i.observedAt === null
          ? `${i.path} has no observation time`
          : `${i.path} observed ${now - i.observedAt}s ago (max ${i.maxAgeSeconds}s)`,
    }));
}

/**
 * Provenance review: facts a payout relies on must come from an independent
 * source (chain, Postgres books, Kernel, provider). A recipient, amount or
 * approval that only exists in chat text or model output is not a fact.
 */
export const FACT_PROVENANCE = [
  'CHAIN',
  'ENVIO',
  'POSTGRES',
  'PLUGIN',
  'KERNEL',
  'CONFIG',
] as const;
export function provenanceRule(
  facts: readonly { field: string; provenance: string; source: string }[],
): RiskFlag[] {
  return facts
    .filter(
      (f) => !(FACT_PROVENANCE as readonly string[]).includes(f.provenance),
    )
    .map((f) => ({
      code: 'UNVERIFIED_PROVENANCE',
      severity: 'HARD' as const,
      detail: `${f.field} comes from ${f.provenance} (${f.source.slice(0, 80)}), not an independent record`,
    }));
}

/** Codes a human reviewer can never clear: they are wallet / vendor-master policy. */
export const NON_OVERRIDABLE_CODES: ReadonlySet<string> = new Set([
  'DESTINATION_CHANGED',
  'NO_VERIFIED_DESTINATION',
  'DESTINATION_RECENTLY_CHANGED',
  'RECIPIENT_NOT_VERIFIED',
  'PAYOUT_ADDRESS_CHANGED',
  'NO_VERIFIED_PAYOUT',
  'SCREENING_HIT',
  'SCREENING_UNAVAILABLE',
  'DUPLICATE_INVOICE',
  'AMOUNT_MISMATCH',
  'SPEND_VELOCITY',
  'CONTROL_RECENTLY_CHANGED',
  'STALE_DATA',
  'UNVERIFIED_PROVENANCE',
  'UNKNOWN_VENDOR',
  'DOCUMENT_CONTAINS_INSTRUCTIONS',
]);
