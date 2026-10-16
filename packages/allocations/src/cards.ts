import {
  AllocationCardSchema,
  arcCardBase,
  cardDecimal,
  cardRef,
  type ArcCardContext,
} from '@synq/schemas';
import type { SplitRecord, LegRecord, Reservation } from './split.js';

export function allocationCard(
  input: {
    split: SplitRecord;
    legs: readonly LegRecord[];
    reservations: readonly Reservation[];
    receiptReview: boolean;
  },
  ctx: ArcCardContext,
) {
  const { split: s, legs } = input;
  const money = (n: bigint) => ({ amount: cardDecimal(n, 6), symbol: 'USDC' });
  const paid = legs
    .filter(
      (l) =>
        l.kind === 'TRANSFER' && ['CONFIRMED', 'RECONCILED'].includes(l.state),
    )
    .reduce((n, l) => n + l.amount, 0n);
  const held = input.reservations
    .filter((r) => r.splitId === s.splitId && r.status === 'ACTIVE')
    .reduce((n, r) => n + r.amount, 0n);
  const free = legs
    .filter((l) => l.kind === 'FREE_CASH')
    .reduce((n, l) => n + l.amount, 0n);
  return AllocationCardSchema.parse({
    ...arcCardBase(
      ctx,
      s.updatedAt,
      'allocation',
      s.splitId,
      s.rev,
      input.receiptReview ? 'REVIEW' : 'FINAL',
    ),
    type: 'ALLOCATION',
    chainId: s.receipt.chainId,
    splitId: cardRef(s.splitId),
    invoiceId: cardRef(s.invoiceId),
    policyVersion: s.policyVersion,
    status:
      input.receiptReview ||
      ['NEEDS_REVIEW', 'FAILED', 'CANCELLED'].includes(s.state)
        ? 'NEEDS_REVIEW'
        : s.state === 'COMPLETED'
          ? 'COMPLETED'
          : 'PROCESSING',
    received: money(s.receipt.amount),
    paid: money(paid),
    held: money(held),
    free: money(free),
    receiptTx: s.receipt.txHash,
    planHash: s.plan?.planHash ?? null,
    legs: legs.map((l) => ({
      purpose: l.purpose,
      state: l.state,
      amount: money(l.amount),
      recipient: l.payTo,
      txHash: l.txHash,
    })),
    note: input.receiptReview
      ? 'Incoming payment proof needs review. Recorded payments are preserved; no new transfer is authorized.'
      : 'Held amounts stay in the vault; tax reserves are estimates, not tax payments. Only paid legs with receipts moved funds.',
  });
}
