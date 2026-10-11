import {
  SynqError,
  ValidationError,
  type ActionState,
  type KernelFailureCode,
} from '@synq/domain';
import { safeParse, type z } from 'zod';

export type Failure = KernelFailureCode;
export type Issue = { path: string; message: string };

export class KernelError extends SynqError {
  declare readonly code: KernelFailureCode;
  constructor(
    code: KernelFailureCode,
    readonly issues: readonly Issue[] = [],
    detail?: string,
  ) {
    super(code, detail);
  }
}

export function requireRule(
  condition: boolean,
  code: KernelFailureCode,
  detail?: string,
): asserts condition {
  if (!condition) throw new KernelError(code, [], detail);
}

export function parseAs<S extends z.core.$ZodType>(
  schema: S,
  value: unknown,
  code: KernelFailureCode,
): z.output<S> {
  const result = safeParse(schema, value);
  if (result.success) return result.data;
  throw new KernelError(
    code,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  );
}

export function asKernelError(error: unknown): KernelError {
  if (error instanceof KernelError) return error;
  if (error instanceof ValidationError)
    return new KernelError('INVALID_REQUEST', error.issues);
  return new KernelError('INVALID_REQUEST', [
    { path: '(root)', message: 'unexpected failure' },
  ]);
}

export const RISK_FAILURES: ReadonlySet<Failure> = new Set<Failure>([
  'RISK_REJECTED',
  'STALE_QUOTE',
  'STALE_EVIDENCE',
  'EVIDENCE_MISMATCH',
  'SIMULATION_FAILED',
  'SIMULATION_MISMATCH',
  'STALE_SIMULATION',
  'STALE_READ_MODEL',
  'DIRECT_VERIFICATION_FAILED',
  'ACCOUNT_PAUSED',
  'QUOTE_REQUIRED',
  'MIN_OUTPUT_TOO_LOW',
  'ALLOCATION_CAP',
  'STABLE_RISK_UNAVAILABLE',
]);
export const SIMULATION_FAILURES: ReadonlySet<Failure> = new Set<Failure>([
  'SIMULATION_FAILED',
  'SIMULATION_MISMATCH',
  'STALE_SIMULATION',
]);
export const PENDING_FAILURES: ReadonlySet<Failure> = new Set<Failure>([
  'MISSING_QUORUM',
  'ONCHAIN_QUORUM_REQUIRED',
  'INVALID_APPROVAL',
  'APPROVAL_DRAFT_MISMATCH',
  'APPROVAL_SIGNATURE_INVALID',
  'APPROVAL_NOT_CONSUMED',
  'PRINCIPAL_KIND_INELIGIBLE',
  'APPROVER_NOT_MEMBER',
  'DUPLICATE_APPROVER',
  'APPROVAL_EPOCH_STALE',
  'DELEGATION_SCOPE',
]);
export const REFRESHABLE_FAILURES: ReadonlySet<Failure> = new Set<Failure>([
  'STALE_QUOTE',
  'STALE_EVIDENCE',
  'STALE_SIMULATION',
  'STALE_READ_MODEL',
  'DIRECT_VERIFICATION_FAILED',
  'DRAFT_EXPIRED',
  'AUDIT_UNAVAILABLE',
  'STABLE_RISK_UNAVAILABLE',
]);

export type DecisionStatus = Extract<
  ActionState,
  'PENDING_APPROVAL' | 'POLICY_REJECTED' | 'RISK_REJECTED' | 'EXPIRED'
>;
export function decisionStatus(code: Failure): DecisionStatus {
  if (PENDING_FAILURES.has(code)) return 'PENDING_APPROVAL';
  if (code === 'DRAFT_EXPIRED') return 'EXPIRED';
  return RISK_FAILURES.has(code) ? 'RISK_REJECTED' : 'POLICY_REJECTED';
}
