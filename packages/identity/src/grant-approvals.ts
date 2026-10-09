import { recoverTypedDataAddress, type Hex } from 'viem';
import { verifiedAsset } from '@synq/chain-registry';
import {
  AddressSchema,
  ApprovalChallengeRequestSchema,
  GrantApprovalChallengeSchema,
  GrantApprovalSubmissionSchema,
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
  approvalAttestationTypedData,
  assertDraftConsistent,
  challengeRequestTypedData,
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
export const CHALLENGE_REQUEST_SKEW_SECONDS = 120;

export type ChallengeRequestInput = {
  draftDigest: string;
  memberId: string;
  principalId: string;
  requestedAt: number;
  requestSignature: string;
};

export interface GrantApprovalPort {
  issueChallenge(
    request: ChallengeRequestInput,
  ): Promise<GrantApprovalChallenge>;
  submit(input: {
    challengeId: string;
    grantSignature: string;
    attestationSignature: string;
  }): Promise<VerifiedApproval>;
  quorum(draftDigest: string): Promise<QuorumView>;
}

function canonicalSignature(raw: string): Hex {
  const parsed = SignatureSchema.safeParse(raw);
  if (!parsed.success) throw new IdentityError('SIGNATURE_MISMATCH');
  const signature = parsed.data.toLowerCase() as Hex;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  if (s > HALF_N || (v !== 27 && v !== 28))
    throw new IdentityError('SIGNATURE_MISMATCH');
  return signature;
}

async function recoverTyped(
  typed: Parameters<typeof recoverTypedDataAddress>[0],
): Promise<string> {
  try {
    return (await recoverTypedDataAddress(typed)).toLowerCase();
  } catch {
    throw new IdentityError('SIGNATURE_MISMATCH');
  }
}

export async function recoverGrantSigner(
  draft: GrantDraft,
  rawSignature: string,
): Promise<string> {
  return recoverTyped({
    ...grantTypedData(draft),
    signature: canonicalSignature(rawSignature),
  });
}

export type GrantApprovalOptions = {
  executionModules: Readonly<Record<number, string>>;
  localAssets?: readonly Asset[];
};

export class GrantApprovalGateway implements GrantApprovalPort {
  readonly config: ResolvedConfig;
  private readonly modules: ReadonlyMap<number, string>;
  constructor(
    readonly store: IdentityStore,
    config: IdentityConfig,
    readonly options: GrantApprovalOptions,
  ) {
    this.config = resolveConfig(config);
    this.modules = new Map(
      Object.entries(options.executionModules).map(([chain, address]) => [
        Number(chain),
        AddressSchema.parse(address),
      ]),
    );
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
        this.config.profile === 'local/anvil'
          ? (this.options.localAssets ?? [])
          : [],
      );
    } catch {
      throw new IdentityError('DRAFT_INVALID', 'asset not in registry');
    }
    grantPreview(draft, asset);
    const module = this.modules.get(draft.domain.chainId);
    if (!module || draft.domain.verifyingContract !== module)
      throw new IdentityError('DRAFT_INVALID', 'verifying contract');
    const record: DraftRecord = {
      draft,
      asset,
      status: 'PENDING',
      createdAt: this.config.now(),
    };
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, draft.groupId);
      if (
        draft.grant.groupId !== group.groupId ||
        draft.grant.account !== group.account ||
        draft.domain.chainId !== group.chainId ||
        (group.executors.length > 0 &&
          !group.executors.includes(draft.grant.executor)) ||
        group.owners.includes(draft.grant.executor) ||
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
      status:
        record.status === 'INVALIDATED'
          ? 'INVALIDATED'
          : quorum.satisfied
            ? 'APPROVED'
            : 'PENDING_APPROVAL',
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

  async issueChallenge(
    raw: ChallengeRequestInput,
  ): Promise<GrantApprovalChallenge> {
    const parsed = ApprovalChallengeRequestSchema.safeParse(raw);
    if (!parsed.success) throw new IdentityError('INVALID_INPUT', 'request');
    const request = parsed.data;
    const now = this.config.now();
    if (Math.abs(now - request.requestedAt) > CHALLENGE_REQUEST_SKEW_SECONDS)
      throw new IdentityError('CHALLENGE_EXPIRED', 'request time');
    const { draft, status } = await this.store.transaction((tx) =>
      this.draft(tx, request.draftDigest),
    );
    if (status !== 'PENDING') throw new IdentityError('DRAFT_INVALIDATED');
    const requester = await recoverTyped({
      ...challengeRequestTypedData(draft, request),
      signature: canonicalSignature(request.requestSignature),
    });
    return this.store.transaction(async (tx) => {
      const current = await this.draft(tx, draft.digest);
      if (current.status !== 'PENDING')
        throw new IdentityError('DRAFT_INVALIDATED');
      if (now >= Number(draft.grant.validUntil))
        throw new IdentityError('CHALLENGE_EXPIRED');
      const group = await requireGroup(tx, draft.groupId);
      const membership = await activeMembership(
        tx,
        group.groupId,
        request.memberId,
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
      if (
        principal.principalId !== request.principalId ||
        requester !== principal.signer
      )
        throw new IdentityError('SIGNATURE_MISMATCH');
      if (!group.owners.includes(principal.signer))
        throw new IdentityError('NOT_SAFE_OWNER');
      const approved = (await tx.listApprovals(draft.digest)).some(
        (a) =>
          a.memberId === membership.memberId || a.signer === principal.signer,
      );
      if (approved) throw new IdentityError('ALREADY_APPROVED');
      const challenge = GrantApprovalChallengeSchema.parse({
        schemaVersion: 1,
        challengeId: this.config.randomNonce(),
        challengeNonce: this.config.randomNonce(),
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

  async submit(raw: {
    challengeId: string;
    grantSignature: string;
    attestationSignature: string;
  }): Promise<VerifiedApproval> {
    const parsed = GrantApprovalSubmissionSchema.safeParse(raw);
    if (!parsed.success) throw new IdentityError('SIGNATURE_MISMATCH');
    const input = parsed.data;
    const now = this.config.now();
    const stored = await this.store.transaction(async (tx) => {
      const row = await tx.getGrantChallenge(input.challengeId);
      if (!row) throw new IdentityError('CHALLENGE_NOT_FOUND');
      return {
        row,
        record: await this.draft(tx, row.challenge.draftDigest),
      };
    });
    const { challenge } = stored.row;
    const draft = assertDraftConsistent(stored.record.draft);
    const grantSignature = canonicalSignature(input.grantSignature);
    const attestationSignature = canonicalSignature(input.attestationSignature);
    const [grantSigner, attestationSigner] = await Promise.all([
      recoverTyped({ ...grantTypedData(draft), signature: grantSignature }),
      recoverTyped({
        ...approvalAttestationTypedData(draft, challenge),
        signature: attestationSignature,
      }),
    ]);
    if (
      grantSigner !== challenge.signer ||
      attestationSigner !== challenge.signer
    )
      throw new IdentityError('SIGNATURE_MISMATCH');
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, challenge.groupId, 'SHARE');
      if ((await this.draft(tx, draft.digest)).status !== 'PENDING')
        throw new IdentityError('DRAFT_INVALIDATED');
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
        principal.status !== 'ACTIVE' ||
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
        signature: grantSignature,
        membershipEpoch: c.membershipEpoch,
        verifiedAt: now,
      });
      await tx.insertApproval(approval, attestationSignature);
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
    if (record.status === 'PENDING')
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
      draftStatus: record.status,
      required: record.draft.requiredApprovals,
      membershipEpoch: group.membershipEpoch,
      counted,
      satisfied:
        record.status === 'PENDING' &&
        counted.length >= record.draft.requiredApprovals,
    });
  }
}
