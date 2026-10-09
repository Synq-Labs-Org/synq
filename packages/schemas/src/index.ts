import { z } from 'zod';
import { AssetSchema, ChainIdSchema, NetworkProfileSchema } from './network.js';
import { ActionIntentSchema, ActionKindSchema } from './intent.js';
import { PrincipalKindSchema } from './events.js';
import { ActionStateSchema, TxStateSchema } from './lifecycle.js';
import {
  AddressSchema,
  AmountSchema,
  BpsSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  MandateIdSchema,
  MemberIdSchema,
  PluginIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  SelectorSchema,
  SignatureSchema,
  TimestampSchema,
  canonicalBigInt,
} from './primitives.js';

export * from './primitives.js';
export * from './network.js';
export * from './intent.js';
export * from './plugin.js';
export * from './events.js';
export * from './lifecycle.js';
export * from './approval.js';

export const MemberSchema = z.strictObject({
  memberId: MemberIdSchema,
  signer: AddressSchema,
  active: z.boolean(),
});
const amountOrder = (a: string, b: string) => {
  const x = canonicalBigInt(a),
    y = canonicalBigInt(b);
  return x !== null && y !== null && x <= y;
};
export const MandateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mandateId: MandateIdSchema,
    groupId: GroupIdSchema,
    version: z.number().int().positive(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    network: NetworkProfileSchema,
    account: AddressSchema,
    operators: z.array(AddressSchema).min(1),
    plugins: z.array(PluginIdSchema).min(1),
    actions: z.array(ActionKindSchema).min(1),
    targets: z.array(AddressSchema).min(1),
    selectors: z.array(SelectorSchema).min(1),
    inputAsset: AssetSchema,
    outputAssets: z.array(AssetSchema),
    allowNewOutputAssets: z.boolean(),
    perActionCap: AmountSchema,
    cumulativeBudget: AmountSchema,
    maxNativeValue: AmountSchema,
    maxSlippageBps: BpsSchema,
    maxReferenceDeviationBps: BpsSchema,
    maxLeverageBps: z.number().int().min(0).max(1_000_000),
    autoCap: AmountSchema,
    reviewCap: AmountSchema,
    quorum: z.number().int().positive(),
    members: z.array(MemberSchema).min(1),
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    quoteTtlSeconds: z.number().int().positive(),
    evidenceTtlSeconds: z.number().int().positive(),
    simulationTtlSeconds: z.number().int().positive(),
    maxGrantTtlSeconds: z.number().int().positive(),
    minIntervalSeconds: z.number().int().nonnegative(),
    maxExecutions: z.number().int().positive(),
  })
  .refine(
    (v) =>
      v.validUntil > v.validAfter &&
      v.inputAsset.chainId === v.network.chainId &&
      amountOrder(v.autoCap, v.reviewCap) &&
      amountOrder(v.reviewCap, v.perActionCap) &&
      amountOrder(v.perActionCap, v.cumulativeBudget) &&
      v.quorum <= v.members.filter((m) => m.active).length &&
      new Set(v.members.map((m) => m.memberId)).size === v.members.length &&
      new Set(v.members.map((m) => m.signer)).size === v.members.length,
    'invalid mandate envelope',
  );
export const ApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  groupId: GroupIdSchema,
  mandateId: MandateIdSchema,
  mandateVersion: z.number().int().positive(),
  intentHash: HashSchema,
  memberId: MemberIdSchema,
  signer: AddressSchema,
  expiresAt: TimestampSchema,
  nonce: AmountSchema,
  signature: SignatureSchema,
});
export const EvidenceSchema = z.strictObject({
  source: IdSchema,
  retrievedAt: TimestampSchema,
  chainId: ChainIdSchema,
  artifactHash: HashSchema,
  untrusted: z.boolean(),
});
export const RiskPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intentHash: HashSchema,
  evaluatedAt: TimestampSchema,
  quoteAt: TimestampSchema,
  quoteExpiresAt: TimestampSchema,
  slippageBps: BpsSchema,
  referenceDeviationBps: BpsSchema,
  maxReferenceDeviationBps: BpsSchema,
  blocked: z.boolean(),
  evidence: z.array(EvidenceSchema).min(1),
});
export const SimulationSchema = z.strictObject({
  intentHash: HashSchema,
  calldataHash: HashSchema,
  chainId: ChainIdSchema,
  account: AddressSchema,
  target: AddressSchema,
  succeeded: z.boolean(),
  simulatedAt: TimestampSchema,
  blockNumber: AmountSchema,
  artifactHash: HashSchema,
});
export const ExecutionGrantSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    grantId: HashSchema,
    intentHash: HashSchema,
    groupId: GroupIdSchema,
    mandateId: MandateIdSchema,
    mandateVersion: z.number().int().positive(),
    operator: AddressSchema,
    pluginId: PluginIdSchema,
    chainId: ChainIdSchema,
    account: AddressSchema,
    target: AddressSchema,
    selector: SelectorSchema,
    calldataHash: HashSchema,
    inputAsset: AssetSchema,
    maxInputAmount: AmountSchema,
    outputToken: AddressSchema.nullable(),
    minOutputAmount: AmountSchema,
    nativeValue: AmountSchema,
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    nonce: AmountSchema,
    evidenceHash: HashSchema,
    riskPacketHash: HashSchema,
    simulationHash: HashSchema,
    tier: z.enum(['AUTO', 'REVIEW', 'CONSENSUS']),
  })
  .refine((v) => v.validUntil > v.validAfter, 'invalid grant validity');
export const ExecutionReceiptSchema = z.strictObject({
  grantId: HashSchema,
  intentHash: HashSchema,
  transactionHash: HashSchema,
  chainId: ChainIdSchema,
  actualInputAmount: AmountSchema,
  actualOutputAmount: AmountSchema,
  state: TxStateSchema.extract([
    'SUBMITTED',
    'INCLUDED',
    'CONFIRMED',
    'INDEXED',
    'RECONCILED',
    'SETTLED',
  ]),
  outcome: z.enum(['SUCCESS', 'REVERTED']).nullable(),
  blockNumber: AmountSchema.nullable(),
});
export const ReservationSchema = z.strictObject({
  grantId: HashSchema,
  mandateId: MandateIdSchema,
  groupId: GroupIdSchema,
  asset: AssetSchema,
  amount: AmountSchema,
  expiresAt: TimestampSchema,
  status: z.enum(['RESERVED', 'CONSUMED', 'RELEASED', 'RECONCILED']),
});
export const TreasuryBalanceSchema = z.strictObject({
  account: AddressSchema,
  asset: AssetSchema,
  balance: AmountSchema,
});
export const PrincipalSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: PrincipalKindSchema,
  address: AddressSchema.nullable(),
});
export const GroupSchema = z.strictObject({
  groupId: GroupIdSchema,
  account: AddressSchema,
  network: NetworkProfileSchema,
  coreTreasuryAsset: z.literal('AUSD'),
});
export const ProposalSchema = z.strictObject({
  proposalId: ProposalIdSchema,
  intent: ActionIntentSchema,
  status: ActionStateSchema.extract([
    'PROPOSED',
    'RISKED',
    'SIMULATED',
    'PENDING_APPROVAL',
    'AUTHORIZED',
    'POLICY_REJECTED',
    'RISK_REJECTED',
    'EXPIRED',
    'CANCELLED',
  ]),
});
export const WorldSnapshotSchema = z.strictObject({
  group: GroupSchema,
  members: z.array(MemberSchema),
  mandates: z.array(MandateSchema),
  proposals: z.array(ProposalSchema),
  approvals: z.array(ApprovalSchema),
  reservations: z.array(ReservationSchema),
  coreAsset: z.literal('AUSD'),
  generatedAt: TimestampSchema,
  chainHead: AmountSchema,
  indexedHead: AmountSchema,
});
export type Mandate = z.output<typeof MandateSchema>;
export type ExecutionGrant = z.output<typeof ExecutionGrantSchema>;
export type Approval = z.output<typeof ApprovalSchema>;
export type RiskPacket = z.output<typeof RiskPacketSchema>;
export type Simulation = z.output<typeof SimulationSchema>;
export type ExecutionReceipt = z.output<typeof ExecutionReceiptSchema>;
export type Reservation = z.output<typeof ReservationSchema>;
export type WorldSnapshot = z.output<typeof WorldSnapshotSchema>;
export type Member = z.output<typeof MemberSchema>;
export type Principal = z.output<typeof PrincipalSchema>;
export type Group = z.output<typeof GroupSchema>;
export type Proposal = z.output<typeof ProposalSchema>;
