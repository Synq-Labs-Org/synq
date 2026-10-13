import { z } from 'zod';
import { ExecutionModeSchema } from './world.js';

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

export const InteractiveCardSchema = z.discriminatedUnion('type', [
  GroupTreasuryCardSchema,
  ApprovalProposalCardSchema,
  GroupGiftCardSchema,
  HotelComparisonCardSchema,
  DcaMandateCardSchema,
  ExecutionReceiptCardSchema,
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
