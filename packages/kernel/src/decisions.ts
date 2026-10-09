import { z } from 'zod';
import type {
  ActionState,
  ExecutionGrant,
  GrantDraft,
  Tier,
  TransitionRecord,
} from '@synq/domain';
import type { RejectedApproval } from './approvals.js';
import type { CanonicalIntent, Hash } from './canonical.js';
import type { AuditRecord } from './audit.js';
import { artifactHash } from './canonical.js';
import {
  decisionStatus,
  type Failure,
  type Issue,
  type KernelError,
} from './errors.js';
import type { PolicyResult } from './policy.js';

export interface Clock {
  now(): number;
}
export type TrustedEvidence = {
  riskPacketHashes: readonly string[];
  simulationHashes: readonly string[];
};
export type AuthorizationRequest = {
  intent: unknown;
  risk: unknown;
  simulation: unknown;
  approvals: readonly unknown[];
};
type DecisionCommon = {
  intentId: string | null;
  intentHash: Hash | null;
  state: ActionState | null;
  tier: Tier | null;
  policy: PolicyResult | null;
  transitions: TransitionRecord<ActionState>[];
  audit: { sequence: number; hash: Hash } | null;
};
export type AuthorizedDecision = DecisionCommon & {
  status: 'AUTHORIZED';
  tier: Exclude<Tier, 'BLOCKED'>;
  requiredApprovals: number;
  draft: GrantDraft;
  grant: ExecutionGrant;
};
export type PendingDecision = DecisionCommon & {
  status: 'PENDING_APPROVAL';
  code: Failure;
  issues: Issue[];
  draft: GrantDraft | null;
  requiredApprovals: number | null;
  countedApprovals: number;
  rejectedApprovals: RejectedApproval[];
};
export type RejectedDecision = DecisionCommon & {
  status: 'POLICY_REJECTED' | 'RISK_REJECTED' | 'EXPIRED';
  code: Failure;
  issues: Issue[];
};
export type AuthorizationDecision =
  | AuthorizedDecision
  | PendingDecision
  | RejectedDecision;

export const RequestSchema = z.strictObject({
  intent: z.unknown(),
  risk: z.unknown(),
  simulation: z.unknown(),
  approvals: z.array(z.unknown()),
});

export type DecisionContext = {
  canonical?: CanonicalIntent;
  policy?: PolicyResult;
  draft?: GrantDraft;
  counted?: number;
  rejected?: RejectedApproval[];
  required?: number;
};

export function refusalPayload(
  ctx: DecisionContext,
  error: KernelError,
  advanced: readonly TransitionRecord<ActionState>[],
) {
  const canonical = ctx.canonical;
  return {
    status: decisionStatus(error.code),
    code: error.code,
    issues: [...error.issues],
    intentId: canonical?.intentId ?? null,
    proposedIntentId: canonical?.proposedIntentId ?? null,
    intentHash: canonical?.intentHash ?? null,
    tier: ctx.policy?.tier ?? null,
    policyResultHash: ctx.policy ? artifactHash(ctx.policy) : null,
    policy: ctx.policy ?? null,
    draftDigest: ctx.draft?.digest ?? null,
    rejectedApprovals: ctx.rejected ?? [],
    transitions: advanced.map((t) => t.to),
  };
}

export function refusalDecision(
  ctx: DecisionContext,
  error: KernelError,
  recorded: {
    state: ActionState | null;
    transitions: TransitionRecord<ActionState>[];
    audit: AuditRecord | null;
  },
): PendingDecision | RejectedDecision {
  const { audit } = recorded;
  const status = decisionStatus(error.code);
  const common = {
    intentId: ctx.canonical?.intentId ?? null,
    intentHash: ctx.canonical?.intentHash ?? null,
    state: recorded.state,
    tier: ctx.policy?.tier ?? null,
    policy: ctx.policy ?? null,
    transitions: recorded.transitions,
    audit: audit ? { sequence: audit.sequence, hash: audit.hash } : null,
    code: audit ? error.code : ('AUDIT_UNAVAILABLE' as const),
    issues: [...error.issues],
  };
  if (status === 'PENDING_APPROVAL')
    return {
      ...common,
      status,
      draft: ctx.draft ?? null,
      requiredApprovals: ctx.required ?? null,
      countedApprovals: ctx.counted ?? 0,
      rejectedApprovals: ctx.rejected ?? [],
    };
  return { ...common, status };
}
