import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';
import { BoundActionIntentSchema } from './intent.js';
import {
  GroupIdSchema,
  HashSchema,
  IdSchema,
  ProposalIdSchema,
  TimestampSchema,
} from './primitives.js';
import {
  ExecutionModeSchema,
  FieldFreshnessSchema,
  ProvenanceSchema,
  SourceFreshnessSchema,
} from './world.js';

export function canonicalJsonOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonOf).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonOf(v)}`)
      .join(',')}}`;
  if (typeof value === 'bigint') throw new Error('BIGINT_WIRE_VALUE');
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('UNDEFINED_CANONICAL_VALUE');
  return result;
}
export function canonicalArtifactHash(value: unknown): `0x${string}` {
  return keccak256(stringToHex(canonicalJsonOf(value)));
}

export const MODEL_ROLES = [
  'SUPERVISOR',
  'INTENT',
  'RESEARCH',
  'CRITIC',
  'RISK',
  'FUNDING',
  'TRADING',
  'COMMERCE',
] as const;
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.output<typeof ModelRoleSchema>;
export const FIXTURE_LABELS = [
  'HAND_AUTHORED_FIXTURE',
  'RECORDED_LIVE',
] as const;
export const FixtureLabelSchema = z.enum(FIXTURE_LABELS);
export type FixtureLabel = z.output<typeof FixtureLabelSchema>;
export const ModelCallRecordSchema = z.strictObject({
  role: ModelRoleSchema,
  agentId: IdSchema,
  provider: z.enum(['qwen', 'kimi', 'openai', 'deterministic']),
  model: z.string().min(1).max(64),
  mode: z.enum(['LIVE', 'REPLAY', 'NONE']),
  fixtureLabel: FixtureLabelSchema.nullable(),
  requestHash: HashSchema,
  responseHash: HashSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  outcome: z.enum(['OK', 'PARSE_REJECTED', 'PROVIDER_ERROR', 'BLOCKED']),
});
export type ModelCallRecord = z.output<typeof ModelCallRecordSchema>;

export const UntrustedEvidenceSchema = z.strictObject({
  evidenceId: IdSchema,
  kind: z.enum([
    'WEB_SEARCH_RESULT',
    'WEB_PAGE',
    'MEMBER_MESSAGE',
    'API_RESPONSE',
  ]),
  origin: z.string().min(1).max(512),
  retrievedAt: TimestampSchema,
  contentHash: HashSchema,
  excerpt: z.string().max(2000),
  untrusted: z.literal(true),
  injectionSignals: z.array(z.string().max(64)),
});
export type UntrustedEvidence = z.output<typeof UntrustedEvidenceSchema>;

export const ClaimSchema = z.strictObject({
  claimId: IdSchema,
  role: ModelRoleSchema,
  text: z.string().min(1).max(500),
  evidenceRefs: z.array(IdSchema),
  derivedFromUntrusted: z.boolean(),
});
export const UncertaintySchema = z.strictObject({
  role: ModelRoleSchema,
  topic: z.string().min(1).max(120),
  level: z.number().min(0).max(1),
  note: z.string().max(500),
});
export const ContradictionSchema = z.strictObject({
  topic: z.string().min(1).max(120),
  positions: z
    .array(
      z.strictObject({
        role: ModelRoleSchema,
        position: z.string().max(500),
      }),
    )
    .min(2),
  material: z.boolean(),
});
export type Contradiction = z.output<typeof ContradictionSchema>;
export const CriticResultSchema = z.strictObject({
  verdict: z.enum(['SUPPORT', 'OBJECT', 'UNCERTAIN', 'NOT_RUN']),
  issues: z.array(z.string().max(500)),
  uncertainty: z.number().min(0).max(1),
});
export type CriticResult = z.output<typeof CriticResultSchema>;
export const RoleReviewSchema = z.strictObject({
  role: ModelRoleSchema,
  agentId: IdSchema.nullable(),
  itemIndexes: z.array(z.number().int().nonnegative()),
  outcome: z.enum(['OK', 'NOT_RUN', 'UNAVAILABLE_IN_PHASE']),
  checks: z.array(
    z.strictObject({
      itemIndex: z.number().int().nonnegative(),
      name: z.string().min(1).max(64),
      ok: z.boolean(),
      detail: z.string().max(300),
    }),
  ),
  verdicts: z.array(
    z.strictObject({
      itemIndex: z.number().int().nonnegative(),
      verdict: z.enum(['PROCEED', 'ADJUST', 'BLOCK']),
      notes: z.string().max(500),
    }),
  ),
  uncertainty: z.number().min(0).max(1),
});
export type RoleReview = z.output<typeof RoleReviewSchema>;
export const RunCostsSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  paidToolCalls: z.number().int().nonnegative(),
  paidToolMicroUsd: z.number().int().nonnegative(),
  externalCalls: z.number().int().nonnegative(),
  subagentsSpawned: z.number().int().nonnegative(),
  maxDepthReached: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  wallClockMs: z.number().int().nonnegative(),
});
export type RunCosts = z.output<typeof RunCostsSchema>;
export const FINDING_KINDS = [
  'SPAWN_LOOP',
  'SPAWN_DEPTH_EXCEEDED',
  'CONCURRENCY_EXCEEDED',
  'BUDGET_EXCEEDED',
  'CAPABILITY_ESCALATION',
  'FORBIDDEN_TOOL_CALL',
  'PROMPT_INJECTION_SUSPECTED',
  'VALIDATION_REJECTED',
  'UNCERTAINTY_ESCALATION',
  'CONTRADICTION',
  'PROVIDER_UNAVAILABLE',
  'MEMBER_POLICY_OVERRIDE',
  'CANCELLED',
  'CRITIC_GATE',
  'ROLE_REVIEW_BLOCKED',
  'DUPLICATE_PROPOSAL',
] as const;
export const FindingKindSchema = z.enum(FINDING_KINDS);
export type FindingKind = z.output<typeof FindingKindSchema>;
export const AgentFindingSchema = z.strictObject({
  findingId: IdSchema,
  kind: FindingKindSchema,
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH']),
  role: ModelRoleSchema.nullable(),
  agentId: IdSchema.nullable(),
  detail: z.string().max(500),
  at: TimestampSchema,
});
export type AgentFinding = z.output<typeof AgentFindingSchema>;

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = 1;
export const EvidenceArtifactSchema = z.strictObject({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactId: IdSchema,
  runId: IdSchema,
  proposalId: ProposalIdSchema,
  groupId: GroupIdSchema,
  snapshotId: HashSchema,
  createdAt: TimestampSchema,
  executionMode: ExecutionModeSchema,
  sources: z.array(SourceFreshnessSchema),
  decisiveFreshness: FieldFreshnessSchema,
  modelCalls: z.array(ModelCallRecordSchema),
  roles: z.array(ModelRoleSchema),
  claims: z.array(ClaimSchema),
  uncertainties: z.array(UncertaintySchema),
  contradictions: z.array(ContradictionSchema),
  critic: CriticResultSchema,
  roleReviews: z.array(RoleReviewSchema),
  untrustedEvidence: z.array(UntrustedEvidenceSchema),
  costs: RunCostsSchema,
  findings: z.array(AgentFindingSchema),
  outcome: z.enum(['PROPOSED', 'ESCALATED', 'REJECTED']),
});
export type EvidenceArtifact = z.output<typeof EvidenceArtifactSchema>;
export function evidenceArtifactHash(artifact: EvidenceArtifact) {
  return canonicalArtifactHash(EvidenceArtifactSchema.parse(artifact));
}

export const ZERO_HASH = `0x${'0'.repeat(64)}` as const;
export const MarketRefSchema = z.strictObject({
  pair: z.string().max(32),
  provenance: ProvenanceSchema,
  observedAt: TimestampSchema,
  freshness: FieldFreshnessSchema,
});
export const BrainActionProposalSchema = z.strictObject({
  kind: z.literal('ACTION'),
  proposalId: ProposalIdSchema,
  groupId: GroupIdSchema,
  snapshotId: HashSchema,
  intent: BoundActionIntentSchema,
  evidenceArtifact: EvidenceArtifactSchema,
  evidenceArtifactHash: HashSchema,
  market: MarketRefSchema.nullable(),
});
export type BrainActionProposal = z.output<typeof BrainActionProposalSchema>;
export const BrainMandateProposalSchema = z.strictObject({
  kind: z.literal('MANDATE'),
  proposalId: ProposalIdSchema,
  groupId: GroupIdSchema,
  snapshotId: HashSchema,
  change: z.enum(['NEW', 'SUPERSEDE']),
  mandate: z.unknown(),
  evidenceArtifact: EvidenceArtifactSchema,
  evidenceArtifactHash: HashSchema,
});
export type BrainMandateProposal = z.output<typeof BrainMandateProposalSchema>;
export const ProposalDecisionSchema = z.strictObject({
  proposalId: ProposalIdSchema,
  kind: z.enum(['ACTION', 'MANDATE']),
  status: z.enum([
    'AUTHORIZED',
    'PENDING_APPROVAL',
    'POLICY_REJECTED',
    'RISK_REJECTED',
    'EXPIRED',
    'REQUIRES_HUMAN_APPROVAL',
    'REJECTED',
  ]),
  code: z.string().max(64).nullable(),
  intentId: z.string().max(140).nullable(),
  draftDigest: HashSchema.nullable(),
  riskPacketHash: HashSchema.nullable(),
  evidenceHash: HashSchema.nullable(),
  mandateHash: HashSchema.nullable(),
  narrowedFields: z.array(z.string().max(64)),
  executionMode: ExecutionModeSchema,
});
export type ProposalDecision = z.output<typeof ProposalDecisionSchema>;
