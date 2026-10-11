import {
  add,
  applyBps,
  compare,
  convert,
  sameUnit,
  type Money,
} from './money.js';
import { comparable, matchSubject, type MatchResult } from './matchers.js';
import type { ProviderCapabilityGraph } from './capability.js';
import type { OfferProvider, SearchResult } from './search.js';
import { withDeadline } from './search.js';
import type { EconomicIntent, EconomicOffer } from './schemas.js';

export function landedTotal(
  offer: EconomicOffer,
  target: { currency: string; decimals: number },
): Money {
  const p = offer.price;
  return [p.base, p.shipping, p.tax, p.fees]
    .map((m) => convert(m, target, p.fx))
    .reduce((a, b) => add(a, b));
}

export type Candidate = {
  offer: EconomicOffer;
  match: MatchResult;
  landed: Money;
};
export type Rejection = {
  offerId: string;
  providerId: string;
  reasons: string[];
};
export type RankedCandidate = Candidate & { rank: number; explanation: string };

export type Selection = {
  intentId: string;
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  recommendations: Candidate[];
  rejected: Rejection[];
  coverage: SearchResult['coverage'];
};

function constraintViolations(
  intent: EconomicIntent,
  c: Candidate,
  now: number,
): string[] {
  const out: string[] = [];
  const { offer } = c;
  if (offer.price.expiresAt <= now) out.push('quote expired');
  if (offer.execution.mode === 'DISCOVERY_ONLY' && offer.domain !== 'COMMERCE')
    out.push('discovery-only offer');
  if (compare(c.landed, intent.budget.max) > 0) out.push('over budget');
  for (const h of intent.hardConstraints) {
    switch (h.kind) {
      case 'MAX_LANDED_TOTAL':
        try {
          if (compare(convert(c.landed, h.max, []), h.max) > 0)
            out.push('landed total above hard cap');
        } catch {
          out.push('hard cap currency differs from budget');
        }
        break;
      case 'REQUIRE_REFUNDABLE':
        if (!offer.cancellation.refundable) out.push('not refundable');
        break;
      case 'CONDITION_IN':
        if (
          offer.subject.kind === 'PRODUCT' &&
          !h.allowed.includes(offer.subject.condition)
        )
          out.push(`condition ${offer.subject.condition} not allowed`);
        break;
      case 'DELIVER_BY':
        if (
          offer.subject.kind === 'PRODUCT' &&
          (offer.subject.deliverBy === undefined ||
            offer.subject.deliverBy > h.at)
        )
          out.push('delivery after deadline');
        break;
      case 'SELLER_MIN_RATING_BPS':
        if (
          offer.subject.kind === 'PRODUCT' &&
          (offer.subject.sellerRatingBps ?? 0) < h.min
        )
          out.push('seller rating below minimum');
        break;
      case 'PROVIDER_ALLOWLIST':
        if (!h.providers.includes(offer.fulfillmentProviderId))
          out.push('provider not allowed');
        break;
      case 'MAX_STOPS':
        if ((offer.stops ?? 0) > h.max) out.push('too many stops');
        break;
      case 'MIN_EXPIRY_SECONDS':
        if (offer.price.expiresAt - now < h.seconds)
          out.push('quote expires too soon');
        break;
    }
  }
  return out;
}

const LEVEL_ORDER = { EXACT_MATCH: 0, NEAR_EQUIVALENT: 1 } as const;

/** Deterministic total order: strong preferences, landed total, match level, terms, then ids. */
export function rankCandidates(
  intent: EconomicIntent,
  candidates: readonly Candidate[],
): RankedCandidate[] {
  const strong = new Set(
    intent.preferences.filter((p) => p.weight >= 50).map((p) => p.key),
  );
  const key = (c: Candidate) => ({
    landed: BigInt(c.landed.amount),
    level:
      LEVEL_ORDER[c.match.level as keyof typeof LEVEL_ORDER] ??
      Number.MAX_VALUE,
    refundable: c.offer.cancellation.refundable ? 0 : 1,
    delivery:
      c.offer.subject.kind === 'PRODUCT'
        ? (c.offer.subject.deliverBy ?? Number.MAX_SAFE_INTEGER)
        : 0,
    rating:
      c.offer.subject.kind === 'PRODUCT'
        ? -(c.offer.subject.sellerRatingBps ?? 0)
        : 0,
    stops: c.offer.stops ?? 0,
  });
  const sorted = [...candidates].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const terms: [number, number][] = [];
    if (strong.has('REFUNDABLE')) terms.push([x.refundable, y.refundable]);
    if (strong.has('FAST_DELIVERY')) terms.push([x.delivery, y.delivery]);
    if (strong.has('FEWER_STOPS')) terms.push([x.stops, y.stops]);
    if (strong.has('SELLER_RATING')) terms.push([x.rating, y.rating]);
    for (const [p, q] of terms) if (p !== q) return p - q;
    if (x.landed !== y.landed) return x.landed < y.landed ? -1 : 1;
    if (x.level !== y.level) return x.level - y.level;
    if (x.refundable !== y.refundable) return x.refundable - y.refundable;
    if (x.delivery !== y.delivery) return x.delivery - y.delivery;
    if (x.rating !== y.rating) return x.rating - y.rating;
    return (
      a.offer.fulfillmentProviderId.localeCompare(
        b.offer.fulfillmentProviderId,
      ) || a.offer.offerId.localeCompare(b.offer.offerId)
    );
  });
  return sorted.map((c, i) => ({
    ...c,
    rank: i + 1,
    explanation: [
      `#${i + 1}`,
      `landed ${c.landed.amount} ${c.landed.currency}/${c.landed.decimals}`,
      c.match.level,
      `via ${c.match.basis}`,
      c.offer.cancellation.refundable ? 'refundable' : 'non-refundable',
      `provider ${c.offer.fulfillmentProviderId}`,
      ...(c.match.reasons.length ? [`(${c.match.reasons.join('; ')})`] : []),
    ].join(' '),
  }));
}

/** Merges the same fulfillable offer seen by several discovery sources, keeping every source. */
export function dedupeOffers(
  offers: readonly EconomicOffer[],
): EconomicOffer[] {
  const byKey = new Map<string, EconomicOffer>();
  for (const o of offers) {
    const key = `${o.fulfillmentProviderId}|${o.providerRef}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, o);
      continue;
    }
    const sources = new Set([
      prior.discoveryProviderId,
      ...prior.alsoDiscoveredBy,
      o.discoveryProviderId,
      ...o.alsoDiscoveredBy,
    ]);
    const cheaper =
      sameUnit(o.price.base, prior.price.base) &&
      compare(o.price.base, prior.price.base) < 0
        ? o
        : prior;
    sources.delete(cheaper.discoveryProviderId);
    byKey.set(key, { ...cheaper, alsoDiscoveredBy: [...sources].sort() });
  }
  return [...byKey.values()];
}

export function selectOffers(input: {
  intent: EconomicIntent;
  search: SearchResult;
  now: number;
}): Selection {
  const { intent, now } = input;
  const rejected: Rejection[] = [];
  const recommendations: Candidate[] = [];
  const candidates: Candidate[] = [];
  if (intent.validUntil <= now)
    return {
      intentId: intent.id,
      selected: null,
      ranked: [],
      recommendations: [],
      rejected: input.search.offers.map((o) => ({
        offerId: o.offerId,
        providerId: o.fulfillmentProviderId,
        reasons: ['intent expired'],
      })),
      coverage: input.search.coverage,
    };
  for (const offer of dedupeOffers(input.search.offers)) {
    const match = matchSubject(
      intent.subject,
      offer.subject,
      intent.autonomy.substitution,
    );
    let landed: Money;
    try {
      landed = landedTotal(offer, intent.budget.max);
    } catch (error) {
      rejected.push({
        offerId: offer.offerId,
        providerId: offer.fulfillmentProviderId,
        reasons: [error instanceof Error ? error.message : 'price invalid'],
      });
      continue;
    }
    const c: Candidate = { offer, match, landed };
    if (!comparable(match.level, intent.autonomy.substitution)) {
      if (match.level === 'NOT_COMPARABLE')
        rejected.push({
          offerId: offer.offerId,
          providerId: offer.fulfillmentProviderId,
          reasons: [match.level, ...match.reasons],
        });
      else recommendations.push(c);
      continue;
    }
    const violations = constraintViolations(intent, c, now);
    if (violations.length) {
      rejected.push({
        offerId: offer.offerId,
        providerId: offer.fulfillmentProviderId,
        reasons: violations,
      });
      continue;
    }
    candidates.push(c);
  }
  const ranked = rankCandidates(intent, candidates);
  return {
    intentId: intent.id,
    selected: ranked[0] ?? null,
    ranked,
    recommendations,
    rejected,
    coverage: input.search.coverage,
  };
}

export type RevalidationOutcome =
  | { status: 'EXECUTABLE'; offer: EconomicOffer; landed: Money }
  | {
      status:
        | 'EXPIRED'
        | 'UNAVAILABLE'
        | 'PRICE_DRIFT'
        | 'MISMATCH'
        | 'PROVIDER_UNAVAILABLE'
        | 'NO_REVALIDATION';
      reason: string;
    };

/**
 * A quote is never executable until the fulfillment provider revalidates it
 * (Bible §89). Price drift beyond the mandate tolerance or any identity change
 * blocks execution.
 */
export async function revalidateOffer(input: {
  intent: EconomicIntent;
  candidate: Candidate;
  provider: OfferProvider;
  graph: ProviderCapabilityGraph;
  approvedMax: Money;
  now: () => number;
  timeoutMs?: number;
}): Promise<RevalidationOutcome> {
  const { intent, candidate, provider, graph } = input;
  const offer = candidate.offer;
  if (
    provider.providerId !== offer.fulfillmentProviderId &&
    !provider.revalidatesFor?.includes(offer.fulfillmentProviderId)
  )
    return {
      status: 'MISMATCH',
      reason: 'provider cannot revalidate for the fulfiller',
    };
  if (!provider.revalidate)
    return { status: 'NO_REVALIDATION', reason: 'provider cannot revalidate' };
  if (!graph.usable(provider.providerId, 'QUOTE', input.now()))
    return { status: 'PROVIDER_UNAVAILABLE', reason: 'provider not usable' };
  if (intent.validUntil <= input.now())
    return { status: 'EXPIRED', reason: 'intent expired' };
  let fresh;
  try {
    fresh = await withDeadline(
      input.timeoutMs ?? 10_000,
      provider.providerId,
      (signal) => provider.revalidate!(offer, signal),
    );
    graph.recordSuccess(provider.providerId, 0, input.now());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    graph.recordFailure(provider.providerId, reason, input.now());
    return { status: 'PROVIDER_UNAVAILABLE', reason };
  }
  const now = input.now();
  if (!fresh.available)
    return { status: 'UNAVAILABLE', reason: 'provider reports unavailable' };
  if (fresh.price.expiresAt <= now)
    return { status: 'EXPIRED', reason: 'revalidated quote already expired' };
  const identity = matchSubject(offer.subject, fresh.subject, 'NONE');
  if (identity.level !== 'EXACT_MATCH')
    return {
      status: 'MISMATCH',
      reason: `revalidated item changed: ${identity.reasons.join('; ')}`,
    };
  const next: EconomicOffer = {
    ...offer,
    providerRef: fresh.providerRef,
    subject: fresh.subject,
    price: { ...fresh.price, revalidatedAt: now },
  };
  const landed = landedTotal(next, intent.budget.max);
  const tolerance = add(
    candidate.landed,
    applyBps(candidate.landed, intent.maxPriceDriftBps),
  );
  if (compare(landed, input.approvedMax) > 0)
    return {
      status: 'PRICE_DRIFT',
      reason: `landed ${landed.amount} exceeds approved max ${input.approvedMax.amount}`,
    };
  if (compare(landed, tolerance) > 0)
    return {
      status: 'PRICE_DRIFT',
      reason: `landed ${landed.amount} drifted beyond ${intent.maxPriceDriftBps} bps`,
    };
  if (compare(landed, intent.budget.max) > 0)
    return { status: 'PRICE_DRIFT', reason: 'over intent budget' };
  return { status: 'EXECUTABLE', offer: { ...next, executable: true }, landed };
}

export class NotExecutableError extends Error {
  constructor(reason: string) {
    super(`QUOTE_NOT_EXECUTABLE: ${reason}`);
    this.name = 'NotExecutableError';
  }
}

export function assertExecutable(
  offer: EconomicOffer,
  now: number,
  maxAgeSeconds = 300,
): void {
  if (!offer.executable || offer.price.revalidatedAt === null)
    throw new NotExecutableError('not revalidated');
  if (offer.price.expiresAt <= now) throw new NotExecutableError('expired');
  if (now - offer.price.revalidatedAt > maxAgeSeconds)
    throw new NotExecutableError('revalidation stale');
}
