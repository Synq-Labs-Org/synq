import { EconomicOfferSchema, type EconomicOffer } from '@synq/offer-exchange';

/** A Duffel test-mode return flight offer DEL ⇄ GOI (fixture; sandbox only). */
export function duffelOffer(
  id: string,
  cents: number,
  over: Record<string, unknown> = {},
  retrievedAt = 1_792_137_600,
): EconomicOffer {
  const NOW = retrievedAt;
  return EconomicOfferSchema.parse({
    offerId: id,
    intentId: 'trip-1',
    domain: 'FLIGHT',
    discoveryProviderId: 'duffel-flights',
    fulfillmentProviderId: 'duffel-flights',
    providerRef: id,
    subject: {
      kind: 'FLIGHT',
      segments: [
        {
          origin: 'DEL',
          destination: 'GOI',
          departureDate: '2026-12-01',
          carrier: 'ZZ',
          flightNumber: '123',
        },
        {
          origin: 'GOI',
          destination: 'DEL',
          departureDate: '2026-12-05',
          carrier: 'ZZ',
          flightNumber: '456',
        },
      ],
      adults: 3,
      cabin: 'premium_economy',
      checkedBags: 1,
    },
    price: {
      quoteId: `q-${id}`,
      base: { amount: String(cents), currency: 'USD', decimals: 2 },
      shipping: { amount: '0', currency: 'USD', decimals: 2 },
      tax: { amount: '1000', currency: 'USD', decimals: 2 },
      fees: { amount: '0', currency: 'USD', decimals: 2 },
      fx: [],
      quotedAt: NOW,
      expiresAt: NOW + 1200,
      revalidatedAt: null,
    },
    cancellation: {
      kind: 'NON_REFUNDABLE',
      refundable: false,
      freeUntil: null,
      penalty: null,
      changeable: false,
    },
    settlement: {
      accepts: [{ rail: 'PROVIDER_BALANCE', currency: 'USD' }],
      payee: null,
    },
    execution: {
      mode: 'NATIVE_API',
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: [],
    },
    environment: 'SANDBOX',
    evidence: 'MOCKED',
    stops: 0,
    retrievedAt: NOW,
    executable: false,
    ...over,
  });
}
