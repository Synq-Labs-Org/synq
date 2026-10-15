import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { deepFreeze } from './common.js';
import {
  executeDecision,
  type CouncilDecision,
  type CouncilStore,
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
 * Applies a policy change. It needs a recorded council decision over this
 * exact from→to diff, signed under the current policy, which executes once
 * (M-of-N re-verified, challenge window passed, unchallenged). Every open
 * snapshot and every other pending council decision under the old hash is
 * void afterwards. When the launch terms change, only contributors who signed
 * assent to the new terms are bound by them; the rest keep their original terms.
 */
export async function applyPolicyChange(input: {
  store: CouncilStore;
  current: GovernancePolicy;
  proposed: GovernancePolicy;
  decision: Pick<CouncilDecision, 'digest'>;
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
  const materialTermsChange = proposed.termsHash !== current.termsHash;
  if (
    materialTermsChange &&
    (!input.newTerms || launchTermsHash(input.newTerms) !== proposed.termsHash)
  )
    throw new GovernanceError(
      'BAD_TERMS',
      'a terms change must present the new launch terms',
    );
  const receipt = await executeDecision({
    store: input.store,
    decision: input.decision,
    policy: current,
    now: input.now,
    kind: 'POLICY_CHANGE',
    actionHash: policyChangeHash(current, proposed),
  });
  const contributorRights =
    materialTermsChange && input.newTerms
      ? launchReadiness({
          terms: input.newTerms,
          contributions: input.contributions ?? [],
          assents: input.assents ?? [],
        })
      : null;
  return deepFreeze({
    policy: proposed,
    previousPolicyHash: policyHash(current),
    policyHash: policyHash(proposed),
    receipt,
    /** Snapshots and council decisions under the previous hash are void. */
    requiresResnapshot: true as const,
    materialTermsChange,
    contributorRights,
  });
}
