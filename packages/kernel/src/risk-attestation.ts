import { z } from 'zod';
import { isLocalChain } from '@synq/chain-registry';
import {
  AddressSchema,
  HashSchema,
  type ActionKind,
  type BoundActionIntent,
  type Mandate,
  type Tier,
} from '@synq/domain';
import type { Hash } from './canonical.js';
import { KernelError } from './errors.js';
import { requiredApprovalsFor, type PolicyResult } from './policy.js';

export const STABLE_RISK_STATUSES = [
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED',
  'STALE',
] as const;
export type StableRiskStatus = (typeof STABLE_RISK_STATUSES)[number];
export const MAX_ATTESTATION_FUTURE_SKEW_SECONDS = 300;
export const DEFAULT_STABLE_RISK_ACTIONS: readonly ActionKind[] = [
  'SPOT_TRADE',
  'CONVERSION',
  'PERP_HEDGE',
  'CROSS_CHAIN_FUND',
];

export type RiskAttestationQuery = {
  chainId: number;
  registry: `0x${string}`;
  assetId: Hash;
};
export const RiskAttestationObservationSchema = z.strictObject({
  chainId: z.number().int().positive(),
  registry: AddressSchema,
  assetId: HashSchema,
  status: z.enum(STABLE_RISK_STATUSES),
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  referencePrice: z.string().regex(/^(0|[1-9][0-9]*)$/),
  deviationBps: z.number().int().nonnegative(),
  stalenessSec: z.number().int().nonnegative(),
  sourceConfigHash: HashSchema,
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  workflowId: HashSchema,
  forwarder: AddressSchema,
  forwarderKind: z.enum(['CRE_FORWARDER', 'CRE_MOCK_FORWARDER']),
});
export type RiskAttestationObservation = z.output<
  typeof RiskAttestationObservationSchema
>;

/** Reads the latest attestation from the on-chain registry at confirmation depth. */
export interface RiskAttestationReader {
  latest(
    query: RiskAttestationQuery,
  ): Promise<RiskAttestationObservation | null>;
}

export type StableRiskAsset = { address: `0x${string}`; assetId: Hash };
export type RiskAttestationGateConfig = {
  reader: RiskAttestationReader;
  chainId: number;
  registry: `0x${string}`;
  assets: readonly StableRiskAsset[];
  maxAttestationAgeSeconds: number;
  trustedSourceConfigHash: Hash;
  maxReferenceStalenessSeconds: number;
  maxHealthyDeviationBps: number;
  trustedForwarder: `0x${string}`;
  forwarderKind: 'CRE_FORWARDER' | 'CRE_MOCK_FORWARDER';
  trustedWorkflowId: Hash;
  degradedTier?: Extract<Tier, 'REVIEW' | 'CONSENSUS'>;
  actions?: readonly ActionKind[];
};
export type StableRiskAssessment =
  | { applies: false }
  | {
      applies: true;
      effect: 'ALLOW' | 'ESCALATE';
      tier: Extract<Tier, 'REVIEW' | 'CONSENSUS'> | null;
      observation: RiskAttestationObservation;
    };

const TIER_RANK: Record<Tier, number> = {
  AUTO: 0,
  REVIEW: 1,
  CONSENSUS: 2,
  BLOCKED: 3,
};

/**
 * Stablecoin risk rule fed only by the attestation registry reader: HEALTHY keeps the policy result, DEGRADED
 * escalates the tier and disables delegated (autonomous) approvals, and UNKNOWN, STALE, missing, too old or
 * unreadable attestations fail closed with STABLE_RISK_UNAVAILABLE.
 */
export class RiskAttestationGate {
  private readonly registry: `0x${string}`;
  private readonly assets: ReadonlyMap<string, Hash>;
  private readonly actions: ReadonlySet<ActionKind>;
  private readonly degradedTier: Extract<Tier, 'REVIEW' | 'CONSENSUS'>;

  constructor(private readonly config: RiskAttestationGateConfig) {
    this.registry = AddressSchema.parse(config.registry);
    this.assets = new Map(
      config.assets.map((a) => [
        AddressSchema.parse(a.address),
        HashSchema.parse(a.assetId),
      ]),
    );
    if (
      !Number.isSafeInteger(config.maxAttestationAgeSeconds) ||
      config.maxAttestationAgeSeconds <= 0 ||
      !Number.isSafeInteger(config.maxReferenceStalenessSeconds) ||
      config.maxReferenceStalenessSeconds <= 0 ||
      !Number.isSafeInteger(config.maxHealthyDeviationBps) ||
      config.maxHealthyDeviationBps < 0 ||
      !HashSchema.safeParse(config.trustedSourceConfigHash).success ||
      !HashSchema.safeParse(config.trustedWorkflowId).success ||
      !AddressSchema.safeParse(config.trustedForwarder).success
    )
      throw new KernelError('INVALID_REQUEST');
    this.actions = new Set(config.actions ?? DEFAULT_STABLE_RISK_ACTIONS);
    this.degradedTier = config.degradedTier ?? 'CONSENSUS';
  }

  async assess(
    intent: Pick<
      BoundActionIntent,
      'action' | 'chainId' | 'inputToken' | 'outputToken'
    >,
    now: number,
  ): Promise<StableRiskAssessment> {
    if (!this.actions.has(intent.action)) return { applies: false };
    const assetId =
      this.assets.get(intent.inputToken) ??
      (intent.outputToken === undefined
        ? undefined
        : this.assets.get(intent.outputToken));
    if (assetId === undefined) return { applies: false };
    const unavailable = (detail: string) =>
      new KernelError('STABLE_RISK_UNAVAILABLE', [], detail);
    if (intent.chainId !== this.config.chainId)
      throw unavailable('attestation chain differs from intent chain');
    const query = {
      chainId: this.config.chainId,
      registry: this.registry,
      assetId,
    };
    let raw: unknown;
    try {
      raw = await this.config.reader.latest({ ...query });
    } catch {
      throw unavailable('attestation reader failed');
    }
    if (raw === null) throw unavailable('no attestation recorded');
    const parsed = RiskAttestationObservationSchema.safeParse(raw);
    if (!parsed.success) throw unavailable('malformed attestation');
    const observation = parsed.data;
    if (
      observation.chainId !== query.chainId ||
      observation.registry !== query.registry ||
      observation.assetId !== query.assetId
    )
      throw unavailable('attestation does not echo the query');
    if (
      observation.sourceConfigHash !== this.config.trustedSourceConfigHash ||
      observation.workflowId !== this.config.trustedWorkflowId ||
      observation.forwarder !== this.config.trustedForwarder.toLowerCase() ||
      observation.forwarderKind !== this.config.forwarderKind
    )
      throw unavailable('untrusted source or writer identity');
    if (
      this.config.forwarderKind === 'CRE_MOCK_FORWARDER' &&
      !isLocalChain(intent.chainId)
    )
      throw unavailable(
        'simulation attestation cannot authorize live execution',
      );
    const peg = 100_000_000n;
    const price = BigInt(observation.referencePrice);
    const pegDeviation =
      ((price > peg ? price - peg : peg - price) * 10_000n + peg - 1n) / peg;
    if (
      observation.stalenessSec + Math.max(0, now - observation.timestamp) >
        this.config.maxReferenceStalenessSeconds ||
      BigInt(observation.referencePrice) <= 0n ||
      (observation.status === 'HEALTHY' &&
        (observation.deviationBps > this.config.maxHealthyDeviationBps ||
          pegDeviation > BigInt(this.config.maxHealthyDeviationBps)))
    )
      throw unavailable('underlying reference is stale or inconsistent');
    if (observation.status === 'UNKNOWN' || observation.status === 'STALE')
      throw unavailable(`attestation status ${observation.status}`);
    if (
      observation.timestamp > now + MAX_ATTESTATION_FUTURE_SKEW_SECONDS ||
      now - observation.timestamp > this.config.maxAttestationAgeSeconds
    )
      throw unavailable('attestation is too old or in the future');
    return observation.status === 'HEALTHY'
      ? { applies: true, effect: 'ALLOW', tier: null, observation }
      : {
          applies: true,
          effect: 'ESCALATE',
          tier: this.degradedTier,
          observation,
        };
  }
}

export function escalateForStableRisk(
  policy: PolicyResult,
  mandate: Mandate,
  assessment: Extract<StableRiskAssessment, { applies: true }>,
): PolicyResult {
  const rule = `risk.stableAttestation:${assessment.observation.status}`;
  if (assessment.effect === 'ALLOW')
    return { ...policy, matchedRules: [...policy.matchedRules, rule] };
  const tier = assessment.tier!;
  const contributions = [...policy.contributions, { rule, tier }];
  const escalated =
    TIER_RANK[tier] > TIER_RANK[policy.tier] ? tier : policy.tier;
  return {
    ...policy,
    contributions,
    matchedRules: [...policy.matchedRules, `${rule}:${tier}`],
    tier: escalated,
    requiredApprovals: requiredApprovalsFor(
      escalated,
      mandate,
      policy.facts.withdrawal,
    ),
  };
}
