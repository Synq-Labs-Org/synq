import {
  artifactHash,
  type EconomicExecution,
  type EconomicGrant,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import {
  FulfillmentReceiptSchema,
  assertExecutable,
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
  | { kind: 'REFUSED'; reason: string };

export function commerceExecution(input: {
  offer: EconomicOffer;
  host: string;
  providerId: string;
  maxAmount: Money;
  reservationId: string;
  planHash: string;
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
    reservationId: input.reservationId,
    settlementPlanHash: input.planHash,
    recipientRef: input.recipientRef,
  };
}

/**
 * Commerce checkout in the execution worker: the Kernel grant is consumed for
 * the exact merchant host, item, quantity, amount and recipient before any
 * route runs. Without sandbox access the result is SIMULATED_CHECKOUT.
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
    actual: EconomicExecution;
    idempotencyKey: string;
  },
): Promise<CommerceCheckoutResult> {
  const now = deps.now();
  if (input.decision.kind === 'HANDOFF')
    return { kind: 'HANDOFF', reason: input.decision.reason };
  const route = input.decision.route;
  if (
    input.actual.host !== route.host ||
    input.actual.providerId !== route.providerId
  )
    return {
      kind: 'REFUSED',
      reason: 'route differs from the authorized merchant',
    };
  try {
    assertExecutable(input.offer, now, 900);
    deps.authority.consume(input.grant, input.actual, now);
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
        reservationId: input.actual.reservationId,
        grantId: input.grant.grantId,
        now,
      }),
    };
  const recipient = await deps.resolveRecipient(
    input.actual.recipientRef ?? '',
    `checkout:${input.intentId}`,
  );
  const placed = await route.place!({
    offer: input.offer,
    recipient,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    kind: 'RECEIPT',
    receipt: FulfillmentReceiptSchema.parse({
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
      reservationId: input.actual.reservationId,
      grantId: input.grant.grantId,
      environment: 'SANDBOX',
      evidence: 'PROVIDER_SANDBOX',
      createdAt: now,
    }),
  };
}
