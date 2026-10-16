import { compare, type EconomicOffer, type Money } from '@synq/offer-exchange';
import {
  selectExecutionRoute,
  type ProviderExecutionCapability,
  type RouteConsidered,
} from '@synq/settlement';
import {
  CommerceExecutionRouter,
  type CheckoutMode,
  type CheckoutRoute,
} from './checkout.js';

/**
 * The chat commerce journey: "@Synq, find this product on Amazon and buy it
 * under my approved budget". Chat text only drafts the request; the budget
 * comes from the signed mandate and chat can only lower it. A marketplace
 * listing is discovery, never order authority: checkout runs only through a
 * provider entitled to order from that merchant, a consented scoped card the
 * human uses, or a plain human handoff. Arc USDC is never presented as
 * paying an arbitrary Web2 merchant.
 */
export type CommerceRequest = Readonly<{
  marketplace: 'AMAZON' | 'ANY';
  asin: string | null;
  url: string | null;
  query: string | null;
  /** A cap stated in chat ("under $25"); it can only lower the mandate budget. */
  statedCapCents: number | null;
  wantsPurchase: boolean;
}>;

export function parseCommerceRequest(text: string): CommerceRequest | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!/@synq\b/i.test(t)) return null;
  const url =
    /(https?:\/\/(?:www\.)?amazon\.[a-z.]+\/[^\s]+)/i.exec(t)?.[1] ?? null;
  const asin =
    /(?:\/dp\/|\/gp\/product\/|\basin[:\s]+)([A-Z0-9]{10})\b/i
      .exec(t)?.[1]
      ?.toUpperCase() ?? null;
  const cap =
    /\b(?:under|below|max(?:imum)?|up to)\s*\$\s?(\d{1,6})(?:\.(\d{2}))?/i.exec(
      t,
    );
  const quoted = /"([^"]{3,120})"/.exec(t)?.[1] ?? null;
  return {
    marketplace: /\bamazon\b/i.test(t) || url ? 'AMAZON' : 'ANY',
    asin,
    url,
    query: quoted,
    statedCapCents: cap ? Number(cap[1]) * 100 + Number(cap[2] ?? 0) : null,
    wantsPurchase: /\b(buy|order|purchase|get it)\b/i.test(t),
  };
}

/** The mandate budget, lowered (never raised) by a cap stated in chat. */
export function effectiveBudget(
  mandateCap: Money,
  request: CommerceRequest,
): Money {
  if (request.statedCapCents === null || mandateCap.currency !== 'USD')
    return mandateCap;
  const stated: Money = {
    amount: String(
      request.statedCapCents * 10 ** Math.max(0, mandateCap.decimals - 2),
    ),
    currency: 'USD',
    decimals: mandateCap.decimals,
  };
  return compare(stated, mandateCap) < 0 ? stated : mandateCap;
}

export type CheckoutPath =
  | 'NATIVE_ORDER'
  | 'STABLECOIN_CHECKOUT'
  | 'SCOPED_CARD_HANDOFF'
  | 'HUMAN_HANDOFF';

export type CheckoutEligibility = Readonly<{
  listing: Readonly<{
    discoveredBy: readonly string[];
    providerRef: string;
    merchant: string;
    /** A listing never carries order authority, whatever the source. */
    orderAuthority: false;
  }>;
  path: CheckoutPath;
  /** Entitled checkout route (NATIVE_ORDER / STABLECOIN_CHECKOUT). */
  route: CheckoutRoute | null;
  /** Card provider for the consented scoped-card path. */
  cardProvider: ProviderExecutionCapability | null;
  considered: readonly { providerId: string; mode: string; verdict: string }[];
  statement: string;
}>;

const merchantOf = (offer: EconomicOffer) =>
  /^amazon:/.test(offer.providerRef) ||
  offer.discoveryProviderId.includes('amazon')
    ? 'amazon'
    : offer.subject.kind === 'PRODUCT'
      ? (offer.subject.seller ?? offer.fulfillmentProviderId)
      : offer.fulfillmentProviderId;

/**
 * Which providers can actually execute this purchase. Order of preference:
 * an entitled native/stablecoin checkout, then a consented scoped card the
 * human uses at the merchant, then a plain human handoff. Nothing is ever
 * simulated here.
 */
export function checkoutEligibility(input: {
  offer: EconomicOffer;
  routes: readonly CheckoutRoute[];
  allowed: readonly CheckoutMode[];
  fabric: readonly ProviderExecutionCapability[];
}): CheckoutEligibility {
  const { offer } = input;
  const merchant = merchantOf(offer);
  const listing = {
    discoveredBy: [offer.discoveryProviderId, ...offer.alsoDiscoveredBy],
    providerRef: offer.providerRef,
    merchant,
    orderAuthority: false as const,
  };
  const decision = new CommerceExecutionRouter(input.routes, {
    fallback: 'HANDOFF',
  }).decide(offer, input.allowed);
  const considered: { providerId: string; mode: string; verdict: string }[] =
    decision.considered.map((c) => ({
      providerId: c.providerId,
      mode: c.mode,
      verdict: c.verdict,
    }));
  const sources = listing.discoveredBy.join(', ');
  if (decision.kind === 'EXECUTE')
    return {
      listing,
      path:
        decision.route.mode === 'NATIVE_API'
          ? 'NATIVE_ORDER'
          : 'STABLECOIN_CHECKOUT',
      route: decision.route,
      cardProvider: null,
      considered,
      statement: `Listing found via ${sources}. ${decision.route.providerId} is entitled to place this ${merchant} order in its sandbox.`,
    };
  let cardProvider: ProviderExecutionCapability | null = null;
  if (input.allowed.includes('SCOPED_CARD')) {
    const card = selectExecutionRoute(
      {
        intentId: offer.intentId,
        product: 'VIRTUAL_CARD_AUTHORIZATION',
        currency: offer.price.base.currency,
        requiredChain: null,
        allowedModes: ['PROVIDER_SANDBOX'],
        categories: ['CARD_NETWORK_SANDBOX'],
      },
      input.fabric,
    );
    considered.push(
      ...card.considered
        .filter((c: RouteConsidered) => c.category === 'CARD_NETWORK_SANDBOX')
        .map((c: RouteConsidered) => ({
          providerId: c.providerId,
          mode: 'SCOPED_CARD',
          verdict: c.verdict,
        })),
    );
    if (card.status === 'SELECTED') cardProvider = card.provider;
  }
  if (cardProvider)
    return {
      listing,
      path: 'SCOPED_CARD_HANDOFF',
      route: null,
      cardProvider,
      considered,
      statement:
        `Listing found via ${sources}. Synq has no order authority at ${merchant}; ` +
        `a human completes checkout with a single-use card scoped to the approved amount (${cardProvider.displayName}). ` +
        `Sandbox cards reach no card network: no ${merchant} order is placed and no merchant is charged.`,
    };
  return {
    listing,
    path: 'HUMAN_HANDOFF',
    route: null,
    cardProvider: null,
    considered,
    statement: `Listing found via ${sources}. No entitled checkout or consented card path for ${merchant}; a human completes the purchase.`,
  };
}

export const JOURNEY_STAGES = [
  'REQUESTED',
  'DISCOVERED',
  'MATCHED',
  'REVALIDATED',
  'PROVIDERS_IDENTIFIED',
  'APPROVAL_PENDING',
  'APPROVED',
  'RAIL_SELECTED',
  'CHECKOUT_PLACED',
  'HANDOFF',
  'RECONCILED',
  'DELIVERY_PENDING',
  'REFUND_ACCEPTED',
  'REFUND_SETTLED',
  'FAILED',
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

const NEXT: Record<JourneyStage, readonly JourneyStage[]> = {
  REQUESTED: ['DISCOVERED', 'FAILED'],
  DISCOVERED: ['MATCHED', 'FAILED'],
  MATCHED: ['REVALIDATED', 'FAILED'],
  // A price change after revalidation goes back through approval, never forward.
  REVALIDATED: ['PROVIDERS_IDENTIFIED', 'MATCHED', 'FAILED'],
  PROVIDERS_IDENTIFIED: ['APPROVAL_PENDING', 'FAILED'],
  APPROVAL_PENDING: ['APPROVED', 'FAILED'],
  APPROVED: ['RAIL_SELECTED', 'REVALIDATED', 'FAILED'],
  RAIL_SELECTED: ['CHECKOUT_PLACED', 'HANDOFF', 'FAILED'],
  CHECKOUT_PLACED: ['RECONCILED', 'FAILED'],
  HANDOFF: ['RECONCILED', 'FAILED'],
  RECONCILED: ['DELIVERY_PENDING', 'REFUND_ACCEPTED'],
  DELIVERY_PENDING: ['REFUND_ACCEPTED'],
  // Accepted is a claim; only arrived money settles it.
  REFUND_ACCEPTED: ['REFUND_SETTLED'],
  REFUND_SETTLED: [],
  FAILED: [],
};

export class JourneyTransitionError extends Error {
  constructor(from: JourneyStage, to: JourneyStage) {
    super(`JOURNEY_TRANSITION_FORBIDDEN: ${from} -> ${to}`);
    this.name = 'JourneyTransitionError';
  }
}

/** Agent-facing journey record: refs, ids, amounts and labels only; never PII or card data. */
export type JourneyFact = Readonly<{
  stage: JourneyStage;
  at: number;
  note: string;
  refs: Readonly<Record<string, string>>;
}>;

const SAFE_REF = /^[A-Za-z0-9:_.\-/]{1,200}$/;

export class CommerceJourney {
  stage: JourneyStage = 'REQUESTED';
  readonly facts: JourneyFact[] = [];
  constructor(
    readonly journeyId: string,
    private readonly now: () => number,
  ) {
    this.facts.push({
      stage: 'REQUESTED',
      at: now(),
      note: 'chat request drafted an intent; it authorizes nothing',
      refs: {},
    });
  }

  advance(to: JourneyStage, note: string, refs: Record<string, string> = {}) {
    if (!NEXT[this.stage].includes(to))
      throw new JourneyTransitionError(this.stage, to);
    for (const [k, v] of Object.entries(refs))
      if (!SAFE_REF.test(v)) throw new Error(`JOURNEY_UNSAFE_REF: ${k}`);
    this.stage = to;
    this.facts.push({
      stage: to,
      at: this.now(),
      note: note.slice(0, 300),
      refs,
    });
  }

  /** What a model may see about this journey. */
  agentView() {
    return { journeyId: this.journeyId, stage: this.stage, facts: this.facts };
  }
}
