import {
  landedTotal,
  toDecimal,
  type EconomicOffer,
  type FlightSubject,
} from '@synq/offer-exchange';
import {
  InteractiveCardSchema,
  arcCardBase,
  cardLine,
  cardRef,
  type ArcCardContext,
  type CardOf,
} from '@synq/schemas';

/*
 * Duffel flight offers → FLIGHT_COMPARISON card. Each offer's subject has
 * one segment per slice (outbound, then the return when present). Prices
 * are the landed totals as exact decimals in the offer currency. Duffel test
 * mode is a provider sandbox: nothing on the card is a real ticket.
 */

const CARRIER: Record<string, string> = { ZZ: 'Duffel Airways' };

export type FlightCardOption = Readonly<{
  /** Stable option id (e.g. a hash of the offer id). */
  optionId: string;
  offer: EconomicOffer;
  votes: number;
  /** Landed total the group sees, when already computed (decimal + currency). */
  total?: { amount: string; currency: string };
}>;

const flightOf = (o: EconomicOffer) => {
  if (o.subject.kind !== 'FLIGHT') throw new TypeError('not a flight offer');
  return o.subject as FlightSubject;
};

function option(o: FlightCardOption) {
  const f = flightOf(o.offer);
  const seg = f.segments.slice(0, 2);
  const code = seg[0]!.carrier;
  const flights = seg
    .map((s) =>
      s.flightNumber ? `${s.carrier ?? ''} ${s.flightNumber}`.trim() : null,
    )
    .filter(Boolean)
    .join(' / ');
  const price =
    o.total ??
    (() => {
      const base = o.offer.price.base;
      const landed = landedTotal(o.offer, {
        currency: base.currency,
        decimals: base.decimals,
      });
      return { amount: toDecimal(landed), currency: landed.currency };
    })();
  return {
    optionId: o.optionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'o',
    carrier: cardLine((code && CARRIER[code]) ?? code ?? 'Airline', 80),
    flights: flights ? cardLine(flights, 80) : null,
    legs: seg.map((s) => ({
      origin: s.origin,
      destination: s.destination,
      date: s.departureDate,
    })),
    stops: o.offer.stops ?? 0,
    price: { amount: price.amount, symbol: price.currency },
    baggage: f.checkedBags
      ? `${f.checkedBags} checked bag${f.checkedBags === 1 ? '' : 's'}`
      : 'Cabin bag only',
    refundable: o.offer.cancellation.refundable,
    votes: o.votes,
  };
}

export function flightComparisonCard(
  input: {
    tripId: string;
    proposalId?: string | null;
    /** Up to five options; the card shows the top three by preference and votes. */
    options: readonly FlightCardOption[];
    preferredOptionId?: string | null;
    provider?: string;
  },
  ctx: ArcCardContext,
): CardOf<'FLIGHT_COMPARISON'> {
  const options = input.options.slice(0, 5).map(option);
  const first = flightOf(input.options[0]!.offer);
  const out = first.segments[0]!;
  const back = first.segments.length > 1 ? first.segments.at(-1)! : null;
  const observed = Math.max(...input.options.map((o) => o.offer.retrievedAt));
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      observed,
      'flights',
      input.tripId,
      input.preferredOptionId ?? '',
      ...options.map((o) => `${o.optionId}:${o.votes}`),
    ),
    type: 'FLIGHT_COMPARISON',
    chainId: null,
    tripId: cardRef(input.tripId),
    proposalId: input.proposalId ? cardRef(input.proposalId) : null,
    origin: out.origin,
    destination: out.destination,
    departureDate: out.departureDate,
    returnDate: back ? back.departureDate : null,
    travelers: Math.min(9, first.adults),
    cabin: first.cabin.replace(/_/g, ' '),
    options,
    preferredOptionId:
      options.find((o) => o.optionId === input.preferredOptionId)?.optionId ??
      null,
    provider: cardLine(input.provider ?? 'Duffel (test mode)', 80),
  }) as CardOf<'FLIGHT_COMPARISON'>;
}
