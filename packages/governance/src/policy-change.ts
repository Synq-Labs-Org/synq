import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { deepFreeze } from './common.js';
import {
  assertExecutable,
  type AcceptedChallenge,
  type CouncilDecision,
  type CouncilTerm,
} from './council.js';
import {
  launchReadiness,
  launchTermsHash,
  type Contribution,
  type LaunchTerms,
  type VerifiedAssent,
} from './contributors.js';
import { GovernanceError } from './errors.js';
import { policyHash, type GovernancePolicy } from './policy.js';

/** What a council signs to move from one policy version to the next. */
export const policyChangeHash = (
  from: GovernancePolicy,
  to: GovernancePolicy,
): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [policyHash(from), policyHash(to)],
    ),
  );

/**
 * Applies a policy change. It needs an executable council decision over this
 * exact from→to diff (M-of-N, challenge window passed, unchallenged). Every
 * open snapshot taken under the old hash is stale afterwards (`resnapshot`).
 * When the launch terms change, only contributors who signed assent to the
 * new terms are bound by them; the rest keep their original terms.
 */
export function applyPolicyChange(input: {
  current: GovernancePolicy;
  proposed: GovernancePolicy;
  term: CouncilTerm;
  decision: CouncilDecision;
  challenges: readonly AcceptedChallenge[];
  now: number;
  /** Required when `proposed.termsHash` differs from the current one. */
  newTerms?: LaunchTerms;
  contributions?: readonly Contribution[];
  assents?: readonly VerifiedAssent[];
}) {
  const { current, proposed } = input;
  if (
    proposed.policyId !== current.policyId ||
    proposed.workspaceId !== current.workspaceId ||
    proposed.chainId !== current.chainId ||
    proposed.version !== current.version + 1
  )
    throw new GovernanceError(
      'BAD_POLICY',
      'proposed policy must be the next version',
    );
  assertExecutable({
    decision: input.decision,
    term: input.term,
    challenges: input.challenges,
    now: input.now,
    kind: 'POLICY_CHANGE',
    actionHash: policyChangeHash(current, proposed),
  });
  const materialTermsChange = proposed.termsHash !== current.termsHash;
  let contributorRights: ReturnType<typeof launchReadiness> | null = null;
  if (materialTermsChange) {
    if (
      !input.newTerms ||
      launchTermsHash(input.newTerms) !== proposed.termsHash
    )
      throw new GovernanceError(
        'BAD_TERMS',
        'a terms change must present the new launch terms',
      );
    contributorRights = launchReadiness({
      terms: input.newTerms,
      contributions: input.contributions ?? [],
      assents: input.assents ?? [],
    });
  }
  return deepFreeze({
    policy: proposed,
    previousPolicyHash: policyHash(current),
    policyHash: policyHash(proposed),
    /** Snapshots under the previous hash can no longer admit votes or produce results. */
    requiresResnapshot: true as const,
    materialTermsChange,
    contributorRights,
  });
}
