import { keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  MemoryEconomicGrantLedger,
  economicApprovalTypedData,
} from '@synq/kernel';
import type {
  ApprovalLedger,
  DirectoryMember,
  MembershipDirectory,
  VerifiedApproval,
} from '@synq/schemas';
import { MemoryReservationStore } from '@synq/settlement';

export const memberAccount = (memberId: string) =>
  privateKeyToAccount(keccak256(stringToHex(`synq-test-member:${memberId}`)));

let n = 0;
/** Identity-ledger approval with a real EIP-712 signature by the member's fixture key. */
export async function approval(
  memberId: string,
  requestHash: string,
  opts: {
    groupId?: string;
    mandateId: string;
    principalKind?: VerifiedApproval['principalKind'];
    signAs?: string;
    epoch?: number;
  },
): Promise<VerifiedApproval> {
  const id = ++n;
  const groupId = opts.groupId ?? 'group-1';
  const account = memberAccount(opts.signAs ?? memberId);
  const signature = await account.signTypedData(
    economicApprovalTypedData({
      groupId,
      mandateId: opts.mandateId,
      requestHash: requestHash as `0x${string}`,
    }),
  );
  return {
    schemaVersion: 1,
    approvalId: `apr-${id}`,
    challengeId: `chl-${id}`,
    groupId: groupId as VerifiedApproval['groupId'],
    memberId: memberId as VerifiedApproval['memberId'],
    principalId: `principal-${memberId}` as VerifiedApproval['principalId'],
    principalKind: opts.principalKind ?? 'LOCAL_FIXTURE',
    signer: memberAccount(memberId).address.toLowerCase() as `0x${string}`,
    draftDigest: requestHash as `0x${string}`,
    signature,
    membershipEpoch: opts.epoch ?? 1,
    verifiedAt: 1_780_000_000,
  };
}

/** Membership directory + identity approval ledger for fixture members. */
export function approvalPorts(
  members: readonly string[],
  opts: {
    groupId?: string;
    epoch?: number;
    consumed?: (a: VerifiedApproval) => boolean;
    inactive?: readonly string[];
    principalKind?: DirectoryMember['principalKind'];
  } = {},
): { ledger: ApprovalLedger; directory: MembershipDirectory } {
  const groupId = opts.groupId ?? 'group-1';
  const epoch = opts.epoch ?? 1;
  return {
    ledger: {
      isConsumed: async (a) => (opts.consumed ? opts.consumed(a) : true),
    },
    directory: {
      membershipEpoch: async (g) => (g === groupId ? epoch : null),
      activeMember: async (g, memberId): Promise<DirectoryMember | null> =>
        g === groupId &&
        members.includes(memberId) &&
        !opts.inactive?.includes(memberId)
          ? {
              groupId,
              memberId,
              principalId: `principal-${memberId}`,
              principalKind: opts.principalKind ?? 'LOCAL_FIXTURE',
              role: 'APPROVER',
              signer: memberAccount(
                memberId,
              ).address.toLowerCase() as `0x${string}`,
              membershipEpoch: epoch,
              ownerOfAccount: true,
            }
          : null,
    },
  };
}

export const memoryLedger = () => new MemoryEconomicGrantLedger();

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
