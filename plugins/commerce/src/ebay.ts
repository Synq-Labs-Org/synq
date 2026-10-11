import {
  providerMoney,
  zero,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type OfferProvider,
  type ProductSubject,
  type RevalidatedQuote,
} from '@synq/offer-exchange';
import { arr, getJson, obj, str, type HttpFetch, type Json } from './http.js';

export const EBAY_BROWSE = 'ebay-browse';
export const EBAY_ORDER = 'ebay-order';
const HOSTS = {
  sandbox: 'api.sandbox.ebay.com',
  production: 'api.ebay.com',
} as const;

const CONDITION: Record<string, ProductSubject['condition']> = {
  '1000': 'NEW',
  '1500': 'NEW',
  '2000': 'REFURBISHED',
  '2010': 'REFURBISHED',
  '2020': 'REFURBISHED',
  '2030': 'REFURBISHED',
  '2500': 'REFURBISHED',
  '3000': 'USED',
};

function aspects(item: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of arr(item.localizedAspects)) {
    const name = str(a.name)?.toLowerCase();
    const value = str(a.value);
    if (name && value) out[name] = value;
  }
  return out;
}

export function ebaySubject(
  item: Json,
  quantity: number,
  gtinFilter?: string,
): ProductSubject {
  const a = aspects(item);
  const gtin =
    str(item.gtin) ??
    (Array.isArray(item.gtins) ? str(item.gtins[0]) : undefined) ??
    gtinFilter;
  const condition =
    CONDITION[String(item.conditionId ?? '')] ??
    (/new/i.test(str(item.condition) ?? '') ? 'NEW' : 'USED');
  const seller = obj(item.seller);
  const pct = Number(seller.feedbackPercentage);
  const color = a.color ?? str(item.color);
  const storage = a['storage capacity'];
  const mpn = str(item.mpn) ?? a.mpn;
  const brand = str(item.brand) ?? a.brand;
  const model = a.model;
  return {
    kind: 'PRODUCT',
    title: (str(item.title) ?? 'untitled').slice(0, 300),
    ...(gtin && /^[0-9]{8,14}$/.test(gtin) ? { gtin } : {}),
    ...(mpn ? { mpn } : {}),
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
    variant: { ...(color ? { color } : {}), ...(storage ? { storage } : {}) },
    condition,
    ...(str(seller.username) ? { seller: String(seller.username) } : {}),
    ...(Number.isFinite(pct) ? { sellerRatingBps: Math.round(pct * 100) } : {}),
    attributes: {},
    quantity,
  };
}

/**
 * eBay Browse API discovery (OAuth client credentials, official API only).
 * Order API fulfillment is limited-release, so offers point at the gated
 * eBay Order capability and fall back via the commerce router.
 */
export class EbayBrowseDiscovery implements OfferProvider {
  readonly providerId = EBAY_BROWSE;
  readonly revalidatesFor = [EBAY_ORDER];
  private token: { value: string; expiresAt: number } | null = null;
  constructor(
    private readonly credentials: {
      clientId: string;
      clientSecret: string;
      environment: 'sandbox' | 'production';
    },
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number,
    private readonly options: {
      evidence: 'PROVIDER_SANDBOX' | 'MAINNET_READ_ONLY' | 'MOCKED';
      marketplace?: string;
      maxResults?: number;
    },
  ) {
    if (!credentials.clientId || !credentials.clientSecret)
      throw new Error('EBAY_CREDENTIALS_MISSING');
  }

  private get host() {
    return HOSTS[this.credentials.environment];
  }

  private async bearer(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60)
      return this.token.value;
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`,
    ).toString('base64');
    const body = await getJson(
      this.fetchImpl,
      'ebay',
      `https://${this.host}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'https://api.ebay.com/oauth/api_scope',
        }).toString(),
        ...(signal ? { signal } : {}),
      },
    );
    const value = str(body.access_token);
    if (!value) throw new Error('EBAY_TOKEN_MISSING');
    this.token = {
      value,
      expiresAt: this.now() + Number(body.expires_in ?? 3600),
    };
    return value;
  }

  private async get(path: string, signal?: AbortSignal) {
    return getJson(this.fetchImpl, 'ebay', `https://${this.host}${path}`, {
      headers: {
        Authorization: `Bearer ${await this.bearer(signal)}`,
        'X-EBAY-C-MARKETPLACE-ID': this.options.marketplace ?? 'EBAY_US',
      },
      ...(signal ? { signal } : {}),
    });
  }

  async search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]> {
    const s = intent.subject;
    if (s.kind !== 'PRODUCT') return [];
    const params = new URLSearchParams({
      limit: String(this.options.maxResults ?? 20),
    });
    if (s.gtin) params.set('gtin', s.gtin);
    else
      params.set(
        'q',
        [s.brand, s.model ?? s.title, s.variant.color]
          .filter(Boolean)
          .join(' '),
      );
    const body = await this.get(
      `/buy/browse/v1/item_summary/search?${params}`,
      signal,
    );
    const now = this.now();
    return arr(body.itemSummaries).flatMap((item) => {
      try {
        return [
          this.toOffer(
            intent,
            item,
            ebaySubject(item, s.quantity, s.gtin),
            now,
          ),
        ];
      } catch {
        return [];
      }
    });
  }

  private toOffer(
    intent: EconomicIntent,
    item: Json,
    subject: ProductSubject,
    now: number,
  ): EconomicOfferInput {
    const price = obj(item.price);
    const currency = str(price.currency) ?? 'USD';
    const base = providerMoney(String(price.value), currency);
    const ship = obj(obj(arr(item.shippingOptions)[0]).shippingCost);
    const shipping =
      ship.value != null && str(ship.currency) === currency
        ? providerMoney(String(ship.value), currency)
        : zero(currency, base.decimals);
    const eta = str(obj(arr(item.shippingOptions)[0]).maxEstimatedDeliveryDate);
    const id = String(item.itemId);
    return {
      offerId: `${EBAY_BROWSE}:${id}`,
      intentId: intent.id,
      domain: 'COMMERCE',
      discoveryProviderId: EBAY_BROWSE,
      fulfillmentProviderId: EBAY_ORDER,
      providerRef: id,
      subject: eta
        ? { ...subject, deliverBy: Math.floor(Date.parse(eta) / 1000) }
        : subject,
      price: {
        quoteId: `${EBAY_BROWSE}:${id}:${now}`,
        base,
        shipping,
        tax: zero(currency, base.decimals),
        fees: zero(currency, base.decimals),
        fx: [],
        quotedAt: now,
        expiresAt: now + 300,
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
        accepts: [{ rail: 'HUMAN_HANDOFF', currency }],
        payee: null,
      },
      execution: {
        mode: 'NATIVE_API',
        requiresQuote: true,
        requiresKyc: false,
        requiresStepUp: false,
        piiFields: ['SHIPPING_ADDRESS', 'EMAIL'],
      },
      environment:
        this.options.evidence === 'PROVIDER_SANDBOX'
          ? 'SANDBOX'
          : this.options.evidence === 'MOCKED'
            ? 'FIXTURE'
            : 'PRODUCTION',
      evidence: this.options.evidence,
      retrievedAt: now,
      executable: false,
    };
  }

  /** getItem: exact availability, price and aspects before any checkout. */
  async revalidate(
    offer: EconomicOffer,
    signal: AbortSignal,
  ): Promise<RevalidatedQuote> {
    const item = await this.get(
      `/buy/browse/v1/item/${encodeURIComponent(offer.providerRef)}`,
      signal,
    );
    const prior = offer.subject as ProductSubject;
    const subject = ebaySubject(item, prior.quantity, prior.gtin);
    const fresh = this.toOffer(
      { id: offer.intentId } as EconomicIntent,
      item,
      subject,
      this.now(),
    );
    const status = arr(item.estimatedAvailabilities).map((a) =>
      str(a.estimatedAvailabilityStatus),
    );
    return {
      available: !status.includes('OUT_OF_STOCK'),
      providerRef: offer.providerRef,
      subject: {
        ...(fresh.subject as ProductSubject),
        ...(prior.deliverBy !== undefined &&
        (fresh.subject as ProductSubject).deliverBy === undefined
          ? { deliverBy: prior.deliverBy }
          : {}),
      },
      price: {
        ...(fresh.price as EconomicOffer['price']),
        revalidatedAt: this.now(),
      },
    };
  }
}
