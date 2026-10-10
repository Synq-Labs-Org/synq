/** Deliberately incompatible: the settlement recheck ships without a patch marker. */
export const PATCHES = {
  settlementRecheck: 'settlement-reservation-recheck-v1',
} as const;
export function settlementRecheck(): boolean {
  return true;
}
