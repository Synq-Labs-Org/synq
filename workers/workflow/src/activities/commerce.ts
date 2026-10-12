import {
  artifactHash,
  type EconomicExecution,
  type EconomicGrant,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import {
  FulfillmentReceiptSchema,
  add,
  applyBps,
  assertExecutable,
  compare,
  convert,
  landedTotal,
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
} from '@synq/offer-exchange';
import {
  USDC_USD_PAR,
  simulatedCheckoutReceipt,
  type CheckoutDecision,
  type CheckoutRecipient,
  type CheckoutRoute,
  type PaymentEvidence,
  type ReconcileOutcome,
} from '@synq/plugin-commerce';
import type { TreasuryReservationStore } from '@synq/settlement';

export type CommerceCheckoutResult =
  | {
      kind: 'RECEIPT';
      receipt: FulfillmentReceipt;
      payment?: PaymentEvidence;
    }
  | { kind: 'HANDOFF'; reason: string }
  | { kind: 'REFUSED'; reason: string }
  | {
      kind: 'INCIDENT';
      reason: string;
      receipt: FulfillmentReceipt;
      payment?: PaymentEvidence;
    }
  /**
   * The reservation is HELD: the route stopped before paying (mismatch, price
   * increase, step-up) or the outcome is ambiguous. Reconcile; never retry.
   */
  | {
      kind: 'HOLD';
      reason: string;
      receipt: FulfillmentReceipt;
      stepUp?: 'KYC';
      payment?: PaymentEvidence;
      quoted?: Money | null;
    };

export type CommerceReservationBinding = {
  reservationId: string;
  planHash: string;
  reservedAssetId: string;
  reservedAmount: string;
};

/**
 * Grant cap for a checkout whose tax and shipping are only known once the
 * provider quotes: the revalidated landed price plus a mandate-set allowance
 * (rounded up). The provider quote is checked against this cap before paying.
 */
export function commerceGrantCap(landed: Money, allowanceBps: number): Money {
  if (
    !Number.isInteger(allowanceBps) ||
    allowanceBps < 0 ||
    allowanceBps > 5_000
  )
    throw new RangeError('allowance must be 0..5000 bps');
  return add(landed, applyBps(landed, allowanceBps, 'up'));
}

export function commerceExecution(input: {
  offer: EconomicOffer;
  host: string;
  providerId: string;
  maxAmount: Money;
  reservation: CommerceReservationBinding;
  recipientRef: string;
}): EconomicExecution {
  return {
    domain: 'COMMERCE',
    providerId: input.providerId,
    host: input.host,
    offerId: input.offer.offerId,
    subjectHash: artifactHash({
      subject: input.offer.subject,
      providerRef: input.offer.providerRef,
    }),
    quantity:
      input.offer.subject.kind === 'PRODUCT' ? input.offer.subject.quantity : 1,
    maxAmount: input.maxAmount,
    reservationId: input.reservation.reservationId,
    reservedAssetId: input.reservation.reservedAssetId,
    reservedAmount: input.reservation.reservedAmount,
    settlementPlanHash: input.reservation.planHash,
    recipientRef: input.recipientRef,
    payAsset: null,
  };
}

/**
 * Commerce checkout in the execution worker. The execution checked against the
 * Kernel grant is rebuilt here from the offer actually being placed and the
 * route actually used, never taken from the caller.
 */
export async function executeCommerceCheckout(
  deps: {
    authority: EconomicGrantAuthority;
    reservations: TreasuryReservationStore;
    resolveRecipient(ref: string, purpose: string): Promise<CheckoutRecipient>;
    now: () => number;
  },
  input: {
    intentId: string;
    decision: CheckoutDecision;
    offer: EconomicOffer;
    grant: EconomicGrant;
    reservation: CommerceReservationBinding;
    recipientRef: string;
    idempotencyKey: string;
  },
): Promise<CommerceCheckoutResult> {
  const now = deps.now();
  if (input.decision.kind === 'HANDOFF')
    return { kind: 'HANDOFF', reason: input.decision.reason };
  const route = input.decision.route;
  const cap = input.grant.execution.maxAmount;
  let landed: Money;
  try {
    assertExecutable(input.offer, now, 900);
    landed = landedTotal(input.offer, cap);
    if (compare(landed, cap) > 0)
      return { kind: 'REFUSED', reason: 'landed price exceeds the grant' };
    const actual = commerceExecution({
      offer: input.offer,
      host: route.host,
      providerId: route.providerId,
      maxAmount: landed,
      reservation: input.reservation,
      recipientRef: input.recipientRef,
    });
    for (const id of [
      input.reservation.reservationId,
      `${input.reservation.reservationId}-edge`,
    ]) {
      if (
        id !== input.reservation.reservationId &&
        !(await deps.reservations.get(id))
      )
        continue;
      await deps.reservations.beginExecution(
        id,
        {
          groupId: input.grant.groupId,
          settlementPlanHash: input.reservation.planHash,
        },
        now,
      );
    }
    await deps.authority.consume(input.grant, actual, now);
  } catch (e) {
    return {
      kind: 'REFUSED',
      reason: `KERNEL_REFUSED: ${(e as Error).message}`,
    };
  }
  if (input.decision.kind === 'SIMULATE')
    return {
      kind: 'RECEIPT',
      receipt: simulatedCheckoutReceipt({
        offer: input.offer,
        route,
        intentId: input.intentId,
        idempotencyKey: input.idempotencyKey,
        reservationId: input.reservation.reservationId,
        grantId: input.grant.grantId,
        now,
      }),
    };
  const recipient = await deps.resolveRecipient(
    input.recipientRef,
    `checkout:${input.intentId}`,
  );
  const placed = await route.place!({
    offer: input.offer,
    recipient,
    idempotencyKey: input.idempotencyKey,
    maxTotal: cap,
    maxUnit: convert(input.offer.price.base, cap, input.offer.price.fx),
  });
  const orderRef =
    placed.state === 'ORDER_PLACED'
      ? placed.orderRef
      : placed.state === 'FAILED'
        ? null
        : (placed.orderRef ?? null);
  const payment =
    placed.state === 'ORDER_PLACED' ||
    placed.state === 'UNKNOWN_PROVIDER_OUTCOME'
      ? placed.payment
      : undefined;
  const receipt = FulfillmentReceiptSchema.parse({
    receiptId: `order-${input.idempotencyKey}`.slice(0, 160),
    intentId: input.intentId,
    offerId: input.offer.offerId,
    providerId: route.providerId,
    providerRef: orderRef,
    providerReference: null,
    state:
      placed.state === 'ORDER_PLACED'
        ? 'ORDER_PLACED'
        : placed.state === 'FAILED'
          ? 'FAILED'
          : 'UNKNOWN_PROVIDER_OUTCOME',
    charged: placed.state === 'ORDER_PLACED' ? placed.charged : null,
    idempotencyKey: input.idempotencyKey,
    reservationId: input.reservation.reservationId,
    grantId: input.grant.grantId,
    environment: 'SANDBOX',
    evidence: 'PROVIDER_SANDBOX',
    createdAt: now,
  });
  const reservationIds = async () => {
    const ids = [input.reservation.reservationId];
    const edge = `${input.reservation.reservationId}-edge`;
    if (await deps.reservations.get(edge)) ids.push(edge);
    return ids;
  };
  if (placed.state === 'HELD' || placed.state === 'UNKNOWN_PROVIDER_OUTCOME') {
    for (const id of await reservationIds())
      await deps.reservations.hold(id, placed.reason.slice(0, 200), now);
    return {
      kind: 'HOLD',
      reason: placed.reason,
      receipt,
      ...(placed.state === 'HELD' && placed.stepUp
        ? { stepUp: placed.stepUp }
        : {}),
      ...(placed.state === 'HELD' ? { quoted: placed.quoted ?? null } : {}),
      ...(payment ? { payment } : {}),
    };
  }
  if (placed.state === 'FAILED') {
    // Definitive provider rejection before any order or payment existed.
    for (const id of await reservationIds())
      await deps.reservations.release(id, placed.reason.slice(0, 200), now);
    return { kind: 'RECEIPT', receipt };
  }
  if (placed.charged) {
    let over = true;
    try {
      over =
        compare(
          convert(placed.charged, cap, [...input.offer.price.fx, USDC_USD_PAR]),
          cap,
        ) > 0;
    } catch {
      over = true;
    }
    if (over)
      return {
        kind: 'INCIDENT',
        reason: 'charged amount exceeds the grant',
        receipt,
        ...(payment ? { payment } : {}),
      };
  }
  return { kind: 'RECEIPT', receipt, ...(payment ? { payment } : {}) };
}

export type CommerceReconciliation =
  | { status: 'RELEASED'; reason: string }
  | { status: 'STILL_HELD'; outcome: ReconcileOutcome };

/**
 * Reconciles a HELD checkout by reading the provider. The reservation is only
 * released when the provider shows no order and no payment was broadcast, or
 * the order exists but was never paid; anything else stays HELD for recourse.
 */
export async function reconcileCommerceCheckout(
  deps: { reservations: TreasuryReservationStore; now: () => number },
  input: {
    route: CheckoutRoute;
    reservationId: string;
    orderRef: string | null;
    paymentBroadcast: boolean;
    since: number;
  },
): Promise<CommerceReconciliation> {
  const outcome: ReconcileOutcome = input.route.reconcile
    ? await input.route.reconcile({
        orderRef: input.orderRef,
        since: input.since,
      })
    : { status: 'UNKNOWN', reason: 'route cannot reconcile' };
  const unpaid =
    outcome.status === 'FOUND' &&
    [
      'awaiting-payment',
      'requires-kyc',
      'failed-kyc',
      'manual-kyc',
      'requires-recipient',
      'requires-crypto-payer-address',
      'draft',
    ].includes(outcome.paymentStatus);
  if (
    !input.paymentBroadcast &&
    ((outcome.status === 'NOT_FOUND' && input.orderRef === null) || unpaid)
  ) {
    const reason =
      outcome.status === 'NOT_FOUND'
        ? 'reconciled: provider has no order and nothing was paid'
        : 'reconciled: order exists but was never paid';
    const ids = [input.reservationId];
    const edge = `${input.reservationId}-edge`;
    if (await deps.reservations.get(edge)) ids.push(edge);
    for (const id of ids)
      await deps.reservations.releaseHeld(id, reason, deps.now());
    return { status: 'RELEASED', reason };
  }
  return { status: 'STILL_HELD', outcome };
}
