import {
  providerMoney,
  zero,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type OfferProvider,
  type RevalidatedQuote,
} from '@synq/offer-exchange';
import { arr, getJson, obj, str, type HttpFetch, type Json } from './http.js';
import {
  SEARCH_PRICE_TTL_SECONDS,
  productQuery,
  productRowOffer,
} from './serpapi.js';

export const SEARCHAPI_AMAZON = 'searchapi-amazon';
export const SEARCHAPI_GOOGLE_SHOPPING = 'searchapi-google-shopping';
export const SEARCHAPI_HOST = 'www.searchapi.io';

/**
 * Response cache port. SearchApi credits are scarce, so callers may serve
 * repeated identical requests from a cache. Keys never contain the API key.
 */
export interface SearchResponseCache {
  get(key: string): Promise<Json | null>;
  put(key: string, body: Json): Promise<void>;
}

/**
 * SearchApi.io discovery (official API, no scraping). The key travels only in
 * the Authorization header, never in a URL, so it cannot leak via logged URLs
 * or provider-echoed request metadata. Search prices are never executable;
 * Amazon offers are revalidated per ASIN (`amazon_product`) for the Crossmint
 * fulfiller, whose own order quote is checked again before any payment.
 */
export class SearchApiDiscovery implements OfferProvider {
  readonly revalidatesFor: readonly string[];
  constructor(
    readonly providerId:
      | typeof SEARCHAPI_AMAZON
      | typeof SEARCHAPI_GOOGLE_SHOPPING,
    private readonly apiKey: string,
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number,
    private readonly options: {
      evidence: 'MAINNET_READ_ONLY' | 'MOCKED';
      maxResults?: number;
      checkoutProviderId?: string;
      /** Marketplace-currency upper bound passed to the provider as a filter. */
      priceMax?: number;
      cache?: SearchResponseCache;
    },
  ) {
    if (!apiKey) throw new Error('SEARCHAPI_KEY_MISSING');
    this.revalidatesFor =
      providerId === SEARCHAPI_AMAZON
        ? [options.checkoutProviderId ?? 'crossmint']
        : [];
  }

  private async call(
    params: Record<string, string>,
    signal: AbortSignal,
    cacheable = true,
  ): Promise<Json> {
    const query = new URLSearchParams(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    );
    const key = query.toString();
    const cache = cacheable ? this.options.cache : undefined;
    const cached = await cache?.get(key);
    if (cached) return cached;
    const body = await getJson(
      this.fetchImpl,
      'searchapi',
      `https://${SEARCHAPI_HOST}/api/v1/search?${query}`,
      { signal, headers: { Authorization: `Bearer ${this.apiKey}` } },
    ).catch((e: Error) => {
      throw new Error(e.message.split(this.apiKey).join('[REDACTED]'));
    });
    const status = str(obj(body.search_metadata).status);
    if (status && status !== 'Success')
      throw new Error(`SEARCHAPI_STATUS: ${status.slice(0, 60)}`);
    await cache?.put(key, body);
    return body;
  }

  async search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]> {
    const s = intent.subject;
    if (s.kind !== 'PRODUCT') return [];
    const amazon = this.providerId === SEARCHAPI_AMAZON;
    const priceMax: Record<string, string> =
      this.options.priceMax !== undefined
        ? { price_max: String(this.options.priceMax) }
        : {};
    const body = await this.call(
      amazon
        ? {
            engine: 'amazon_search',
            q: productQuery(s),
            amazon_domain: 'amazon.com',
            ...priceMax,
          }
        : { engine: 'google_shopping', q: productQuery(s), gl: 'us', hl: 'en' },
      signal,
    );
    const now = this.now();
    const rows = arr(
      amazon ? body.organic_results : body.shopping_results,
    ).slice(0, this.options.maxResults ?? 10);
    return rows.flatMap((r) => this.toOffer(intent, r, now, amazon));
  }

  private toOffer(
    intent: EconomicIntent,
    r: Json,
    now: number,
    amazon: boolean,
  ): EconomicOfferInput[] {
    if (intent.subject.kind !== 'PRODUCT') return [];
    const asin = str(r.asin);
    const pos = r.position !== undefined ? String(r.position) : undefined;
    const gid = str(r.product_id);
    return productRowOffer(intent, intent.subject, now, {
      price: r.extracted_price,
      title: str(r.title),
      brand: str(r.brand),
      seller: str(r.seller) ?? str(r.source),
      rating: r.rating,
      conditionText: str(r.condition),
      evidence: this.options.evidence,
      ...(amazon
        ? {
            providerId: SEARCHAPI_AMAZON,
            ref: asin ? `amazon:${asin}` : undefined,
            fulfillmentProviderId:
              this.options.checkoutProviderId ?? 'crossmint',
            mode: 'STABLECOIN_CHECKOUT' as const,
          }
        : {
            providerId: SEARCHAPI_GOOGLE_SHOPPING,
            ref: pos ? `gshop:${gid ?? 'np'}:${pos}` : undefined,
            fulfillmentProviderId: 'human-handoff',
            mode: 'DISCOVERY_ONLY' as const,
          }),
    });
  }

  /**
   * Live per-ASIN price and availability (`amazon_product` buy box). The item
   * identity is the ASIN; anything other than an in-stock, Amazon-listed USD
   * buy box for the same ASIN is reported unavailable.
   */
  async revalidate(
    offer: EconomicOffer,
    signal: AbortSignal,
  ): Promise<RevalidatedQuote> {
    const m = /^amazon:([A-Z0-9]{10})$/.exec(offer.providerRef);
    if (this.providerId !== SEARCHAPI_AMAZON || !m)
      throw new Error('SEARCHAPI_REVALIDATE_UNSUPPORTED');
    const asin = m[1]!;
    const body = await this.call(
      { engine: 'amazon_product', asin, amazon_domain: 'amazon.com' },
      signal,
      false, // a revalidation is always a live read
    );
    const product = obj(body.product);
    const buybox = obj(product.buybox ?? body.buybox);
    const price = obj(buybox.price);
    const value = price.value;
    const qty = offer.subject.kind === 'PRODUCT' ? offer.subject.quantity : 1;
    const maxQty = buybox.maximum_order_quantity;
    const available =
      str(product.asin) === asin &&
      typeof value === 'number' &&
      value > 0 &&
      (str(price.currency) ?? 'USD') === 'USD' &&
      !/unavailable|out of stock|currently not/i.test(
        str(buybox.availability) ?? '',
      ) &&
      (typeof maxQty !== 'number' || maxQty >= qty);
    const now = this.now();
    const base = available
      ? providerMoney(value as number, 'USD')
      : offer.price.base;
    return {
      available,
      providerRef: offer.providerRef,
      subject: offer.subject,
      price: {
        quoteId: `${SEARCHAPI_AMAZON}:${asin}:${now}`,
        base,
        shipping: zero('USD', base.decimals),
        tax: zero('USD', base.decimals),
        fees: zero('USD', base.decimals),
        fx: [],
        quotedAt: now,
        expiresAt: now + SEARCH_PRICE_TTL_SECONDS,
        revalidatedAt: now,
      },
    };
  }
}
