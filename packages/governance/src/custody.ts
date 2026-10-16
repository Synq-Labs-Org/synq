import type { Address } from 'viem';
import { addr, sameAddress } from './common.js';
import type { CouncilTerm } from './council.js';
import { GovernanceError } from './errors.js';
import type { GovernancePolicy } from './policy.js';

/**
 * Custody truth versus governance claims (ADR-002).
 *
 * Money in a Synq vault moves only as the vault's Safe and its policy module
 * allow on chain: `threshold`-of-`owners` Safe signatures, or the policy's
 * scoped operator within its per-payment and window caps. The off-chain
 * council (`council.ts`) is proposal governance: it can stop Synq from
 * initiating a payout, but it cannot stop the Safe owners. So a council money
 * policy ("5-of-7 approve withdrawals") may be advertised or acted on only
 * when the Safe itself enforces it: the Safe owners are exactly the current
 * term's seat holders and the Safe threshold equals the council threshold.
 * Everything here works on facts read live from the chain (`SafeCustody`).
 */

export type OperatorAllowance = Readonly<{
  operator: Address;
  /** 6-decimal base units. */
  perPaymentCap: bigint;
  windowCap: bigint;
  paused: boolean;
}>;

export type SafeCustody = Readonly<{
  chainId: number;
  safe: Address;
  threshold: number;
  owners: readonly Address[];
  /** The policy module's operator path, when the vault has one. */
  operator: OperatorAllowance | null;
  /** Block the facts were read at (provenance). */
  blockNumber: bigint;
}>;

export type CustodyBinding =
  | Readonly<{
      status: 'BOUND';
      threshold: number;
      owners: readonly Address[];
      termId: number;
    }>
  | Readonly<{ status: 'UNBOUND'; reasons: readonly string[] }>;

/** Whether the Safe enforces exactly this council term's M-of-N. */
export function councilCustodyBinding(
  term: CouncilTerm,
  policy: GovernancePolicy,
  custody: SafeCustody,
): CustodyBinding {
  const reasons: string[] = [];
  if (custody.chainId !== term.chainId || custody.chainId !== policy.chainId)
    reasons.push(
      `vault is on chain ${custody.chainId}, council on ${term.chainId}`,
    );
  if (term.threshold !== policy.councilThreshold)
    reasons.push('term threshold differs from policy');
  if (custody.threshold !== term.threshold)
    reasons.push(
      `Safe threshold is ${custody.threshold}; council requires ${term.threshold}`,
    );
  const owners = new Set(custody.owners.map((o) => o.toLowerCase()));
  const seats = new Set(term.seats.map((s) => s.holder.toLowerCase()));
  if (owners.size !== custody.owners.length)
    reasons.push('duplicate Safe owner');
  const notSeats = [...owners].filter((o) => !seats.has(o));
  const notOwners = [...seats].filter((s) => !owners.has(s));
  if (notSeats.length)
    reasons.push(
      `${notSeats.length} Safe owner(s) hold no council seat: ${notSeats.map(addr).join(', ')}`,
    );
  if (notOwners.length)
    reasons.push(`${notOwners.length} seat holder(s) are not Safe owners`);
  if (reasons.length) return { status: 'UNBOUND', reasons };
  return {
    status: 'BOUND',
    threshold: custody.threshold,
    owners: custody.owners.map(addr),
    termId: term.termId,
  };
}

export type MoneyPolicyClaim = Readonly<{ threshold: number; of: number }>;

/**
 * Refuses a money-policy claim the chain does not enforce: "M-of-N" is true
 * only when the Safe has exactly N owners and threshold M.
 */
export function assertMoneyPolicyEnforced(
  claim: MoneyPolicyClaim,
  custody: SafeCustody,
): void {
  if (
    custody.threshold !== claim.threshold ||
    custody.owners.length !== claim.of
  )
    throw new GovernanceError(
      'CUSTODY_MISMATCH',
      `cannot advertise ${claim.threshold}-of-${claim.of}: vault ${custody.safe} enforces ${custody.threshold}-of-${custody.owners.length} on chain`,
    );
}

export type AdvertisedMoneyPolicy = Readonly<{
  /** What actually authorises a withdrawal, from live chain reads. */
  custody: string;
  operator: string | null;
  /** BOUND: council approvals are what the Safe requires. PROPOSALS_ONLY otherwise. */
  council: 'BOUND' | 'PROPOSALS_ONLY';
  councilNote: string;
}>;

/**
 * The only money-policy statement Synq shows for a vault: derived from the
 * Safe's live threshold/owners and the operator caps, never from the
 * council's configured M-of-N.
 */
export function advertisedMoneyPolicy(
  custody: SafeCustody,
  council: { term: CouncilTerm; policy: GovernancePolicy } | null,
): AdvertisedMoneyPolicy {
  const binding = council
    ? councilCustodyBinding(council.term, council.policy, custody)
    : null;
  const op = custody.operator;
  return {
    custody: `${custody.threshold}-of-${custody.owners.length} Safe owner signatures (vault ${custody.safe}, chain ${custody.chainId}, read at block ${custody.blockNumber})`,
    operator: op
      ? `operator ${op.operator} may pay allowlisted recipients up to ${op.perPaymentCap} per payment and ${op.windowCap} per window${op.paused ? ' (paused)' : ''}`
      : null,
    council: binding?.status === 'BOUND' ? 'BOUND' : 'PROPOSALS_ONLY',
    councilNote:
      binding?.status === 'BOUND'
        ? `council ${council!.term.threshold}-of-${council!.term.seats.length} is enforced by the Safe`
        : council
          ? `council ${council.term.threshold}-of-${council.term.seats.length} approves proposals only; it does not control vault custody (${(binding as { reasons: readonly string[] }).reasons.join('; ')})`
          : 'no council',
  };
}

/**
 * Executor precondition for a council-gated payout: the Safe must enforce the
 * council, or Synq refuses to act on the council's money policy at all.
 */
export function requireBoundCustody(
  term: CouncilTerm,
  policy: GovernancePolicy,
  custody: SafeCustody,
): Extract<CustodyBinding, { status: 'BOUND' }> {
  const b = councilCustodyBinding(term, policy, custody);
  if (b.status !== 'BOUND')
    throw new GovernanceError(
      'CUSTODY_UNBOUND',
      `vault ${custody.safe} does not enforce council ${term.councilId}: ${b.reasons.join('; ')}`,
    );
  return b;
}

/** True when `signer` is one of the Safe owners. */
export const isOwner = (custody: SafeCustody, signer: string) =>
  custody.owners.some((o) => sameAddress(o, signer));
