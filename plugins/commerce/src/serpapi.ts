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

function query(subject: ProductSubject): string {
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

function baseOffer(
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
            k: query(s),
            amazon_domain: 'amazon.com',
            api_key: this.apiKey,
          }
        : {
            engine: 'google_shopping',
            q: query(s),
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
    const price = r.extracted_price;
    if (typeof price !== 'number' || !(price > 0)) return [];
    const title = str(r.title) ?? '';
    const used =
      /\b(renewed|refurbished|used|pre-owned)\b/i.test(title) ||
      /used|refurb/i.test(str(r.second_hand_condition) ?? '');
    const subject: ProductSubject = {
      kind: 'PRODUCT',
      title: title.slice(0, 300) || 'untitled',
      ...(str(r.brand) ? { brand: String(r.brand) } : {}),
      variant: {},
      condition: used
        ? /refurb|renewed/i.test(title)
          ? 'REFURBISHED'
          : 'USED'
        : 'NEW',
      ...(str(r.source) ? { seller: String(r.source) } : {}),
      ...(typeof r.rating === 'number'
        ? { sellerRatingBps: Math.round((r.rating / 5) * 10_000) }
        : {}),
      attributes: {},
      quantity: want.quantity,
    };
    if (amazon) {
      const asin = str(r.asin);
      if (!asin) return [];
      return [
        baseOffer(
          intent,
          SERPAPI_AMAZON,
          this.options.checkoutProviderId ?? 'crossmint',
          `amazon:${asin}`,
          subject,
          price,
          'USD',
          now,
          'STABLECOIN_CHECKOUT',
          this.options.evidence,
        ),
      ];
    }
    const id =
      str(r.product_id) ??
      str(r.position !== undefined ? String(r.position) : undefined);
    if (!id) return [];
    return [
      baseOffer(
        intent,
        SERPAPI_GOOGLE_SHOPPING,
        'human-handoff',
        `gshop:${id}`,
        subject,
        price,
        'USD',
        now,
        'DISCOVERY_ONLY',
        this.options.evidence,
      ),
    ];
  }
}
