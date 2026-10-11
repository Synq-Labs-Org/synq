import {
  providerMoney,
  zero,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type FlightSubject,
  type OfferProvider,
  type RevalidatedQuote,
} from '@synq/offer-exchange';
import { DuffelClient, DuffelError } from './client.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const DUFFEL_FLIGHTS = 'duffel-flights';
export const DUFFEL_AIRWAYS_IATA = 'ZZ';

const epoch = (iso: string | undefined, fallback: number) =>
  iso ? Math.floor(Date.parse(iso) / 1000) : fallback;

export function offerSubject(offer: Json, adults: number): FlightSubject {
  const slices = arr(offer.slices);
  const firstPassenger = (seg: Json) => obj(arr(seg.passengers)[0]);
  const segments = slices.map((slice) => {
    const segs = arr(slice.segments);
    const first = segs[0] ?? {};
    return {
      origin: String(
        obj(slice.origin).iata_code ?? obj(first.origin).iata_code,
      ),
      destination: String(
        obj(slice.destination).iata_code ?? obj(segs.at(-1)).destination,
      ),
      departureDate: String(str(first.departing_at) ?? '').slice(0, 10),
      ...(str(obj(first.marketing_carrier).iata_code)
        ? { carrier: String(obj(first.marketing_carrier).iata_code) }
        : {}),
      ...(segs.length === 1 && str(first.marketing_carrier_flight_number)
        ? { flightNumber: String(first.marketing_carrier_flight_number) }
        : {}),
    };
  });
  const allSegs = slices.flatMap((s) => arr(s.segments));
  const cabins = new Set(
    allSegs.map((s) => str(firstPassenger(s).cabin_class) ?? 'economy'),
  );
  const bags = allSegs.length
    ? Math.min(
        ...allSegs.map((s) =>
          arr(firstPassenger(s).baggages)
            .filter((b) => b.type === 'checked')
            .reduce((n, b) => n + Number(b.quantity ?? 0), 0),
        ),
      )
    : 0;
  const conditions = obj(offer.conditions);
  const fareBrand = str(slices[0]?.fare_brand_name);
  return {
    kind: 'FLIGHT',
    segments,
    adults,
    cabin: (cabins.size === 1
      ? [...cabins][0]
      : 'economy') as FlightSubject['cabin'],
    ...(fareBrand ? { fareFamily: fareBrand } : {}),
    checkedBags: bags,
    changeable: obj(conditions.change_before_departure).allowed === true,
    refundable: obj(conditions.refund_before_departure).allowed === true,
  };
}

function offerPrice(offer: Json, now: number, revalidatedAt: number | null) {
  const currency = str(offer.total_currency) ?? 'USD';
  const total = providerMoney(String(offer.total_amount), currency);
  const tax =
    offer.tax_amount != null
      ? providerMoney(
          String(offer.tax_amount),
          str(offer.tax_currency) ?? currency,
        )
      : zero(currency, total.decimals);
  const sameUnit = tax.currency === total.currency;
  const base = sameUnit
    ? { ...total, amount: String(BigInt(total.amount) - BigInt(tax.amount)) }
    : total;
  return {
    quoteId: String(offer.id),
    base,
    shipping: zero(currency, total.decimals),
    tax: sameUnit ? tax : zero(currency, total.decimals),
    fees: zero(currency, total.decimals),
    fx: [],
    quotedAt: now,
    expiresAt: epoch(str(offer.expires_at), now + 600),
    revalidatedAt,
  };
}

export class DuffelFlightsProvider implements OfferProvider {
  readonly providerId = DUFFEL_FLIGHTS;
  constructor(
    private readonly client: DuffelClient,
    private readonly now: () => number,
    private readonly options: {
      maxOffers?: number;
      fxRates?: EconomicOffer['price']['fx'];
    } = {},
  ) {}

  async search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]> {
    const s = intent.subject;
    if (s.kind !== 'FLIGHT') return [];
    const r = await this.client.request<Json>(
      'POST',
      '/air/offer_requests?return_offers=true',
      {
        slices: s.segments.map((g) => ({
          origin: g.origin,
          destination: g.destination,
          departure_date: g.departureDate,
        })),
        passengers: Array.from({ length: s.adults }, () => ({ type: 'adult' })),
        cabin_class: s.cabin,
        max_connections: 1,
      },
      signal,
    );
    const now = this.now();
    return arr(r.data.offers)
      .slice(0, this.options.maxOffers ?? 20)
      .map((o) => this.toOffer(intent, o, now, null));
  }

  toOffer(
    intent: EconomicIntent,
    o: Json,
    now: number,
    revalidatedAt: number | null,
  ): EconomicOfferInput {
    const subject = offerSubject(o, (intent.subject as FlightSubject).adults);
    const conditions = obj(o.conditions);
    const refund = obj(conditions.refund_before_departure);
    const currency = str(o.total_currency) ?? 'USD';
    const stops = Math.max(
      0,
      ...arr(o.slices).map((sl) => arr(sl.segments).length - 1),
    );
    return {
      offerId: `${DUFFEL_FLIGHTS}:${String(o.id)}`,
      intentId: intent.id,
      domain: 'FLIGHT',
      discoveryProviderId: DUFFEL_FLIGHTS,
      fulfillmentProviderId: DUFFEL_FLIGHTS,
      providerRef: String(o.id),
      subject,
      stops,
      price: {
        ...offerPrice(o, now, revalidatedAt),
        fx: this.options.fxRates ?? [],
      },
      cancellation: {
        kind:
          refund.allowed === true
            ? refund.penalty_amount && refund.penalty_amount !== '0.00'
              ? 'PARTIAL'
              : 'FREE_UNTIL'
            : 'NON_REFUNDABLE',
        refundable: refund.allowed === true,
        freeUntil: null,
        penalty:
          refund.allowed === true && refund.penalty_amount != null
            ? providerMoney(
                String(refund.penalty_amount),
                str(refund.penalty_currency) ?? currency,
              )
            : null,
        changeable: subject.changeable === true,
      },
      settlement: {
        accepts: [{ rail: 'PROVIDER_BALANCE', currency }],
        payee: null,
      },
      execution: {
        mode: 'NATIVE_API',
        requiresQuote: true,
        requiresKyc: false,
        requiresStepUp: false,
        piiFields: ['TRAVELER_NAME', 'DOB', 'EMAIL', 'PHONE'],
      },
      environment: 'SANDBOX',
      evidence: 'PROVIDER_SANDBOX',
      retrievedAt: now,
      executable: false,
    };
  }

  async revalidate(
    offer: EconomicOffer,
    signal: AbortSignal,
  ): Promise<RevalidatedQuote> {
    const now = this.now();
    try {
      const r = await this.client.request<Json>(
        'GET',
        `/air/offers/${encodeURIComponent(offer.providerRef)}`,
        undefined,
        signal,
      );
      const subject = offerSubject(
        r.data,
        (offer.subject as FlightSubject).adults,
      );
      return {
        available: true,
        providerRef: String(r.data.id),
        subject,
        price: { ...offerPrice(r.data, now, now), fx: offer.price.fx },
      };
    } catch (error) {
      if (
        error instanceof DuffelError &&
        error.kind === 'DEFINITIVE' &&
        error.status !== null &&
        error.status < 500
      )
        return {
          available: false,
          providerRef: offer.providerRef,
          subject: offer.subject,
          price: offer.price,
        };
      throw error;
    }
  }

  async passengerIds(offerId: string, signal?: AbortSignal): Promise<string[]> {
    const r = await this.client.request<Json>(
      'GET',
      `/air/offers/${encodeURIComponent(offerId)}`,
      undefined,
      signal,
    );
    return arr(r.data.passengers).map((p) => String(p.id));
  }
}
