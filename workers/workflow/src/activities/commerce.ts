import {
  artifactHash,
  type EconomicExecution,
  type EconomicGrant,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import {
  FulfillmentReceiptSchema,
  assertExecutable,
  compare,
  convert,
  landedTotal,
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
} from '@synq/offer-exchange';
import {
  simulatedCheckoutReceipt,
  type CheckoutDecision,
  type CheckoutRecipient,
} from '@synq/plugin-commerce';

export type CommerceCheckoutResult =
  | { kind: 'RECEIPT'; receipt: FulfillmentReceipt }
  | { kind: 'HANDOFF'; reason: string }
  | { kind: 'REFUSED'; reason: string }
  | { kind: 'INCIDENT'; reason: string; receipt: FulfillmentReceipt };

export type CommerceReservationBinding = {
  reservationId: string;
  planHash: string;
  reservedAssetId: string;
  reservedAmount: string;
};

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
  });
  const receipt = FulfillmentReceiptSchema.parse({
    receiptId: `order-${input.idempotencyKey}`.slice(0, 160),
    intentId: input.intentId,
    offerId: input.offer.offerId,
    providerId: route.providerId,
    providerRef: placed.state === 'ORDER_PLACED' ? placed.orderRef : null,
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
  if (placed.state === 'ORDER_PLACED' && placed.charged) {
    let over = true;
    try {
      over =
        compare(convert(placed.charged, cap, input.offer.price.fx), cap) > 0;
    } catch {
      over = true;
    }
    if (over)
      return {
        kind: 'INCIDENT',
        reason: 'charged amount exceeds the grant',
        receipt,
      };
  }
  return { kind: 'RECEIPT', receipt };
}
