import type {
  Asset,
  DelegationPolicy,
  GrantApprovalChallenge,
  GrantDraft,
  IdentityChallenge,
  IdentityPrincipalKind,
  MembershipView,
  PasskeyCredential,
  VerifiedApproval,
} from '@synq/schemas';
import { IdentityError } from './errors.js';

export type PrincipalRecord = {
  principalId: string;
  kind: IdentityPrincipalKind;
  signer: `0x${string}`;
  rpId: string | null;
  credential: PasskeyCredential | null;
  providerRef: Record<string, string> | null;
  status: 'ACTIVE' | 'DISABLED';
  enrolledAt: number;
  lastRecoveredAt: number | null;
};
export type GroupRecord = {
  groupId: string;
  chainGroupId: `0x${string}`;
  chainId: number;
  account: `0x${string}`;
  owners: `0x${string}`[];
  threshold: number;
  executors: `0x${string}`[];
  membershipEpoch: number;
  createdAt: number;
};
export type MembershipRecord = MembershipView;
export type DraftStatus = 'PENDING' | 'INVALIDATED';
export type DraftRecord = {
  draft: GrantDraft;
  asset: Asset;
  status: DraftStatus;
  createdAt: number;
};
export type IdempotencyRecord = {
  scope: string;
  key: string;
  requestHash: string;
  state: 'PENDING' | 'DONE';
  statusCode: number | null;
  response: unknown;
  createdAt: number;
};
export type DelegationUsage = {
  usageId: string;
  policyId: string;
  amount: string;
  at: number;
};

export interface IdentityTx {
  insertChallenge(challenge: IdentityChallenge): Promise<void>;
  getChallenge(id: string): Promise<{
    challenge: IdentityChallenge;
    consumedAt: number | null;
  } | null>;
  consumeChallenge(id: string, now: number): Promise<IdentityChallenge>;
  insertPrincipal(principal: PrincipalRecord): Promise<void>;
  getPrincipal(id: string): Promise<PrincipalRecord | null>;
  markRecovered(id: string, now: number): Promise<void>;
  insertGroup(group: GroupRecord): Promise<void>;
  getGroup(id: string, lock?: 'UPDATE' | 'SHARE'): Promise<GroupRecord | null>;
  setGroupEpoch(id: string, epoch: number): Promise<void>;
  listMemberships(groupId: string): Promise<MembershipRecord[]>;
  listPrincipalMemberships(principalId: string): Promise<MembershipRecord[]>;
  insertMembership(membership: MembershipRecord): Promise<void>;
  revokeMembership(
    groupId: string,
    memberId: string,
    now: number,
  ): Promise<void>;
  insertDraft(record: DraftRecord): Promise<void>;
  getDraft(digest: string): Promise<DraftRecord | null>;
  getDraftByIntent(intentHash: string): Promise<DraftRecord | null>;
  invalidatePendingDrafts(groupId: string): Promise<number>;
  insertGrantChallenge(challenge: GrantApprovalChallenge): Promise<void>;
  getGrantChallenge(id: string): Promise<{
    challenge: GrantApprovalChallenge;
    consumedAt: number | null;
  } | null>;
  consumeGrantChallenge(
    id: string,
    now: number,
  ): Promise<GrantApprovalChallenge>;
  insertApproval(
    approval: VerifiedApproval,
    attestationSignature: string,
  ): Promise<void>;
  listApprovals(draftDigest: string): Promise<VerifiedApproval[]>;
  claimIdempotency(
    record: IdempotencyRecord,
    staleBefore: number,
  ): Promise<IdempotencyRecord | null>;
  completeIdempotency(
    scope: string,
    key: string,
    statusCode: number,
    response: unknown,
  ): Promise<void>;
  releaseIdempotency(scope: string, key: string): Promise<void>;
  insertDelegationPolicy(policy: DelegationPolicy): Promise<void>;
  getDelegationPolicy(
    id: string,
    lock?: boolean,
  ): Promise<DelegationPolicy | null>;
  revokeDelegationPolicy(id: string, now: number): Promise<void>;
  listDelegationUsage(policyId: string): Promise<DelegationUsage[]>;
  getDelegationUsage(usageId: string): Promise<DelegationUsage | null>;
  listDelegationPolicies(
    groupId: string,
    delegatePrincipalId: string,
  ): Promise<DelegationPolicy[]>;
  revokeDelegationsForMember(
    groupId: string,
    memberId: string,
    now: number,
  ): Promise<number>;
  insertDelegationUsage(usage: DelegationUsage): Promise<boolean>;
}
export interface IdentityStore {
  transaction<T>(work: (tx: IdentityTx) => Promise<T>): Promise<T>;
}

type MemoryState = {
  challenges: Map<
    string,
    { challenge: IdentityChallenge; consumedAt: number | null }
  >;
  principals: Map<string, PrincipalRecord>;
  groups: Map<string, GroupRecord>;
  memberships: MembershipRecord[];
  drafts: Map<string, DraftRecord>;
  grantChallenges: Map<
    string,
    { challenge: GrantApprovalChallenge; consumedAt: number | null }
  >;
  approvals: VerifiedApproval[];
  attestations: Map<string, string>;
  idempotency: Map<string, IdempotencyRecord>;
  delegations: Map<string, DelegationPolicy>;
  usage: DelegationUsage[];
};
const emptyState = (): MemoryState => ({
  challenges: new Map(),
  principals: new Map(),
  groups: new Map(),
  memberships: [],
  drafts: new Map(),
  grantChallenges: new Map(),
  approvals: [],
  attestations: new Map(),
  idempotency: new Map(),
  delegations: new Map(),
  usage: [],
});

export function consumable<T extends { expiresAt: number }>(
  row: { challenge: T; consumedAt: number | null } | null | undefined,
  now: number,
): T {
  if (!row) throw new IdentityError('CHALLENGE_NOT_FOUND');
  if (row.consumedAt !== null) throw new IdentityError('CHALLENGE_CONSUMED');
  if (now >= row.challenge.expiresAt)
    throw new IdentityError('CHALLENGE_EXPIRED');
  return row.challenge;
}

export class MemoryIdentityStore implements IdentityStore {
  private state = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  async transaction<T>(work: (tx: IdentityTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await work(memoryTx(draft));
      this.state = draft;
      return structuredClone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function memoryTx(s: MemoryState): IdentityTx {
  const active = (m: MembershipRecord) => m.status === 'ACTIVE';
  return {
    async insertChallenge(challenge) {
      if (s.challenges.has(challenge.challengeId))
        throw new IdentityError('INVALID_INPUT', 'challenge collision');
      s.challenges.set(challenge.challengeId, { challenge, consumedAt: null });
    },
    async getChallenge(id) {
      return s.challenges.get(id) ?? null;
    },
    async consumeChallenge(id, now) {
      const row = s.challenges.get(id);
      const challenge = consumable(row, now);
      row!.consumedAt = now;
      return challenge;
    },
    async insertPrincipal(p) {
      const clash = [...s.principals.values()].some(
        (x) =>
          x.principalId === p.principalId ||
          x.signer === p.signer ||
          (p.credential !== null &&
            x.rpId === p.rpId &&
            x.credential?.credentialId === p.credential.credentialId),
      );
      if (clash) throw new IdentityError('PRINCIPAL_EXISTS');
      s.principals.set(p.principalId, p);
    },
    async getPrincipal(id) {
      return s.principals.get(id) ?? null;
    },
    async markRecovered(id, now) {
      const p = s.principals.get(id);
      if (p) p.lastRecoveredAt = now;
    },
    async insertGroup(g) {
      if (
        s.groups.has(g.groupId) ||
        [...s.groups.values()].some(
          (x) => x.chainId === g.chainId && x.account === g.account,
        )
      )
        throw new IdentityError('GROUP_EXISTS');
      s.groups.set(g.groupId, g);
    },
    async getGroup(id) {
      return s.groups.get(id) ?? null;
    },
    async setGroupEpoch(id, epoch) {
      const g = s.groups.get(id);
      if (!g) throw new IdentityError('GROUP_NOT_FOUND');
      g.membershipEpoch = epoch;
    },
    async listMemberships(groupId) {
      return s.memberships.filter((m) => m.groupId === groupId);
    },
    async listPrincipalMemberships(principalId) {
      return s.memberships.filter((m) => m.principalId === principalId);
    },
    async insertMembership(m) {
      if (
        s.memberships.some(
          (x) =>
            active(x) &&
            x.groupId === m.groupId &&
            (x.memberId === m.memberId ||
              x.principalId === m.principalId ||
              x.signer === m.signer),
        )
      )
        throw new IdentityError('DUPLICATE_MEMBERSHIP');
      s.memberships.push(m);
    },
    async revokeMembership(groupId, memberId, now) {
      const m = s.memberships.find(
        (x) => active(x) && x.groupId === groupId && x.memberId === memberId,
      );
      if (!m) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      m.status = 'REVOKED';
      m.revokedAt = now;
    },
    async insertDraft(r) {
      if (
        s.drafts.has(r.draft.digest) ||
        [...s.drafts.values()].some(
          (x) =>
            x.status === 'PENDING' &&
            x.draft.grant.intentHash === r.draft.grant.intentHash,
        )
      )
        throw new IdentityError('DRAFT_EXISTS');
      s.drafts.set(r.draft.digest, r);
    },
    async getDraft(digest) {
      return s.drafts.get(digest) ?? null;
    },
    async getDraftByIntent(intentHash) {
      const matches = [...s.drafts.values()].filter(
        (x) => x.draft.grant.intentHash === intentHash,
      );
      return (
        matches.find((x) => x.status === 'PENDING') ?? matches.at(-1) ?? null
      );
    },
    async invalidatePendingDrafts(groupId) {
      let n = 0;
      for (const d of s.drafts.values())
        if (d.draft.groupId === groupId && d.status === 'PENDING') {
          d.status = 'INVALIDATED';
          n++;
        }
      return n;
    },
    async insertGrantChallenge(c) {
      if (s.grantChallenges.has(c.challengeId))
        throw new IdentityError('INVALID_INPUT', 'challenge collision');
      s.grantChallenges.set(c.challengeId, { challenge: c, consumedAt: null });
    },
    async getGrantChallenge(id) {
      return s.grantChallenges.get(id) ?? null;
    },
    async consumeGrantChallenge(id, now) {
      const row = s.grantChallenges.get(id);
      const challenge = consumable(row, now);
      row!.consumedAt = now;
      return challenge;
    },
    async insertApproval(a, attestationSignature) {
      if (
        s.approvals.some(
          (x) =>
            x.challengeId === a.challengeId ||
            (x.draftDigest === a.draftDigest &&
              (x.memberId === a.memberId || x.signer === a.signer)),
        )
      )
        throw new IdentityError('ALREADY_APPROVED');
      s.approvals.push(a);
      s.attestations.set(a.approvalId, attestationSignature);
    },
    async listApprovals(digest) {
      return s.approvals.filter((a) => a.draftDigest === digest);
    },
    async claimIdempotency(r, staleBefore) {
      const id = `${r.scope}\u0000${r.key}`;
      const existing = s.idempotency.get(id);
      if (
        existing &&
        !(
          existing.state === 'PENDING' &&
          existing.createdAt < staleBefore &&
          existing.requestHash === r.requestHash
        )
      )
        return existing;
      s.idempotency.set(id, r);
      return null;
    },
    async completeIdempotency(scope, key, statusCode, response) {
      const r = s.idempotency.get(`${scope}\u0000${key}`);
      if (r) Object.assign(r, { state: 'DONE', statusCode, response });
    },
    async releaseIdempotency(scope, key) {
      s.idempotency.delete(`${scope}\u0000${key}`);
    },
    async insertDelegationPolicy(p) {
      if (s.delegations.has(p.policyId))
        throw new IdentityError('INVALID_INPUT', 'policy exists');
      s.delegations.set(p.policyId, p);
    },
    async getDelegationPolicy(id) {
      return s.delegations.get(id) ?? null;
    },
    async revokeDelegationPolicy(id, now) {
      const p = s.delegations.get(id);
      if (!p) throw new IdentityError('INVALID_INPUT', 'unknown policy');
      if (p.revokedAt === null) p.revokedAt = now;
    },
    async listDelegationUsage(policyId) {
      return s.usage.filter((u) => u.policyId === policyId);
    },
    async listDelegationPolicies(groupId, delegatePrincipalId) {
      return [...s.delegations.values()].filter(
        (p) =>
          p.groupId === groupId &&
          p.delegatePrincipalId === delegatePrincipalId,
      );
    },
    async getDelegationUsage(usageId) {
      return s.usage.find((u) => u.usageId === usageId) ?? null;
    },
    async revokeDelegationsForMember(groupId, memberId, now) {
      let n = 0;
      for (const p of s.delegations.values())
        if (
          p.groupId === groupId &&
          p.delegatorMemberId === memberId &&
          p.revokedAt === null
        ) {
          p.revokedAt = now;
          n++;
        }
      return n;
    },
    async insertDelegationUsage(u) {
      if (s.usage.some((x) => x.usageId === u.usageId)) return false;
      s.usage.push(u);
      return true;
    },
  };
}
