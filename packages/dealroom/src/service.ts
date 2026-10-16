import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import {
  decide,
  type AuthorityConfig,
  type Decision as KernelDecision,
  type MandateState,
  type OwnerApproval,
  type PaymentIntent,
  type PaymentMandate,
  type RiskInput,
} from '@synq/kernel/arc';
import {
  escrowIntent,
  type EscrowCall,
  type EscrowOpenCall,
  type EscrowRefundCall,
  type EscrowReleaseCall,
} from '@synq/kernel/arc-escrow';
import { assetKey } from '@synq/domain';
import { arcGasEntry, type JournalEntry, type Ledger } from '@synq/ledger';
import {
  DealRoomError,
  EvidenceSchema,
  TermsSchema,
  termKeys,
  type Attestation,
  type AttestationKind,
  type Deal,
  type DealAsset,
  type DealSignature,
  type DealStatus,
  type DealVersion,
  type Evidence,
  type MilestoneState,
  type Party,
  type PartyRole,
  type Provenance,
  type Role,
  type Terms,
  type TermsInput,
  type Transition,
} from './schema.js';
import {
  canonical,
  attestationTypedData,
  dealDecisionTypedData,
  dealTermsTypedData,
  evidenceHashOf,
  provenanceHash,
  recoverSigner,
  termsHashOf,
} from './typed-data.js';
import {
  checkProvenanceAgainstOrigin,
  originOf,
  type AuthorizedContext,
} from './context.js';
import { draftTerms, type DraftSettings } from './draft.js';
import {
  ATTESTATION_RULES,
  POST_FUNDING,
  PRE_FUNDING,
  assertFundable,
  assertTransition,
  dealStatusFromMilestones,
  otherParty,
} from './rules.js';
import type { DealRoomStore } from './store.js';
import {
  escrowFundingEntry,
  escrowRefundEntry,
  escrowReleaseEntry,
  type DealBooks,
} from './ledger.js';
import type { StructuredReasoner } from '@synq/agent-runtime';

/**
 * Deal Room: conversation -> versioned agreement -> both parties sign ->
 * Kernel-granted escrow funding -> evidence + human attestation -> release
 * exactly once; a disputed milestone cannot be released by the payer path;
 * refunds go only to the funder named in the signed terms.
 *
 * Nothing here signs or broadcasts. Every human decision arrives as an
 * EIP-712 signature that is recovered and compared with the party's verified
 * wallet in the signed terms; chat text never reaches these methods. Escrow
 * calls are produced only from the exact signed version and are handed to the
 * Kernel (`decide`) and then to the restricted executor.
 */

export type DealRoomConfig = Readonly<{
  now: () => number;
  chainName: 'arc-testnet' | 'arc-mainnet';
  asset: DealAsset;
  escrow: Address;
  settings: DraftSettings;
  newId?: () => string;
  /** When set, chain effects are posted to these books (idempotent per log). */
  books?: { ledger: Ledger; workspaceId: string } | null;
}>;

export type DealView = Readonly<{
  deal: Deal;
  current: DealVersion;
  versions: readonly DealVersion[];
  signatures: readonly DealSignature[];
  attestations: readonly Attestation[];
  transitions: readonly Transition[];
}>;

/** What the executor reports back; structural so this package needs no signer code. */
export type ExecutionRecord = Readonly<{
  escrowDealId: bigint;
  txs: readonly { label: string; hash: Hex; from: Address; feeWei: bigint }[];
  transfers: readonly {
    from: Address;
    to: Address;
    value: bigint;
    logIndex: number;
    hash: Hex;
  }[];
}>;

/** On-chain escrow deal as read back after funding. */
export type ChainEscrowDeal = Readonly<{
  token: Address;
  payer: Address;
  payee: Address;
  arbiter: Address;
  refundAfter: bigint;
  termsHash: Hex;
  milestones: readonly { amount: bigint; status: string }[];
}>;

export type KernelInputs = Readonly<{
  config: AuthorityConfig;
  mandate: PaymentMandate;
  mandateSignature: Hex;
  state: MandateState;
  risk: RiskInput;
  simulationOk: boolean;
  ownerApproval?: OwnerApproval;
  requireOwnerApproval?: boolean;
}>;

const lower = (a: string) => a.toLowerCase();
const partyKey = {
  CLIENT: 'client',
  FREELANCER: 'freelancer',
  ARBITER: 'arbiter',
} as const;
export const partyOf = (t: Terms, role: Role): Party => t[partyKey[role]];

export class DealRoomService {
  constructor(
    readonly store: DealRoomStore,
    readonly config: DealRoomConfig,
  ) {}

  private now() {
    return this.config.now();
  }
  private expected() {
    return {
      token: this.config.asset.token,
      chainId: this.config.asset.chainId,
      escrow: this.config.escrow,
    };
  }
  private id() {
    return this.config.newId?.() ?? `deal_${randomBytes(8).toString('hex')}`;
  }

  // ---------------------------------------------------------------- reads

  async view(dealId: string): Promise<DealView> {
    const deal = await this.store.get(dealId);
    if (!deal) throw new DealRoomError('NOT_FOUND', dealId);
    const [versions, signatures, attestations, transitions] = await Promise.all(
      [
        this.store.versions(dealId),
        this.store.signatures(dealId),
        this.store.attestations(dealId),
        this.store.transitions(dealId),
      ],
    );
    const current = versions.find((v) => v.version === deal.currentVersion);
    if (!current)
      throw new DealRoomError('NOT_FOUND', `${dealId} v${deal.currentVersion}`);
    return { deal, current, versions, signatures, attestations, transitions };
  }

  /** The EIP-712 message a party signs to accept `version` (shown in full by the wallet). */
  typedData(v: DealVersion) {
    return dealTermsTypedData({
      dealId: v.dealId,
      version: v.version,
      parentTermsHash: v.parentTermsHash,
      terms: v.terms,
      provenanceHash: v.provenanceHash,
    });
  }

  /**
   * Every term with its provenance kinds, kept distinct: cited messages and
   * model interpretation (static), each party's signature on this version
   * (HUMAN_CONFIRMED), and EXECUTABLE_AUTHORIZATION once both signed and,
   * separately, once the Kernel granted the escrow funding.
   */
  provenance(
    view: DealView,
    version = view.current,
  ): Record<string, Provenance[]> {
    const signed = acceptsFor(view.signatures, version);
    const both = signed.CLIENT && signed.FREELANCER;
    const out: Record<string, Provenance[]> = {};
    for (const k of termKeys(version.terms)) {
      const list: Provenance[] = [...(version.provenance[k] ?? [])];
      for (const role of ['CLIENT', 'FREELANCER'] as const)
        if (signed[role])
          list.push({
            kind: 'HUMAN_CONFIRMED',
            role,
            wallet: partyOf(version.terms, role).wallet,
            version: version.version,
            how: 'SIGNED',
          });
      if (both)
        list.push({
          kind: 'EXECUTABLE_AUTHORIZATION',
          what: 'BOTH_PARTIES_SIGNED',
          ref: version.termsHash,
        });
      if (
        both &&
        view.deal.funding &&
        version.version === view.deal.currentVersion
      )
        list.push({
          kind: 'EXECUTABLE_AUTHORIZATION',
          what: 'KERNEL_GRANT',
          ref: view.deal.funding.grantId,
        });
      out[k] = list;
    }
    return out;
  }

  // ---------------------------------------------------------------- drafting

  /** Version 1 from the authorized context. Participants must already be verified. */
  async draft(input: {
    workspaceId: string;
    context: AuthorizedContext;
    request: string;
    parties: { client: Party; freelancer: Party; arbiter: Party };
    reasoner: StructuredReasoner | null;
    fixtureKey?: string;
    dealId?: string;
  }): Promise<DealView> {
    for (const p of Object.values(input.parties))
      if (!p.verification?.reference)
        throw new DealRoomError(
          'PARTY_NOT_VERIFIED',
          `${p.role} has no verified wallet link`,
        );
    const now = this.now();
    const drafted = await draftTerms({
      context: input.context,
      request: input.request,
      parties: input.parties,
      asset: this.config.asset,
      escrow: this.config.escrow,
      now,
      settings: this.config.settings,
      reasoner: input.reasoner,
      ...(input.fixtureKey ? { fixtureKey: input.fixtureKey } : {}),
    });
    const terms = TermsSchema.parse(drafted.terms);
    const origin = originOf(input.context);
    checkProvenanceAgainstOrigin(origin, drafted.provenance);
    const dealId = input.dealId ?? this.id();
    const version = makeVersion({
      dealId,
      version: 1,
      parent: null,
      terms,
      provenance: drafted.provenance,
      proposedBy: 'SYNQ_DRAFT',
      ambiguities: drafted.ambiguities,
      at: now,
    });
    const deal: Deal = {
      dealId,
      workspaceId: input.workspaceId,
      status: 'DRAFT',
      currentVersion: 1,
      rev: 1,
      origin,
      funding: null,
      escrow: null,
      milestones: terms.milestones.map((m) => ({
        index: m.index,
        status: 'PENDING',
        evidenceHash: null,
        authorizedBy: null,
        txs: [],
      })),
      dispute: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create({
      deal,
      version,
      transition: {
        dealId,
        idempotencyKey: 'drafted',
        kind: 'DRAFTED',
        from: null,
        to: 'DRAFT',
        actor: `synq:${drafted.interpretation.mode.toLowerCase()}`,
        payload: {
          termsHash: version.termsHash,
          contextDigest: origin.contextDigest,
          source: origin.source,
          ambiguities: version.ambiguities,
        },
        at: now,
      },
    });
    return this.view(dealId);
  }

  // ---------------------------------------------------------------- negotiation

  /**
   * The version a counteroffer would create (with its provenance and terms
   * hash), so the proposer's wallet can sign exactly it. Nothing is stored.
   */
  async prepareCounteroffer(input: {
    dealId: string;
    baseVersion: number;
    by: PartyRole;
    terms: TermsInput;
  }): Promise<{
    view: DealView;
    version: DealVersion;
    typedData: ReturnType<DealRoomService['typedData']>;
  }> {
    const view = await this.view(input.dealId);
    const { deal, current } = view;
    if (!PRE_FUNDING.includes(deal.status))
      throw new DealRoomError(
        'WRONG_STATE',
        `cannot amend a ${deal.status} deal; terms are on chain`,
      );
    if (input.baseVersion !== current.version)
      throw new DealRoomError(
        'STALE_VERSION',
        `current version is ${current.version}`,
      );
    this.notExpired(current.terms);
    const terms = TermsSchema.parse(input.terms);
    for (const role of ['CLIENT', 'FREELANCER', 'ARBITER'] as const)
      if (
        canonical(partyOf(terms, role)) !==
        canonical(partyOf(current.terms, role))
      )
        throw new DealRoomError(
          'PARTY_NOT_VERIFIED',
          `${role} cannot be changed by a counteroffer`,
        );
    if (
      canonical(terms.asset) !== canonical(current.terms.asset) ||
      lower(terms.escrow) !== lower(current.terms.escrow)
    )
      throw new DealRoomError(
        'INVALID_TERMS',
        'asset and escrow cannot change',
      );
    assertFundable(terms, this.expected());
    const next = current.version + 1;
    const proposer = partyOf(terms, input.by);
    const provenance: Record<string, Provenance[]> = {};
    for (const k of termKeys(terms)) {
      const same =
        canonical(termValue(terms, k)) ===
        canonical(termValue(current.terms, k));
      provenance[k] = same
        ? [...(current.provenance[k] ?? [])]
        : [
            {
              kind: 'HUMAN_CONFIRMED',
              role: input.by,
              wallet: proposer.wallet,
              version: next,
              how: 'PROPOSED',
            },
          ];
    }
    const version = makeVersion({
      dealId: deal.dealId,
      version: next,
      parent: current.termsHash,
      terms,
      provenance,
      proposedBy: input.by,
      ambiguities: [],
      at: this.now(),
    });
    return { view, version, typedData: this.typedData(version) };
  }

  /**
   * A party's counteroffer: a new immutable version, signed (ACCEPT) by its
   * proposer. Every earlier signature is for another terms hash, so the
   * other party's approval is required again (P13-03). Parties, asset and
   * escrow cannot change; changed terms lose their message/model provenance
   * and are HUMAN_CONFIRMED by the proposer.
   */
  async counteroffer(input: {
    dealId: string;
    baseVersion: number;
    by: PartyRole;
    terms: TermsInput;
    signature: Hex;
  }): Promise<DealView> {
    const { view, version } = await this.prepareCounteroffer(input);
    const current = view.current;
    const next = version.version;
    await this.recoverAccept(version, input.by, input.signature);
    const signature = this.sig(
      version,
      input.by,
      'ACCEPT',
      '',
      input.signature,
    );
    return this.apply(view, {
      kind: 'COUNTEROFFER',
      key: `counteroffer:v${next}`,
      to: 'NEGOTIATING',
      actor: input.by,
      payload: { termsHash: version.termsHash, parent: current.termsHash },
      patch: { currentVersion: next, funding: null },
      version,
      signature,
    });
  }

  /** A party accepts the current version by signing its DealTerms. Both: ACCEPTED. */
  async sign(input: {
    dealId: string;
    version: number;
    role: PartyRole;
    signature: Hex;
  }): Promise<DealView> {
    const view = await this.view(input.dealId);
    const { deal, current } = view;
    if (!PRE_FUNDING.includes(deal.status))
      throw new DealRoomError('WRONG_STATE', `deal is ${deal.status}`);
    if (input.version !== current.version)
      throw new DealRoomError(
        'STALE_VERSION',
        `v${input.version} is not the current version v${current.version}`,
      );
    this.notExpired(current.terms);
    await this.recoverAccept(current, input.role, input.signature);
    if (rejectedBy(view.signatures, current, input.role))
      throw new DealRoomError(
        'COUNTERPARTY_REJECTED',
        `${input.role} already rejected v${current.version}`,
      );
    const signature = this.sig(
      current,
      input.role,
      'ACCEPT',
      '',
      input.signature,
    );
    const accepted = acceptsFor([...view.signatures, signature], current);
    const both =
      accepted.CLIENT &&
      accepted.FREELANCER &&
      !anyRejection(view.signatures, current);
    return this.apply(view, {
      kind: 'SIGNED',
      key: `sign:v${current.version}:${input.role}:ACCEPT`,
      to: both ? 'ACCEPTED' : 'NEGOTIATING',
      actor: input.role,
      payload: { termsHash: current.termsHash, signer: signature.signer },
      signature,
    });
  }

  /**
   * A party's signed REJECT (the version can no longer be funded; P13-02) or
   * CANCEL (the deal ends; only before funding).
   */
  async decline(input: {
    dealId: string;
    version: number;
    role: PartyRole;
    decision: 'REJECT' | 'CANCEL';
    reason: string;
    signature: Hex;
  }): Promise<DealView> {
    const view = await this.view(input.dealId);
    const { deal, current } = view;
    if (!PRE_FUNDING.includes(deal.status))
      throw new DealRoomError('WRONG_STATE', `deal is ${deal.status}`);
    if (input.version !== current.version)
      throw new DealRoomError(
        'STALE_VERSION',
        `current version is ${current.version}`,
      );
    const reason = input.reason.slice(0, 500);
    const signer = await recoverSigner({
      ...dealDecisionTypedData({
        chainId: current.terms.asset.chainId,
        escrow: current.terms.escrow,
        dealId: deal.dealId,
        version: current.version,
        termsHash: current.termsHash,
        role: input.role,
        decision: input.decision,
        reason,
      }),
      signature: input.signature,
    });
    this.mustBe(current.terms, input.role, signer);
    const signature = this.sig(
      current,
      input.role,
      input.decision,
      reason,
      input.signature,
    );
    return this.apply(view, {
      kind: input.decision === 'CANCEL' ? 'CANCELLED' : 'REJECTED',
      key: `sign:v${current.version}:${input.role}:${input.decision}`,
      to: input.decision === 'CANCEL' ? 'CANCELLED' : 'NEGOTIATING',
      actor: input.role,
      payload: { termsHash: current.termsHash, reason },
      signature,
    });
  }

  /** Marks an unfunded deal whose offer lapsed. */
  async expire(dealId: string): Promise<DealView> {
    const view = await this.view(dealId);
    if (!PRE_FUNDING.includes(view.deal.status)) return view;
    if (this.now() < view.current.terms.expiresAt)
      throw new DealRoomError('WRONG_STATE', 'offer has not expired');
    return this.apply(view, {
      kind: 'EXPIRED',
      key: 'expired',
      to: 'EXPIRED',
      actor: 'synq:clock',
      payload: {},
    });
  }

  // ---------------------------------------------------------------- funding

  /**
   * The exact escrow `open` for the current version. Refused unless both
   * parties' ACCEPT signatures on this version recover to their verified
   * wallets, neither rejected it, the offer is live and the terms are
   * fundable on the registry escrow (P13-02, P13-03).
   */
  async fundingCall(
    dealId: string,
  ): Promise<{ call: EscrowOpenCall; view: DealView }> {
    const view = await this.view(dealId);
    const { deal, current } = view;
    if (!PRE_FUNDING.includes(deal.status))
      throw new DealRoomError('WRONG_STATE', `deal is ${deal.status}`);
    if (anyRejection(view.signatures, current))
      throw new DealRoomError(
        'COUNTERPARTY_REJECTED',
        `v${current.version} was rejected; no funding mandate can be issued`,
      );
    if (deal.status !== 'ACCEPTED')
      throw new DealRoomError(
        deal.status === 'NEGOTIATING' || deal.status === 'DRAFT'
          ? 'NOT_FULLY_SIGNED'
          : 'WRONG_STATE',
        `deal is ${deal.status}`,
      );
    this.notExpired(current.terms);
    const accepted = acceptsFor(view.signatures, current);
    if (!accepted.CLIENT || !accepted.FREELANCER)
      throw new DealRoomError(
        'NOT_FULLY_SIGNED',
        `v${current.version} lacks a party signature`,
      );
    // Re-verify cryptographically: stored rows are not trusted on their own.
    for (const role of ['CLIENT', 'FREELANCER'] as const)
      await this.recoverAccept(current, role, accepted[role]!.signature);
    assertFundable(current.terms, this.expected());
    const t = current.terms;
    return {
      view,
      call: {
        op: 'OPEN',
        chainId: t.asset.chainId,
        escrow: t.escrow,
        token: t.asset.token,
        sender: t.client.wallet,
        termsHash: current.termsHash,
        payee: t.freelancer.wallet,
        arbiter: t.arbiter.wallet,
        refundAfter: t.refundAfter,
        amounts: t.milestones.map((m) => m.amount),
      },
    };
  }

  /** Kernel decision for one escrow call (funding, release or refund). */
  async authorize(
    call: EscrowCall,
    meta: { obligationRef: string; evidenceHash: Hex; proposedBy: string },
    k: KernelInputs,
  ): Promise<{ decision: KernelDecision; intent: PaymentIntent }> {
    const intent = escrowIntent(call, {
      mandateId: k.mandate.mandateId,
      mandateVersion: k.mandate.version,
      ...meta,
    });
    const decision = await decide({
      config: k.config,
      mandate: k.mandate,
      mandateSignature: k.mandateSignature,
      state: k.state,
      intent,
      risk: k.risk,
      simulationOk: k.simulationOk,
      now: this.now(),
      ...(k.ownerApproval ? { ownerApproval: k.ownerApproval } : {}),
      ...(k.requireOwnerApproval ? { requireOwnerApproval: true } : {}),
    });
    return { decision, intent };
  }

  /** Funding: Kernel decision under the client's mandate; an ALLOW moves the deal to FUNDING. */
  async authorizeFunding(dealId: string, k: KernelInputs) {
    const { call, view } = await this.fundingCall(dealId);
    if (lower(k.mandate.owner) !== lower(view.current.terms.client.wallet))
      throw new DealRoomError(
        'WRONG_SIGNER',
        'funding mandate must be the client’s',
      );
    const r = await this.authorize(
      call,
      {
        obligationRef: `deal:${dealId}:fund:v${view.current.version}`,
        evidenceHash: view.current.termsHash,
        proposedBy: 'dealroom',
      },
      k,
    );
    if (r.decision.outcome === 'ALLOW')
      await this.apply(view, {
        kind: 'FUNDING_GRANTED',
        key: `fund:v${view.current.version}:${r.decision.grant.grantId}`,
        to: 'FUNDING',
        actor: 'kernel',
        payload: {
          intentId: r.intent.intentId,
          grantId: r.decision.grant.grantId,
        },
        patch: {
          funding: {
            intentId: r.intent.intentId,
            grantId: r.decision.grant.grantId,
          },
        },
      });
    return { ...r, call };
  }

  /** The executor failed before funding landed: back to ACCEPTED, a new grant is needed. */
  async fundingFailed(dealId: string, reason: string) {
    const view = await this.view(dealId);
    if (view.deal.status !== 'FUNDING') return view;
    return this.apply(view, {
      kind: 'FUNDING_FAILED',
      key: `fundfail:${view.deal.funding?.grantId ?? 'none'}`,
      to: 'ACCEPTED',
      actor: 'executor',
      payload: { reason: reason.slice(0, 300) },
      patch: { funding: null },
    });
  }

  /**
   * Funding confirmed only when chain state equals the signed agreement
   * (P13-04): registry asset, payer = client, payee, arbiter, refund time,
   * terms hash, per-milestone amounts all Funded, and exactly the total moved
   * client -> escrow.
   */
  async recordFunded(input: {
    dealId: string;
    execution: ExecutionRecord;
    chain: ChainEscrowDeal;
  }) {
    const view = await this.view(input.dealId);
    if (view.deal.status !== 'FUNDING')
      throw new DealRoomError('WRONG_STATE', `deal is ${view.deal.status}`);
    const t = view.current.terms;
    const problems = fundingMismatches(
      t,
      view.current.termsHash,
      input.chain,
      input.execution,
    );
    if (problems.length)
      throw new DealRoomError('FUNDING_MISMATCH', problems.join('; '));
    const fundingTxs = input.execution.txs.map((x) => x.hash);
    const out = await this.apply(view, {
      kind: 'FUNDED',
      key: `funded:${input.execution.escrowDealId}`,
      to: 'FUNDED',
      actor: 'chain',
      payload: {
        escrowDealId: String(input.execution.escrowDealId),
        txs: fundingTxs,
      },
      patch: {
        escrow: {
          escrow: t.escrow,
          escrowDealId: String(input.execution.escrowDealId),
          termsHash: view.current.termsHash,
          fundingTxs,
          fundedAt: this.now(),
        },
        milestones: view.deal.milestones.map((m) => ({
          ...m,
          status: 'FUNDED' as const,
        })),
      },
    });
    const transfer = input.execution.transfers.find(
      (x) =>
        lower(x.from) === lower(t.client.wallet) &&
        lower(x.to) === lower(t.escrow),
    )!;
    await this.book(view, input.execution, (b) =>
      escrowFundingEntry(b, {
        txHash: transfer.hash,
        logIndex: transfer.logIndex,
        amount: transfer.value,
        at: this.now(),
      }),
    );
    return out;
  }

  // ---------------------------------------------------------------- milestones

  /**
   * A signed human statement about one milestone. DELIVERED (freelancer, with
   * evidence of the agreed type), ACCEPT_RELEASE (client, over the delivered
   * evidence hash), DISPUTE (either party), ARBITER_RELEASE / ARBITER_REFUND
   * (arbiter, only for a disputed milestone), CANCEL_REFUND (the payee gives
   * the milestone back to the funder). Each nonce works once and each kind
   * once per milestone.
   */
  async attest(input: {
    dealId: string;
    milestone: number;
    kind: AttestationKind;
    role: Role;
    evidence: Evidence | null;
    nonce: Hex;
    deadline: number;
    signature: Hex;
  }): Promise<DealView> {
    const view = await this.view(input.dealId);
    const { deal, current } = view;
    if (!POST_FUNDING.includes(deal.status) || !deal.escrow)
      throw new DealRoomError('WRONG_STATE', `deal is ${deal.status}`);
    const rule = ATTESTATION_RULES[input.kind];
    if (!rule.by.includes(input.role))
      throw new DealRoomError(
        'WRONG_SIGNER',
        `${input.role} cannot attest ${input.kind}`,
      );
    const ms = deal.milestones[input.milestone];
    const term = current.terms.milestones[input.milestone];
    if (!ms || !term)
      throw new DealRoomError('NOT_FOUND', `milestone ${input.milestone}`);
    if (!rule.from.includes(ms.status))
      throw new DealRoomError(
        'WRONG_STATE',
        `milestone ${input.milestone} is ${ms.status}; ${input.kind} needs ${rule.from.join('/')}`,
      );
    if (!Number.isSafeInteger(input.deadline) || this.now() > input.deadline)
      throw new DealRoomError('EXPIRED', 'attestation deadline passed');
    if (view.attestations.some((a) => lower(a.nonce) === lower(input.nonce)))
      throw new DealRoomError('REPLAYED', 'attestation nonce already used');
    let evidence: Evidence | null = null;
    if (input.kind === 'DELIVERED') {
      evidence = checkEvidence(input.evidence, term.evidenceType);
    } else if (input.evidence) {
      evidence = EvidenceSchema.parse(input.evidence);
    }
    const evidenceHash = evidenceHashOf(evidence);
    if (input.kind === 'ACCEPT_RELEASE' && evidenceHash !== ms.evidenceHash)
      throw new DealRoomError(
        'EVIDENCE_INVALID',
        'the client must accept the delivered evidence',
      );
    const signer = await recoverSigner({
      ...attestationTypedData({
        chainId: current.terms.asset.chainId,
        escrow: current.terms.escrow,
        dealId: deal.dealId,
        version: current.version,
        termsHash: current.termsHash,
        milestone: input.milestone,
        kind: input.kind,
        role: input.role,
        evidenceHash,
        nonce: input.nonce,
        deadline: input.deadline,
      }),
      signature: input.signature,
    });
    this.mustBe(current.terms, input.role, signer);
    const attestationId = `att_${input.nonce.slice(2).toLowerCase()}`;
    const attestation: Attestation = {
      attestationId,
      dealId: deal.dealId,
      version: current.version,
      termsHash: current.termsHash,
      milestone: input.milestone,
      kind: input.kind,
      role: input.role,
      signer,
      evidenceHash,
      evidence,
      nonce: input.nonce,
      deadline: input.deadline,
      signature: input.signature,
      at: this.now(),
    };
    const milestones = deal.milestones.map(
      (m): MilestoneState =>
        m.index !== input.milestone
          ? m
          : {
              ...m,
              status: rule.to,
              evidenceHash:
                input.kind === 'DELIVERED' ? evidenceHash : m.evidenceHash,
              authorizedBy:
                rule.to === 'ACCEPTED' || rule.to === 'REFUNDING'
                  ? attestationId
                  : m.authorizedBy,
            },
    );
    const dispute =
      input.kind === 'DISPUTE'
        ? {
            milestone: input.milestone,
            raisedBy: input.role as PartyRole,
            attestationId,
            raisedAt: this.now(),
            deadline: this.now() + current.terms.dispute.periodSeconds,
            txs: [],
          }
        : deal.dispute;
    return this.apply(view, {
      kind: `ATTESTED_${input.kind}`,
      key: `attest:${input.milestone}:${input.kind}`,
      to: dealStatusFromMilestones(milestones),
      actor: input.role,
      payload: { attestationId, evidenceHash, signer },
      patch: { milestones, dispute },
      attestation,
    });
  }

  /** Whether the escrow's dispute freeze is in force (deal-wide, as on chain). */
  disputeActive(deal: Deal) {
    return deal.dispute !== null && this.now() < deal.dispute.deadline;
  }

  /**
   * The exact escrow release for an accepted milestone. The payer path needs
   * the client's ACCEPT_RELEASE and no active dispute anywhere on the deal
   * (P13-06); a disputed deal releases only through the arbiter's signed
   * ARBITER_RELEASE. A settled milestone has no release (P13-05).
   */
  async releaseCall(
    dealId: string,
    milestone: number,
  ): Promise<{ call: EscrowReleaseCall; view: DealView; via: Attestation }> {
    const view = await this.view(dealId);
    const { deal, current } = view;
    const ms = deal.milestones[milestone];
    const term = current.terms.milestones[milestone];
    if (!ms || !term || !deal.escrow)
      throw new DealRoomError('NOT_FOUND', `milestone ${milestone}`);
    if (ms.status === 'DISPUTED')
      throw new DealRoomError(
        'MILESTONE_DISPUTED',
        `milestone ${milestone} is disputed; only the arbiter can resolve it`,
      );
    if (ms.status !== 'ACCEPTED')
      throw new DealRoomError(
        'WRONG_STATE',
        `milestone ${milestone} is ${ms.status}, not ACCEPTED`,
      );
    const via = view.attestations.find(
      (a) => a.attestationId === ms.authorizedBy,
    );
    if (
      !via ||
      (via.kind !== 'ACCEPT_RELEASE' && via.kind !== 'ARBITER_RELEASE')
    )
      throw new DealRoomError('WRONG_STATE', 'no release attestation');
    const byArbiter = via.kind === 'ARBITER_RELEASE';
    if (
      !byArbiter &&
      (this.disputeActive(deal) ||
        deal.milestones.some((m) => m.status === 'DISPUTED'))
    )
      throw new DealRoomError(
        'MILESTONE_DISPUTED',
        'the deal is under dispute; payer release is frozen',
      );
    const t = current.terms;
    return {
      view,
      via,
      call: {
        op: 'RELEASE',
        chainId: t.asset.chainId,
        escrow: t.escrow,
        token: t.asset.token,
        sender: byArbiter ? t.arbiter.wallet : t.client.wallet,
        termsHash: deal.escrow.termsHash,
        escrowDealId: BigInt(deal.escrow.escrowDealId),
        index: milestone,
        amount: term.amount,
        payee: t.freelancer.wallet,
      },
    };
  }

  async authorizeRelease(dealId: string, milestone: number, k: KernelInputs) {
    const { call, via } = await this.releaseCall(dealId, milestone);
    if (lower(k.mandate.owner) !== lower(call.sender))
      throw new DealRoomError(
        'WRONG_SIGNER',
        'release mandate must belong to the attesting payer or arbiter',
      );
    const r = await this.authorize(
      call,
      {
        obligationRef: `deal:${dealId}:m${milestone}:release`,
        evidenceHash: via.evidenceHash,
        proposedBy: via.attestationId,
      },
      k,
    );
    return { ...r, call };
  }

  /** Records an executed release + withdraw; replays are no-ops (exactly once). */
  async recordReleased(input: {
    dealId: string;
    milestone: number;
    execution: ExecutionRecord;
  }) {
    const view = await this.view(input.dealId);
    const ms = view.deal.milestones[input.milestone];
    const t = view.current.terms;
    if (!ms)
      throw new DealRoomError('NOT_FOUND', `milestone ${input.milestone}`);
    const key = `released:${input.milestone}`;
    if (view.transitions.some((x) => x.idempotencyKey === key)) return view;
    if (ms.status !== 'ACCEPTED')
      throw new DealRoomError('WRONG_STATE', `milestone is ${ms.status}`);
    const paid = input.execution.transfers.filter(
      (x) =>
        lower(x.from) === lower(t.escrow) &&
        lower(x.to) === lower(t.freelancer.wallet),
    );
    if (
      paid.length !== 1 ||
      paid[0]!.value !== t.milestones[input.milestone]!.amount
    )
      throw new DealRoomError(
        'FUNDING_MISMATCH',
        'release did not pay exactly the milestone to the freelancer',
      );
    const milestones = view.deal.milestones.map(
      (m): MilestoneState =>
        m.index === input.milestone
          ? {
              ...m,
              status: 'SETTLED',
              txs: [
                ...m.txs,
                ...input.execution.txs.map((x) => ({
                  label: x.label,
                  hash: x.hash,
                })),
              ],
            }
          : m,
    );
    await this.apply(view, {
      kind: 'RELEASED',
      key,
      to: dealStatusFromMilestones(milestones),
      actor: 'chain',
      payload: { txs: input.execution.txs.map((x) => x.hash) },
      patch: { milestones },
    });
    const p = paid[0]!;
    await this.book(view, input.execution, (b) =>
      escrowReleaseEntry(b, {
        txHash: p.hash,
        logIndex: p.logIndex,
        amount: p.value,
        at: this.now(),
        milestone: input.milestone,
      }),
    );
    return this.view(input.dealId);
  }

  /** The exact refund for a milestone whose refund was authorized; always to the funder (P13-07). */
  async refundCall(
    dealId: string,
    milestone: number,
  ): Promise<{ call: EscrowRefundCall; view: DealView; via: Attestation }> {
    const view = await this.view(dealId);
    const { deal, current } = view;
    const ms = deal.milestones[milestone];
    const term = current.terms.milestones[milestone];
    if (!ms || !term || !deal.escrow)
      throw new DealRoomError('NOT_FOUND', `milestone ${milestone}`);
    if (ms.status !== 'REFUNDING')
      throw new DealRoomError(
        'WRONG_STATE',
        `milestone ${milestone} is ${ms.status}, no refund authorized`,
      );
    const via = view.attestations.find(
      (a) => a.attestationId === ms.authorizedBy,
    );
    if (!via || (via.kind !== 'ARBITER_REFUND' && via.kind !== 'CANCEL_REFUND'))
      throw new DealRoomError('WRONG_STATE', 'no refund attestation');
    const t = current.terms;
    return {
      view,
      via,
      call: {
        op: 'REFUND',
        chainId: t.asset.chainId,
        escrow: t.escrow,
        token: t.asset.token,
        sender:
          via.kind === 'ARBITER_REFUND'
            ? t.arbiter.wallet
            : t.freelancer.wallet,
        termsHash: deal.escrow.termsHash,
        escrowDealId: BigInt(deal.escrow.escrowDealId),
        index: milestone,
        amount: term.amount,
        funder: t.client.wallet,
      },
    };
  }

  async authorizeRefund(dealId: string, milestone: number, k: KernelInputs) {
    const { call, via } = await this.refundCall(dealId, milestone);
    if (lower(k.mandate.owner) !== lower(call.sender))
      throw new DealRoomError(
        'WRONG_SIGNER',
        'refund mandate must belong to the attesting arbiter or payee',
      );
    const r = await this.authorize(
      call,
      {
        obligationRef: `deal:${dealId}:m${milestone}:refund`,
        evidenceHash: via.evidenceHash,
        proposedBy: via.attestationId,
      },
      k,
    );
    return { ...r, call };
  }

  async recordRefunded(input: {
    dealId: string;
    milestone: number;
    execution: ExecutionRecord;
  }) {
    const view = await this.view(input.dealId);
    const t = view.current.terms;
    const ms = view.deal.milestones[input.milestone];
    if (!ms)
      throw new DealRoomError('NOT_FOUND', `milestone ${input.milestone}`);
    const key = `refunded:${input.milestone}`;
    if (view.transitions.some((x) => x.idempotencyKey === key)) return view;
    if (ms.status !== 'REFUNDING')
      throw new DealRoomError('WRONG_STATE', `milestone is ${ms.status}`);
    const back = input.execution.transfers.filter(
      (x) => lower(x.from) === lower(t.escrow),
    );
    if (
      back.length !== 1 ||
      lower(back[0]!.to) !== lower(t.client.wallet) ||
      back[0]!.value !== t.milestones[input.milestone]!.amount
    )
      throw new DealRoomError(
        'FUNDING_MISMATCH',
        'refund did not return exactly the milestone to the funder',
      );
    const milestones = view.deal.milestones.map(
      (m): MilestoneState =>
        m.index === input.milestone
          ? {
              ...m,
              status: 'REFUNDED',
              txs: [
                ...m.txs,
                ...input.execution.txs.map((x) => ({
                  label: x.label,
                  hash: x.hash,
                })),
              ],
            }
          : m,
    );
    await this.apply(view, {
      kind: 'REFUNDED',
      key,
      to: dealStatusFromMilestones(milestones),
      actor: 'chain',
      payload: { txs: input.execution.txs.map((x) => x.hash) },
      patch: { milestones },
    });
    const p = back[0]!;
    await this.book(view, input.execution, (b) =>
      escrowRefundEntry(b, {
        txHash: p.hash,
        logIndex: p.logIndex,
        amount: p.value,
        at: this.now(),
        milestone: input.milestone,
      }),
    );
    return this.view(input.dealId);
  }

  /** Records the on-chain dispute transaction for the deal's active dispute. */
  async recordDispute(input: { dealId: string; execution: ExecutionRecord }) {
    const view = await this.view(input.dealId);
    const d = view.deal.dispute;
    if (!d) throw new DealRoomError('WRONG_STATE', 'no dispute attested');
    const out = await this.apply(view, {
      kind: 'DISPUTE_ON_CHAIN',
      key: `dispute-tx:${d.attestationId}`,
      to: view.deal.status,
      actor: 'chain',
      payload: { txs: input.execution.txs.map((x) => x.hash) },
      patch: {
        dispute: {
          ...d,
          txs: [...d.txs, ...input.execution.txs.map((x) => x.hash)],
        },
      },
    });
    await this.book(view, input.execution, () => null);
    return out;
  }

  // ---------------------------------------------------------------- internals

  private notExpired(t: Terms) {
    if (this.now() >= t.expiresAt)
      throw new DealRoomError('EXPIRED', 'the offer has expired');
  }

  private mustBe(t: Terms, role: Role, signer: Address) {
    const want = partyOf(t, role).wallet;
    if (lower(signer) !== lower(want))
      throw new DealRoomError(
        'WRONG_SIGNER',
        `signed by ${signer}, ${role} is ${want}`,
      );
  }

  private async recoverAccept(v: DealVersion, role: PartyRole, signature: Hex) {
    const signer = await recoverSigner({ ...this.typedData(v), signature });
    this.mustBe(v.terms, role, signer);
    return signer;
  }

  private sig(
    v: DealVersion,
    role: PartyRole,
    decision: DealSignature['decision'],
    reason: string,
    signature: Hex,
  ): DealSignature {
    return {
      dealId: v.dealId,
      version: v.version,
      termsHash: v.termsHash,
      role,
      signer: partyOf(v.terms, role).wallet,
      decision,
      reason,
      signature,
      signedAt: this.now(),
    };
  }

  private async apply(
    view: DealView,
    t: {
      kind: string;
      key: string;
      to: DealStatus;
      actor: string;
      payload: unknown;
      patch?: Partial<Deal>;
      version?: DealVersion;
      signature?: DealSignature;
      attestation?: Attestation;
    },
  ): Promise<DealView> {
    const { deal } = view;
    if (view.transitions.some((x) => x.idempotencyKey === t.key)) return view;
    if (t.to !== deal.status) assertTransition(deal.status, t.to);
    const now = this.now();
    const next: Deal = {
      ...deal,
      ...t.patch,
      status: t.to,
      rev: deal.rev + 1,
      updatedAt: now,
    };
    await this.store.commit({
      dealId: deal.dealId,
      expectedRev: deal.rev,
      deal: next,
      transition: {
        dealId: deal.dealId,
        idempotencyKey: t.key,
        kind: t.kind,
        from: deal.status,
        to: t.to,
        actor: t.actor,
        payload: t.payload,
        at: now,
      },
      ...(t.version ? { version: t.version } : {}),
      ...(t.signature ? { signature: t.signature } : {}),
      ...(t.attestation ? { attestation: t.attestation } : {}),
    });
    return this.view(deal.dealId);
  }

  /** Posts the effect and the gas of every transaction (idempotent per log / tx). */
  private async book(
    view: DealView,
    exec: ExecutionRecord,
    effect: (b: DealBooks) => JournalEntry | null,
  ) {
    const books = this.config.books;
    if (!books) return;
    const t = view.current.terms;
    const b: DealBooks = {
      workspaceId: books.workspaceId,
      dealId: view.deal.dealId,
      chainId: t.asset.chainId,
      assetId: assetIdOf(t.asset),
      escrow: t.escrow,
      client: t.client.wallet,
      freelancer: t.freelancer.wallet,
    };
    const e = effect(b);
    if (e) await books.ledger.post(e);
    for (const tx of exec.txs) {
      const gas = arcGasEntry({
        workspaceId: books.workspaceId,
        chain: this.config.chainName,
        txHash: tx.hash,
        payer: tx.from,
        feeWei: tx.feeWei,
        at: this.now(),
        memo: `Gas: ${tx.label} (deal ${view.deal.dealId})`,
      });
      if (gas) await books.ledger.post(gas);
    }
  }
}

/** Registry asset id of the agreement asset (`@synq/domain` assetKey). */
export const assetIdOf = (a: DealAsset) =>
  assetKey({ network: a.network as `eip155:${number}`, address: a.token });

function makeVersion(input: {
  dealId: string;
  version: number;
  parent: Hex | null;
  terms: Terms;
  provenance: Record<string, Provenance[]>;
  proposedBy: DealVersion['proposedBy'];
  ambiguities: readonly string[];
  at: number;
}): DealVersion {
  const ph = provenanceHash(input.provenance);
  return {
    dealId: input.dealId,
    version: input.version,
    parentTermsHash: input.parent,
    terms: input.terms,
    provenance: input.provenance,
    provenanceHash: ph,
    termsHash: termsHashOf({
      dealId: input.dealId,
      version: input.version,
      parentTermsHash: input.parent,
      terms: input.terms,
      provenanceHash: ph,
    }),
    proposedBy: input.proposedBy,
    ambiguities: [...input.ambiguities],
    createdAt: input.at,
  };
}

function termValue(t: Terms, key: string): unknown {
  let v: unknown = t;
  for (const part of key.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = Array.isArray(v)
      ? v[Number(part)]
      : (v as Record<string, unknown>)[part];
  }
  return v;
}

/** ACCEPT signatures on exactly this version (by terms hash), per party. */
export function acceptsFor(sigs: readonly DealSignature[], v: DealVersion) {
  const pick = (role: PartyRole) =>
    sigs.find(
      (s) =>
        s.version === v.version &&
        s.termsHash === v.termsHash &&
        s.role === role &&
        s.decision === 'ACCEPT',
    ) ?? null;
  return { CLIENT: pick('CLIENT'), FREELANCER: pick('FREELANCER') };
}
const rejectedBy = (
  sigs: readonly DealSignature[],
  v: DealVersion,
  role: PartyRole,
) =>
  sigs.some(
    (s) =>
      s.version === v.version && s.role === role && s.decision !== 'ACCEPT',
  );
const anyRejection = (sigs: readonly DealSignature[], v: DealVersion) =>
  rejectedBy(sigs, v, 'CLIENT') || rejectedBy(sigs, v, 'FREELANCER');
export { otherParty };

/** P13-04: every way the funded escrow can differ from the signed version. */
export function fundingMismatches(
  t: Terms,
  termsHash: Hex,
  chain: ChainEscrowDeal,
  exec: ExecutionRecord,
): string[] {
  const out: string[] = [];
  if (lower(chain.token) !== lower(t.asset.token))
    out.push(`escrow asset ${chain.token} != agreement ${t.asset.token}`);
  if (lower(chain.payer) !== lower(t.client.wallet))
    out.push(`funder ${chain.payer} is not the client`);
  if (lower(chain.payee) !== lower(t.freelancer.wallet))
    out.push(`payee ${chain.payee} is not the freelancer`);
  if (lower(chain.arbiter) !== lower(t.arbiter.wallet))
    out.push(`arbiter ${chain.arbiter} differs`);
  if (chain.refundAfter !== BigInt(t.refundAfter))
    out.push('refundAfter differs');
  if (lower(chain.termsHash) !== lower(termsHash))
    out.push('on-chain terms hash is not the signed version');
  if (chain.milestones.length !== t.milestones.length)
    out.push('milestone count differs');
  t.milestones.forEach((m, i) => {
    const c = chain.milestones[i];
    if (!c || c.amount !== m.amount) out.push(`milestone ${i} amount differs`);
    else if (c.status !== 'Funded')
      out.push(`milestone ${i} is ${c.status}, not Funded`);
  });
  const paid = exec.transfers.filter((x) => lower(x.to) === lower(t.escrow));
  if (
    paid.length !== 1 ||
    lower(paid[0]!.from) !== lower(t.client.wallet) ||
    paid[0]!.value !== t.total
  )
    out.push(`funding transfer is not exactly ${t.total} from the client`);
  return out;
}

const GITHUB =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(commit|pull)\/([0-9a-f]{40}|[0-9]+)$/;

/** Evidence must be of the agreed type and internally consistent (URL, repo, sha / PR number). */
export function checkEvidence(
  e: Evidence | null,
  type: Terms['milestones'][number]['evidenceType'],
): Evidence {
  if (!e)
    throw new DealRoomError('EVIDENCE_INVALID', 'delivery needs evidence');
  const ev = EvidenceSchema.parse(e);
  if (ev.type !== type)
    throw new DealRoomError(
      'EVIDENCE_INVALID',
      `milestone needs ${type}, got ${ev.type}`,
    );
  if (type === 'FILE_SHA256') {
    if (!ev.sha256)
      throw new DealRoomError('EVIDENCE_INVALID', 'missing sha256');
    return ev;
  }
  const m = GITHUB.exec(ev.url);
  if (!m || ev.repo !== m[1])
    throw new DealRoomError(
      'EVIDENCE_INVALID',
      'not a GitHub URL of the named repo',
    );
  if (type === 'GITHUB_COMMIT' && (m[2] !== 'commit' || ev.commitSha !== m[3]))
    throw new DealRoomError('EVIDENCE_INVALID', 'commit URL and hash differ');
  if (type === 'GITHUB_PR' && (m[2] !== 'pull' || ev.prNumber !== Number(m[3])))
    throw new DealRoomError('EVIDENCE_INVALID', 'PR URL and number differ');
  return ev;
}
