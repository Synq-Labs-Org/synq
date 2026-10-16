import { flightComparisonCard } from '@synq/plugin-duffel';
import { EconomicOfferSchema, type EconomicOffer } from '@synq/offer-exchange';
import type { CardOf } from '@synq/schemas';
import type { Trip } from './fund-trips.js';

/*
 * A fund's flight trip as a FLIGHT_COMPARISON card: the stored Duffel test
 * offers (never re-priced here), the group's preference votes and the
 * option the group chose. Mode is PROVIDER_SANDBOX: no real ticket.
 */

const offerOf = (stored: unknown): EconomicOffer | null => {
  const parsed = EconomicOfferSchema.safeParse(
    (stored as { offer?: unknown } | null)?.offer,
  );
  return parsed.success ? parsed.data : null;
};

export function flightTripCard(
  trip: Trip,
  ctx: { groupLabel: string; webBaseUrl: string; now: number },
): CardOf<'FLIGHT_COMPARISON'> | null {
  if (trip.kind !== 'FLIGHT') return null;
  const counts = new Map<string, number>();
  for (const o of Object.values(trip.votes))
    counts.set(o, (counts.get(o) ?? 0) + 1);
  const options = trip.options.flatMap((o) => {
    const offer = offerOf(o.offer);
    return offer
      ? [
          {
            optionId: o.optionId,
            offer,
            votes: counts.get(o.optionId) ?? 0,
            total: { amount: o.total, currency: o.currency },
          },
        ]
      : [];
  });
  if (!options.length) return null;
  const leading = [...options].sort((a, b) => b.votes - a.votes)[0]!;
  const url = `${ctx.webBaseUrl.replace(/\/$/, '')}/fund/${trip.fundId}/trips/${trip.tripId}`;
  return flightComparisonCard(
    {
      tripId: trip.tripId,
      options,
      preferredOptionId:
        trip.chosen ?? (leading.votes ? leading.optionId : null),
    },
    {
      groupId: trip.fundId,
      groupLabel: ctx.groupLabel,
      issuedAt: ctx.now,
      executionMode: 'PROVIDER_SANDBOX',
      actions: [
        { kind: 'VOTE', label: 'Compare and vote', url, style: 'PRIMARY' },
      ],
    },
  );
}
