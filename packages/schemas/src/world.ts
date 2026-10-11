import { z } from 'zod';
import {
  IdentityPrincipalKindSchema,
  VerifiedApprovalSchema,
} from './approval.js';
import { MandateSchema } from './index.js';
import { ActionStateSchema } from './lifecycle.js';
import {
  AssetIdentitySchema,
  ChainIdSchema,
  NetworkProfileSchema,
  ProfileNameSchema,
} from './network.js';
import {
  AddressSchema,
  AmountSchema,
  HashSchema,
  IdSchema,
  TimestampSchema,
} from './primitives.js';

export const PROVENANCES = [
  'CHAIN',
  'ENVIO',
  'POSTGRES',
  'PLUGIN',
  'TEMPORAL',
  'MARKET',
  'KERNEL',
  'CONFIG',
] as const;
export const ProvenanceSchema = z.enum(PROVENANCES);
export type Provenance = z.output<typeof ProvenanceSchema>;
export const FIELD_FRESHNESS = ['FRESH', 'STALE', 'UNKNOWN'] as const;
export const FieldFreshnessSchema = z.enum(FIELD_FRESHNESS);
export type FieldFreshness = z.output<typeof FieldFreshnessSchema>;

export const FieldMetaSchema = z.strictObject({
  provenance: ProvenanceSchema,
  source: z.string().min(1).max(128),
  observedAt: TimestampSchema.nullable(),
  freshness: FieldFreshnessSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200).optional(),
});
export type FieldMeta = z.output<typeof FieldMetaSchema>;
export function observedField<S extends z.ZodType>(value: S) {
  return z.strictObject({ value, meta: FieldMetaSchema });
}
export type Observed<T> = { value: T; meta: FieldMeta };

export const EXECUTION_MODES = [
  'REAL_TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'MAINNET_SIMULATION',
  'SIMULATION',
  'CANARY_READY',
] as const;
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.output<typeof ExecutionModeSchema>;

export const CAPABILITY_ACTIONS = [
  'READ',
  'QUOTE',
  'PREPARE',
  'SIMULATE',
  'BROADCAST',
  'TRANSFER',
  'TRADE',
  'CANCEL',
  'HEDGE',
  'FUND',
  'PRODUCTION_WRITE',
  'INDEX',
  'HUMAN_APPROVAL',
  'STRUCTURED_REASONING',
  'WEB_RESEARCH',
  'CRITIQUE',
] as const;
export const CapabilityActionSchema = z.enum(CAPABILITY_ACTIONS);
export type CapabilityAction = z.output<typeof CapabilityActionSchema>;
export const CAPABILITY_AVAILABILITY = [
  'AVAILABLE',
  'UNAVAILABLE_IN_NETWORK_PROFILE',
  'UNHEALTHY',
  'NOT_INSTALLED',
  'READ_ONLY',
  'REQUIRES_HUMAN',
] as const;
export const CapabilityAvailabilitySchema = z.enum(CAPABILITY_AVAILABILITY);
export type CapabilityAvailability = z.output<
  typeof CapabilityAvailabilitySchema
>;
export const PROVIDER_STATUSES = [
  'READY',
  'UNHEALTHY',
  'NOT_INSTALLED',
  'UNAVAILABLE_IN_PROFILE',
  'BLOCKED_NO_CREDENTIALS',
] as const;
export const ProviderStatusSchema = z.enum(PROVIDER_STATUSES);
export type ProviderStatus = z.output<typeof ProviderStatusSchema>;
export const CapabilityFactSchema = z.strictObject({
  action: CapabilityActionSchema,
  networks: z.array(ProfileNameSchema).min(1),
  mutating: z.boolean(),
  requiresHuman: z.boolean(),
  disabledBy: z.string().max(64).nullable(),
  note: z.string().max(240),
});
export type CapabilityFact = z.output<typeof CapabilityFactSchema>;
export const CapabilityNodeSchema = z.strictObject({
  providerId: IdSchema,
  pluginId: IdSchema.nullable(),
  kind: z.enum(['PLUGIN', 'MODEL_PROVIDER']),
  installed: z.boolean(),
  status: ProviderStatusSchema,
  statusReason: z.string().max(200).nullable(),
  facts: z.array(CapabilityFactSchema),
  sourceRefs: z.array(z.string().max(200)),
  health: z
    .strictObject({
      available: z.boolean(),
      checkedAt: TimestampSchema,
      reason: z.string().max(200).nullable(),
    })
    .nullable(),
});
export type CapabilityNode = z.output<typeof CapabilityNodeSchema>;
export const CapabilityVerdictSchema = z.strictObject({
  providerId: IdSchema,
  action: CapabilityActionSchema,
  network: ProfileNameSchema,
  availability: CapabilityAvailabilitySchema,
  reason: z.string().max(200),
});
export type CapabilityVerdict = z.output<typeof CapabilityVerdictSchema>;
export const CapabilityGraphViewSchema = z.strictObject({
  network: ProfileNameSchema,
  builtAt: TimestampSchema,
  nodes: z.array(CapabilityNodeSchema),
  flags: z.strictObject({ mainnetBroadcastAllowed: z.boolean() }),
});
export type CapabilityGraphView = z.output<typeof CapabilityGraphViewSchema>;

export const WorldMemberSchema = z.strictObject({
  memberId: IdSchema,
  principalId: IdSchema,
  principalKind: IdentityPrincipalKindSchema,
  role: z.enum(['APPROVER', 'OPERATOR']),
  signer: AddressSchema,
  ownerOfAccount: z.boolean(),
});
export const WorldGroupSchema = z.strictObject({
  groupId: IdSchema,
  chainGroupId: HashSchema,
  chainId: ChainIdSchema,
  account: AddressSchema,
  owners: z.array(AddressSchema),
  threshold: z.number().int().positive().nullable(),
  paused: z.boolean(),
  accountingStatus: z.enum(['OPEN', 'FROZEN']),
  membershipEpoch: z.number().int().nonnegative(),
});
export const QuorumStateSchema = z.strictObject({
  accountThreshold: z.number().int().positive().nullable(),
  approvers: z.number().int().nonnegative(),
  mandates: z.array(
    z.strictObject({
      mandateId: IdSchema,
      quorum: z.number().int().positive(),
      reviewApprovals: z.number().int().positive(),
      accountThreshold: z.number().int().positive(),
    }),
  ),
});
export const TreasuryPositionSchema = z.strictObject({
  asset: AssetIdentitySchema,
  balance: AmountSchema,
  reserved: AmountSchema,
  free: AmountSchema,
});
export type TreasuryPosition = z.output<typeof TreasuryPositionSchema>;
export const WorldMandateSchema = z.strictObject({
  mandateId: IdSchema,
  version: z.number().int().positive(),
  status: z.enum(['ACTIVE', 'REVOKED']),
  chainMandateId: HashSchema,
  onchainVersion: z.number().int().nonnegative().nullable(),
  inputAsset: AssetIdentitySchema,
  outputAssets: z.array(AssetIdentitySchema),
  perActionCap: AmountSchema,
  cumulativeBudget: AmountSchema,
  spentToken: AmountSchema,
  reservedToken: AmountSchema,
  maxSlippageBps: z.number().int().min(0).max(10_000),
  pluginIds: z.array(IdSchema),
  recipients: z.array(AddressSchema),
  validAfter: TimestampSchema,
  validUntil: TimestampSchema,
  terms: z.lazy(() => MandateSchema),
});
export type WorldMandate = z.output<typeof WorldMandateSchema>;
export const WorldProposalSchema = z.strictObject({
  intentHash: HashSchema,
  draftDigest: HashSchema,
  status: z.enum(['PENDING', 'INVALIDATED', 'APPROVED']),
  countedApprovals: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export const WorldIntentStateSchema = z.strictObject({
  intentId: IdSchema,
  state: ActionStateSchema,
  updatedAt: z.string().max(40),
});
export const WorldGrantSchema = z.strictObject({
  grantId: HashSchema,
  intentId: IdSchema,
  mandateId: IdSchema,
  state: z.string().max(32),
  maxInputAmount: AmountSchema,
  nativeValue: AmountSchema,
  validUntil: TimestampSchema,
});
export const WorldExecutionSchema = z.strictObject({
  nonce: AmountSchema,
  intentHash: HashSchema,
  tokenAmount: AmountSchema,
  recipient: AddressSchema,
  transactionHash: HashSchema,
  blockNumber: z.number().int().nonnegative(),
});
export const WorkflowStatusSchema = z.strictObject({
  workflowId: IdSchema,
  type: z.string().min(1).max(64),
  status: z.enum([
    'RUNNING',
    'WAITING_APPROVAL',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TERMINATED',
    'TIMED_OUT',
  ]),
  intentId: IdSchema.nullable(),
  startedAt: TimestampSchema,
  nextEventAt: TimestampSchema.nullable(),
});
export type WorkflowStatus = z.output<typeof WorkflowStatusSchema>;
export const MarketQuoteSchema = z.strictObject({
  pair: z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/),
  price: AmountSchema,
  priceDecimals: z.number().int().min(0).max(36),
  source: z.string().min(1).max(64),
  chainId: ChainIdSchema,
  observedAt: TimestampSchema,
  maxAgeSeconds: z.number().int().positive(),
});
export type MarketQuote = z.output<typeof MarketQuoteSchema>;
export const RiskStateSchema = z.strictObject({
  status: z.enum(['HEALTHY', 'DEGRADED', 'UNKNOWN', 'STALE']),
  reasons: z.array(z.string().max(200)),
  attestationRef: z.string().max(128).nullable(),
  referenceDeviationBps: z.number().int().min(0).max(10_000).nullable(),
});
export type RiskState = z.output<typeof RiskStateSchema>;
export const PluginHealthEntrySchema = z.strictObject({
  pluginId: IdSchema,
  available: z.boolean(),
  checkedAt: TimestampSchema.nullable(),
  reason: z.string().max(200).nullable(),
});
export const ProviderHealthEntrySchema = z.strictObject({
  providerId: IdSchema,
  status: z.enum([
    'READY',
    'MISSING_CREDENTIALS',
    'PARTNER_GATED',
    'DEGRADED',
    'DOWN',
    'BLOCKED',
  ]),
  environment: z.enum([
    'SANDBOX',
    'PRODUCTION',
    'MAINNET_READ_ONLY',
    'FIXTURE',
  ]),
  authState: z.enum(['READY', 'MISSING_CREDENTIALS', 'EXPIRED', 'BLOCKED']),
  circuit: z.enum(['CLOSED', 'OPEN']),
  verbs: z.array(z.string().min(1).max(32)),
  latencyMs: z.number().int().nonnegative().nullable(),
  lastSuccessfulAt: TimestampSchema.nullable(),
  lastCheckedAt: TimestampSchema.nullable(),
  lastError: z.string().max(200).nullable(),
});
export type ProviderHealthEntry = z.output<typeof ProviderHealthEntrySchema>;
export const ReadModelFreshnessSchema = z.strictObject({
  indexedThroughBlock: z.number().int().nonnegative(),
  headBlock: z.number().int().nonnegative(),
  lagBlocks: z.number().int().nonnegative(),
  maxLagBlocks: z.number().int().nonnegative(),
  status: z.enum(['FRESH', 'STALE', 'FROZEN', 'INCONSISTENT']),
});
export const SourceFreshnessSchema = z.strictObject({
  source: z.string().min(1).max(64),
  provenance: ProvenanceSchema,
  freshness: FieldFreshnessSchema,
  observedAt: TimestampSchema.nullable(),
  reason: z.string().max(200).nullable(),
});
export type SourceFreshness = z.output<typeof SourceFreshnessSchema>;

export const WORLD_MODEL_SCHEMA_VERSION = 1;
export const WorldModelSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(WORLD_MODEL_SCHEMA_VERSION),
  snapshotId: HashSchema,
  generatedAt: TimestampSchema,
  network: observedField(NetworkProfileSchema),
  readModel: observedField(ReadModelFreshnessSchema.nullable()),
  group: observedField(WorldGroupSchema.nullable()),
  members: observedField(z.array(WorldMemberSchema)),
  principalTypes: observedField(z.array(IdentityPrincipalKindSchema)),
  quorum: observedField(QuorumStateSchema),
  treasury: observedField(z.array(TreasuryPositionSchema)),
  mandates: observedField(z.array(WorldMandateSchema)),
  proposals: observedField(z.array(WorldProposalSchema)),
  approvals: observedField(
    z.array(VerifiedApprovalSchema.omit({ signature: true })),
  ),
  kernelIntents: observedField(z.array(WorldIntentStateSchema)),
  pendingExecutions: observedField(z.array(WorldGrantSchema)),
  recentExecutions: observedField(z.array(WorldExecutionSchema)),
  pluginHealth: observedField(z.array(PluginHealthEntrySchema)),
  providerHealth: observedField(z.array(ProviderHealthEntrySchema)).optional(),
  capabilities: observedField(CapabilityGraphViewSchema),
  workflows: observedField(z.array(WorkflowStatusSchema)),
  marketSnapshots: observedField(z.array(MarketQuoteSchema)),
  riskState: observedField(RiskStateSchema),
  sourceFreshness: z.array(SourceFreshnessSchema),
});
export type WorldModelSnapshot = z.output<typeof WorldModelSnapshotSchema>;
export type WorldModelSnapshotInput = z.input<typeof WorldModelSnapshotSchema>;
