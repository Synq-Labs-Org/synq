import {
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
  type ProviderCapability,
} from '@synq/offer-exchange';

export type CheckoutMode =
  | 'NATIVE_API'
  | 'STABLECOIN_CHECKOUT'
  | 'SCOPED_CARD'
  | 'HUMAN_HANDOFF';
export const CHECKOUT_LADDER: readonly CheckoutMode[] = [
  'NATIVE_API',
  'STABLECOIN_CHECKOUT',
  'SCOPED_CARD',
  'HUMAN_HANDOFF',
];

/** Shipping/recipient fields resolved from ProfileVault inside the execution worker. */
export type CheckoutRecipient = {
  name: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
};

/** On-chain payment the route broadcast for an order (testnet only). */
export type PaymentEvidence = {
  chain: string;
  chainId: number;
  txHash: string;
};

/**
 * `HELD`: the route stopped before paying (quote above the grant, price
 * increase, wrong item, unexpected payment transaction, step-up required).
 * Nothing was paid; the order, if any, is left to expire. `FAILED`: the
 * provider definitively created nothing. `UNKNOWN_PROVIDER_OUTCOME`: an
 * order or payment may exist; reconcile, never resubmit.
 */
export type PlacedOrder =
  | {
      state: 'ORDER_PLACED';
      orderRef: string;
      charged: Money | null;
      payment?: PaymentEvidence;
      providerStatus?: string;
    }
  | {
      state: 'HELD';
      orderRef: string | null;
      reason: string;
      stepUp?: 'KYC';
      quoted?: Money | null;
    }
  | { state: 'FAILED'; reason: string }
  | {
      state: 'UNKNOWN_PROVIDER_OUTCOME';
      reason: string;
      orderRef?: string | null;
      payment?: PaymentEvidence;
    };

export type ReconcileOutcome =
  | {
      status: 'FOUND';
      orderRef: string;
      paymentStatus: string;
      deliveryStatus: string | null;
    }
  | { status: 'NOT_FOUND' }
  | { status: 'UNKNOWN'; reason: string };

export type PlaceInput = {
  offer: EconomicOffer;
  recipient: CheckoutRecipient;
  idempotencyKey: string;
  /** Kernel grant cap, including tax and shipping. */
  maxTotal: Money;
  /** Revalidated item price the grant was issued against; any increase holds. */
  maxUnit: Money;
};

export interface CheckoutRoute {
  readonly mode: CheckoutMode;
  readonly providerId: string;
  readonly host: string;
  readonly capability: ProviderCapability;
  supports(offer: EconomicOffer): boolean;
  /** True only with real sandbox credentials for this route. */
  sandboxReady(): boolean;
  place?(input: PlaceInput): Promise<PlacedOrder>;
  /** Looks an ambiguous order up at the provider; never creates or pays. */
  reconcile?(input: {
    orderRef: string | null;
    since: number;
  }): Promise<ReconcileOutcome>;
}

export type CheckoutDecision =
  | { kind: 'EXECUTE'; route: CheckoutRoute; considered: Considered[] }
  | {
      kind: 'SIMULATE';
      route: CheckoutRoute;
      considered: Considered[];
      reason: string;
    }
  | { kind: 'HANDOFF'; considered: Considered[]; reason: string };
export type Considered = {
  mode: CheckoutMode;
  providerId: string;
  verdict: string;
};

/**
 * Execution ladder (Bible §82): native merchant API > stablecoin checkout >
 * scoped card > human handoff. Without sandbox access the best supported route
 * is simulated; nothing is ever reported as placed unless a sandbox placed it.
 */
export class CommerceExecutionRouter {
  constructor(private readonly routes: readonly CheckoutRoute[]) {}

  decide(
    offer: EconomicOffer,
    allowed: readonly CheckoutMode[],
  ): CheckoutDecision {
    const considered: Considered[] = [];
    let supported: CheckoutRoute | null = null;
    const ordered = [...this.routes].sort(
      (a, b) =>
        CHECKOUT_LADDER.indexOf(a.mode) - CHECKOUT_LADDER.indexOf(b.mode),
    );
    for (const route of ordered) {
      if (route.mode === 'HUMAN_HANDOFF') continue;
      const note = (verdict: string) =>
        considered.push({
          mode: route.mode,
          providerId: route.providerId,
          verdict,
        });
      if (!allowed.includes(route.mode)) {
        note('not allowed by mandate');
        continue;
      }
      if (!route.supports(offer)) {
        note('merchant not supported');
        continue;
      }
      if (!route.capability.verbs.includes('PURCHASE')) {
        note('no purchase capability');
        continue;
      }
      if (
        route.capability.status === 'READY' &&
        route.sandboxReady() &&
        route.place
      ) {
        note('selected');
        return { kind: 'EXECUTE', route, considered };
      }
      note(
        `${route.capability.status}${route.capability.statusReason ? `: ${route.capability.statusReason}` : ''}`,
      );
      supported ??= route;
    }
    if (supported)
      return {
        kind: 'SIMULATE',
        route: supported,
        considered,
        reason: `no sandbox access for ${supported.providerId}; checkout is simulated`,
      };
    return {
      kind: 'HANDOFF',
      considered,
      reason: 'no supported automated route',
    };
  }
}

export function simulatedCheckoutReceipt(input: {
  offer: EconomicOffer;
  route: CheckoutRoute;
  intentId: string;
  idempotencyKey: string;
  reservationId: string;
  grantId: string;
  now: number;
}): FulfillmentReceipt {
  return {
    receiptId: `sim-${input.idempotencyKey}`.slice(0, 160),
    intentId: input.intentId,
    offerId: input.offer.offerId,
    providerId: input.route.providerId,
    providerRef: null,
    providerReference: null,
    state: 'SIMULATED_CHECKOUT',
    charged: null,
    idempotencyKey: input.idempotencyKey,
    reservationId: input.reservationId,
    grantId: input.grantId,
    environment: 'FIXTURE',
    evidence: 'SIMULATED',
    createdAt: input.now,
  };
}
