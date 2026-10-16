import { createHash } from 'node:crypto';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  fromDecimal,
  landedTotal,
  revalidateOffer,
  searchOffers,
  selectOffers,
  toDecimal,
  type EconomicIntent,
  type EconomicOffer,
  type FlightSubject,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  travelCapabilities,
  type HttpFetch,
} from '@synq/plugin-duffel';
import type { TripOption, TripPorts } from './fund-trips.js';
import type { Cabin } from './fund-intents.js';

/**
 * Duffel flights in TEST MODE for fund trips. Test mode can only issue orders on
 * Duffel Airways (ZZ), so only those offers are shown; passengers are synthetic
 * test travellers and no real ticket or charge is ever made. A return trip is
 * one offer request with two slices (out and back), priced and booked as one
 * order.
 */
const TEST_TRAVELERS = ['Ada', 'Ben', 'Cy', 'Dee'].map((givenName, i) => ({
  givenName,
  familyName: 'Synqtest',
  bornOn: `199${i}-01-01`,
  email: `${givenName.toLowerCase()}.synqtest@example.com`,
  phone: '+442080160509',
  title: 'ms' as const,
  gender: 'f' as const,
}));
const BUDGET = { amount: '500000', currency: 'USD', decimals: 2 };

const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

type StoredOffer = { intent: EconomicIntent; offer: EconomicOffer };

const flightOf = (o: EconomicOffer) => o.subject as FlightSubject;
const isDuffelAirways = (o: EconomicOffer) =>
  o.subject.kind === 'FLIGHT' &&
  flightOf(o).segments.every((s) => s.carrier === 'ZZ');

export function duffelTripPorts(
  token: string,
  now: () => number,
): Pick<TripPorts, 'search' | 'book'> {
  const client = new DuffelClient(token, realFetch, {
    evidence: 'PROVIDER_SANDBOX',
  });
  const provider = new DuffelFlightsProvider(client, now, { maxOffers: 500 });
  const exec = new DuffelBookingExecutor(client);
  const graph = new ProviderCapabilityGraph(
    travelCapabilities({ DUFFEL_TEST_TOKEN: token }),
  );

  type Leg = { origin: string; destination: string; departureDate: string };
  const legsOf = (input: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string | null;
  }): Leg[] => [
    {
      origin: input.origin,
      destination: input.destination,
      departureDate: input.departureDate,
    },
    ...(input.returnDate
      ? [
          {
            origin: input.destination,
            destination: input.origin,
            departureDate: input.returnDate,
          },
        ]
      : []),
  ];

  const intentFor = (input: {
    legs: Leg[];
    travelers: number;
    cabin: Cabin;
  }): EconomicIntent =>
    EconomicIntentSchema.parse({
      id: `flight-${now()}-${Math.random().toString(36).slice(2, 8)}`,
      groupId: 'synq-fund',
      domain: 'FLIGHT',
      objective: 'Group fund flight (Duffel test mode)',
      subject: {
        kind: 'FLIGHT',
        segments: input.legs,
        adults: input.travelers,
        cabin: input.cabin,
        checkedBags: 0,
      },
      hardConstraints: [],
      preferences: [],
      budget: { max: BUDGET },
      autonomy: { execution: 'QUORUM', substitution: 'NONE' },
      maxPriceDriftBps: 500,
      validUntil: now() + 86_400,
    });

  async function ranked(intent: EconomicIntent): Promise<EconomicOffer[]> {
    const result = await searchOffers({
      intent,
      providers: [provider],
      graph,
      now,
      timeoutMs: 90_000,
    });
    const failed = result.outcomes.find((o) => o.status !== 'OK');
    if (failed && !result.offers.length)
      throw new Error(`flight search failed: ${failed.status}`);
    return selectOffers({
      intent,
      search: { ...result, offers: result.offers.filter(isDuffelAirways) },
      now: now(),
    }).ranked.map((c) => c.offer);
  }

  const optionOf = (
    intent: EconomicIntent,
    offer: EconomicOffer,
  ): TripOption => {
    // One subject segment per slice: the outbound, then the return when present.
    const f = flightOf(offer);
    const total = landedTotal(offer, BUDGET);
    const flights = f.segments
      .map((s) => (s.flightNumber ? `ZZ ${s.flightNumber}` : null))
      .filter(Boolean);
    const legs = f.segments.map(
      (s) => `${s.origin} → ${s.destination} ${s.departureDate}`,
    );
    return {
      optionId: createHash('sha256')
        .update(offer.offerId)
        .digest('hex')
        .slice(0, 12),
      title: `Duffel Airways${flights.length ? ` ${flights.join(' / ')}` : ''}`,
      detail: [
        ...legs,
        offer.stops
          ? `${offer.stops} stop${offer.stops > 1 ? 's' : ''}`
          : 'nonstop',
        f.cabin.replace('_', ' '),
      ].join(' · '),
      total: toDecimal(total),
      currency: total.currency,
      refundable: offer.cancellation.refundable,
      offer: { intent, offer } satisfies StoredOffer,
    };
  };

  async function quoteAndOrder(
    stored: StoredOffer,
    maxTotal: string,
    idempotencyKey: string,
  ) {
    const approvedMax = fromDecimal(maxTotal, 'USD', 2);
    const attempt = (offer: EconomicOffer, intent: EconomicIntent) =>
      revalidateOffer({
        intent,
        candidate: {
          offer,
          landed: landedTotal(offer, BUDGET),
          match: { level: 'EXACT_MATCH', basis: 'SELECTED', reasons: [] },
        },
        provider,
        graph,
        approvedMax,
        now,
        timeoutMs: 60_000,
      });
    let intent = stored.intent;
    let quote = await attempt(stored.offer, intent);
    if (quote.status !== 'EXECUTABLE') {
      // Offers expire while the group approves: search the same route (both
      // legs for a return trip) again and take the cheapest Duffel Airways
      // offer within what was paid.
      const wanted = stored.intent.subject as FlightSubject;
      intent = intentFor({
        legs: wanted.segments.map((s) => ({
          origin: s.origin,
          destination: s.destination,
          departureDate: s.departureDate,
        })),
        travelers: wanted.adults,
        cabin: wanted.cabin,
      });
      const again = (await ranked(intent))[0];
      if (!again)
        return {
          status: 'FAILED' as const,
          reason: 'No bookable test flight is left on that route.',
        };
      quote = await attempt(again, intent);
    }
    if (quote.status !== 'EXECUTABLE')
      return {
        status: 'FAILED' as const,
        reason: `The fare changed beyond what the group paid (${quote.status}).`,
      };
    const p = quote.offer.price;
    const total = {
      ...p.base,
      amount: String(
        BigInt(p.base.amount) + BigInt(p.tax.amount) + BigInt(p.fees.amount),
      ),
    };
    const ids = await provider.passengerIds(quote.offer.providerRef);
    const order = await exec.bookFlight({
      offerId: quote.offer.providerRef,
      passengerIds: ids,
      passengers: ids.map((_, i) => TEST_TRAVELERS[i % TEST_TRAVELERS.length]!),
      amount: total,
      amountDecimal: toDecimal(total),
      idempotencyKey,
    });
    if (order.status !== 'CONFIRMED')
      return {
        status: 'FAILED' as const,
        reason: 'Duffel test mode did not confirm the order.',
      };
    return {
      status: 'BOOKED' as const,
      reference: order.reference ?? null,
      bookingId: order.providerRef ?? null,
    };
  }

  return {
    search: async (input) => {
      const intent = intentFor({
        legs: legsOf(input),
        travelers: input.travelers,
        cabin: input.cabin,
      });
      return (await ranked(intent))
        .slice(0, 3)
        .map((offer) => optionOf(intent, offer));
    },
    book: async ({ option, maxTotal, idempotencyKey }) =>
      quoteAndOrder(option.offer as StoredOffer, maxTotal, idempotencyKey),
  };
}
