import type { Duration } from '@temporalio/common';
import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';

/** Activity failure types that must never be retried by the workflow. */
export const NON_RETRYABLE = [
  'MAINNET_BROADCAST_DISABLED',
  'KERNEL_REFUSED',
  'AUTONOMY_FROZEN',
  'GRANT_REPREPARATION_FORBIDDEN',
  'RECONCILIATION_MISMATCH',
  'INVALID_INPUT',
  'NOT_CONFIGURED',
  'EXECUTION_SIMULATION_REVERTED',
] as const;
export type NonRetryableType = (typeof NON_RETRYABLE)[number];

export function failureType(error: unknown): string | null {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  return cause instanceof ApplicationFailure ? (cause.type ?? null) : null;
}

export function isNonRetryable(error: unknown): boolean {
  const type = failureType(error);
  return type !== null && (NON_RETRYABLE as readonly string[]).includes(type);
}

export function errorMessage(error: unknown): string {
  const cause =
    error instanceof ActivityFailure ? (error.cause ?? error) : error;
  return cause instanceof Error
    ? cause.message.slice(0, 300)
    : String(error).slice(0, 300);
}

export const seconds = (n: number): Duration => `${n}s`;
