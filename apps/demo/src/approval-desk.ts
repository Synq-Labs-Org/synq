import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, keccak256, recoverTypedDataAddress } from 'viem';
import {
  VerifiedApprovalSchema,
  executionGrantDigest,
  executionGrantTypedData,
  type ApprovalLedger,
  type GrantDraft,
  type VerifiedApproval,
} from '@synq/schemas';
import type { PrincipalRegistry } from '@synq/identity';

const HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
type Challenge = {
  challengeId: string;
  memberId: string;
  draft: GrantDraft;
  expiresAt: number;
  principalId: string;
  membershipEpoch: number;
  consumed: VerifiedApproval | null;
};

export class LocalApprovalDesk implements ApprovalLedger {
  private readonly challenges = new Map<string, Challenge>();
  constructor(private readonly registry: PrincipalRegistry) {}
  async issue(draft: GrantDraft, memberId: string, now: number, ttl = 120) {
    if (executionGrantDigest(draft.domain, draft.grant) !== draft.digest)
      throw new Error('LOCAL_DESK_DRAFT_INVALID');
    const member = await this.registry.activeMember(draft.groupId, memberId);
    if (!member || !member.ownerOfAccount)
      throw new Error('LOCAL_DESK_NOT_OWNER');
    const challenge: Challenge = {
      challengeId: randomBytes(32).toString('hex'),
      memberId,
      draft: structuredClone(draft),
      expiresAt: Math.min(now + ttl, Number(draft.grant.validUntil)),
      principalId: member.principalId,
      membershipEpoch: member.membershipEpoch,
      consumed: null,
    };
    this.challenges.set(challenge.challengeId, challenge);
    return { challengeId: challenge.challengeId, draftDigest: draft.digest };
  }
  async submit(
    challengeId: string,
    signature: `0x${string}`,
    now: number,
  ): Promise<VerifiedApproval> {
    const c = this.challenges.get(challengeId);
    if (!c || c.consumed || now >= c.expiresAt)
      throw new Error('LOCAL_DESK_CHALLENGE_INVALID');
    const member = await this.registry.activeMember(
      c.draft.groupId,
      c.memberId,
    );
    const recovered = (
      await recoverTypedDataAddress({
        ...executionGrantTypedData(c.draft.domain, c.draft.grant),
        signature,
      })
    ).toLowerCase();
    if (
      !member ||
      member.principalId !== c.principalId ||
      member.membershipEpoch !== c.membershipEpoch ||
      recovered !== member.signer ||
      BigInt(`0x${signature.slice(66, 130)}`) > HALF_ORDER
    )
      throw new Error('LOCAL_DESK_SIGNATURE_INVALID');
    const approval = VerifiedApprovalSchema.parse({
      schemaVersion: 1,
      approvalId: `approval_${keccak256(
        encodeAbiParameters(
          [{ type: 'string' }, { type: 'bytes' }],
          [challengeId, signature],
        ),
      ).slice(2)}`,
      challengeId,
      groupId: c.draft.groupId,
      memberId: c.memberId,
      principalId: member.principalId,
      principalKind: member.principalKind,
      signer: member.signer,
      draftDigest: c.draft.digest,
      signature,
      membershipEpoch: member.membershipEpoch,
      verifiedAt: now,
    });
    c.consumed = approval;
    return structuredClone(approval);
  }
  async isConsumed(approval: VerifiedApproval): Promise<boolean> {
    const stored = this.challenges.get(approval.challengeId)?.consumed;
    return (
      stored !== null &&
      stored !== undefined &&
      JSON.stringify(stored) ===
        JSON.stringify(VerifiedApprovalSchema.parse(approval))
    );
  }
}
