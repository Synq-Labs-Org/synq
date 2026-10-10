import { z } from 'zod';
import {
  AssetIdentitySchema,
  AssetSchema,
  ChainIdSchema,
  NetworkProfileSchema,
} from './network.js';
import { ActionIntentSchema, ActionKindSchema } from './intent.js';
import { PrincipalKindSchema } from './events.js';
import { ActionStateSchema, TxStateSchema } from './lifecycle.js';
import {
  GrantDraftSchema,
  IdentityPrincipalKindSchema,
  VerifiedApprovalSchema,
} from './approval.js';
import {
  AddressSchema,
  AmountSchema,
  BpsSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  IntentIdSchema,
  MandateIdSchema,
  MemberIdSchema,
  NonZeroAddressSchema,
  PluginIdSchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  SelectorSchema,
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
export const TIERS = ['AUTO', 'REVIEW', 'CONSENSUS', 'BLOCKED'] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.output<typeof TierSchema>;
export const MandateBindingSchema = z.strictObject({
  pluginId: PluginIdSchema,
  action: ActionKindSchema,
  target: NonZeroAddressSchema,
  selector: SelectorSchema,
});
export type MandateBinding = z.output<typeof MandateBindingSchema>;
export const RecipientPurposeSchema = z.enum([
  'COUNTERPARTY',
  'MEMBER_WITHDRAWAL',
  'SELF',
]);
export type RecipientPurpose = z.output<typeof RecipientPurposeSchema>;
export const MandateRecipientSchema = z.strictObject({
  address: NonZeroAddressSchema,
  purpose: RecipientPurposeSchema,
});
export type MandateRecipient = z.output<typeof MandateRecipientSchema>;
const SpendBandSchema = z
  .strictObject({ autoMax: AmountSchema, reviewMax: AmountSchema })
  .refine((v) => amountOrder(v.autoMax, v.reviewMax), {
    path: ['reviewMax'],
    message: 'reviewMax must be at least autoMax',
  });
export const TierPolicySchema = z.strictObject({
  tokenSpend: SpendBandSchema,
  nativeSpend: SpendBandSchema,
  actionFloors: z
    .array(z.strictObject({ action: ActionKindSchema, tier: TierSchema }))
    .refine((v) => new Set(v.map((x) => x.action)).size === v.length, {
      message: 'duplicate action floor',
    }),
  newOutputAsset: z.enum(['CONSENSUS', 'BLOCKED']),
  leverage: z.enum(['CONSENSUS', 'BLOCKED']),
  withdrawal: z.enum(['UNANIMOUS', 'CONSENSUS', 'BLOCKED']),
});
export type TierPolicy = z.output<typeof TierPolicySchema>;
export const ApprovalPolicySchema = z.strictObject({
  quorum: z.number().int().positive(),
  reviewApprovals: z.number().int().positive(),
  accountThreshold: z.number().int().positive(),
  eligibleKinds: z
    .array(IdentityPrincipalKindSchema)
    .min(1)
    .refine((v) => new Set(v).size === v.length, 'duplicate principal kind')
    .refine(
      (v) => !v.includes('DYNAMIC_OPERATOR'),
      'operator principals can never approve',
    ),
});
export type ApprovalPolicy = z.output<typeof ApprovalPolicySchema>;
export const DelegationScopeSchema = z.strictObject({
  actions: z.array(ActionKindSchema).min(1),
  maxInputPerAction: AmountSchema,
  maxNativePerAction: AmountSchema,
  periodSeconds: z.number().int().positive(),
  maxUsesPerPeriod: z.number().int().positive(),
});
export type DelegationScope = z.output<typeof DelegationScopeSchema>;
export const MANDATE_LIST_LIMIT = 32;
export const MANDATE_SCHEMA_VERSION = 2;
export const MandateSchema = z
  .strictObject({
    schemaVersion: z.literal(MANDATE_SCHEMA_VERSION),
    mandateId: MandateIdSchema,
    groupId: GroupIdSchema,
    version: z.number().int().positive(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    network: NetworkProfileSchema,
    account: NonZeroAddressSchema,
    chainGroupId: HashSchema,
    operators: z.array(NonZeroAddressSchema).min(1),
    bindings: z.array(MandateBindingSchema).min(1),
    recipients: z.array(MandateRecipientSchema).min(1),
    inputAsset: AssetSchema,
    outputAssets: z.array(AssetSchema),
    perActionCap: AmountSchema,
    cumulativeBudget: AmountSchema,
    maxNativeValue: AmountSchema,
    cumulativeNativeBudget: AmountSchema,
    maxSlippageBps: BpsSchema,
    maxReferenceDeviationBps: BpsSchema,
    maxLeverageBps: z.number().int().min(0).max(1_000_000),
    maxAllocationBps: BpsSchema,
    tierPolicy: TierPolicySchema,
    approvalPolicy: ApprovalPolicySchema,
    delegationScope: DelegationScopeSchema.nullable(),
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
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (v.validUntil <= v.validAfter)
      issue(['validUntil'], 'validUntil must be after validAfter');
    if (v.inputAsset.chainId !== v.network.chainId)
      issue(['inputAsset', 'chainId'], 'input asset is on another network');
    v.outputAssets.forEach((a, i) => {
      if (a.chainId !== v.network.chainId)
        issue(['outputAssets', i, 'chainId'], 'output asset network mismatch');
    });
    if (!amountOrder(v.perActionCap, v.cumulativeBudget))
      issue(['perActionCap'], 'per-action cap exceeds cumulative budget');
    if (!amountOrder(v.maxNativeValue, v.cumulativeNativeBudget))
      issue(['maxNativeValue'], 'native cap exceeds cumulative native budget');
    const active = v.members.filter((m) => m.active).length;
    const policy = v.approvalPolicy;
    if (policy.quorum > active)
      issue(['approvalPolicy', 'quorum'], 'quorum exceeds active members');
    if (policy.reviewApprovals > policy.quorum)
      issue(['approvalPolicy', 'reviewApprovals'], 'review exceeds quorum');
    if (policy.accountThreshold > v.members.length)
      issue(['approvalPolicy', 'accountThreshold'], 'threshold exceeds owners');
    if (policy.eligibleKinds.includes('PRIVY_DELEGATE') && !v.delegationScope)
      issue(['delegationScope'], 'delegated approvals need a scope');
    if (new Set(v.members.map((m) => m.memberId)).size !== v.members.length)
      issue(['members'], 'duplicate member id');
    const signers = new Set(v.members.map((m) => m.signer));
    if (signers.size !== v.members.length)
      issue(['members'], 'duplicate member signer');
    if (new Set(v.operators).size !== v.operators.length)
      issue(['operators'], 'duplicate operator');
    v.operators.forEach((o, i) => {
      if (signers.has(o))
        issue(['operators', i], 'an operator cannot be an account owner');
    });
    const tuples = new Set(
      v.bindings.map((b) =>
        JSON.stringify([b.pluginId, b.action, b.target, b.selector]),
      ),
    );
    if (tuples.size !== v.bindings.length)
      issue(['bindings'], 'duplicate binding tuple');
    const calls = new Set(v.bindings.map((b) => `${b.target}:${b.selector}`));
    if (calls.size > MANDATE_LIST_LIMIT)
      issue(['bindings'], 'too many (target, selector) pairs');
    v.bindings.forEach((b, i) => {
      if (b.target === v.account)
        issue(['bindings', i, 'target'], 'account cannot be a call target');
    });
    if (v.recipients.length > MANDATE_LIST_LIMIT)
      issue(['recipients'], 'too many recipients');
    if (
      new Set(v.recipients.map((r) => r.address)).size !== v.recipients.length
    )
      issue(['recipients'], 'duplicate recipient');
    v.recipients.forEach((r, i) => {
      if (r.address === v.inputAsset.address)
        issue(['recipients', i], 'the token contract cannot be a recipient');
      if ((r.purpose === 'SELF') !== (r.address === v.account))
        issue(['recipients', i, 'purpose'], 'SELF is exactly the account');
      if ((r.purpose === 'MEMBER_WITHDRAWAL') !== signers.has(r.address))
        issue(
          ['recipients', i, 'purpose'],
          'member addresses are withdrawal recipients and only they are',
        );
    });
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
  quotedOutputAmount: AmountSchema.optional(),
  postTradeAllocationBps: BpsSchema.optional(),
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
export const GRANT_SCHEMA_VERSION = 2;
export const ExecutionGrantSchema = z
  .strictObject({
    schemaVersion: z.literal(GRANT_SCHEMA_VERSION),
    grantId: HashSchema,
    intentId: IntentIdSchema,
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
    inputAsset: AssetSchema.nullable(),
    maxInputAmount: AmountSchema,
    outputToken: AddressSchema.nullable(),
    minOutputAmount: AmountSchema,
    nativeValue: AmountSchema,
    recipient: AddressSchema,
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    nonce: AmountSchema,
    evidenceHash: HashSchema,
    riskPacketHash: HashSchema,
    simulationHash: HashSchema,
    policyResultHash: HashSchema,
    tier: TierSchema.exclude(['BLOCKED']),
    requiredApprovals: z.number().int().nonnegative(),
    issuedAt: TimestampSchema,
    draft: GrantDraftSchema,
    approvals: z.array(VerifiedApprovalSchema),
  })
  .superRefine((v, ctx) => {
    const g = v.draft.grant;
    const zero = `0x${'0'.repeat(40)}`;
    const pairs: [string, unknown, unknown][] = [
      ['grantId', v.grantId, v.draft.digest],
      ['groupId', v.groupId, v.draft.groupId],
      ['intentHash', v.intentHash, g.intentHash],
      ['mandateVersion', String(v.mandateVersion), g.mandateVersion],
      ['operator', v.operator, g.executor],
      ['chainId', String(v.chainId), g.chainId],
      ['chainId', v.chainId, v.draft.domain.chainId],
      ['account', v.account, g.account],
      ['target', v.target, g.target],
      ['selector', v.selector, g.selector],
      ['calldataHash', v.calldataHash, g.calldataHash],
      ['inputAsset', v.inputAsset?.address ?? zero, g.token],
      ['maxInputAmount', v.maxInputAmount, g.maxInputAmount],
      ['nativeValue', v.nativeValue, g.nativeValue],
      ['minOutputAmount', v.minOutputAmount, g.minOutputAmount],
      ['recipient', v.recipient, g.recipient],
      ['validAfter', String(v.validAfter), g.validAfter],
      ['validUntil', String(v.validUntil), g.validUntil],
      ['nonce', v.nonce, g.nonce],
    ];
    for (const [path, a, b] of pairs)
      if (a !== b)
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: 'grant field differs from its signed draft',
        });
    if (v.validUntil <= v.validAfter)
      ctx.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'invalid grant validity',
      });
  });
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
  asset: AssetIdentitySchema,
  amount: AmountSchema,
  expiresAt: TimestampSchema,
  status: z.enum(['RESERVED', 'CONSUMED', 'RELEASED', 'RECONCILED']),
});
export const TreasuryBalanceSchema = z.strictObject({
  account: AddressSchema,
  asset: AssetIdentitySchema,
  balance: AmountSchema,
});
export const GrantExecutedEventSchema = z.strictObject({
  groupId: HashSchema,
  intentHash: HashSchema,
  mandateId: HashSchema,
  mandateVersion: AmountSchema,
  account: AddressSchema,
  executor: AddressSchema,
  pluginId: HashSchema,
  chainId: AmountSchema,
  nonce: AmountSchema,
  grantHash: HashSchema,
  target: AddressSchema,
  selector: SelectorSchema,
  calldataHash: HashSchema,
  token: AddressSchema,
  recipient: AddressSchema,
  tokenAmount: AmountSchema,
  nativeValue: AmountSchema,
  outputAmount: AmountSchema,
});
export type GrantExecutedEvent = z.output<typeof GrantExecutedEventSchema>;
export const GrantExecutionObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    chainId: ChainIdSchema,
    transactionHash: HashSchema,
    blockNumber: AmountSchema,
    receiptStatus: z.enum(['success', 'reverted']),
    emitter: AddressSchema.nullable(),
    event: GrantExecutedEventSchema.nullable(),
  })
  .refine(
    (v) =>
      v.receiptStatus === 'success'
        ? v.event !== null && v.emitter !== null
        : v.event === null,
    'a successful receipt carries exactly its decoded GrantExecuted event',
  );
export type GrantExecutionObservation = z.output<
  typeof GrantExecutionObservationSchema
>;
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
  approvals: z.array(VerifiedApprovalSchema),
  reservations: z.array(ReservationSchema),
  coreAsset: z.literal('AUSD'),
  generatedAt: TimestampSchema,
  chainHead: AmountSchema,
  indexedHead: AmountSchema,
});
export type Mandate = z.output<typeof MandateSchema>;
export type MandateInput = z.input<typeof MandateSchema>;
export type ExecutionGrant = z.output<typeof ExecutionGrantSchema>;
export type RiskPacket = z.output<typeof RiskPacketSchema>;
export type Simulation = z.output<typeof SimulationSchema>;
export type ExecutionReceipt = z.output<typeof ExecutionReceiptSchema>;
export type Reservation = z.output<typeof ReservationSchema>;
export type TreasuryBalance = z.output<typeof TreasuryBalanceSchema>;
export type WorldSnapshot = z.output<typeof WorldSnapshotSchema>;
export type Member = z.output<typeof MemberSchema>;
export type Principal = z.output<typeof PrincipalSchema>;
export type Group = z.output<typeof GroupSchema>;
export type Proposal = z.output<typeof ProposalSchema>;
export * from './identity.js';
export * from './workflow.js';
