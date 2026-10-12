import { createHash } from 'node:crypto';
import {
  money,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type Money,
  type ProviderBookingOutcome,
  type ProviderBookingPort,
  type RevalidatedQuote,
} from '@synq/offer-exchange';
import { arr, obj, str, type HttpFetch, type Json } from './http.js';

export const RELOADLY = 'reloadly-sandbox';
export const RELOADLY_SANDBOX_HOST = 'giftcards-sandbox.reloadly.com';
export const RELOADLY_SANDBOX_BASE = `https://${RELOADLY_SANDBOX_HOST}`;
export const RELOADLY_SANDBOX_AUDIENCE = RELOADLY_SANDBOX_BASE;
export const RELOADLY_AUTH_URL = 'https://auth.reloadly.com/oauth/token';
export const RELOADLY_ACCEPT = 'application/com.reloadly.giftcards-v1+json';
export const RELOADLY_SOURCES = [
  'https://developers.reloadly.com/gift-cards/quickstart',
  'https://developers.reloadly.com/developer-tools/sandbox',
  'https://docs.reloadly.com/assets/api/gift-cards.json',
];

export class ReloadlyEnvironmentError extends Error {
  constructor(detail: string) {
    super(`RELOADLY_NOT_SANDBOX: ${detail}`);
    this.name = 'ReloadlyEnvironmentError';
  }
}

export type ReloadlyConfig = {
  clientId: string;
  clientSecret: string;
  environment: string | undefined;
  baseUrl?: string;
};

/** Sandbox only: production gift cards are real money. */
export function assertReloadlySandbox(c: ReloadlyConfig): string {
  if (c.environment !== 'sandbox')
    throw new ReloadlyEnvironmentError('RELOADLY_ENV must be sandbox');
  if (!c.clientId || !c.clientSecret)
    throw new ReloadlyEnvironmentError('client credentials missing');
  const base = (c.baseUrl ?? RELOADLY_SANDBOX_BASE).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ReloadlyEnvironmentError('base URL invalid');
  }
  if (url.protocol !== 'https:' || url.host !== RELOADLY_SANDBOX_HOST)
    throw new ReloadlyEnvironmentError('base URL is not the gift card sandbox');
  return RELOADLY_SANDBOX_BASE;
}

export class ReloadlyError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(
      `RELOADLY_HTTP_${status}${errorCode ? `_${errorCode}` : ''}: ${message}`.slice(
        0,
        300,
      ),
    );
    this.name = 'ReloadlyError';
  }
  /** The provider definitively did not act on the request. */
  get definitive() {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      ![408, 409, 425, 429].includes(this.status)
    );
  }
}

/** JSON numbers to Money, rounding any sub-unit remainder up (conservative for costs). */
export function decimalMoney(
  v: unknown,
  currency: string,
  decimals = 2,
): Money {
  const s =
    typeof v === 'number' && Number.isFinite(v)
      ? v.toFixed(8)
      : typeof v === 'string'
        ? v
        : '';
  if (!/^-?\d+(\.\d+)?$/.test(s))
    throw new ReloadlyError(0, null, 'bad amount');
  const [i, f = ''] = s.replace(/^-/, '').split('.');
  const head = BigInt(`${i}${f.slice(0, decimals).padEnd(decimals, '0')}`);
  const roundUp = /[1-9]/.test(f.slice(decimals)) ? 1n : 0n;
  return money(head + roundUp, currency, decimals);
}

export type ReloadlyProduct = {
  productId: number;
  productName: string;
  brand: string | null;
  countryCode: string;
  status: string;
  denominationType: 'FIXED' | 'RANGE';
  recipientCurrency: string;
  senderCurrency: string;
  fixed: { recipient: number; sender: number }[];
  range: { min: number; max: number; rate: number } | null;
  senderFee: number;
  senderFeePercentage: number;
};

function toProduct(j: Json): ReloadlyProduct {
  const id = j.productId;
  if (typeof id !== 'number') throw new ReloadlyError(0, null, 'product id');
  const rawMap = j.fixedRecipientToSenderDenominationsMap;
  const map: Record<string, number> = {};
  for (const m of Array.isArray(rawMap) ? rawMap.flat(2) : [rawMap])
    for (const [k, v] of Object.entries(obj(m)))
      if (typeof v === 'number') map[Number(k).toFixed(2)] = v;
  const recip = (
    Array.isArray(j.fixedRecipientDenominations)
      ? (j.fixedRecipientDenominations as unknown[]).flat(2)
      : []
  ).filter((x): x is number => typeof x === 'number');
  const type = str(j.denominationType) === 'RANGE' ? 'RANGE' : 'FIXED';
  const min = j.minRecipientDenomination;
  const max = j.maxRecipientDenomination;
  const rate = j.recipientCurrencyToSenderCurrencyExchangeRate;
  return {
    productId: id,
    productName: str(j.productName) ?? `product ${id}`,
    brand: str(obj(j.brand).brandName) ?? null,
    countryCode: str(obj(j.country).isoName) ?? '',
    status: str(j.status) ?? 'ACTIVE',
    denominationType: type,
    recipientCurrency: str(j.recipientCurrencyCode) ?? '',
    senderCurrency: str(j.senderCurrencyCode) ?? '',
    fixed: recip
      .map((r) => ({ recipient: r, sender: map[r.toFixed(2)] ?? NaN }))
      .filter((d) => Number.isFinite(d.sender)),
    range:
      type === 'RANGE' &&
      typeof min === 'number' &&
      typeof max === 'number' &&
      typeof rate === 'number'
        ? { min, max, rate }
        : null,
    senderFee: typeof j.senderFee === 'number' ? j.senderFee : 0,
    senderFeePercentage:
      typeof j.senderFeePercentage === 'number' ? j.senderFeePercentage : 0,
  };
}

export type DenominationCheck =
  | { ok: true; senderCost: Money; fee: Money }
  | {
      ok: false;
      code:
        | 'PRODUCT_INACTIVE'
        | 'UNSUPPORTED_COUNTRY'
        | 'UNSUPPORTED_CURRENCY'
        | 'INVALID_DENOMINATION';
      reason: string;
    };

/** Validates a requested face value and computes what the sender account pays. */
export function checkDenomination(
  p: ReloadlyProduct,
  want: {
    countryCode: string;
    recipientCurrency: string;
    unitPrice: number;
    senderCurrency: string;
  },
): DenominationCheck {
  if (p.status !== 'ACTIVE')
    return { ok: false, code: 'PRODUCT_INACTIVE', reason: p.status };
  if (p.countryCode !== want.countryCode)
    return {
      ok: false,
      code: 'UNSUPPORTED_COUNTRY',
      reason: `${want.countryCode} not served by product (${p.countryCode})`,
    };
  if (p.recipientCurrency !== want.recipientCurrency)
    return {
      ok: false,
      code: 'UNSUPPORTED_CURRENCY',
      reason: `face value currency ${p.recipientCurrency}`,
    };
  if (p.senderCurrency !== want.senderCurrency)
    return {
      ok: false,
      code: 'UNSUPPORTED_CURRENCY',
      reason: `sender currency ${p.senderCurrency} differs from account ${want.senderCurrency}`,
    };
  let sender: number;
  if (p.denominationType === 'FIXED') {
    const d = p.fixed.find(
      (x) => Math.round(x.recipient * 100) === Math.round(want.unitPrice * 100),
    );
    if (!d)
      return {
        ok: false,
        code: 'INVALID_DENOMINATION',
        reason: `${want.unitPrice} not in ${p.fixed.map((x) => x.recipient).join(', ')}`,
      };
    sender = d.sender;
  } else {
    if (
      !p.range ||
      want.unitPrice < p.range.min ||
      want.unitPrice > p.range.max
    )
      return {
        ok: false,
        code: 'INVALID_DENOMINATION',
        reason: `${want.unitPrice} outside range`,
      };
    sender = want.unitPrice * p.range.rate;
  }
  const senderCost = decimalMoney(sender, p.senderCurrency);
  const pct =
    (BigInt(senderCost.amount) *
      BigInt(Math.round(p.senderFeePercentage * 10_000)) +
      999_999n) /
    1_000_000n;
  const fee = money(
    BigInt(decimalMoney(p.senderFee, p.senderCurrency).amount) + pct,
    p.senderCurrency,
    2,
  );
  return { ok: true, senderCost, fee };
}

export type ReloadlyTransaction = {
  transactionId: string;
  status: string;
  customIdentifier: string | null;
  amount: Money;
  productId: number | null;
  countryCode: string | null;
  quantity: number | null;
  unitPrice: number | null;
  recipientCurrency: string | null;
};

function toTransaction(j: Json, senderCurrency: string): ReloadlyTransaction {
  const p = obj(j.product);
  const id = j.transactionId;
  if (typeof id !== 'number' && typeof id !== 'string')
    throw new ReloadlyError(0, null, 'transaction without id');
  return {
    transactionId: String(id),
    status: str(j.status) ?? 'UNKNOWN',
    customIdentifier: str(j.customIdentifier) ?? null,
    amount: decimalMoney(j.amount, str(j.currencyCode) ?? senderCurrency),
    productId: typeof p.productId === 'number' ? p.productId : null,
    countryCode: str(p.countryCode) ?? null,
    quantity: typeof p.quantity === 'number' ? p.quantity : null,
    unitPrice: typeof p.unitPrice === 'number' ? p.unitPrice : null,
    recipientCurrency: str(p.currencyCode) ?? null,
  };
}

const fmt = (t: number) =>
  new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19);

/**
 * Reloadly gift card sandbox client. OAuth client_credentials with the
 * sandbox audience, cached until shortly before expiry and refreshed once on
 * an INVALID/EXPIRED token. Redeem codes are only ever handed to a sealer.
 */
export class ReloadlyClient {
  private readonly base: string;
  private token: { value: string; expiresAt: number } | null = null;
  constructor(
    private readonly config: ReloadlyConfig,
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number,
    private readonly timeoutMs = 30_000,
  ) {
    this.base = assertReloadlySandbox(config);
  }

  private redact(t: string) {
    return [this.config.clientSecret, this.config.clientId, this.token?.value]
      .filter((x): x is string => !!x)
      .reduce((acc, s) => acc.split(s).join('[REDACTED]'), t);
  }

  private async raw(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; json: Json; list: Json[] | null }> {
    const res = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return {
      status: res.status,
      json: obj(parsed),
      list: Array.isArray(parsed) ? (parsed as Json[]) : null,
    };
  }

  async accessToken(force = false): Promise<string> {
    const t = this.now();
    if (!force && this.token && this.token.expiresAt - 60 > t)
      return this.token.value;
    const r = await this.raw(RELOADLY_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
        audience: RELOADLY_SANDBOX_AUDIENCE,
      }),
    });
    const value = str(r.json.access_token);
    if (r.status !== 200 || !value)
      throw new ReloadlyError(
        r.status,
        str(r.json.errorCode) ?? null,
        this.redact(str(r.json.message) ?? 'token request failed'),
      );
    const ttl =
      typeof r.json.expires_in === 'number' ? r.json.expires_in : 3_600;
    this.token = { value, expiresAt: t + ttl };
    return value;
  }

  private async api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    accept = RELOADLY_ACCEPT,
  ): Promise<{ json: Json; list: Json[] | null }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const r = await this.raw(`${this.base}${path}`, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const code = str(r.json.errorCode) ?? null;
      // A 401 was not processed; refresh the token once and retry.
      if (r.status === 401 && attempt === 0) continue;
      if (r.status < 200 || r.status >= 300)
        throw new ReloadlyError(
          r.status,
          code,
          this.redact(str(r.json.message) ?? str(r.json.error) ?? 'error'),
        );
      return r;
    }
  }

  async balance(): Promise<Money> {
    const { json } = await this.api('GET', '/accounts/balance');
    return decimalMoney(json.balance, str(json.currencyCode) ?? 'USD');
  }

  async countries(): Promise<string[]> {
    const { list } = await this.api('GET', '/countries');
    return (list ?? []).map((c) => str(c.isoName) ?? '').filter(Boolean);
  }

  async products(q: {
    countryCode?: string;
    productName?: string;
    size?: number;
  }): Promise<ReloadlyProduct[]> {
    const p = new URLSearchParams({ size: String(q.size ?? 50), page: '1' });
    if (q.countryCode) p.set('countryCode', q.countryCode);
    if (q.productName) p.set('productName', q.productName);
    const { json, list } = await this.api('GET', `/products?${p}`);
    const rows = list ?? arr(json.content);
    return rows.flatMap((r) => {
      try {
        return [toProduct(r)];
      } catch {
        return [];
      }
    });
  }

  async product(productId: number): Promise<ReloadlyProduct> {
    const { json } = await this.api('GET', `/products/${productId}`);
    return toProduct(json);
  }

  async order(input: {
    productId: number;
    countryCode: string;
    unitPrice: number;
    customIdentifier: string;
    senderName: string;
  }): Promise<Json> {
    const { json } = await this.api('POST', '/orders', {
      productId: input.productId,
      countryCode: input.countryCode,
      quantity: 1,
      unitPrice: input.unitPrice,
      customIdentifier: input.customIdentifier,
      senderName: input.senderName,
      preOrder: false,
    });
    return json;
  }

  async transaction(id: string, senderCurrency: string) {
    const { json } = await this.api(
      'GET',
      `/reports/transactions/${encodeURIComponent(id)}`,
    );
    return toTransaction(json, senderCurrency);
  }

  async transactionsByCustomIdentifier(
    customIdentifier: string,
    since: number,
    senderCurrency: string,
  ): Promise<ReloadlyTransaction[]> {
    const p = new URLSearchParams({
      size: '50',
      page: '1',
      customIdentifier,
      startDate: fmt(since - 86_400),
      endDate: fmt(this.now() + 86_400),
    });
    const { json, list } = await this.api('GET', `/reports/transactions?${p}`);
    return (list ?? arr(json.content))
      .map((t) => toTransaction(t, senderCurrency))
      .filter((t) => t.customIdentifier === customIdentifier);
  }

  /** Redeem codes, passed straight to the sealer; never returned or logged. */
  async sealRedeemCodes(
    transactionId: string,
    seal: (codes: GiftCode[]) => Promise<{ ref: string }>,
  ): Promise<{ ref: string; count: number }> {
    const { json, list } = await this.api(
      'GET',
      `/orders/transactions/${encodeURIComponent(transactionId)}/cards`,
    );
    const codes: GiftCode[] = (list ?? [json]).map((c) => ({
      ...(c.cardNumber !== undefined
        ? { cardNumber: String(c.cardNumber) }
        : {}),
      ...(c.pinCode !== undefined ? { pinCode: String(c.pinCode) } : {}),
      ...(str(c.redemptionUrl) ? { redemptionUrl: str(c.redemptionUrl)! } : {}),
    }));
    if (!codes.length) throw new ReloadlyError(0, null, 'no redeem codes');
    const { ref } = await seal(codes);
    return { ref, count: codes.length };
  }
}

export type GiftCode = {
  cardNumber?: string;
  pinCode?: string;
  redemptionUrl?: string;
};

/** Seals redeem codes (e.g. ProfileVault GIFT_CODE); returns only an opaque ref. */
export interface GiftCodeSealer {
  seal(input: {
    provider: string;
    transactionId: string;
    /** The ordering group: the recipient record must belong to it. */
    groupId: string;
    recipientRef: string;
    codes: GiftCode[];
  }): Promise<{ ref: string }>;
}

// ---- Offers and the booking port -------------------------------------------

export type GiftCardRef = {
  productId: number;
  countryCode: string;
  unitPriceCents: number;
  recipientCurrency: string;
};
export const giftCardRef = (r: GiftCardRef) =>
  `reloadly:${r.productId}:${r.countryCode}:${r.unitPriceCents}:${r.recipientCurrency}`;
export function parseGiftCardRef(ref: string): GiftCardRef | null {
  const m = /^reloadly:(\d{1,10}):([A-Z]{2}):(\d{1,9}):([A-Z]{3})$/.exec(ref);
  return m
    ? {
        productId: Number(m[1]),
        countryCode: m[2]!,
        unitPriceCents: Number(m[3]),
        recipientCurrency: m[4]!,
      }
    : null;
}

/** Canonical identity of a gift card denomination, matched exactly by the offer exchange. */
export const giftCardModel = (r: {
  countryCode: string;
  recipientCurrency: string;
  unitPriceCents: number;
}) => `giftcard-${r.countryCode}-${r.recipientCurrency}-${r.unitPriceCents}`;

/** Intent subject for "buy a <brand> gift card": brand + model give an exact identity. */
export function giftCardSubject(input: {
  brand: string;
  countryCode: string;
  recipientCurrency: string;
  unitPriceCents: number;
  recipientRef: string;
}) {
  return {
    kind: 'PRODUCT' as const,
    title: `${input.brand} gift card ${(input.unitPriceCents / 100).toFixed(2)} ${input.recipientCurrency}`,
    brand: input.brand,
    model: giftCardModel(input),
    quantity: 1,
    attributes: {
      giftProduct: input.brand,
      country: input.countryCode,
      faceCurrency: input.recipientCurrency,
      denominationCents: String(input.unitPriceCents),
      recipientRef: input.recipientRef,
    },
  };
}

/** What the group asked for, carried in the intent's product attributes. */
export type GiftCardRequest = {
  productName: string;
  countryCode: string;
  recipientCurrency: string;
  unitPriceCents: number;
  recipientRef: string;
};
export function giftCardRequest(
  intent: EconomicIntent,
): GiftCardRequest | null {
  if (intent.subject.kind !== 'PRODUCT') return null;
  const a = intent.subject.attributes;
  const cents = Number(a.denominationCents);
  if (
    !a.giftProduct ||
    !a.country ||
    !a.faceCurrency ||
    !a.recipientRef ||
    !Number.isInteger(cents) ||
    cents <= 0
  )
    return null;
  return {
    productName: a.giftProduct,
    countryCode: a.country,
    recipientCurrency: a.faceCurrency,
    unitPriceCents: cents,
    recipientRef: a.recipientRef,
  };
}

function offerFor(input: {
  intent: EconomicIntent;
  product: ReloadlyProduct;
  req: GiftCardRequest;
  cost: { senderCost: Money; fee: Money };
  now: number;
}): EconomicOfferInput {
  const { product: p, req, now } = input;
  const ref = giftCardRef({
    productId: p.productId,
    countryCode: req.countryCode,
    unitPriceCents: req.unitPriceCents,
    recipientCurrency: req.recipientCurrency,
  });
  const zero = money(0n, p.senderCurrency, 2);
  return {
    offerId: `${ref}:${input.intent.id}`.slice(0, 160),
    intentId: input.intent.id,
    domain: 'COMMERCE',
    discoveryProviderId: RELOADLY,
    fulfillmentProviderId: RELOADLY,
    providerRef: ref,
    subject: {
      kind: 'PRODUCT',
      title:
        `${p.productName} ${(req.unitPriceCents / 100).toFixed(2)} ${req.recipientCurrency}`.slice(
          0,
          300,
        ),
      brand: (p.brand ?? req.productName).slice(0, 64),
      model: giftCardModel(req),
      quantity: 1,
      attributes: {
        groupId: input.intent.groupId,
        giftProduct: req.productName,
        reloadlyProductId: String(p.productId),
        country: req.countryCode,
        denominationCents: String(req.unitPriceCents),
        faceCurrency: req.recipientCurrency,
        recipientRef: req.recipientRef,
      },
    },
    price: {
      quoteId: `${ref}:${now}`,
      base: input.cost.senderCost,
      shipping: zero,
      tax: zero,
      fees: input.cost.fee,
      fx: [],
      quotedAt: now,
      expiresAt: now + 900,
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
      accepts: [{ rail: 'PROVIDER_BALANCE', currency: p.senderCurrency }],
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
    evidence: 'PROVIDER_SANDBOX',
    retrievedAt: now,
    executable: true,
  };
}

const ACCOUNT_CURRENCY = 'USD';

/** Gift card discovery and revalidation against the Reloadly sandbox catalog. */
export class ReloadlyGiftCardProvider {
  readonly providerId = RELOADLY;
  constructor(
    private readonly client: ReloadlyClient,
    private readonly now: () => number,
    private readonly accountCurrency = ACCOUNT_CURRENCY,
  ) {}

  async search(intent: EconomicIntent): Promise<EconomicOfferInput[]> {
    const req = giftCardRequest(intent);
    if (!req) return [];
    const products = await this.client.products({
      countryCode: req.countryCode,
      productName: req.productName,
    });
    return products.flatMap((product) => {
      const cost = checkDenomination(product, {
        countryCode: req.countryCode,
        recipientCurrency: req.recipientCurrency,
        unitPrice: req.unitPriceCents / 100,
        senderCurrency: this.accountCurrency,
      });
      return cost.ok
        ? [offerFor({ intent, product, req, cost, now: this.now() })]
        : [];
    });
  }

  async revalidate(offer: EconomicOffer): Promise<RevalidatedQuote> {
    const ref = parseGiftCardRef(offer.providerRef);
    if (!ref || offer.subject.kind !== 'PRODUCT')
      throw new ReloadlyError(0, null, 'not a Reloadly offer');
    const product = await this.client.product(ref.productId);
    const cost = checkDenomination(product, {
      countryCode: ref.countryCode,
      recipientCurrency: ref.recipientCurrency,
      unitPrice: ref.unitPriceCents / 100,
      senderCurrency: this.accountCurrency,
    });
    const t = this.now();
    return {
      available: cost.ok,
      providerRef: offer.providerRef,
      subject: offer.subject,
      price: {
        ...offer.price,
        ...(cost.ok ? { base: cost.senderCost, fees: cost.fee } : {}),
        quotedAt: t,
        expiresAt: t + 900,
        revalidatedAt: t,
      },
    };
  }
}

/**
 * Executes a granted gift card order in the Reloadly sandbox. The order's
 * customIdentifier is the workflow's deterministic idempotency key, so a
 * timed-out order is found, never placed twice. Codes go to the sealer only.
 */
export class ReloadlyGiftCardPort implements ProviderBookingPort {
  readonly providerId = RELOADLY;
  readonly host = RELOADLY_SANDBOX_HOST;
  readonly settlement = {
    category: 'DIGITAL_GOODS_SANDBOX',
    mode: 'PROVIDER_SANDBOX',
    economicEffect: 'NONE_SANDBOX' as const,
    providerName: 'Reloadly',
  };
  constructor(
    private readonly client: ReloadlyClient,
    private readonly sealer: GiftCodeSealer | null,
    private readonly accountCurrency = ACCOUNT_CURRENCY,
  ) {}

  /**
   * customIdentifier: a fixed-length hash of the FULL idempotency key. Never a
   * truncation: long keys (bytes32 group ids) must not collide across bookings.
   */
  static customIdentifier(idempotencyKey: string) {
    return `synq-${createHash('sha256').update(`reloadly:${idempotencyKey}`).digest('hex').slice(0, 40)}`;
  }

  private bound(offer: EconomicOffer):
    | {
        ok: true;
        ref: GiftCardRef;
        recipient: { groupId: string; recipientRef: string };
        cap: Money;
      }
    | { ok: false; reason: string } {
    const ref = parseGiftCardRef(offer.providerRef);
    if (!ref || offer.subject.kind !== 'PRODUCT')
      return { ok: false, reason: 'not a Reloadly gift card offer' };
    const a = offer.subject.attributes;
    if (
      a.reloadlyProductId !== String(ref.productId) ||
      a.country !== ref.countryCode ||
      a.denominationCents !== String(ref.unitPriceCents) ||
      a.faceCurrency !== ref.recipientCurrency ||
      !a.recipientRef ||
      !a.groupId ||
      offer.subject.quantity !== 1
    )
      return {
        ok: false,
        reason: 'offer subject differs from its product ref',
      };
    const p = offer.price;
    if (
      p.base.currency !== this.accountCurrency ||
      p.fees.currency !== p.base.currency
    )
      return { ok: false, reason: 'offer not priced in the account currency' };
    return {
      ok: true,
      ref,
      recipient: { groupId: a.groupId, recipientRef: a.recipientRef },
      cap: money(
        BigInt(p.base.amount) +
          BigInt(p.fees.amount) +
          BigInt(p.tax.amount) +
          BigInt(p.shipping.amount),
        p.base.currency,
        p.base.decimals,
      ),
    };
  }

  /** Checks a provider transaction against what was granted. */
  private check(
    t: ReloadlyTransaction,
    ref: GiftCardRef,
    cap: Money,
    customIdentifier: string,
  ): string | null {
    // Exact match only: a transaction without our identifier is never ours.
    if (t.customIdentifier !== customIdentifier)
      return 'customIdentifier differs';
    if (t.productId !== null && t.productId !== ref.productId)
      return 'product differs';
    if (t.quantity !== null && t.quantity !== 1) return 'quantity differs';
    if (
      t.unitPrice !== null &&
      Math.round(t.unitPrice * 100) !== ref.unitPriceCents
    )
      return 'denomination differs';
    if (
      t.recipientCurrency !== null &&
      t.recipientCurrency !== ref.recipientCurrency
    )
      return 'face currency differs';
    if (t.amount.currency !== cap.currency) return 'charge currency differs';
    if (BigInt(t.amount.amount) > BigInt(cap.amount))
      return `INCONSISTENT_AMOUNT: charged ${t.amount.amount} > granted ${cap.amount}`;
    return null;
  }

  private async outcome(
    t: ReloadlyTransaction,
    ref: GiftCardRef,
    cap: Money,
    customIdentifier: string,
    recipient: { groupId: string; recipientRef: string },
  ): Promise<ProviderBookingOutcome> {
    const bad = this.check(t, ref, cap, customIdentifier);
    if (bad)
      return {
        status: 'UNKNOWN',
        reason: `PROVIDER_RESPONSE_INCONSISTENT: ${bad} (transaction ${t.transactionId})`,
      };
    if (t.status === 'SUCCESSFUL') {
      if (this.sealer) {
        const sealer = this.sealer;
        try {
          await this.client.sealRedeemCodes(t.transactionId, (codes) =>
            sealer.seal({
              provider: 'reloadly',
              transactionId: t.transactionId,
              groupId: recipient.groupId,
              recipientRef: recipient.recipientRef,
              codes,
            }),
          );
        } catch {
          // The order stands; code retrieval is retried by delivery, not by reordering.
        }
      }
      return {
        status: 'CONFIRMED',
        providerRef: t.transactionId,
        reference: null,
        charged: t.amount,
      };
    }
    if (t.status === 'FAILED' || t.status === 'REFUNDED')
      return {
        status: 'FAILED',
        reason: `provider ${t.status} (transaction ${t.transactionId})`,
      };
    return {
      status: 'UNKNOWN',
      reason: `provider status ${t.status} (transaction ${t.transactionId})`,
    };
  }

  async book(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome> {
    const b = this.bound(input.offer);
    if (!b.ok) return { status: 'FAILED', reason: b.reason };
    const customIdentifier = ReloadlyGiftCardPort.customIdentifier(
      input.idempotencyKey,
    );
    // Validation before ordering: definitive failures create nothing.
    try {
      const product = await this.client.product(b.ref.productId);
      const cost = checkDenomination(product, {
        countryCode: b.ref.countryCode,
        recipientCurrency: b.ref.recipientCurrency,
        unitPrice: b.ref.unitPriceCents / 100,
        senderCurrency: this.accountCurrency,
      });
      if (!cost.ok)
        return { status: 'FAILED', reason: `${cost.code}: ${cost.reason}` };
      const expected = BigInt(cost.senderCost.amount) + BigInt(cost.fee.amount);
      if (expected > BigInt(b.cap.amount))
        return {
          status: 'FAILED',
          reason: `PRICE_INCREASED: ${expected} > granted ${b.cap.amount}`,
        };
      const bal = await this.client.balance();
      if (bal.currency !== b.cap.currency || BigInt(bal.amount) < expected)
        return {
          status: 'FAILED',
          reason: 'INSUFFICIENT_SANDBOX_BALANCE',
        };
    } catch (e) {
      return {
        status: 'FAILED',
        reason: `pre-order validation failed: ${(e as Error).message}`,
      };
    }
    let created: Json;
    try {
      created = await this.client.order({
        productId: b.ref.productId,
        countryCode: b.ref.countryCode,
        unitPrice: b.ref.unitPriceCents / 100,
        customIdentifier,
        senderName: 'Synq',
      });
    } catch (e) {
      if (
        e instanceof ReloadlyError &&
        /DUPLICATE/i.test(`${e.errorCode ?? ''} ${e.message}`)
      )
        // The identifier already exists: that order is ours. Look it up.
        return (
          (await this.find(input).catch(() => null)) ?? {
            status: 'UNKNOWN',
            reason: 'duplicate customIdentifier but no transaction found yet',
          }
        );
      if (e instanceof ReloadlyError && e.definitive)
        return { status: 'FAILED', reason: e.message };
      return {
        status: 'UNKNOWN',
        reason: `order outcome unknown: ${(e as Error).message}`.slice(0, 200),
      };
    }
    let t: ReloadlyTransaction;
    try {
      t = toTransaction(created, this.accountCurrency);
    } catch {
      return { status: 'UNKNOWN', reason: 'order response unreadable' };
    }
    return this.outcome(t, b.ref, b.cap, customIdentifier, b.recipient);
  }

  async find(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome | null> {
    const b = this.bound(input.offer);
    if (!b.ok) return null;
    const customIdentifier = ReloadlyGiftCardPort.customIdentifier(
      input.idempotencyKey,
    );
    const found = await this.client.transactionsByCustomIdentifier(
      customIdentifier,
      input.offer.retrievedAt,
      this.accountCurrency,
    );
    if (!found.length) return null;
    if (found.length > 1)
      return {
        status: 'UNKNOWN',
        reason: `DUPLICATE_PROVIDER_ORDERS: ${found.map((t) => t.transactionId).join(',')}`,
      };
    return this.outcome(found[0]!, b.ref, b.cap, customIdentifier, b.recipient);
  }

  async cancel() {
    return {
      confirmed: false,
      refund: null,
      reason: 'gift card orders are final; no cancellation path',
    };
  }
}
