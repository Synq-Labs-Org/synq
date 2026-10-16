import { z } from 'zod';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

/**
 * Deal Room agreement model.
 *
 * A deal is a sequence of immutable versions. Each version holds the full
 * economic terms (integer base units of one registry asset), and every term
 * carries its provenance, kept as distinct kinds:
 *
 * - ORIGINAL_MESSAGE: a message Synq was actually permitted to read (a guest
 *   invocation, or an enrolled chat's consented memory), cited by id + hash;
 * - AI_INTERPRETATION: what a model (or the deterministic extractor) read
 *   into those messages. It never authorizes anything;
 * - HUMAN_CONFIRMED: a contracting party proposed or signed the version
 *   containing the term (EIP-712, recovered to the party's verified wallet);
 * - EXECUTABLE_AUTHORIZATION: both parties signed this exact version and the
 *   Kernel granted the escrow call that executes it.
 *
 * Wallets never come from chat text or a model: they come from verified
 * identity links (channel link, governance membership or a wallet signature).
 */

export const DEAL_STATUSES = [
  'DRAFT',
  'NEGOTIATING',
  'ACCEPTED',
  'FUNDING',
  'FUNDED',
  'IN_PROGRESS',
  'DELIVERED',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  /**
   * A funding attempt failed after an `open` may have been broadcast and its
   * outcome is not proven: nothing proceeds until the chain is reconciled.
   */
  'NEEDS_REVIEW',
] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const MILESTONE_STATUSES = [
  'PENDING',
  'FUNDED',
  'DELIVERED',
  'ACCEPTED',
  'DISPUTED',
  /** Refund authorized (arbiter or payee), not yet executed on chain. */
  'REFUNDING',
  'SETTLED',
  'REFUNDED',
] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const ROLES = ['CLIENT', 'FREELANCER', 'ARBITER'] as const;
export type Role = (typeof ROLES)[number];
/** The two contracting parties; the arbiter is named in the terms but does not contract. */
export type PartyRole = Exclude<Role, 'ARBITER'>;

export const EVIDENCE_TYPES = [
  'GITHUB_COMMIT',
  'GITHUB_PR',
  'FILE_SHA256',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const CONTEXT_SOURCES = [
  'GUEST_INVOCATION',
  'ENROLLED_CONTEXT',
  'INVOCATION',
] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

const AddressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'not an address')
  .transform((v) => getAddress(v) as Address);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Units = z
  .union([z.bigint(), z.string().regex(/^(0|[1-9][0-9]{0,30})$/)])
  .transform((v) => BigInt(v));
const Time = z.number().int().nonnegative();

export const PartySchema = z.strictObject({
  role: z.enum(ROLES),
  displayName: z.string().min(1).max(120),
  principalId: z.string().min(1).max(200),
  wallet: AddressSchema,
  /** How the wallet was bound to the person; never a chat claim. */
  verification: z.strictObject({
    method: z.enum(['CHANNEL_LINK', 'GOVERNANCE_MEMBER', 'WALLET_SIGNATURE']),
    /** Link id, membership id or signed challenge id. */
    reference: z.string().min(1).max(200),
    channel: z.enum(['telegram', 'imessage', 'whatsapp']).nullable(),
    channelUserId: z.string().max(200).nullable(),
    verifiedAt: Time,
  }),
});
export type Party = z.output<typeof PartySchema>;

export const MilestoneSchema = z.strictObject({
  index: z.number().int().min(0).max(31),
  title: z.string().min(1).max(200),
  amount: Units,
  /** Unix seconds by which the deliverable is due. */
  deadline: Time,
  acceptanceCondition: z.string().min(1).max(1000),
  evidenceType: z.enum(EVIDENCE_TYPES),
  /** Verified payout wallet; the escrow pays one payee per deal. */
  payee: AddressSchema,
});
export type Milestone = z.output<typeof MilestoneSchema>;

export const AssetSchema = z.strictObject({
  chainId: z.number().int().positive(),
  /** CAIP-2, e.g. eip155:5042002. */
  network: z.string().regex(/^eip155:[0-9]+$/),
  token: AddressSchema,
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().min(0).max(36),
});
export type DealAsset = z.output<typeof AssetSchema>;

export const REFUND_POLICIES = ['UNRELEASED_TO_FUNDER'] as const;
export const CANCELLATION_POLICIES = [
  'BEFORE_FUNDING_EITHER_PARTY_AFTER_FUNDING_ARBITER_OR_PAYEE_REFUNDS_FUNDER',
] as const;

export const TermsSchema = z.strictObject({
  title: z.string().min(1).max(200),
  scope: z.string().min(1).max(2000),
  deliverables: z.array(z.string().min(1).max(300)).min(1).max(20),
  client: PartySchema,
  freelancer: PartySchema,
  arbiter: PartySchema,
  asset: AssetSchema,
  /** Registry SynqMilestoneEscrow that holds the funds. */
  escrow: AddressSchema,
  total: Units,
  /** Amount escrowed at funding. The escrow funds every milestone up front. */
  deposit: Units,
  milestones: z.array(MilestoneSchema).min(1).max(32),
  /** After this, an unreleased, undisputed milestone may be refunded to the funder by anyone. */
  refundAfter: Time,
  dispute: z.strictObject({
    mechanism: z.literal('ARBITER'),
    /** SynqMilestoneEscrow.DISPUTE_PERIOD. */
    periodSeconds: z.number().int().positive(),
    maxPerParty: z.literal(1),
  }),
  refundPolicy: z.enum(REFUND_POLICIES),
  cancellation: z.enum(CANCELLATION_POLICIES),
  /** The offer lapses at this time unless both parties signed and funded. */
  expiresAt: Time,
});
export type Terms = z.output<typeof TermsSchema>;
export type TermsInput = z.input<typeof TermsSchema>;

export const ProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ORIGINAL_MESSAGE'),
    source: z.enum(CONTEXT_SOURCES),
    messageId: z.string().min(1).max(200),
    textSha256: Sha256Hex,
    /** Verbatim span of the cited message. */
    quote: z.string().min(1).max(300),
  }),
  z.strictObject({
    kind: z.literal('AI_INTERPRETATION'),
    provider: z.string().max(40),
    model: z.string().max(80),
    mode: z.enum(['LIVE', 'REPLAY', 'DETERMINISTIC']),
    requestHash: z.string().max(80).nullable(),
    responseHash: z.string().max(80).nullable(),
  }),
  z.strictObject({
    kind: z.literal('HUMAN_CONFIRMED'),
    role: z.enum(ROLES),
    wallet: AddressSchema,
    version: z.number().int().positive(),
    how: z.enum(['PROPOSED', 'SIGNED']),
  }),
  z.strictObject({
    kind: z.literal('EXECUTABLE_AUTHORIZATION'),
    what: z.enum(['BOTH_PARTIES_SIGNED', 'KERNEL_GRANT']),
    ref: z.string().min(1).max(200),
  }),
  /** A wallet taken from a verified identity link, never from chat or a model. */
  z.strictObject({
    kind: z.literal('VERIFIED_LINK'),
    role: z.enum(ROLES),
    method: z.enum(['CHANNEL_LINK', 'GOVERNANCE_MEMBER', 'WALLET_SIGNATURE']),
    reference: z.string().min(1).max(200),
    wallet: AddressSchema,
  }),
]);
export type Provenance = z.output<typeof ProvenanceSchema>;

/** Paths of the terms that carry provenance (e.g. `total`, `milestones.0.amount`). */
export const TERM_KEYS = [
  'client',
  'freelancer',
  'title',
  'scope',
  'deliverables',
  'total',
  'deposit',
  'asset',
  'refundAfter',
  'expiresAt',
  'arbiter',
  'dispute',
  'refundPolicy',
] as const;
export const MILESTONE_TERM_KEYS = [
  'title',
  'amount',
  'deadline',
  'acceptanceCondition',
  'evidenceType',
  'payee',
] as const;
/**
 * The only terms a chat message may be cited for. Parties, payees, the
 * arbiter, asset and escrow come from verified links and the registry.
 */
export const CITABLE_MILESTONE_KEYS = [
  'title',
  'amount',
  'deadline',
  'acceptanceCondition',
  'evidenceType',
] as const;
export function isCitableTerm(term: string): boolean {
  if (['title', 'scope', 'deliverables', 'total'].includes(term)) return true;
  const m = /^milestones\.([0-9]{1,2})\.([A-Za-z]+)$/.exec(term);
  return !!m && (CITABLE_MILESTONE_KEYS as readonly string[]).includes(m[2]!);
}
export const milestoneKey = (
  i: number,
  k: (typeof MILESTONE_TERM_KEYS)[number],
) => `milestones.${i}.${k}`;

export function termKeys(t: Pick<Terms, 'milestones'>): string[] {
  return [
    ...TERM_KEYS,
    ...t.milestones.flatMap((m) =>
      MILESTONE_TERM_KEYS.map((k) => milestoneKey(m.index, k)),
    ),
  ];
}

export type ProvenanceMap = Readonly<Record<string, readonly Provenance[]>>;

export type DealVersion = Readonly<{
  dealId: string;
  version: number;
  parentTermsHash: Hex | null;
  terms: Terms;
  /** Static provenance at creation (citations, interpretation, proposer). */
  provenance: ProvenanceMap;
  provenanceHash: Hex;
  termsHash: Hex;
  proposedBy: PartyRole | 'SYNQ_DRAFT';
  ambiguities: readonly string[];
  createdAt: number;
}>;

export type Decision = 'ACCEPT' | 'REJECT' | 'CANCEL';
export type DealSignature = Readonly<{
  dealId: string;
  version: number;
  termsHash: Hex;
  role: PartyRole;
  signer: Address;
  decision: Decision;
  reason: string;
  signature: Hex;
  signedAt: number;
}>;

export const ATTESTATION_KINDS = [
  'DELIVERED',
  'ACCEPT_RELEASE',
  'DISPUTE',
  'ARBITER_RELEASE',
  'ARBITER_REFUND',
  'CANCEL_REFUND',
] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

export const EvidenceSchema = z.strictObject({
  type: z.enum(EVIDENCE_TYPES),
  url: z.string().url().max(500),
  /** owner/name for GitHub evidence. */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
    .nullable(),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  prNumber: z.number().int().positive().nullable(),
  sha256: Sha256Hex.nullable(),
  /** Who checked the evidence exists and how (null: format only). */
  verifiedBy: z.enum(['GITHUB_API']).nullable(),
  checkedAt: Time,
});
export type Evidence = z.output<typeof EvidenceSchema>;

export type Attestation = Readonly<{
  attestationId: string;
  dealId: string;
  version: number;
  termsHash: Hex;
  milestone: number;
  kind: AttestationKind;
  role: Role;
  signer: Address;
  evidenceHash: Hex;
  evidence: Evidence | null;
  nonce: Hex;
  deadline: number;
  signature: Hex;
  at: number;
}>;

export type MilestoneState = Readonly<{
  index: number;
  status: MilestoneStatus;
  /** Evidence the freelancer delivered (hash of the canonical evidence). */
  evidenceHash: Hex | null;
  /** Attestation that authorized the pending release or refund. */
  authorizedBy: string | null;
  txs: readonly { label: string; hash: Hex }[];
}>;

export type DisputeState = Readonly<{
  milestone: number;
  raisedBy: PartyRole;
  attestationId: string;
  raisedAt: number;
  /** Until then the escrow freezes the payer's release and timeout refunds. */
  deadline: number;
  txs: readonly Hex[];
}>;

export type DealOrigin = Readonly<{
  channel: string | null;
  externalGroupId: string | null;
  source: ContextSource;
  /** sha256 over the ids and hashes of every message Synq could read when drafting. */
  contextDigest: string;
  /** Message id -> text sha256 of that authorized context (no text is kept). */
  messages: Readonly<Record<string, string>>;
}>;

export type EscrowBinding = Readonly<{
  escrow: Address;
  escrowDealId: string;
  termsHash: Hex;
  fundingTxs: readonly Hex[];
  fundedAt: number;
}>;

export type Deal = Readonly<{
  dealId: string;
  workspaceId: string;
  status: DealStatus;
  currentVersion: number;
  rev: number;
  origin: DealOrigin;
  funding: Readonly<{ intentId: string; grantId: string; nonce?: Hex }> | null;
  escrow: EscrowBinding | null;
  milestones: readonly MilestoneState[];
  dispute: DisputeState | null;
  /** Bumped to revoke every review link issued so far (absent = 0). */
  linkEpoch?: number;
  /** Funding attempts proven not to have landed (each allows one new grant). */
  failedFundingAttempts?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type Transition = Readonly<{
  dealId: string;
  /** Unique per deal; replaying a transition with the same key is a no-op. */
  idempotencyKey: string;
  kind: string;
  from: DealStatus | null;
  to: DealStatus;
  actor: string;
  payload: unknown;
  at: number;
}>;

export class DealRoomError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TERMS'
      | 'CITATION_NOT_AUTHORIZED'
      | 'CITATION_MISMATCH'
      | 'PARTY_NOT_VERIFIED'
      | 'WRONG_STATE'
      | 'STALE_VERSION'
      | 'BAD_SIGNATURE'
      | 'WRONG_SIGNER'
      | 'COUNTERPARTY_REJECTED'
      | 'NOT_FULLY_SIGNED'
      | 'EXPIRED'
      | 'REPLAYED'
      | 'MILESTONE_DISPUTED'
      | 'EVIDENCE_INVALID'
      | 'FUNDING_MISMATCH'
      | 'NOT_FOUND'
      | 'CONFLICT',
    message: string = code,
  ) {
    super(message);
    this.name = 'DealRoomError';
  }
}

/** JSON with bigint as decimal strings (for storage and APIs). */
export const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
