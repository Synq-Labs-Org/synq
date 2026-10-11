import type { VerifiedApproval } from '@synq/schemas';
import { MemoryReservationStore } from '@synq/settlement';

let n = 0;
/** Identity-ledger shaped approval as produced by the identity verifier (fixture principal). */
export function approval(
  memberId: string,
  requestHash: string,
  groupId = 'group-1',
  principalKind: VerifiedApproval['principalKind'] = 'LOCAL_FIXTURE',
): VerifiedApproval {
  n++;
  return {
    schemaVersion: 1,
    approvalId: `apr-${n}`,
    challengeId: `chl-${n}`,
    groupId: groupId as VerifiedApproval['groupId'],
    memberId: memberId as VerifiedApproval['memberId'],
    principalId: `principal-${memberId}` as VerifiedApproval['principalId'],
    principalKind,
    signer: `0x${String(n).padStart(40, '0')}` as `0x${string}`,
    draftDigest: requestHash as `0x${string}`,
    signature: `0x${'11'.repeat(65)}` as `0x${string}`,
    membershipEpoch: 1,
    verifiedAt: 1_780_000_000,
  };
}

export async function reservationsWith(
  groupId: string,
  assetId: string,
  holds: {
    reservationId: string;
    amount: string;
    planHash: string;
    expiresAt: number;
  }[],
  now: number,
) {
  const store = new MemoryReservationStore();
  await store.setConfirmedBalance({
    groupId,
    assetId,
    confirmed: 10n ** 15n,
    asOf: now,
  });
  for (const h of holds)
    await store.reserve(
      {
        reservationId: h.reservationId,
        groupId,
        assetId,
        amount: h.amount,
        intentId: `i-${h.reservationId}`,
        purpose: 'OTHER',
        settlementPlanHash: h.planHash,
        expiresAt: h.expiresAt,
      },
      now,
    );
  return store;
}
