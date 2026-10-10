import { patched } from '@temporalio/workflow';

/**
 * In-flight-safe workflow changes (ADR-0014). Each id stays until every history recorded without it
 * has closed; then the call becomes deprecatePatch(id), and finally the branch and the id go away.
 */
export const PATCHES = {
  /** After settlement, re-read the Kernel reservation before declaring the intent SETTLED. */
  settlementRecheck: 'settlement-reservation-recheck-v1',
} as const;

export function settlementRecheck(): boolean {
  return patched(PATCHES.settlementRecheck);
}
