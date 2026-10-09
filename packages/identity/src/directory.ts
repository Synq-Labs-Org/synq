import {
  VerifiedApprovalSchema,
  type ApprovalLedger,
  type IdentityPrincipalKind,
  type VerifiedApproval,
} from '@synq/schemas';
import type { IdentityStore } from './store.js';

export type DirectoryMember = {
  groupId: string;
  memberId: string;
  principalId: string;
  principalKind: IdentityPrincipalKind;
  role: 'APPROVER' | 'OPERATOR';
  signer: `0x${string}`;
  membershipEpoch: number;
  ownerOfAccount: boolean;
};

export interface MembershipDirectory {
  activeMember(
    groupId: string,
    memberId: string,
  ): Promise<DirectoryMember | null>;
  membershipEpoch(groupId: string): Promise<number | null>;
}

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
