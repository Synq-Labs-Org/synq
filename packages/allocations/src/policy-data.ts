import { getAddress, isAddress, keccak256, stringToHex, type Hex } from 'viem';
import { z } from 'zod';
import type { PaymentMandate } from '@synq/kernel/arc';
/**
 * Revenue policy: the owner's signed rules for what happens to a final
 * incoming payment.
 *
 * The policy is versioned and signed by the owner (EIP-712, chain id in the
 * domain) over a hash of its whole canonical body, so every amount, limit and
 * beneficiary is covered. Payout legs run under a Kernel `PaymentMandate`
 * derived deterministically from the policy (`mandateFromPolicy`), which the
 * owner signs as well; the Kernel verifies that signature for every grant.
 * Nothing a model or a chat message produces can create or widen either.
 */

const address = z
  .string()
  .refine((a) => isAddress(a, { strict: false }), 'address')
  .transform((a) => getAddress(a));
const units = z.bigint().nonnegative();
const positive = z.bigint().positive();

export const BeneficiarySchema = z
  .object({
    /** Vendor-master id; the payout address must be VERIFIED there at run time. */
    beneficiaryId: z.string().min(1).max(80),
    address,
    label: z.string().min(1).max(80),
  })
  .strict();

export const DistributionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('FIXED'),
      label: z.string().min(1).max(80),
      beneficiaryId: z.string().min(1).max(80),
      amount: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal('PERCENT_OF_SURPLUS'),
      label: z.string().min(1).max(80),
      beneficiaryId: z.string().min(1).max(80),
      bps: z.number().int().min(1).max(10_000),
    })
    .strict(),
]);

export const RevenuePolicySchema = z
  .object({
    policyId: z.string().regex(/^[a-z0-9_:-]{3,80}$/),
    version: z.number().int().positive(),
    workspaceId: z.string().min(1).max(80),
    owner: address,
    chainId: z.number().int().positive(),
    token: address,
    decimals: z.number().int().min(0).max(18),
    /** The account the receipt lands in and legs pay from (e.g. the governed vault). */
    treasury: address,
    validFrom: z.number().int().nonnegative(),
    validUntil: z.number().int().positive(),
    /**
     * Tax estimate held back from each gross receipt. A reservation on the
     * treasury's own cash: never a transfer and never a tax remittance.
     */
    taxReserveBps: z.number().int().min(0).max(5_000),
    /** Minimum unreserved liquidity the treasury keeps (base units). */
    operatingFloor: units,
    /** AP and bills due within this many days are funded before any surplus. */
    obligationHorizonDays: z.number().int().min(1).max(120),
    allowedBeneficiaries: z.array(BeneficiarySchema).max(20),
    distributions: z.array(DistributionSchema).max(10),
    limits: z
      .object({
        /** A transfer leg above this needs a fresh owner approval (no autonomous grant). */
        maxAutonomousPerLeg: positive,
        /** Autonomous transfers across all splits in `windowSeconds`. */
        maxAutonomousPerWindow: positive,
        windowSeconds: z
          .number()
          .int()
          .min(60)
          .max(31 * 86_400),
        /** Splits this policy may run per window (frequency limit). */
        maxSplitsPerWindow: z.number().int().min(1).max(1_000),
      })
      .strict(),
    /** Oldest balance observation (seconds) a plan may be computed from. */
    maxBalanceAgeSeconds: z.number().int().min(1).max(3_600),
    /** All rounding dust and unallocated surplus stays as free cash. */
    remainder: z.literal('FREE_CASH'),
    /** Cancel releases reservations; only before any leg is signed. */
    cancellation: z.literal('BEFORE_EXECUTION'),
    /** A leg with an unknown outcome is never retried automatically. */
    recovery: z.literal('RECONCILE_THEN_REVIEW'),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (p.validUntil <= p.validFrom) issue('empty validity window');
    if (p.limits.maxAutonomousPerLeg > p.limits.maxAutonomousPerWindow)
      issue('per-leg limit above window limit');
    const ids = new Set<string>();
    for (const b of p.allowedBeneficiaries) {
      if (ids.has(b.beneficiaryId)) issue(`duplicate ${b.beneficiaryId}`);
      ids.add(b.beneficiaryId);
      if (b.address === p.treasury || b.address === p.token)
        issue(`${b.beneficiaryId}: beneficiary cannot be treasury or token`);
    }
    for (const d of p.distributions)
      if (!ids.has(d.beneficiaryId))
        issue(`${d.label}: ${d.beneficiaryId} is not an allowed beneficiary`);
    const pct = p.distributions
      .filter((d) => d.kind === 'PERCENT_OF_SURPLUS')
      .reduce((a, d) => a + (d.kind === 'PERCENT_OF_SURPLUS' ? d.bps : 0), 0);
    if (pct > 10_000) issue('percentage distributions above 100%');
  });

export type RevenuePolicy = z.output<typeof RevenuePolicySchema>;
export type Distribution = z.output<typeof DistributionSchema>;
export type Beneficiary = z.output<typeof BeneficiarySchema>;

export class PolicyError extends Error {
  constructor(
    readonly code:
      | 'INVALID_POLICY'
      | 'NOT_SIGNED_BY_OWNER'
      | 'MANDATE_MISMATCH'
      | 'POLICY_NOT_ACTIVE'
      | 'OWNER_NOT_REGISTERED'
      | 'TREASURY_NOT_REGISTERED'
      | 'POLICY_SUPERSEDED'
      | 'POLICY_REVOKED'
      | 'BAD_REVOCATION',
    message: string = code,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function parsePolicy(input: unknown): RevenuePolicy {
  const r = RevenuePolicySchema.safeParse(input);
  if (!r.success)
    throw new PolicyError(
      'INVALID_POLICY',
      r.error.issues.map((i) => i.message).join('; '),
    );
  return r.data;
}

/** JSON with sorted keys and bigints as decimal strings (`"123n"`). */
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const hashOf = (value: unknown): Hex =>
  keccak256(stringToHex(canonical(value)));

/** keccak256 of the canonical policy body: what the owner's signature covers. */
export const policyHash = (p: RevenuePolicy): Hex => hashOf(p);

export function policyTypedData(p: RevenuePolicy) {
  return {
    domain: { name: 'Synq Revenue Policy', version: '1', chainId: p.chainId },
    types: {
      RevenuePolicy: [
        { name: 'policyId', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'workspaceId', type: 'string' },
        { name: 'owner', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'treasury', type: 'address' },
        { name: 'policyHash', type: 'bytes32' },
        { name: 'validFrom', type: 'uint256' },
        { name: 'validUntil', type: 'uint256' },
      ],
    },
    primaryType: 'RevenuePolicy' as const,
    message: {
      policyId: p.policyId,
      version: BigInt(p.version),
      workspaceId: p.workspaceId,
      owner: p.owner,
      token: p.token,
      treasury: p.treasury,
      policyHash: policyHash(p),
      validFrom: BigInt(p.validFrom),
      validUntil: BigInt(p.validUntil),
    },
  };
}

/**
 * The Kernel mandate a policy implies: the treasury pays only the policy's
 * allowed beneficiaries, at most `maxAutonomousPerLeg` per payment and
 * `maxAutonomousPerWindow` per window, for contractor/vendor obligations.
 */
export function mandateFromPolicy(p: RevenuePolicy): PaymentMandate {
  return {
    mandateId: `rev:${p.policyId}`,
    version: p.version,
    workspaceId: p.workspaceId,
    owner: p.owner,
    chainId: p.chainId,
    token: p.token,
    payer: p.treasury,
    recipients: p.allowedBeneficiaries.map((b) => b.address),
    purposes: [
      'CONTRACTOR_PAYOUT',
      'VENDOR_INVOICE',
      ...(p.distributions.length ? (['OWNER_DISTRIBUTION'] as const) : []),
    ],
    perActionCap: p.limits.maxAutonomousPerLeg,
    periodBudget: p.limits.maxAutonomousPerWindow,
    periodSeconds: p.limits.windowSeconds,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
  };
}
