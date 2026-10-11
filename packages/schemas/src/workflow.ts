import { keccak256 } from 'viem';
import { z } from 'zod';
import { RiskPacketSchema } from './index.js';
import { BoundActionIntentSchema } from './intent.js';
import { PrincipalRefSchema } from './events.js';
import {
  CorrelationIdSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  IntentIdSchema,
  MandateIdSchema,
  MemberIdSchema,
  TimestampSchema,
} from './primitives.js';

export const WORKFLOW_START_SCHEMA_VERSION = 1;

export const WORKFLOW_EXECUTION_MODES = [
  'REAL_TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'MAINNET_SIMULATION',
  'SIMULATION',
  'CANARY_READY',
] as const;
export const WorkflowExecutionModeSchema = z.enum(WORKFLOW_EXECUTION_MODES);
export type WorkflowExecutionMode = z.output<
  typeof WorkflowExecutionModeSchema
>;

export const MandateRefSchema = z.strictObject({
  groupId: GroupIdSchema,
  mandateId: MandateIdSchema,
  version: z.number().int().positive(),
});
export type MandateRef = z.output<typeof MandateRefSchema>;

const CalldataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, 'calldata must be even-length hex')
  .max(2 + 2 * 24_576)
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const StartActionExecutionSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKFLOW_START_SCHEMA_VERSION),
    intent: BoundActionIntentSchema,
    mandateRef: MandateRefSchema,
    evidenceHash: HashSchema,
    risk: z.lazy(() => RiskPacketSchema),
    calldata: CalldataSchema,
    requestedBy: PrincipalRefSchema,
    correlationId: CorrelationIdSchema,
    executionMode: WorkflowExecutionModeSchema,
    approvalTimeoutSeconds: z.number().int().min(60).max(604_800).default(3600),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (
      v.mandateRef.groupId !== v.intent.groupId ||
      v.mandateRef.mandateId !== v.intent.mandateId ||
      v.mandateRef.version !== v.intent.mandateVersion
    )
      issue('mandateRef', 'mandateRef must name the intent mandate version');
    if (v.evidenceHash !== v.intent.evidenceHash)
      issue('evidenceHash', 'evidenceHash must equal the intent evidenceHash');
    if (keccak256(v.calldata) !== v.intent.calldataHash)
      issue('calldata', 'calldata does not hash to intent.calldataHash');
  });
export type StartActionExecution = z.output<typeof StartActionExecutionSchema>;
export type StartActionExecutionInput = z.input<
  typeof StartActionExecutionSchema
>;

export const MANDATE_PROPOSAL_KINDS = [
  'CONFIGURE',
  'SUPERSEDE',
  'REVOKE',
] as const;
export const StartMandateApprovalSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKFLOW_START_SCHEMA_VERSION),
    proposalId: IdSchema,
    kind: z.enum(MANDATE_PROPOSAL_KINDS),
    mandateRef: MandateRefSchema,
    mandateHash: HashSchema,
    securitySensitive: z.boolean().default(false),
    approvers: z.array(MemberIdSchema).min(1).max(32),
    requiredApprovals: z.number().int().positive(),
    expiresAt: TimestampSchema,
    requestedBy: PrincipalRefSchema,
    correlationId: CorrelationIdSchema,
  })
  .superRefine((v, ctx) => {
    if (new Set(v.approvers).size !== v.approvers.length)
      ctx.addIssue({
        code: 'custom',
        path: ['approvers'],
        message: 'approvers must be distinct',
      });
    if (v.requiredApprovals > v.approvers.length)
      ctx.addIssue({
        code: 'custom',
        path: ['requiredApprovals'],
        message: 'requiredApprovals exceeds the approver set',
      });
  });
export type StartMandateApproval = z.output<typeof StartMandateApprovalSchema>;
export type StartMandateApprovalInput = z.input<
  typeof StartMandateApprovalSchema
>;

export const WORKFLOW_ID_PREFIX = {
  actionExecution: 'synq.action',
  mandateApproval: 'synq.mandate-approval',
} as const;

export function actionExecutionWorkflowId(canonicalIntentId: string): string {
  return `${WORKFLOW_ID_PREFIX.actionExecution}.${IntentIdSchema.parse(canonicalIntentId)}`;
}
export function mandateApprovalWorkflowId(proposalId: string): string {
  return `${WORKFLOW_ID_PREFIX.mandateApproval}.${IdSchema.parse(proposalId)}`;
}
