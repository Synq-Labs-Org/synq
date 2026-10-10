import { z } from 'zod';
import {
  AssetSchema,
  AddressSchema,
  HashSchema,
  BoundActionIntentSchema,
  RiskPacketSchema,
  SimulationSchema,
} from '@synq/domain';
import { AUSD_GUARD_REASONS } from './guard.js';
import { EXECUTION_MODES, FUNDING_ROUTES, TokenRefSchema } from './types.js';
import { FUNDING_STATES, type FundingSession } from './session.js';
import { SEND_STATES, type SendPreview, type SendRecord } from './send.js';
import { contentHash } from './canonical.js';

const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ReceiptSchema = z.strictObject({
  chainId: z.number().int().positive(),
  token: AddressSchema,
  from: AddressSchema,
  to: AddressSchema,
  amount: uint,
  transactionHash: HashSchema,
  logIndex: time,
  blockNumber: time,
});
const QuoteSchema = z.strictObject({
  quoteId: z.string().min(1),
  route: z.enum(FUNDING_ROUTES),
  provider: z.string(),
  mode: z.enum(EXECUTION_MODES),
  dry: z.boolean(),
  source: TokenRefSchema,
  destination: TokenRefSchema,
  recipient: z.string(),
  sourceSender: z.string().optional(),
  destinationSender: z.string().optional(),
  amountIn: uint,
  amountOut: uint,
  minAmountOut: uint,
  fees: z.array(
    z.strictObject({
      kind: z.enum([
        'NETWORK',
        'PROTOCOL',
        'APP',
        'REFUND',
        'WITHDRAW',
        'MESSAGING',
      ]),
      token: TokenRefSchema,
      amount: uint,
    }),
  ),
  quotedAt: time,
  expiresAt: time,
  timeEstimateSeconds: time.nullable(),
  depositAddress: z.string().nullable(),
  correlationId: z.string().nullable(),
  artifactHash: HashSchema,
});
export const FundingSessionSchema = z.strictObject({
  sessionId: HashSchema,
  groupId: z.string().min(1),
  route: z.enum(FUNDING_ROUTES),
  idempotencyKey: z.string().min(1),
  quote: QuoteSchema,
  state: z.enum(FUNDING_STATES),
  sourceTransactionHash: HashSchema.nullable(),
  sourceReceipt: ReceiptSchema.nullable(),
  providerStatus: z
    .enum([
      'PENDING_DEPOSIT',
      'KNOWN_DEPOSIT_TX',
      'INCOMPLETE_DEPOSIT',
      'PROCESSING',
      'SUCCESS',
      'REFUNDED',
      'FAILED',
    ])
    .nullable(),
  providerUpdates: z.array(z.string()),
  receipt: ReceiptSchema.nullable(),
  receivedAmount: uint.nullable(),
  shortfall: uint.nullable(),
  creditId: z.string().nullable(),
  creditedAmount: uint.nullable(),
  history: z
    .array(
      z.strictObject({
        from: z.enum(FUNDING_STATES).nullable(),
        to: z.enum(FUNDING_STATES),
        at: time,
        cause: z.string(),
      }),
    )
    .min(1),
});
const GuardSchema = z.strictObject({
  status: z.enum(['PASS', 'BLOCKED']),
  chainId: z.number().int().positive(),
  token: AddressSchema,
  account: AddressSchema,
  recipient: AddressSchema,
  amount: uint,
  blockNumber: uint.nullable(),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      value: z.boolean().nullable(),
      error: z.string().nullable(),
    }),
  ),
  reasons: z.array(z.enum(AUSD_GUARD_REASONS)),
});
export const SendPreviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  previewId: HashSchema,
  groupId: z.string(),
  account: AddressSchema,
  mandateId: z.string(),
  mandateVersion: z.number().int().positive(),
  recipient: z.strictObject({
    recipientId: z.string(),
    kind: z.enum(['MEMBER', 'CONTACT']),
    label: z.string(),
    address: AddressSchema,
    memberId: z.string().nullable(),
    principalId: z.string().nullable(),
    sendable: z.boolean(),
  }),
  asset: AssetSchema,
  amount: uint,
  amountDecimal: z.string(),
  chainId: z.number().int().positive(),
  profile: z.string(),
  createdAt: time,
  expiresAt: time,
  policy: z.strictObject({
    tier: z.enum(['PERSONAL', 'REVIEW', 'QUORUM']),
    kernelTier: z.enum(['AUTO', 'REVIEW', 'CONSENSUS']),
    policyApprovals: time,
    accountThreshold: time,
    requiredApprovals: time,
  }),
  treasury: z.strictObject({ free: uint, freeAfter: uint }),
  guard: GuardSchema,
  digest: HashSchema,
});
export const SendRecordSchema = z.strictObject({
  sendId: HashSchema,
  state: z.enum(SEND_STATES),
  preview: SendPreviewSchema,
  intentId: z.string().nullable(),
  intentHash: HashSchema.nullable(),
  draftDigest: HashSchema.nullable(),
  kernelCode: z.string().nullable(),
  kernelTier: z.string().nullable(),
  grantId: z.string().nullable(),
  receipt: z
    .strictObject({
      transactionHash: HashSchema,
      blockNumber: uint,
      explorer: z.string().nullable(),
      recipientBalanceBefore: uint,
      recipientBalanceAfter: uint,
      recipientDelta: uint,
      indexedThroughBlock: time,
      grantExecutedIndexed: z.boolean(),
      submittedAt: time,
      confirmedAt: time,
      indexedAt: time,
      latencyMs: z.strictObject({
        submitToConfirmed: time,
        submitToIndexed: time,
      }),
    })
    .nullable(),
  sender: z
    .strictObject({
      memberId: z.string(),
      signer: AddressSchema,
      signature: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .transform((v) => v as `0x${string}`),
    })
    .nullable(),
  confirmationProtocol: z.literal(2).nullable().default(null),
  proposal: z
    .strictObject({
      intent: BoundActionIntentSchema,
      risk: RiskPacketSchema,
      simulation: SimulationSchema,
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
    })
    .nullable(),
  history: z
    .array(
      z.strictObject({
        state: z.enum(SEND_STATES),
        at: time,
        note: z.string(),
      }),
    )
    .min(1),
});

export function parseStoredPreview(raw: unknown): SendPreview {
  const p = SendPreviewSchema.parse(raw);
  const { digest, ...body } = p;
  if (contentHash(body) !== digest) throw new Error('STORED_PREVIEW_TAMPERED');
  return p;
}
export function parseStoredSend(raw: unknown): SendRecord {
  const r = SendRecordSchema.parse(raw);
  parseStoredPreview(r.preview);
  if (
    r.sendId !==
      contentHash({ kind: 'SynqSend', previewId: r.preview.previewId }) ||
    r.history.at(-1)!.state !== r.state
  )
    throw new Error('STORED_SEND_INVALID');
  return r;
}
export function parseStoredFunding(raw: unknown): FundingSession {
  const s = FundingSessionSchema.parse(raw);
  if (
    s.route !== s.quote.route ||
    s.history.at(-1)!.to !== s.state ||
    (s.state === 'CREDITED' &&
      (!s.receipt ||
        s.creditId !==
          `${s.receipt.chainId}:${s.receipt.transactionHash}:${s.receipt.logIndex}` ||
        s.creditedAmount !== s.receipt.amount ||
        s.receivedAmount !== s.receipt.amount))
  )
    throw new Error('STORED_FUNDING_INVALID');
  return s;
}
