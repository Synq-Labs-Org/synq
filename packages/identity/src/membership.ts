import {
  GroupBindingInputSchema,
  GroupViewSchema,
  IdentityChallengeSchema,
  MemberIdSchema,
  MembershipViewSchema,
  networkProfileForChain,
  type GroupView,
  type IdentityChallenge,
  type MembershipView,
} from '@synq/schemas';
import {
  approvalEligible,
  resolveConfig,
  type IdentityConfig,
  type ResolvedConfig,
} from './config.js';
import { IdentityError } from './errors.js';
import { verifyChallengeSignature } from './principals.js';
import type {
  GroupRecord,
  IdentityStore,
  IdentityTx,
  PrincipalRecord,
} from './store.js';

export function groupView(
  group: GroupRecord,
  memberships: MembershipView[],
): GroupView {
  return GroupViewSchema.parse({
    groupId: group.groupId,
    chainId: group.chainId,
    account: group.account,
    owners: group.owners,
    threshold: group.threshold,
    executors: group.executors,
    membershipEpoch: group.membershipEpoch,
    memberships,
  });
}

export async function requireGroup(
  tx: IdentityTx,
  groupId: string,
  lock?: 'UPDATE' | 'SHARE',
): Promise<GroupRecord> {
  const group = await tx.getGroup(groupId, lock);
  if (!group) throw new IdentityError('GROUP_NOT_FOUND');
  return group;
}

export async function activeMembership(
  tx: IdentityTx,
  groupId: string,
  memberId: string,
): Promise<MembershipView | null> {
  return (
    (await tx.listMemberships(groupId)).find(
      (m) => m.memberId === memberId && m.status === 'ACTIVE',
    ) ?? null
  );
}

export class MembershipService {
  readonly config: ResolvedConfig;
  constructor(
    readonly store: IdentityStore,
    config: IdentityConfig,
  ) {
    this.config = resolveConfig(config);
  }

  async createGroup(raw: unknown): Promise<GroupView> {
    const parsed = GroupBindingInputSchema.safeParse(raw);
    if (!parsed.success) throw new IdentityError('INVALID_INPUT', 'group');
    const input = parsed.data;
    if (networkProfileForChain(input.chainId).profile !== this.config.profile)
      throw new IdentityError('INVALID_INPUT', 'chain outside profile');
    if (
      new Set(input.owners).size !== input.owners.length ||
      input.threshold > input.owners.length ||
      input.owners.includes(input.account) ||
      input.executors.some((e) => input.owners.includes(e))
    )
      throw new IdentityError('INVALID_INPUT', 'owners/threshold');
    const group: GroupRecord = {
      groupId: input.groupId,
      chainId: input.chainId,
      account: input.account,
      owners: [...input.owners].sort(),
      threshold: input.threshold,
      executors: [...new Set(input.executors)].sort(),
      membershipEpoch: 0,
      createdAt: this.config.now(),
    };
    await this.store.transaction((tx) => tx.insertGroup(group));
    return groupView(group, []);
  }

  async getGroup(groupId: string): Promise<GroupView> {
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, groupId);
      return groupView(group, await tx.listMemberships(groupId));
    });
  }

  private assertApprover(
    principal: PrincipalRecord | null,
    group: GroupRecord,
  ): PrincipalRecord {
    if (!principal || principal.status !== 'ACTIVE')
      throw new IdentityError('PRINCIPAL_NOT_FOUND');
    if (!approvalEligible(principal.kind, this.config.profile))
      throw new IdentityError('PRINCIPAL_NOT_ELIGIBLE');
    if (!group.owners.includes(principal.signer))
      throw new IdentityError('NOT_SAFE_OWNER');
    return principal;
  }

  async issueJoinChallenge(input: {
    groupId: string;
    memberId: string;
    principalId: string;
  }): Promise<IdentityChallenge> {
    const memberId = MemberIdSchema.safeParse(input.memberId);
    if (!memberId.success) throw new IdentityError('INVALID_INPUT', 'memberId');
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, input.groupId);
      const principal = this.assertApprover(
        await tx.getPrincipal(input.principalId),
        group,
      );
      const clash = (await tx.listMemberships(group.groupId)).some(
        (m) =>
          m.status === 'ACTIVE' &&
          (m.memberId === memberId.data ||
            m.principalId === principal.principalId),
      );
      if (clash) throw new IdentityError('DUPLICATE_MEMBERSHIP');
      const challenge = IdentityChallengeSchema.parse({
        schemaVersion: 1,
        challengeId: this.config.randomId(),
        purpose: 'JOIN',
        principalId: principal.principalId,
        principalKind: principal.kind,
        signer: principal.signer,
        rpId: this.config.rpId,
        origin: this.config.origin,
        credentialId: principal.credential?.credentialId ?? '',
        transports: [],
        groupId: group.groupId,
        memberId: memberId.data,
        membershipEpoch: group.membershipEpoch,
        nonce: this.config.randomNonce(),
        issuedAt: now,
        expiresAt: now + this.config.challengeTtlSeconds,
      });
      await tx.insertChallenge(challenge);
      return challenge;
    });
  }

  async join(input: {
    groupId: string;
    challengeId: string;
    signature: string;
  }): Promise<MembershipView> {
    const now = this.config.now();
    const stored = await this.store.transaction((tx) =>
      tx.getChallenge(input.challengeId),
    );
    if (!stored || stored.challenge.purpose !== 'JOIN')
      throw new IdentityError('CHALLENGE_NOT_FOUND');
    if (stored.challenge.groupId !== input.groupId)
      throw new IdentityError('CHALLENGE_MISMATCH');
    await verifyChallengeSignature(stored.challenge, input.signature);
    return this.store.transaction(async (tx) => {
      const c = await tx.consumeChallenge(input.challengeId, now);
      const group = await requireGroup(tx, c.groupId, 'UPDATE');
      if (group.membershipEpoch !== c.membershipEpoch)
        throw new IdentityError('MEMBERSHIP_CHANGED');
      const principal = this.assertApprover(
        await tx.getPrincipal(c.principalId),
        group,
      );
      if (principal.signer !== c.signer)
        throw new IdentityError('SIGNATURE_MISMATCH');
      const epoch = group.membershipEpoch + 1;
      const membership = MembershipViewSchema.parse({
        groupId: group.groupId,
        memberId: c.memberId,
        principalId: principal.principalId,
        principalKind: principal.kind,
        role: 'APPROVER',
        signer: principal.signer,
        status: 'ACTIVE',
        joinedEpoch: epoch,
        joinedAt: now,
        revokedAt: null,
      });
      await tx.insertMembership(membership);
      await tx.setGroupEpoch(group.groupId, epoch);
      await tx.invalidatePendingDrafts(group.groupId);
      return membership;
    });
  }

  async bindOperator(input: {
    groupId: string;
    memberId: string;
    principalId: string;
  }): Promise<MembershipView> {
    const memberId = MemberIdSchema.safeParse(input.memberId);
    if (!memberId.success) throw new IdentityError('INVALID_INPUT', 'memberId');
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, input.groupId, 'UPDATE');
      const principal = await tx.getPrincipal(input.principalId);
      if (!principal || principal.status !== 'ACTIVE')
        throw new IdentityError('PRINCIPAL_NOT_FOUND');
      if (principal.kind !== 'DYNAMIC_OPERATOR')
        throw new IdentityError('PRINCIPAL_NOT_ELIGIBLE');
      if (
        group.owners.includes(principal.signer) ||
        principal.signer === group.account
      )
        throw new IdentityError('OPERATOR_IS_OWNER');
      const membership = MembershipViewSchema.parse({
        groupId: group.groupId,
        memberId: memberId.data,
        principalId: principal.principalId,
        principalKind: principal.kind,
        role: 'OPERATOR',
        signer: principal.signer,
        status: 'ACTIVE',
        joinedEpoch: group.membershipEpoch,
        joinedAt: now,
        revokedAt: null,
      });
      await tx.insertMembership(membership);
      return membership;
    });
  }

  async revoke(input: {
    groupId: string;
    memberId: string;
  }): Promise<GroupView> {
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, input.groupId, 'UPDATE');
      const target = await activeMembership(tx, group.groupId, input.memberId);
      if (!target) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      await tx.revokeMembership(group.groupId, input.memberId, now);
      const epoch =
        target.role === 'APPROVER'
          ? group.membershipEpoch + 1
          : group.membershipEpoch;
      await tx.setGroupEpoch(group.groupId, epoch);
      if (target.role === 'APPROVER') {
        await tx.invalidatePendingDrafts(group.groupId);
        await tx.revokeDelegationsForMember(
          group.groupId,
          target.memberId,
          now,
        );
      }
      return groupView(
        { ...group, membershipEpoch: epoch },
        await tx.listMemberships(group.groupId),
      );
    });
  }
}
