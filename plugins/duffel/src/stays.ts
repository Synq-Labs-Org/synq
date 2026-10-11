import {
  add,
  providerMoney,
  zero,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type OfferProvider,
  type RevalidatedQuote,
  type StaySubject,
} from '@synq/offer-exchange';
import { DuffelClient, DuffelError } from './client.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const DUFFEL_STAYS = 'duffel-stays';
export const STAY_QUOTE_POLICY_TTL_SECONDS = 600;

const BOARD: Record<string, StaySubject['mealPlan']> = {
  room_only: 'ROOM_ONLY',
  breakfast: 'BREAKFAST',
  half_board: 'HALF_BOARD',
  full_board: 'FULL_BOARD',
  all_inclusive: 'ALL_INCLUSIVE',
};

const epoch = (iso: string | undefined): number | null =>
  iso ? Math.floor(Date.parse(iso) / 1000) : null;

export type StayRate = {
  rateId: string;
  roomName: string;
  beds: string | undefined;
  rate: Json;
};

function cancellation(rate: Json, now: number) {
  const timeline = arr(rate.cancellation_timeline);
  const free = timeline.find(
    (t) =>
      str(t.refund_amount) !== undefined &&
      str(t.refund_amount) === str(rate.total_amount),
  );
  const freeUntil = epoch(str(free?.before));
  const refundable =
    timeline.length > 0 && freeUntil !== null && freeUntil > now;
  return {
    kind: refundable
      ? ('FREE_UNTIL' as const)
      : timeline.length
        ? ('PARTIAL' as const)
        : ('NON_REFUNDABLE' as const),
    refundable,
    freeUntil: refundable ? freeUntil : null,
    penalty: null,
    changeable: false,
  };
}

export function rateSubject(
  intentSubject: StaySubject,
  accommodation: Json,
  r: StayRate,
  now: number,
  dates: {
    checkIn: string;
    checkOut: string;
    rooms: number;
    adults: number;
    children: number;
  },
): StaySubject {
  const coords = obj(obj(accommodation.location).geographic_coordinates);
  const lat = typeof coords.latitude === 'number' ? coords.latitude : undefined;
  const lon =
    typeof coords.longitude === 'number' ? coords.longitude : undefined;
  const meal = BOARD[str(r.rate.board_type) ?? ''];
  return {
    kind: 'STAY',
    propertyName: str(accommodation.name),
    providerPropertyIds: { [DUFFEL_STAYS]: String(accommodation.id) },
    ...(lat !== undefined && lon !== undefined
      ? { coordinates: { latitude: lat, longitude: lon } }
      : {}),
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    rooms: dates.rooms,
    adults: dates.adults,
    children: dates.children,
    roomCategory: r.roomName,
    ...(r.beds ? { beds: r.beds } : {}),
    ...(meal ? { mealPlan: meal } : {}),
    refundable: cancellation(r.rate, now).refundable,
    ...(intentSubject.location ? { location: intentSubject.location } : {}),
  };
}

export function ratesOf(accommodation: Json): StayRate[] {
  return arr(accommodation.rooms).flatMap((room) =>
    arr(room.rates).map((rate) => ({
      rateId: String(rate.id),
      roomName: str(room.name) ?? 'room',
      beds:
        arr(room.beds)
          .map((b) => `${b.count ?? 1}x${b.type ?? 'bed'}`)
          .join(',') || undefined,
      rate,
    })),
  );
}

function price(
  rate: Json,
  quoteId: string,
  now: number,
  expiresAt: number,
  revalidatedAt: number | null,
) {
  const currency = str(rate.total_currency) ?? 'USD';
  const total = providerMoney(String(rate.total_amount), currency);
  const tax =
    rate.tax_amount != null
      ? providerMoney(String(rate.tax_amount), currency)
      : zero(currency, total.decimals);
  const fees =
    rate.fee_amount != null
      ? providerMoney(String(rate.fee_amount), currency)
      : zero(currency, total.decimals);
  const baseAmount =
    BigInt(total.amount) - BigInt(tax.amount) - BigInt(fees.amount);
  const base = { ...total, amount: String(baseAmount < 0n ? 0n : baseAmount) };
  if (add(base, tax, fees).amount !== total.amount)
    throw new Error('DUFFEL_PRICE_INCONSISTENT');
  return {
    quoteId,
    base,
    shipping: zero(currency, total.decimals),
    tax,
    fees,
    fx: [],
    quotedAt: now,
    expiresAt,
    revalidatedAt,
  };
}

export class DuffelStaysProvider implements OfferProvider {
  readonly providerId = DUFFEL_STAYS;
  constructor(
    private readonly client: DuffelClient,
    private readonly now: () => number,
    private readonly options: {
      maxResults?: number;
      fxRates?: EconomicOffer['price']['fx'];
    } = {},
  ) {}

  async search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]> {
    const s = intent.subject;
    if (s.kind !== 'STAY') return [];
    if (!s.location && !Object.keys(s.providerPropertyIds).length)
      throw new Error('STAY_SEARCH_NEEDS_LOCATION');
    const guests = [
      ...Array.from({ length: s.adults }, () => ({ type: 'adult' })),
      ...Array.from({ length: s.children }, () => ({ type: 'child', age: 8 })),
    ];
    const mapped = s.providerPropertyIds[DUFFEL_STAYS];
    const search = await this.client.request<Json>(
      'POST',
      '/stays/search',
      {
        rooms: s.rooms,
        check_in_date: s.checkIn,
        check_out_date: s.checkOut,
        guests,
        ...(mapped
          ? { accommodation: { ids: [mapped] } }
          : {
              location: {
                radius: s.location!.radiusKm,
                geographic_coordinates: {
                  latitude: s.location!.latitude,
                  longitude: s.location!.longitude,
                },
              },
            }),
      },
      signal,
    );
    const results = arr(search.data.results).slice(
      0,
      this.options.maxResults ?? 3,
    );
    const offers: EconomicOfferInput[] = [];
    const now = this.now();
    for (const result of results) {
      const full = await this.client.request<Json>(
        'POST',
        `/stays/search_results/${encodeURIComponent(String(result.id))}/actions/fetch_all_rates`,
        undefined,
        signal,
      );
      const accommodation = obj(full.data.accommodation);
      for (const r of ratesOf(accommodation)) {
        const methods = arr(r.rate.available_payment_methods as unknown).map(
          String,
        );
        if (methods.length && !methods.includes('balance')) continue;
        offers.push(this.toOffer(intent, accommodation, r, now));
      }
    }
    return offers;
  }

  toOffer(
    intent: EconomicIntent,
    accommodation: Json,
    r: StayRate,
    now: number,
  ): EconomicOfferInput {
    const s = intent.subject as StaySubject;
    return {
      offerId: `${DUFFEL_STAYS}:${r.rateId}`,
      intentId: intent.id,
      domain: 'STAY',
      discoveryProviderId: DUFFEL_STAYS,
      fulfillmentProviderId: DUFFEL_STAYS,
      providerRef: r.rateId,
      subject: rateSubject(s, accommodation, r, now, s),
      price: {
        ...price(
          r.rate,
          r.rateId,
          now,
          now + STAY_QUOTE_POLICY_TTL_SECONDS,
          null,
        ),
        fx: this.options.fxRates ?? [],
      },
      cancellation: cancellation(r.rate, now),
      settlement: {
        accepts: [
          {
            rail: 'PROVIDER_BALANCE',
            currency: str(r.rate.total_currency) ?? 'USD',
          },
        ],
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
    const rateId = offer.providerRef.startsWith('rat_')
      ? offer.providerRef
      : offer.offerId.split(':')[1]!;
    const now = this.now();
    try {
      const q = await this.client.request<Json>(
        'POST',
        '/stays/quotes',
        { rate_id: rateId },
        signal,
      );
      const accommodation = obj(q.data.accommodation);
      const rates = ratesOf(accommodation);
      const r = rates.find((x) => x.rateId === rateId) ?? rates[0];
      if (!r) throw new Error('DUFFEL_QUOTE_WITHOUT_RATE');
      const quoteRate = {
        ...r.rate,
        total_amount: q.data.total_amount,
        total_currency: q.data.total_currency,
        tax_amount: q.data.tax_amount ?? r.rate.tax_amount,
        fee_amount: q.data.fee_amount ?? r.rate.fee_amount,
      };
      const subject = rateSubject(
        offer.subject as StaySubject,
        accommodation,
        { ...r, rate: quoteRate },
        now,
        offer.subject as StaySubject,
      );
      return {
        available: true,
        providerRef: String(q.data.id),
        subject,
        price: {
          ...price(
            quoteRate,
            String(q.data.id),
            now,
            now + STAY_QUOTE_POLICY_TTL_SECONDS,
            now,
          ),
          fx: offer.price.fx,
        },
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
          providerRef: rateId,
          subject: offer.subject,
          price: offer.price,
        };
      throw error;
    }
  }
}
