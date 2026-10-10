import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Hex,
} from 'viem';

export const ATTESTATION_STATUSES = [
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED',
  'STALE',
] as const;
export type AttestationStatus = (typeof ATTESTATION_STATUSES)[number];
export const REFERENCE_DECIMALS = 8;
export const PEG = 10n ** BigInt(REFERENCE_DECIMALS);
const UINT32_MAX = 4_294_967_295n;

export type FeedRound = {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
};
export type RiskThresholds = {
  maxStalenessSec: number;
  degradedDeviationBps: number;
  maxVenueDeviationBps: number;
};
export type VenueQuote = { priceE8: bigint; source: string };
export type AssessmentInput = {
  assetId: Hex;
  now: bigint;
  reference: FeedRound | null;
  referenceUnavailableReason?: string;
  venue: VenueQuote | null;
  thresholds: RiskThresholds;
  sourceConfigHash: Hex;
};
export type AUSDRiskAttestation = {
  assetId: Hex;
  timestamp: bigint;
  referencePrice: bigint;
  deviationBps: number;
  stalenessSec: bigint;
  status: AttestationStatus;
  sourceConfigHash: Hex;
  reasons: string[];
};

export function normalizePrice(answer: bigint, decimals: number): bigint {
  if (decimals === REFERENCE_DECIMALS) return answer;
  return decimals > REFERENCE_DECIMALS
    ? answer / 10n ** BigInt(decimals - REFERENCE_DECIMALS)
    : answer * 10n ** BigInt(REFERENCE_DECIMALS - decimals);
}

export function deviationBps(price: bigint, reference: bigint): number {
  if (reference <= 0n) return Number(UINT32_MAX);
  const diff = price > reference ? price - reference : reference - price;
  const bps = (diff * 10_000n + reference - 1n) / reference;
  return Number(bps > UINT32_MAX ? UINT32_MAX : bps);
}

export function assessAusdRisk(input: AssessmentInput): AUSDRiskAttestation {
  const base = {
    assetId: input.assetId,
    timestamp: input.now,
    sourceConfigHash: input.sourceConfigHash,
  };
  const unknown = (reason: string): AUSDRiskAttestation => ({
    ...base,
    referencePrice: 0n,
    deviationBps: 0,
    stalenessSec: 0n,
    status: 'UNKNOWN',
    reasons: [reason],
  });
  const reference = input.reference;
  if (!reference)
    return unknown(input.referenceUnavailableReason ?? 'REFERENCE_UNAVAILABLE');
  if (reference.answer <= 0n) return unknown('REFERENCE_NON_POSITIVE');
  if (reference.updatedAt === 0n || reference.updatedAt > input.now)
    return unknown('REFERENCE_TIMESTAMP_INVALID');
  const price = normalizePrice(reference.answer, reference.decimals);
  if (price <= 0n) return unknown('REFERENCE_NON_POSITIVE');
  const stalenessSec = input.now - reference.updatedAt;
  const deviation = deviationBps(price, PEG);
  const measured = {
    ...base,
    referencePrice: price,
    deviationBps: deviation,
    stalenessSec,
  };
  if (
    reference.answeredInRound < reference.roundId ||
    stalenessSec > BigInt(input.thresholds.maxStalenessSec)
  )
    return { ...measured, status: 'STALE', reasons: ['REFERENCE_STALE'] };
  const reasons: string[] = [];
  if (deviation > input.thresholds.degradedDeviationBps)
    reasons.push('PEG_DEVIATION');
  if (input.venue) {
    const venueDeviation = deviationBps(input.venue.priceE8, price);
    if (venueDeviation > input.thresholds.maxVenueDeviationBps)
      reasons.push('VENUE_DEVIATION');
  }
  return reasons.length
    ? { ...measured, status: 'DEGRADED', reasons }
    : { ...measured, status: 'HEALTHY', reasons: ['WITHIN_THRESHOLDS'] };
}

const REPORT_PARAMETERS = [
  { type: 'bytes32', name: 'assetId' },
  { type: 'uint64', name: 'timestamp' },
  { type: 'uint256', name: 'referencePrice' },
  { type: 'uint32', name: 'deviationBps' },
  { type: 'uint64', name: 'stalenessSec' },
  { type: 'uint8', name: 'status' },
  { type: 'bytes32', name: 'sourceConfigHash' },
] as const;

export function encodeAttestationReport(a: AUSDRiskAttestation): Hex {
  return encodeAbiParameters(REPORT_PARAMETERS, [
    a.assetId,
    a.timestamp,
    a.referencePrice,
    a.deviationBps,
    a.stalenessSec,
    ATTESTATION_STATUSES.indexOf(a.status),
    a.sourceConfigHash,
  ]);
}

export function decodeAttestationReport(
  report: Hex,
): Omit<AUSDRiskAttestation, 'reasons'> {
  const [
    assetId,
    timestamp,
    referencePrice,
    deviation,
    stalenessSec,
    status,
    sourceConfigHash,
  ] = decodeAbiParameters(REPORT_PARAMETERS, report);
  const label = ATTESTATION_STATUSES[status];
  if (label === undefined) throw new Error('INVALID_STATUS');
  return {
    assetId,
    timestamp,
    referencePrice,
    deviationBps: deviation,
    stalenessSec,
    status: label,
    sourceConfigHash,
  };
}

export function canonicalAssetKey(chainId: number, address: string): Hex {
  return keccak256(
    stringToHex(`eip155:${chainId}/erc20:${address.toLowerCase()}`),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

export function sourceConfigHash(config: unknown): Hex {
  return keccak256(stringToHex(canonical(config)));
}
