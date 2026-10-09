import { recoverTypedDataAddress, type Hex } from 'viem';
import { verifiedAsset } from '@synq/chain-registry';
import {
  GrantApprovalChallengeSchema,
  MemberIdSchema,
  PendingIntentViewSchema,
  QuorumViewSchema,
  SignatureSchema,
  VerifiedApprovalSchema,
  type Asset,
  type GrantApprovalChallenge,
  type GrantDraft,
  type PendingIntentView,
  type QuorumView,
  type VerifiedApproval,
} from '@synq/schemas';
import {
  approvalEligible,
  resolveConfig,
  type IdentityConfig,
  type ResolvedConfig,
} from './config.js';
import { IdentityError } from './errors.js';
import {
  assertDraftConsistent,
  grantPreview,
  grantTypedData,
} from './grant.js';
import { activeMembership, requireGroup } from './membership.js';
import type {
  DraftRecord,
  GroupRecord,
  IdentityStore,
  IdentityTx,
} from './store.js';

const HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface GrantApprovalPort {
  issueChallenge(input: {
    draftDigest: string;
    memberId: string;
  }): Promise<GrantApprovalChallenge>;
  submit(input: {
    challengeId: string;
    signature: string;
  }): Promise<VerifiedApproval>;
  quorum(draftDigest: string): Promise<QuorumView>;
}

export async function recoverGrantSigner(
  draft: GrantDraft,
  rawSignature: string,
): Promise<string> {
  const parsed = SignatureSchema.safeParse(rawSignature);
  if (!parsed.success) throw new IdentityError('SIGNATURE_MISMATCH');
  const signature = parsed.data as Hex;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  if (s > HALF_N || (v !== 27 && v !== 28))
    throw new IdentityError('SIGNATURE_MISMATCH');
  try {
    return (
      await recoverTypedDataAddress({ ...grantTypedData(draft), signature })
    ).toLowerCase();
  } catch {
    throw new IdentityError('SIGNATURE_MISMATCH');
  }
}

export class GrantApprovalGateway implements GrantApprovalPort {
  readonly config: ResolvedConfig;
  constructor(
    readonly store: IdentityStore,
    config: IdentityConfig,
    readonly localAssets: readonly Asset[] = [],
  ) {
    this.config = resolveConfig(config);
  }

  async registerDraft(input: {
    draft: GrantDraft;
    asset: Asset;
  }): Promise<PendingIntentView> {
    const draft = assertDraftConsistent(input.draft);
    let asset: Asset;
    try {
      asset = verifiedAsset(
        input.asset,
        this.config.profile === 'local/anvil' ? this.localAssets : [],
      );
    } catch {
      throw new IdentityError('DRAFT_INVALID', 'asset not in registry');
    }
    grantPreview(draft, asset);
    const record: DraftRecord = { draft, asset, createdAt: this.config.now() };
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, draft.groupId);
      if (
        draft.grant.account !== group.account ||
        draft.domain.chainId !== group.chainId ||
        draft.requiredApprovals < group.threshold ||
        draft.requiredApprovals > group.owners.length
      )
        throw new IdentityError('DRAFT_INVALID', 'group binding');
      await tx.insertDraft(record);
      return this.view(tx, record, group);
    });
  }

  async pendingIntent(intentId: string): Promise<PendingIntentView> {
    return this.store.transaction(async (tx) => {
      const record = await tx.getDraftByIntent(intentId.toLowerCase());
      if (!record) throw new IdentityError('DRAFT_NOT_FOUND');
      return this.view(
        tx,
        record,
        await requireGroup(tx, record.draft.groupId),
      );
    });
  }

  private async view(tx: IdentityTx, record: DraftRecord, group: GroupRecord) {
    const quorum = await this.count(tx, record, group);
    return PendingIntentViewSchema.parse({
      intentId: record.draft.grant.intentHash,
      status: quorum.satisfied ? 'APPROVED' : 'PENDING_APPROVAL',
      draft: record.draft,
      asset: record.asset,
      preview: grantPreview(record.draft, record.asset),
    });
  }

  private async draft(tx: IdentityTx, digest: string): Promise<DraftRecord> {
    const record = await tx.getDraft(digest.toLowerCase());
    if (!record) throw new IdentityError('DRAFT_NOT_FOUND');
    return record;
  }

  async issueChallenge(input: {
    draftDigest: string;
    memberId: string;
  }): Promise<GrantApprovalChallenge> {
    const memberId = MemberIdSchema.safeParse(input.memberId);
    if (!memberId.success) throw new IdentityError('INVALID_INPUT', 'memberId');
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      const { draft } = await this.draft(tx, input.draftDigest);
      if (now >= Number(draft.grant.validUntil))
        throw new IdentityError('CHALLENGE_EXPIRED');
      const group = await requireGroup(tx, draft.groupId);
      const membership = await activeMembership(
        tx,
        group.groupId,
        memberId.data,
      );
      if (!membership) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      const principal = await tx.getPrincipal(membership.principalId);
      if (
        membership.role !== 'APPROVER' ||
        !principal ||
        principal.status !== 'ACTIVE' ||
        !approvalEligible(principal.kind, this.config.profile)
      )
        throw new IdentityError('PRINCIPAL_NOT_ELIGIBLE');
      if (!group.owners.includes(principal.signer))
        throw new IdentityError('NOT_SAFE_OWNER');
      const approved = (await tx.listApprovals(draft.digest)).some(
        (a) =>
          a.membershipEpoch === group.membershipEpoch &&
          (a.memberId === membership.memberId || a.signer === principal.signer),
      );
      if (approved) throw new IdentityError('ALREADY_APPROVED');
      const challenge = GrantApprovalChallengeSchema.parse({
        schemaVersion: 1,
        challengeId: this.config.randomId(),
        groupId: group.groupId,
        memberId: membership.memberId,
        principalId: principal.principalId,
        principalKind: principal.kind,
        signer: principal.signer,
        draftDigest: draft.digest,
        membershipEpoch: group.membershipEpoch,
        issuedAt: now,
        expiresAt: Math.min(
          now + this.config.challengeTtlSeconds,
          Number(draft.grant.validUntil),
        ),
      });
      await tx.insertGrantChallenge(challenge);
      return challenge;
    });
  }

  async submit(input: {
    challengeId: string;
    signature: string;
  }): Promise<VerifiedApproval> {
    const now = this.config.now();
    const stored = await this.store.transaction(async (tx) => {
      const row = await tx.getGrantChallenge(input.challengeId);
      if (!row) throw new IdentityError('CHALLENGE_NOT_FOUND');
      return { row, record: await this.draft(tx, row.challenge.draftDigest) };
    });
    const { challenge } = stored.row;
    const draft = assertDraftConsistent(stored.record.draft);
    if ((await recoverGrantSigner(draft, input.signature)) !== challenge.signer)
      throw new IdentityError('SIGNATURE_MISMATCH');
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, challenge.groupId, 'SHARE');
      const c = await tx.consumeGrantChallenge(input.challengeId, now);
      if (group.membershipEpoch !== c.membershipEpoch)
        throw new IdentityError('MEMBERSHIP_CHANGED');
      const membership = await activeMembership(tx, group.groupId, c.memberId);
      const principal = membership
        ? await tx.getPrincipal(membership.principalId)
        : null;
      if (
        !membership ||
        !principal ||
        membership.principalId !== c.principalId ||
        membership.role !== 'APPROVER' ||
        principal.signer !== c.signer ||
        principal.kind !== c.principalKind ||
        !approvalEligible(principal.kind, this.config.profile) ||
        !group.owners.includes(principal.signer)
      )
        throw new IdentityError('MEMBERSHIP_CHANGED');
      const approval = VerifiedApprovalSchema.parse({
        schemaVersion: 1,
        approvalId: this.config.randomId(),
        challengeId: c.challengeId,
        groupId: c.groupId,
        memberId: c.memberId,
        principalId: c.principalId,
        principalKind: c.principalKind,
        signer: c.signer,
        draftDigest: c.draftDigest,
        signature: input.signature,
        membershipEpoch: c.membershipEpoch,
        verifiedAt: now,
      });
      await tx.insertApproval(approval);
      return approval;
    });
  }

  async quorum(draftDigest: string): Promise<QuorumView> {
    return this.store.transaction(async (tx) => {
      const record = await this.draft(tx, draftDigest);
      return this.count(
        tx,
        record,
        await requireGroup(tx, record.draft.groupId),
      );
    });
  }

  private async count(
    tx: IdentityTx,
    record: DraftRecord,
    group: GroupRecord,
  ): Promise<QuorumView> {
    const memberships = (await tx.listMemberships(group.groupId)).filter(
      (m) => m.status === 'ACTIVE',
    );
    const members = new Set<string>(),
      signers = new Set<string>();
    const counted: VerifiedApproval[] = [];
    for (const a of await tx.listApprovals(record.draft.digest)) {
      const m = memberships.find((x) => x.memberId === a.memberId);
      if (
        a.membershipEpoch !== group.membershipEpoch ||
        !m ||
        m.role !== 'APPROVER' ||
        m.principalId !== a.principalId ||
        m.signer !== a.signer ||
        !approvalEligible(a.principalKind, this.config.profile) ||
        !group.owners.includes(a.signer) ||
        members.has(a.memberId) ||
        signers.has(a.signer) ||
        (await recoverGrantSigner(record.draft, a.signature).catch(
          () => '',
        )) !== a.signer
      )
        continue;
      members.add(a.memberId);
      signers.add(a.signer);
      counted.push(a);
    }
    return QuorumViewSchema.parse({
      draftDigest: record.draft.digest,
      groupId: group.groupId,
      required: record.draft.requiredApprovals,
      membershipEpoch: group.membershipEpoch,
      counted,
      satisfied: counted.length >= record.draft.requiredApprovals,
    });
  }
}
