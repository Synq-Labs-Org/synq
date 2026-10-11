import {
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
  type ProviderCapability,
} from '@synq/offer-exchange';
import { getJson, obj, str, type HttpFetch } from './http.js';

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

export type PlacedOrder =
  | { state: 'ORDER_PLACED'; orderRef: string; charged: Money | null }
  | { state: 'FAILED'; reason: string }
  | { state: 'UNKNOWN_PROVIDER_OUTCOME'; reason: string };

export interface CheckoutRoute {
  readonly mode: CheckoutMode;
  readonly providerId: string;
  readonly host: string;
  readonly capability: ProviderCapability;
  supports(offer: EconomicOffer): boolean;
  /** True only with real sandbox credentials for this route. */
  sandboxReady(): boolean;
  place?(input: {
    offer: EconomicOffer;
    recipient: CheckoutRecipient;
    idempotencyKey: string;
  }): Promise<PlacedOrder>;
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

export const CROSSMINT = 'crossmint';
export const CROSSMINT_STAGING_HOST = 'staging.crossmint.com';

/**
 * Crossmint headless checkout (staging). Supports Amazon ASIN and Shopify
 * product locators; staging payment is USDC on Base Sepolia, so a Monad
 * treasury needs a bridged edge buffer before a real staging order.
 */
export class CrossmintCheckoutRoute implements CheckoutRoute {
  readonly mode = 'STABLECOIN_CHECKOUT' as const;
  readonly providerId = CROSSMINT;
  readonly host = CROSSMINT_STAGING_HOST;
  constructor(
    readonly capability: ProviderCapability,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: HttpFetch,
    private readonly payerAddress: string | null,
  ) {}
  supports(offer: EconomicOffer) {
    return /^(amazon:[A-Z0-9]{10}|shopify:https:\/\/)/.test(offer.providerRef);
  }
  sandboxReady() {
    return (
      !!this.apiKey &&
      this.apiKey.startsWith('sk_staging') &&
      this.payerAddress !== null
    );
  }
  async place(input: {
    offer: EconomicOffer;
    recipient: CheckoutRecipient;
    idempotencyKey: string;
  }): Promise<PlacedOrder> {
    if (!this.sandboxReady())
      return { state: 'FAILED', reason: 'staging credentials missing' };
    const r = input.recipient;
    try {
      const body = await getJson(
        this.fetchImpl,
        'crossmint',
        `https://${this.host}/api/2022-06-09/orders`,
        {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey!,
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
          },
          body: JSON.stringify({
            recipient: {
              email: r.email,
              physicalAddress: {
                name: r.name,
                line1: r.line1,
                line2: r.line2,
                city: r.city,
                state: r.state,
                postalCode: r.postalCode,
                country: r.country,
              },
            },
            payment: {
              method: 'base-sepolia',
              currency: 'usdc',
              payerAddress: this.payerAddress,
            },
            lineItems: [{ productLocator: input.offer.providerRef }],
          }),
        },
      );
      const order = obj(body.order);
      const phase = str(order.phase);
      const id = str(order.orderId);
      if (!id)
        return { state: 'UNKNOWN_PROVIDER_OUTCOME', reason: 'no order id' };
      return phase === 'completed' || phase === 'delivery'
        ? { state: 'ORDER_PLACED', orderRef: id, charged: null }
        : {
            state: 'UNKNOWN_PROVIDER_OUTCOME',
            reason: `order ${id} awaiting ${phase ?? 'unknown'} (payment not broadcast)`,
          };
    } catch (e) {
      return {
        state: 'UNKNOWN_PROVIDER_OUTCOME',
        reason: (e as Error).message,
      };
    }
  }
}
