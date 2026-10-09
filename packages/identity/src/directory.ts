import {
  VerifiedApprovalSchema,
  type ApprovalLedger,
  type DirectoryMember,
  type MembershipDirectory,
  type VerifiedApproval,
} from '@synq/schemas';
import { evaluateDelegation, type DelegationUse } from './delegation.js';
import { activeMembership } from './membership.js';
import type { IdentityStore } from './store.js';

export type { DirectoryMember, MembershipDirectory };

export class StoreMembershipDirectory implements MembershipDirectory {
  constructor(readonly store: IdentityStore) {}
  async activeMember(
    groupId: string,
    memberId: string,
  ): Promise<DirectoryMember | null> {
    return this.store.transaction(async (tx) => {
      const group = await tx.getGroup(groupId);
      if (!group) return null;
      const m = (await tx.listMemberships(groupId)).find(
        (x) => x.memberId === memberId && x.status === 'ACTIVE',
      );
      const principal = m ? await tx.getPrincipal(m.principalId) : null;
      if (
        !m ||
        !principal ||
        principal.status !== 'ACTIVE' ||
        principal.signer !== m.signer
      )
        return null;
      return {
        groupId,
        memberId,
        principalId: m.principalId,
        principalKind: m.principalKind,
        role: m.role,
        signer: m.signer,
        membershipEpoch: group.membershipEpoch,
        ownerOfAccount: group.owners.includes(m.signer),
      };
    });
  }
  async membershipEpoch(groupId: string): Promise<number | null> {
    return this.store.transaction(
      async (tx) => (await tx.getGroup(groupId))?.membershipEpoch ?? null,
    );
  }
}

export class StoreApprovalLedger implements ApprovalLedger {
  constructor(readonly store: IdentityStore) {}
  async isConsumed(raw: VerifiedApproval): Promise<boolean> {
    const approval = VerifiedApprovalSchema.parse(raw);
    return this.store.transaction(async (tx) => {
      const challenge = await tx.getGrantChallenge(approval.challengeId);
      if (!challenge || challenge.consumedAt === null) return false;
      const stored = (await tx.listApprovals(approval.draftDigest)).find(
        (a) => a.approvalId === approval.approvalId,
      );
      return (
        stored !== undefined &&
        JSON.stringify(VerifiedApprovalSchema.parse(stored)) ===
          JSON.stringify(approval)
      );
    });
  }
}

export type KernelDelegationRequest = {
  groupId: string;
  mandateId: string;
  memberId: string;
  principalId: string;
  signer: string;
  action: string;
  token: string;
  chainId: number;
  recipient: string;
  amount: string;
  nativeValue: string;
  at: number;
};
export type KernelDelegationVerdict =
  | { allowed: true; policyId: string }
  | { allowed: false; reason: string };

export class StoreDelegationEvaluator {
  constructor(readonly store: IdentityStore) {}
  async evaluate(
    request: KernelDelegationRequest,
    history: (policyId: string) => readonly DelegationUse[],
  ): Promise<KernelDelegationVerdict> {
    if (request.action !== 'TRANSFER' || request.nativeValue !== '0')
      return { allowed: false, reason: 'ACTION_NOT_DELEGATED' };
    return this.store.transaction(async (tx) => {
      const delegate = await tx.getPrincipal(request.principalId);
      if (
        !delegate ||
        delegate.status !== 'ACTIVE' ||
        delegate.kind !== 'PRIVY_DELEGATE' ||
        delegate.signer !== request.signer.toLowerCase()
      )
        return { allowed: false, reason: 'DELEGATE_INACTIVE' };
      let reason = 'NO_POLICY';
      for (const policy of await tx.listDelegationPolicies(
        request.groupId,
        request.principalId,
      )) {
        const delegator = await activeMembership(
          tx,
          policy.groupId,
          policy.delegatorMemberId,
        );
        if (!delegator || delegator.role !== 'APPROVER') {
          reason = 'DELEGATOR_INACTIVE';
          continue;
        }
        const decision = evaluateDelegation(policy, history(policy.policyId), {
          amount: request.amount,
          token: request.token,
          chainId: request.chainId,
          recipient: request.recipient,
          at: request.at,
        });
        if (decision.allowed)
          return { allowed: true, policyId: policy.policyId };
        reason = decision.reason;
      }
      return { allowed: false, reason };
    });
  }
}
