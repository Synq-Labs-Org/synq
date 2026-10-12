import {
  providerMoney,
  zero,
  type EconomicIntent,
  type EconomicOfferInput,
  type EvidenceLabel,
  type OfferProvider,
  type ProductSubject,
} from '@synq/offer-exchange';
import { arr, getJson, str, type HttpFetch, type Json } from './http.js';

export const SERPAPI_AMAZON = 'serpapi-amazon';
export const SERPAPI_GOOGLE_SHOPPING = 'serpapi-google-shopping';
export const SEARCH_PRICE_TTL_SECONDS = 300;

export function productQuery(subject: ProductSubject): string {
  return (
    subject.gtin ??
    [
      subject.brand,
      subject.model ?? subject.title,
      subject.variant.color,
      subject.variant.storage,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export function productOffer(
  intent: EconomicIntent,
  providerId: string,
  fulfillmentProviderId: string,
  ref: string,
  subject: ProductSubject,
  price: number | string,
  currency: string,
  now: number,
  mode: 'STABLECOIN_CHECKOUT' | 'DISCOVERY_ONLY',
  evidence: EvidenceLabel,
): EconomicOfferInput {
  const base = providerMoney(price, currency);
  return {
    offerId: `${providerId}:${ref}`,
    intentId: intent.id,
    domain: 'COMMERCE',
    discoveryProviderId: providerId,
    fulfillmentProviderId,
    providerRef: ref,
    subject,
    price: {
      quoteId: `${providerId}:${ref}:${now}`,
      base,
      shipping: zero(currency, base.decimals),
      tax: zero(currency, base.decimals),
      fees: zero(currency, base.decimals),
      fx: [],
      quotedAt: now,
      expiresAt: now + SEARCH_PRICE_TTL_SECONDS,
      revalidatedAt: null,
    },
    cancellation: {
      kind: 'UNKNOWN',
      refundable: false,
      freeUntil: null,
      penalty: null,
      changeable: false,
    },
    settlement: {
      accepts:
        mode === 'STABLECOIN_CHECKOUT'
          ? [{ rail: 'STABLECOIN_CHECKOUT', currency: 'USDC' }]
          : [{ rail: 'HUMAN_HANDOFF', currency }],
      payee: null,
    },
    execution: {
      mode,
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: ['SHIPPING_ADDRESS', 'EMAIL'],
    },
    environment:
      evidence === 'PROVIDER_SANDBOX'
        ? 'SANDBOX'
        : evidence === 'MOCKED'
          ? 'FIXTURE'
          : 'PRODUCTION',
    evidence,
    retrievedAt: now,
    executable: false,
  };
}

/**
 * SerpAPI discovery (official API, no scraping). Search prices are evidence,
 * never executable quotes: Amazon results are fulfilled through a checkout
 * provider that must revalidate, Google Shopping results only hand off.
 */
export class SerpApiDiscovery implements OfferProvider {
  constructor(
    readonly providerId: typeof SERPAPI_AMAZON | typeof SERPAPI_GOOGLE_SHOPPING,
    private readonly apiKey: string,
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number,
    private readonly options: {
      evidence: 'MAINNET_READ_ONLY' | 'MOCKED';
      maxResults?: number;
      checkoutProviderId?: string;
    },
  ) {
    if (!apiKey) throw new Error('SERPAPI_KEY_MISSING');
  }

  async search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]> {
    const s = intent.subject;
    if (s.kind !== 'PRODUCT') return [];
    const amazon = this.providerId === SERPAPI_AMAZON;
    const params = new URLSearchParams(
      amazon
        ? {
            engine: 'amazon',
            k: productQuery(s),
            amazon_domain: 'amazon.com',
            api_key: this.apiKey,
          }
        : {
            engine: 'google_shopping',
            q: productQuery(s),
            gl: 'us',
            hl: 'en',
            api_key: this.apiKey,
          },
    );
    const body = await getJson(
      this.fetchImpl,
      'serpapi',
      `https://serpapi.com/search.json?${params}`,
      { signal },
    );
    const now = this.now();
    const rows = arr(
      amazon ? body.organic_results : body.shopping_results,
    ).slice(0, this.options.maxResults ?? 10);
    return rows.flatMap((r) => this.toOffer(intent, s, r, now, amazon));
  }

  private toOffer(
    intent: EconomicIntent,
    want: ProductSubject,
    r: Json,
    now: number,
    amazon: boolean,
  ): EconomicOfferInput[] {
    const gid =
      str(r.product_id) ??
      (r.position !== undefined ? String(r.position) : undefined);
    return productRowOffer(intent, want, now, {
      price: r.extracted_price,
      title: str(r.title),
      brand: str(r.brand),
      seller: str(r.source),
      rating: r.rating,
      conditionText: str(r.second_hand_condition),
      ...(amazon
        ? {
            providerId: SERPAPI_AMAZON,
            ref: str(r.asin) ? `amazon:${str(r.asin)}` : undefined,
            fulfillmentProviderId:
              this.options.checkoutProviderId ?? 'crossmint',
            mode: 'STABLECOIN_CHECKOUT' as const,
          }
        : {
            providerId: SERPAPI_GOOGLE_SHOPPING,
            ref: gid ? `gshop:${gid}` : undefined,
            fulfillmentProviderId: 'human-handoff',
            mode: 'DISCOVERY_ONLY' as const,
          }),
      evidence: this.options.evidence,
    });
  }
}

/** Provider-neutral search row, normalised by each discovery adapter. */
export type ProductRow = {
  providerId: string;
  fulfillmentProviderId: string;
  ref: string | undefined;
  price: unknown;
  title: string | undefined;
  brand: string | undefined;
  seller: string | undefined;
  rating: unknown;
  conditionText: string | undefined;
  mode: 'STABLECOIN_CHECKOUT' | 'DISCOVERY_ONLY';
  evidence: EvidenceLabel;
};

/** Maps one normalised search row to an offer; search prices are never executable. */
export function productRowOffer(
  intent: EconomicIntent,
  want: ProductSubject,
  now: number,
  r: ProductRow,
): EconomicOfferInput[] {
  const price = r.price;
  if (typeof price !== 'number' || !(price > 0) || !r.ref) return [];
  if (r.mode === 'STABLECOIN_CHECKOUT' && !/^amazon:[A-Z0-9]{10}$/.test(r.ref))
    return [];
  const title = r.title ?? '';
  const used =
    /\b(renewed|refurbished|used|pre-owned)\b/i.test(title) ||
    /used|refurb|pre-owned/i.test(r.conditionText ?? '');
  const subject: ProductSubject = {
    kind: 'PRODUCT',
    title: title.slice(0, 300) || 'untitled',
    ...(r.mode === 'STABLECOIN_CHECKOUT' ? { asin: r.ref.slice(7) } : {}),
    ...(r.brand ? { brand: r.brand.slice(0, 64) } : {}),
    variant: {},
    condition: used
      ? /refurb|renewed/i.test(`${title} ${r.conditionText ?? ''}`)
        ? 'REFURBISHED'
        : 'USED'
      : 'NEW',
    ...(r.seller ? { seller: r.seller.slice(0, 120) } : {}),
    ...(typeof r.rating === 'number'
      ? { sellerRatingBps: Math.round((r.rating / 5) * 10_000) }
      : {}),
    attributes: {},
    quantity: want.quantity,
  };
  return [
    productOffer(
      intent,
      r.providerId,
      r.fulfillmentProviderId,
      r.ref,
      subject,
      price,
      'USD',
      now,
      r.mode,
      r.evidence,
    ),
  ];
}
