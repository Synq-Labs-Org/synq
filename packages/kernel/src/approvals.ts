import { recoverTypedDataAddress } from 'viem';
import {
  VerifiedApprovalSchema,
  executionGrantTypedData,
  type ApprovalLedger,
  type BoundActionIntent,
  type GrantDraft,
  type IdentityPrincipalKind,
  type Mandate,
  type NetworkProfile,
  type VerifiedApproval,
} from '@synq/schemas';
import type {
  DelegationEvaluator,
  DelegationUsage,
  MembershipDirectory,
} from './delegation.js';
import type { Failure } from './errors.js';

const HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type RejectedApproval = {
  index: number;
  approvalId: string | null;
  code: Failure;
};
export type DelegatedUse = { approvalId: string; policyId: string };
export type ApprovalOutcome = {
  counted: VerifiedApproval[];
  rejected: RejectedApproval[];
  delegated: DelegatedUse[];
  requiredByPolicy: number;
  required: number;
  satisfied: boolean;
  shortfall: Failure | null;
};
export type ApprovalPorts = {
  ledger: ApprovalLedger;
  directory: MembershipDirectory;
  delegations: DelegationEvaluator;
  usage: DelegationUsage;
};

export function eligibleKind(
  kind: IdentityPrincipalKind,
  mandate: Mandate,
  network: NetworkProfile,
): boolean {
  if (kind === 'DYNAMIC_OPERATOR') return false;
  if (kind === 'LOCAL_FIXTURE' && network.profile !== 'local/anvil')
    return false;
  return mandate.approvalPolicy.eligibleKinds.includes(kind);
}

export function canonicalSignature(signature: `0x${string}`): boolean {
  if (signature.length !== 132) return false;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return (v === 27 || v === 28) && s > 0n && s <= HALF_ORDER;
}

async function safely<T>(task: () => T | Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

export class ApprovalCalculator {
  async evaluate(input: {
    draft: GrantDraft;
    intent: BoundActionIntent;
    mandate: Mandate;
    network: NetworkProfile;
    approvals: readonly unknown[];
    requiredByPolicy: number;
    ports: ApprovalPorts;
    now: number;
  }): Promise<ApprovalOutcome> {
    const { draft, mandate, network, intent, ports } = input;
    const typed = executionGrantTypedData(draft.domain, draft.grant);
    const rejected: RejectedApproval[] = [];
    const candidates: { index: number; approval: VerifiedApproval }[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of input.approvals.entries()) {
      const parsed = VerifiedApprovalSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({ index, approvalId: null, code: 'INVALID_APPROVAL' });
        continue;
      }
      const approval = parsed.data;
      const reject = (code: Failure) =>
        rejected.push({ index, approvalId: approval.approvalId, code });
      if (
        approval.groupId !== mandate.groupId ||
        approval.draftDigest !== draft.digest
      ) {
        reject('APPROVAL_DRAFT_MISMATCH');
        continue;
      }
      if (
        !eligibleKind(approval.principalKind, mandate, network) ||
        mandate.operators.includes(approval.signer)
      ) {
        reject('PRINCIPAL_KIND_INELIGIBLE');
        continue;
      }
      if (
        !mandate.members.some(
          (m) =>
            m.memberId === approval.memberId &&
            m.signer === approval.signer &&
            m.active,
        )
      ) {
        reject('APPROVER_NOT_MEMBER');
        continue;
      }
      const recovered = await safely(async () =>
        (
          await recoverTypedDataAddress({
            ...typed,
            signature: approval.signature,
          })
        ).toLowerCase(),
      );
      if (
        recovered !== approval.signer ||
        !canonicalSignature(approval.signature)
      ) {
        reject('APPROVAL_SIGNATURE_INVALID');
        continue;
      }
      const keys = [
        `member:${approval.memberId}`,
        `signer:${approval.signer}`,
        `principal:${approval.principalId}`,
        `challenge:${approval.challengeId}`,
        `approval:${approval.approvalId}`,
      ];
      if (keys.some((k) => seen.has(k))) {
        reject('DUPLICATE_APPROVER');
        continue;
      }
      keys.forEach((k) => seen.add(k));
      candidates.push({ index, approval });
    }
    const counted: VerifiedApproval[] = [];
    const delegated: DelegatedUse[] = [];
    for (const { index, approval } of candidates) {
      const reject = (code: Failure) =>
        rejected.push({ index, approvalId: approval.approvalId, code });
      if ((await safely(() => ports.ledger.isConsumed(approval))) !== true) {
        reject('APPROVAL_NOT_CONSUMED');
        continue;
      }
      const member = await safely(() =>
        ports.directory.activeMember(approval.groupId, approval.memberId),
      );
      if (
        !member ||
        member.role !== 'APPROVER' ||
        !member.ownerOfAccount ||
        member.principalId !== approval.principalId ||
        member.principalKind !== approval.principalKind ||
        member.signer.toLowerCase() !== approval.signer
      ) {
        reject('APPROVER_NOT_MEMBER');
        continue;
      }
      if (member.membershipEpoch !== approval.membershipEpoch) {
        reject('APPROVAL_EPOCH_STALE');
        continue;
      }
      if (approval.principalKind === 'PRIVY_DELEGATE') {
        const verdict = await safely(() =>
          ports.delegations.evaluate(
            {
              groupId: approval.groupId,
              mandateId: mandate.mandateId,
              memberId: approval.memberId,
              principalId: approval.principalId,
              signer: approval.signer,
              action: intent.action,
              token: intent.inputToken,
              chainId: intent.chainId,
              recipient: intent.recipient,
              amount: intent.maxInputAmount,
              nativeValue: intent.nativeValue,
              at: input.now,
            },
            (policyId) => ports.usage.history(policyId),
          ),
        );
        if (
          !verdict?.allowed ||
          !ports.usage.withinScope(mandate, intent, verdict.policyId, input.now)
        ) {
          reject('DELEGATION_SCOPE');
          continue;
        }
        delegated.push({
          approvalId: approval.approvalId,
          policyId: verdict.policyId,
        });
      }
      counted.push(approval);
    }
    counted.sort((a, b) => (a.signer < b.signer ? -1 : 1));
    rejected.sort((a, b) => a.index - b.index);
    const required = Math.max(
      input.requiredByPolicy,
      mandate.approvalPolicy.accountThreshold,
    );
    const shortfall: Failure | null =
      counted.length < input.requiredByPolicy
        ? 'MISSING_QUORUM'
        : counted.length < required
          ? 'ONCHAIN_QUORUM_REQUIRED'
          : null;
    return {
      counted,
      rejected,
      delegated,
      requiredByPolicy: input.requiredByPolicy,
      required,
      satisfied: rejected.length === 0 && shortfall === null,
      shortfall,
    };
  }
}
