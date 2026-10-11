import { patched } from '@temporalio/workflow';

/**
 * In-flight-safe workflow changes (ADR-0015). Each id stays until every history recorded without it
 * has closed; then the call becomes deprecatePatch(id), and finally the branch and the id go away.
 */
export const PATCHES = {
  /** After settlement, re-read the Kernel reservation before declaring the intent SETTLED. */
  settlementRecheck: 'settlement-reservation-recheck-v1',
  /** Wait for the verified approval quorum before a hedge order is submitted. */
  hedgeApprovalGate: 'hedge-approval-gate-v1',
} as const;

export function settlementRecheck(): boolean {
  return patched(PATCHES.settlementRecheck);
}

export function hedgeApprovalGate(): boolean {
  return patched(PATCHES.hedgeApprovalGate);
}
