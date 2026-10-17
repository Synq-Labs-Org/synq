import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';
import { EXECUTION_MODES, ExecutionModeSchema } from './world.js';

/**
 * Canonical interactive card descriptions. Every channel renderer (Telegram,
 * web, iMessage fallback, bridge link preview, native Messages extension)
 * consumes these; none of them computes money. Amounts are exact decimal
 * strings produced by the backend. Card actions only open authenticated
 * pages: a card never carries signing material and never approves anything.
 */
export const CARD_SCHEMA = 'synq.card/v1' as const;

const Ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const Line = (max: number) => z.string().min(1).max(max);
export const CardDecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/);
export const CardMoneySchema = z.strictObject({
  amount: CardDecimalSchema,
  symbol: z.string().regex(/^[A-Za-z0-9.$-]{1,16}$/),
});
export type CardMoney = z.output<typeof CardMoneySchema>;

export const CARD_ACTION_KINDS = [
  'REVIEW_APPROVE',
  'REVIEW_REJECT',
  'VIEW',
  'VOTE',
  'PAUSE',
  'REVOKE',
  'EXPLORER',
] as const;
export const CardActionSchema = z.strictObject({
  kind: z.enum(CARD_ACTION_KINDS),
  label: Line(40),
  /** https URL of an authenticated page (or a public explorer); never a signature. */
  url: z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s]+$/),
  style: z.enum(['PRIMARY', 'SECONDARY', 'DESTRUCTIVE']),
});
export type CardAction = z.output<typeof CardActionSchema>;

const base = {
  schema: z.literal(CARD_SCHEMA),
  cardId: z.string().regex(/^card_[0-9a-f]{24}$/),
  groupId: Ref,
  groupLabel: Line(120),
  issuedAt: z.number().int().nonnegative(),
  actions: z.array(CardActionSchema).max(4),
};

export const ApprovalStatusSchema = z.enum([
  'PENDING',
  'SATISFIED',
  'INVALIDATED',
]);

export const GroupTreasuryCardSchema = z.strictObject({
  ...base,
  type: z.literal('GROUP_TREASURY'),
  balance: CardMoneySchema,
  available: CardMoneySchema,
  reserved: CardMoneySchema,
  pending: CardMoneySchema,
  memberCount: z.number().int().nonnegative().nullable(),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive(),
  asOf: Line(120),
  activity: z
    .array(z.strictObject({ label: Line(160), at: z.string().max(40) }))
    .max(5),
});

export const ApprovalProposalCardSchema = z.strictObject({
  ...base,
  type: z.literal('APPROVAL_PROPOSAL'),
  proposalId: Ref,
  proposalKind: z.enum(['SEND', 'ACTION', 'MANDATE']),
  /** Exact amount being authorized; null when the proposal has no single amount (e.g. a mandate change). */
  amount: CardMoneySchema.nullable(),
  recipient: z
    .strictObject({
      label: Line(120),
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .nullable(),
    })
    .nullable(),
  reason: Line(280),
  quorum: z.strictObject({
    counted: z.number().int().nonnegative(),
    required: z.number().int().positive(),
  }),
  status: ApprovalStatusSchema,
  statusReason: z.string().max(200).nullable(),
});

const OptionId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const GroupGiftCardSchema = z.strictObject({
  ...base,
  type: z.literal('GROUP_GIFT'),
  proposalId: Ref.nullable(),
  occasion: Line(120),
  options: z
    .array(
      z.strictObject({
        optionId: OptionId,
        product: Line(120),
        price: CardMoneySchema,
        delivery: Line(120),
        votes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(5),
  /** The option the group's final proposal covers, once one exists. */
  finalOptionId: OptionId.nullable(),
  provider: Line(80),
  executionMode: ExecutionModeSchema,
});

export const HotelComparisonCardSchema = z.strictObject({
  ...base,
  type: z.literal('HOTEL_COMPARISON'),
  proposalId: Ref.nullable(),
  stay: Line(160),
  options: z
    .array(
      z.strictObject({
        optionId: OptionId,
        hotel: Line(120),
        room: Line(120),
        total: CardMoneySchema,
        cancellation: Line(200),
        preferenceVotes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(5),
  preferredOptionId: OptionId.nullable(),
  provider: Line(80),
  executionMode: ExecutionModeSchema,
});

export const DcaMandateCardSchema = z.strictObject({
  ...base,
  type: z.literal('DCA_MANDATE'),
  mandateId: Ref,
  asset: z.string().regex(/^[A-Za-z0-9.$-]{1,16}$/),
  frequency: Line(60),
  perExecutionLimit: CardMoneySchema,
  cumulativeLimit: CardMoneySchema,
  spent: CardMoneySchema,
  nextExecutionAt: z.number().int().nonnegative().nullable(),
  status: z.enum(['PROPOSED', 'ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED']),
});

export const ExecutionReceiptCardSchema = z.strictObject({
  ...base,
  type: z.literal('EXECUTION_RECEIPT'),
  subjectId: Ref,
  label: Line(200),
  status: z.enum([
    'SUBMITTED',
    'CONFIRMED',
    'RECONCILED',
    'FAILED',
    'REFUNDED',
  ]),
  transactionHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .nullable(),
  orderId: z.string().max(120).nullable(),
  explorerUrl: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s]+$/)
    .nullable(),
  settlementStatus: z.enum([
    'SETTLED',
    'PENDING',
    'REFUNDED',
    'NOT_APPLICABLE',
    'UNKNOWN',
  ]),
  /** Always shown: what kind of execution this receipt evidences. */
  executionMode: ExecutionModeSchema,
});

/*
 * Arc-era card types. Each one carries immutable references (ids, hashes,
 * transaction hashes), freshness (`issuedAt` when the card was built,
 * `observedAt` when its facts were read), the network (`chainId`, null for
 * off-chain provider cards) and an always-shown execution mode.
 */

/**
 * Card execution modes: the shared ExecutionMode plus the evidence labels the
 * Arc runtime uses. A fixture is LOCAL_FIXTURE, never a live mode.
 */
export const CARD_EXECUTION_MODES = [
  ...EXECUTION_MODES,
  'LIVE_ARC_TESTNET',
  'LIVE_SEPOLIA',
  'LOCAL_FIXTURE',
] as const;
export const CardExecutionModeSchema = z.enum(CARD_EXECUTION_MODES);
export type CardExecutionMode = z.output<typeof CardExecutionModeSchema>;

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Iata = z.string().regex(/^[A-Z]{3}$/);
const Time = z.number().int().nonnegative();
const arcBase = {
  ...base,
  /** When the facts on the card were read (≤ issuedAt). */
  observedAt: Time,
  /** Network the card's references live on; null for off-chain provider cards. */
  chainId: z.number().int().positive().nullable(),
  executionMode: CardExecutionModeSchema,
};
const Party = z.strictObject({ label: Line(120), address: Address });
const SignatureState = z.enum(['SIGNED', 'PENDING', 'DECLINED']);

export const DEAL_CARD_STATUSES = [
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
  'NEEDS_REVIEW',
] as const;
/** One immutable Deal Room agreement version. */
export const DealProposalCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('DEAL_PROPOSAL'),
  dealId: Ref,
  version: z.number().int().positive(),
  /** keccak256 of the exact terms both parties sign. */
  termsHash: Hash32,
  title: Line(200),
  status: z.enum(DEAL_CARD_STATUSES),
  client: Party,
  freelancer: Party,
  total: CardMoneySchema,
  milestoneCount: z.number().int().min(1).max(32),
  signatures: z.strictObject({
    client: SignatureState,
    freelancer: SignatureState,
  }),
  /** Escrow contract holding the funds, once known. */
  escrow: Address.nullable(),
  expiresAt: Time.nullable(),
});

export const MILESTONE_CARD_STATES = [
  'PENDING',
  'FUNDED',
  'DELIVERED',
  'ACCEPTED',
  'RELEASED',
  'DISPUTED',
  'REFUNDING',
  'REFUNDED',
] as const;
/** One milestone of a funded (or to-be-funded) Deal Room escrow. */
export const EscrowMilestoneCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('ESCROW_MILESTONE'),
  dealId: Ref,
  termsHash: Hash32,
  /** On-chain escrow deal id (uint256 as decimal), once opened. */
  escrowDealId: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .nullable(),
  escrow: Address.nullable(),
  milestoneIndex: z.number().int().min(0).max(31),
  milestoneCount: z.number().int().min(1).max(32),
  title: Line(200),
  amount: CardMoneySchema,
  state: z.enum(MILESTONE_CARD_STATES),
  deadline: Time,
  evidence: z
    .strictObject({
      type: z.enum(['GITHUB_COMMIT', 'GITHUB_PR', 'FILE_SHA256']),
      /** Hash of the canonical evidence the freelancer attested. */
      hash: Hash32,
      label: Line(160),
    })
    .nullable(),
  /** Until then the escrow freezes release and timeout refunds. */
  disputeDeadline: Time.nullable(),
  transactions: z
    .array(z.strictObject({ label: Line(60), hash: Hash32 }))
    .max(4),
});

export const INVOICE_CARD_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIAL',
  'PAID',
  'OVERPAID',
  'VOID',
] as const;
export const InvoiceCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('INVOICE'),
  invoiceId: Ref,
  number: Line(40),
  version: z.number().int().positive(),
  status: z.enum(INVOICE_CARD_STATUSES),
  issuer: Party,
  payer: Line(120),
  total: CardMoneySchema,
  paid: CardMoneySchema,
  due: CardMoneySchema,
  /** Excess paid, owed back as a refund (zero when none). */
  overpaid: CardMoneySchema,
  dueDate: Day,
  /** The version's 32-byte Memo payment reference; null while drafting. */
  paymentRef: Hash32.nullable(),
  termsHash: Hash32.nullable(),
  paymentCount: z.number().int().nonnegative(),
  lastPaymentTx: Hash32.nullable(),
});

export const RISK_CASE_STATES = [
  'HELD',
  'IN_REVIEW',
  'APPEALED',
  'RELEASED',
  'RESOLVED',
  'BLOCKED',
] as const;
/** An explainable payout hold. Flags are human-readable; secrets never appear. */
export const RiskHoldCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('RISK_HOLD'),
  caseId: Ref,
  /** Case revision the card was built from. */
  revision: z.number().int().nonnegative(),
  subject: z.strictObject({
    kind: z.enum(['VENDOR', 'DESTINATION', 'COUNTERPARTY']),
    label: Line(120),
    address: Address.nullable(),
  }),
  state: z.enum(RISK_CASE_STATES),
  flags: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
        severity: z.enum(['HARD', 'SOFT']),
        detail: Line(200),
        /** False for wallet / vendor-master policy no reviewer can clear. */
        reviewerClearable: z.boolean(),
      }),
    )
    .max(8),
  /** What clears the hold, e.g. "Owner signature required". */
  clearedBy: Line(200),
  /** The held payout amount, when known. */
  amount: CardMoneySchema.nullable(),
  alertCount: z.number().int().nonnegative(),
  openedAt: Time,
});

export const AGENT_PERSONAS = [
  'CFO',
  'RISK',
  'PAYMENT',
  'AUDIT',
  'INVOICE',
  'DEAL',
  'COMMERCE',
  'TRAVEL',
  'RESEARCH',
] as const;
export const AGENT_STANCES = [
  'PAY',
  'HOLD',
  'VETO',
  'REVIEW',
  'CLEAR',
  'INFO',
  'UNAVAILABLE',
] as const;
/** An agent-team council answer; the decision is the Kernel's, from structured data only. */
export const AgentRecommendationCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('AGENT_RECOMMENDATION'),
  runId: Ref,
  question: Line(280),
  roles: z
    .array(
      z.strictObject({
        persona: z.enum(AGENT_PERSONAS),
        stance: z.enum(AGENT_STANCES),
        summary: Line(280),
        citations: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(6),
  decision: z.strictObject({
    outcome: z.enum(['ALLOW', 'DENY', 'NEEDS_APPROVAL', 'NOT_SUBMITTED']),
    reasons: z.array(Line(200)).max(3),
  }),
  counterparty: Line(120).nullable(),
  amount: CardMoneySchema.nullable(),
  evidence: z.strictObject({
    facts: z.number().int().nonnegative(),
    inferences: z.number().int().nonnegative(),
    /** Age of the oldest verified fact when the council answered. */
    oldestFactSeconds: z.number().int().nonnegative().nullable(),
  }),
  riskCaseId: Ref.nullable(),
  auditHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$|^[0-9a-f]{64}$/)
    .nullable(),
});

export const CONTRACTOR_PAYMENT_STATUSES = [
  'PROPOSED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'DENIED',
] as const;
export const ContractorPaymentCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('CONTRACTOR_PAYMENT'),
  /** Payment intent id. */
  paymentId: Ref,
  recipient: z.strictObject({
    label: Line(120),
    address: Address,
    /** The address is the vendor master's verified payout address. */
    verified: z.boolean(),
  }),
  amount: CardMoneySchema,
  route: z.enum(['VAULT_POLICY_PAY', 'SAFE_QUORUM_TRANSFER', 'AGENT_WALLET']),
  /** Invoice / payable / milestone the payment settles. */
  obligationRef: Ref.nullable(),
  approvals: z.strictObject({
    counted: z.number().int().nonnegative(),
    required: z.number().int().nonnegative(),
  }),
  status: z.enum(CONTRACTOR_PAYMENT_STATUSES),
  transactionHash: Hash32.nullable(),
  evidenceHash: Hash32.nullable(),
});

export const FlightComparisonCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('FLIGHT_COMPARISON'),
  tripId: Ref,
  proposalId: Ref.nullable(),
  origin: Iata,
  destination: Iata,
  departureDate: Day,
  returnDate: Day.nullable(),
  travelers: z.number().int().min(1).max(9),
  cabin: Line(40),
  options: z
    .array(
      z.strictObject({
        optionId: OptionId,
        carrier: Line(80),
        /** Flight numbers, e.g. "ZZ 123 / ZZ 456". */
        flights: z.string().max(80).nullable(),
        legs: z
          .array(z.strictObject({ origin: Iata, destination: Iata, date: Day }))
          .min(1)
          .max(2),
        stops: z.number().int().nonnegative(),
        price: CardMoneySchema,
        baggage: z.string().max(80).nullable(),
        refundable: z.boolean(),
        votes: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(5),
  preferredOptionId: OptionId.nullable(),
  provider: Line(80),
});

export const AllocationCardSchema = z.strictObject({
  ...arcBase,
  type: z.literal('ALLOCATION'),
  splitId: Ref,
  invoiceId: Ref,
  policyVersion: z.number().int().positive(),
  status: z.enum(['PROCESSING', 'COMPLETED', 'NEEDS_REVIEW']),
  received: CardMoneySchema,
  paid: CardMoneySchema,
  held: CardMoneySchema,
  free: CardMoneySchema,
  receiptTx: Hash32,
  planHash: Hash32.nullable(),
  legs: z
    .array(
      z.strictObject({
        purpose: Line(80),
        state: Line(40),
        amount: CardMoneySchema,
        recipient: Address.nullable(),
        txHash: Hash32.nullable(),
      }),
    )
    .max(64),
  note: Line(300),
});

export const InteractiveCardSchema = z.discriminatedUnion('type', [
  AllocationCardSchema,
  GroupTreasuryCardSchema,
  ApprovalProposalCardSchema,
  GroupGiftCardSchema,
  HotelComparisonCardSchema,
  DcaMandateCardSchema,
  ExecutionReceiptCardSchema,
  DealProposalCardSchema,
  EscrowMilestoneCardSchema,
  InvoiceCardSchema,
  RiskHoldCardSchema,
  AgentRecommendationCardSchema,
  ContractorPaymentCardSchema,
  FlightComparisonCardSchema,
]);
export type InteractiveCard = z.output<typeof InteractiveCardSchema>;
export type InteractiveCardType = InteractiveCard['type'];
export type CardOf<T extends InteractiveCardType> = Extract<
  InteractiveCard,
  { type: T }
>;

export const EXECUTION_MODE_LABEL: Record<
  z.output<typeof ExecutionModeSchema>,
  string
> = {
  REAL_TESTNET: 'Monad testnet (real testnet transaction)',
  PROVIDER_SANDBOX: 'Provider sandbox (no real money moved)',
  MAINNET_READ_ONLY: 'Mainnet read-only',
  MAINNET_SIMULATION: 'Mainnet simulation (nothing broadcast)',
  SIMULATION: 'Simulation (nothing broadcast)',
  CANARY_READY: 'Canary-ready (not executed)',
};
export const CARD_EXECUTION_MODE_LABEL: Record<CardExecutionMode, string> = {
  ...EXECUTION_MODE_LABEL,
  LIVE_ARC_TESTNET: 'Arc testnet (live testnet state)',
  LIVE_SEPOLIA: 'Sepolia testnet (live testnet state)',
  LOCAL_FIXTURE: 'Local fixture (nothing on any network)',
};

/** Card types that carry `observedAt`, `chainId` and a card execution mode. */
export const ARC_CARD_TYPES = [
  'ALLOCATION',
  'DEAL_PROPOSAL',
  'ESCROW_MILESTONE',
  'INVOICE',
  'RISK_HOLD',
  'AGENT_RECOMMENDATION',
  'CONTRACTOR_PAYMENT',
  'FLIGHT_COMPARISON',
] as const satisfies readonly InteractiveCardType[];
export type ArcCardType = (typeof ARC_CARD_TYPES)[number];
export type ArcCard = CardOf<ArcCardType>;
export const isArcCard = (card: InteractiveCard): card is ArcCard =>
  (ARC_CARD_TYPES as readonly string[]).includes(card.type);

/** Deterministic card id from the parts that define a card's state. */
export function cardIdOf(...parts: (string | number | bigint)[]): string {
  return `card_${keccak256(stringToHex(parts.map(String).join('|'))).slice(2, 26)}`;
}

/** Exact decimal string of integer base units (no rounding, no exponent). */
export function cardDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new Error('CARD_NEGATIVE_AMOUNT');
  if (decimals === 0) return units.toString();
  const d = 10n ** BigInt(decimals);
  const frac = (units % d)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${units / d}${frac ? `.${frac}` : ''}`;
}

/**
 * Same-origin path only: one leading slash, never `//host` (protocol-relative)
 * and never a scheme, so the review link cannot leave the Synq web origin.
 */
export const ReviewPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[A-Za-z0-9/_.:-]*$/);

/** Response of the authenticated card-link resolution endpoint. */
export const CardResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('OK'),
    memberId: z.string(),
    card: ApprovalProposalCardSchema,
    reviewPath: ReviewPathSchema,
  }),
  z.strictObject({
    status: z.literal('NOT_PENDING'),
    memberId: z.string(),
    card: ApprovalProposalCardSchema,
  }),
]);
export type CardResolution = z.output<typeof CardResolutionSchema>;

/** What a source package needs, besides its own domain object, to build an Arc-era card. */
export type ArcCardContext = Readonly<{
  /** Group or workspace the card belongs to. */
  groupId: string;
  groupLabel: string;
  /** Unix seconds the card is built (defaults to `observedAt`). */
  issuedAt?: number;
  /** Execution evidence label of the deployment that produced the facts. */
  executionMode: CardExecutionMode;
  /** Authenticated-page links only; a card action never approves. */
  actions?: readonly CardAction[];
}>;

/** Clips free text to a card line (whitespace collapsed, ellipsis when cut). */
export function cardLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s || '-' : `${s.slice(0, max - 1).trimEnd()}…`;
}
/** A card reference id from any id (characters outside the card id alphabet become `_`). */
export function cardRef(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
  return /^[a-zA-Z0-9]/.test(s) ? s : `r${s.slice(0, 127)}`;
}

/** Common fields of an Arc-era card; `parts` fix its id. */
export function arcCardBase(
  ctx: ArcCardContext,
  observedAt: number,
  ...parts: (string | number | bigint)[]
) {
  return {
    schema: CARD_SCHEMA,
    cardId: cardIdOf(...parts),
    groupId: cardRef(ctx.groupId),
    groupLabel: cardLine(ctx.groupLabel, 120),
    issuedAt: Math.max(ctx.issuedAt ?? observedAt, observedAt),
    observedAt,
    executionMode: ctx.executionMode,
    actions: [...(ctx.actions ?? [])].slice(0, 4),
  };
}
