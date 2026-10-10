import { deprecatePatch } from '@temporalio/workflow';

/** The next step of the patch lifecycle: every pre-patch history has closed, the branch is permanent. */
export const PATCHES = {
  settlementRecheck: 'settlement-reservation-recheck-v1',
} as const;
export function settlementRecheck(): boolean {
  deprecatePatch(PATCHES.settlementRecheck);
  return true;
}
