import { randomUUID, createHash } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import {
  ATTESTATION_KINDS,
  EvidenceSchema,
  attestationTypedData,
  checkEvidence,
  contextFromEnrolled,
  sha256Hex,
  dealLinkToken,
  evidenceHashOf,
  type AttestationKind,
  type DealRoomService,
  type DealView,
  type Party,
  type Role,
} from '@synq/dealroom';
import { z } from 'zod';
import { WorkspaceError } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

import { DraftWorkspaceDealSchema } from './deal-contracts.js';
export { DraftWorkspaceDealSchema } from './deal-contracts.js';
/** Parties select signed-in workspace contacts; the model never chooses wallets. */
export class WorkspaceDeals {
  constructor(
    readonly workspaces: PostgresWorkspaceStore,
    readonly service: DealRoomService,
    private readonly linkKey: Uint8Array,
  ) {
    if (linkKey.length < 32) throw new Error('DEAL_LINK_KEY_TOO_SHORT');
  }
  async contacts(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    return (
      await this.workspaces.pool.query(
        'SELECT principal_id,wallet,role FROM synq_ws_members WHERE workspace_id=$1 ORDER BY joined_at',
        [workspaceId],
      )
    ).rows.map((r) => ({
      principalId: String(r.principal_id),
      walletHint: `${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}`,
      role: String(r.role),
    }));
  }
  private async party(
    workspaceId: string,
    principalId: string,
    role: Role,
  ): Promise<Party> {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role === 'VIEWER')
      throw new WorkspaceError('DEAL_PARTY_ROLE_REQUIRED', 403);
    return {
      principalId,
      role,
      wallet: getAddress(m.wallet),
      displayName: `${role.toLowerCase()} ${m.wallet.slice(0, 6)}…${m.wallet.slice(-4)}`,
      verification: {
        method: 'WALLET_SIGNATURE',
        reference: principalId,
        channel: null,
        channelUserId: null,
        verifiedAt: m.joinedAt,
      },
    };
  }
  private async permitted(
    workspaceId: string,
    principalId: string,
    dealId: string,
  ) {
    await this.workspaces.membership(workspaceId, principalId);
    const view = await this.service.view(dealId);
    if (
      view.deal.workspaceId !== workspaceId ||
      ![
        view.current.terms.client,
        view.current.terms.freelancer,
        view.current.terms.arbiter,
      ].some((p) => p.principalId === principalId)
    )
      throw new WorkspaceError('DEAL_NOT_FOUND', 404);
    return view;
  }
  private view(v: DealView) {
    const t = v.current.terms;
    return {
      id: v.deal.dealId,
      workspaceId: v.deal.workspaceId,
      status: v.deal.status,
      version: v.current.version,
      title: t.title,
      total: String(t.total),
      termsHash: v.current.termsHash,
      parties: [t.client, t.freelancer, t.arbiter].map((p) => ({
        principalId: p.principalId,
        role: p.role,
        wallet: p.wallet,
        label: p.displayName,
      })),
      reviewPath: `/deal/${v.deal.dealId}?t=${dealLinkToken(this.linkKey, v.deal.dealId, { expiresAt: this.workspaces.now() + 900, epoch: v.deal.linkEpoch ?? 0 })}`,
      execution: 'PARTY_WALLET_ESCROW',
      escrow: v.deal.escrow
        ? {
            address: v.deal.escrow.escrow,
            escrowDealId: v.deal.escrow.escrowDealId,
          }
        : null,
      milestones: v.deal.milestones.map((m, i) => ({
        index: i,
        title: t.milestones[i]?.title ?? '',
        amount: String(t.milestones[i]?.amount ?? 0n),
        evidenceType: t.milestones[i]?.evidenceType ?? null,
        status: m.status,
      })),
      dispute: v.deal.dispute
        ? {
            raisedBy: v.deal.dispute.raisedBy,
            deadline: v.deal.dispute.deadline,
          }
        : null,
    };
  }
  async draft(workspaceId: string, principalId: string, raw: unknown) {
    const b = DraftWorkspaceDealSchema.parse(raw);
    await this.workspaces.membership(workspaceId, principalId);
    if (![b.clientId, b.freelancerId].includes(principalId))
      throw new WorkspaceError('CONTRACTING_PARTY_REQUIRED', 403);
    if (new Set([b.clientId, b.freelancerId, b.arbiterId]).size !== 3)
      throw new WorkspaceError('INDEPENDENT_ARBITER_REQUIRED');
    const parties = {
      client: await this.party(workspaceId, b.clientId, 'CLIENT'),
      freelancer: await this.party(workspaceId, b.freelancerId, 'FREELANCER'),
      arbiter: await this.party(workspaceId, b.arbiterId, 'ARBITER'),
    };
    const dealId = `deal_${createHash('sha256').update(`${workspaceId}:${b.idempotencyKey}`).digest('hex').slice(0, 32)}`;
    const old = await this.service.store.get(dealId);
    if (old) {
      const prior = await this.permitted(workspaceId, principalId, dealId);
      if (
        prior.current.terms.client.principalId !== b.clientId ||
        prior.current.terms.freelancer.principalId !== b.freelancerId ||
        prior.current.terms.arbiter.principalId !== b.arbiterId ||
        !Object.values(prior.deal.origin.messages).includes(
          sha256Hex(b.request),
        )
      )
        throw new WorkspaceError('DEAL_IDEMPOTENCY_CONFLICT');
      return this.view(prior);
    }
    const now = this.workspaces.now(),
      messageId = `workspace-request:${randomUUID()}`;
    await this.service.draft({
      workspaceId,
      dealId,
      request: b.request,
      parties,
      reasoner: null,
      context: contextFromEnrolled({
        channel: 'web',
        externalGroupId: workspaceId,
        stored: [],
        invocation: { messageId, principalId, text: b.request, sentAt: now },
      }),
    });
    // Creation may lose a concurrent idempotency race; authorize the persisted winner.
    const saved = await this.permitted(workspaceId, principalId, dealId);
    if (
      saved.current.terms.client.principalId !== b.clientId ||
      saved.current.terms.freelancer.principalId !== b.freelancerId ||
      saved.current.terms.arbiter.principalId !== b.arbiterId ||
      !Object.values(saved.deal.origin.messages).includes(sha256Hex(b.request))
    )
      throw new WorkspaceError('DEAL_IDEMPOTENCY_CONFLICT');
    return this.view(saved);
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const rows = await this.service.store.list(workspaceId),
      views = await Promise.all(rows.map((r) => this.service.view(r.dealId)));
    return views
      .filter((v) =>
        [
          v.current.terms.client,
          v.current.terms.freelancer,
          v.current.terms.arbiter,
        ].some((p) => p.principalId === principalId),
      )
      .map((v) => this.view(v));
  }
  async authorize(workspaceId: string, principalId: string, id: string) {
    await this.permitted(workspaceId, principalId, id);
  }
  async get(workspaceId: string, principalId: string, id: string) {
    return this.view(await this.permitted(workspaceId, principalId, id));
  }
  async sign(
    workspaceId: string,
    principalId: string,
    id: string,
    version: number,
    signature: Hex,
  ) {
    const v = await this.permitted(workspaceId, principalId, id);
    const role =
      v.current.terms.client.principalId === principalId
        ? 'CLIENT'
        : v.current.terms.freelancer.principalId === principalId
          ? 'FREELANCER'
          : null;
    if (!role) throw new WorkspaceError('CONTRACTING_PARTY_REQUIRED', 403);
    return this.view(
      await this.service.sign({ dealId: id, version, role, signature }),
    );
  }
  /** The caller's role in a deal it belongs to, with its verified wallet. */
  async role(workspaceId: string, principalId: string, dealId: string) {
    const view = await this.permitted(workspaceId, principalId, dealId);
    const t = view.current.terms;
    const role: Role =
      t.client.principalId === principalId
        ? 'CLIENT'
        : t.freelancer.principalId === principalId
          ? 'FREELANCER'
          : 'ARBITER';
    const party =
      role === 'CLIENT'
        ? t.client
        : role === 'FREELANCER'
          ? t.freelancer
          : t.arbiter;
    return { view, role, wallet: getAddress(party.wallet) };
  }
  /**
   * The exact milestone statement the caller's wallet signs. The evidence hash
   * is computed here from the claim (never trusted from the client); an
   * acceptance signs over the evidence the payee delivered.
   */
  async attestationRequest(
    workspaceId: string,
    principalId: string,
    dealId: string,
    raw: unknown,
  ) {
    const b = AttestationRequestSchema.parse(raw);
    const { view, role } = await this.role(workspaceId, principalId, dealId);
    const term = view.current.terms.milestones[b.milestone];
    const ms = view.deal.milestones[b.milestone];
    if (!term || !ms) throw new WorkspaceError('MILESTONE_NOT_FOUND', 404);
    const evidenceHash =
      b.kind === 'ACCEPT_RELEASE'
        ? (ms.evidenceHash as Hex)
        : evidenceHashOf(
            b.kind === 'DELIVERED'
              ? {
                  ...checkEvidence(
                    b.evidence
                      ? { ...b.evidence, verifiedBy: null, checkedAt: 0 }
                      : null,
                    term.evidenceType,
                  ),
                  verifiedBy: null,
                  checkedAt: 0,
                }
              : null,
          );
    if (!evidenceHash) throw new WorkspaceError('NOTHING_DELIVERED');
    const nonce = `0x${randomBytes(32).toString('hex')}` as Hex,
      deadline = this.workspaces.now() + 900;
    const typedData = attestationTypedData({
      chainId: view.current.terms.asset.chainId,
      escrow: view.current.terms.escrow,
      dealId,
      version: view.current.version,
      termsHash: view.current.termsHash,
      milestone: b.milestone,
      kind: b.kind,
      role,
      evidenceHash,
      nonce,
      deadline,
    });
    return {
      role,
      nonce,
      deadline,
      evidenceHash,
      typedData: JSON.parse(
        JSON.stringify(typedData, (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ) as unknown,
    };
  }
  async attest(
    workspaceId: string,
    principalId: string,
    dealId: string,
    raw: unknown,
  ) {
    const b = AttestationSchema.parse(raw);
    const { role } = await this.role(workspaceId, principalId, dealId);
    return this.view(
      await this.service.attest({
        dealId,
        milestone: b.milestone,
        kind: b.kind,
        role,
        evidence:
          b.kind === 'DELIVERED' && b.evidence
            ? { ...b.evidence, verifiedBy: null, checkedAt: 0 }
            : null,
        nonce: b.nonce as Hex,
        deadline: b.deadline,
        signature: b.signature as Hex,
      }),
    );
  }
}

const EvidenceClaimSchema = EvidenceSchema.omit({
  verifiedBy: true,
  checkedAt: true,
});
export const AttestationRequestSchema = z.strictObject({
  milestone: z.number().int().min(0).max(31),
  kind: z.enum(
    ATTESTATION_KINDS as unknown as [AttestationKind, ...AttestationKind[]],
  ),
  evidence: EvidenceClaimSchema.nullable().default(null),
});
export const AttestationSchema = AttestationRequestSchema.extend({
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  deadline: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
