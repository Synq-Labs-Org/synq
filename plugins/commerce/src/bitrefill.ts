import { arr, obj, str, type HttpFetch, type Json } from './http.js';

export const BITREFILL = 'bitrefill';
export const BITREFILL_HOSTS = ['api.bitrefill.com', 'api-bitrefill.com'];
export const BITREFILL_BASE = 'https://api.bitrefill.com/v2';
export const BITREFILL_SOURCES = [
  'https://docs.bitrefill.com/docs/api-overview',
  'https://docs.bitrefill.com/docs/crypto-payments',
  'https://docs.bitrefill.com/docs/core-concepts',
  'https://docs.bitrefill.com/reference/post_invoices',
];

/**
 * Bitrefill is real money (mainnet crypto, live gift cards). Synq uses it
 * read-only: catalog, product details, validation and payment-method
 * discovery. Invoice creation is off by default and paying an invoice has
 * no implementation behind a default-deny real-money gate.
 */
export type BitrefillConfig =
  | { kind: 'PERSONAL'; apiKey: string; baseUrl?: string }
  | { kind: 'BUSINESS'; apiId: string; apiSecret: string; baseUrl?: string };

export function bitrefillConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BitrefillConfig | null {
  if (env.BITREFILL_API_ID && env.BITREFILL_API_SECRET)
    return {
      kind: 'BUSINESS',
      apiId: env.BITREFILL_API_ID,
      apiSecret: env.BITREFILL_API_SECRET,
    };
  if (env.BITREFILL_API_KEY)
    return { kind: 'PERSONAL', apiKey: env.BITREFILL_API_KEY };
  return null;
}

export class BitrefillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`BITREFILL_HTTP_${status}: ${message}`.slice(0, 300));
    this.name = 'BitrefillError';
  }
}

/** Documented payment methods (docs: Crypto Payments; POST /invoices payment_method). */
export const BITREFILL_PAYMENT_METHODS: Readonly<
  Record<string, { chain: string; asset: string }>
> = Object.freeze({
  balance: { chain: 'bitrefill-account', asset: 'ACCOUNT_BALANCE' },
  bitcoin: { chain: 'bitcoin', asset: 'BTC' },
  lightning: { chain: 'lightning', asset: 'BTC' },
  ethereum: { chain: 'ethereum', asset: 'ETH' },
  eth_base: { chain: 'base', asset: 'ETH' },
  eth_arbitrum: { chain: 'arbitrum', asset: 'ETH' },
  usdc_erc20: { chain: 'ethereum', asset: 'USDC' },
  usdc_polygon: { chain: 'polygon', asset: 'USDC' },
  usdc_solana: { chain: 'solana', asset: 'USDC' },
  usdc_base: { chain: 'base', asset: 'USDC' },
  usdc_arbitrum: { chain: 'arbitrum', asset: 'USDC' },
  usdt_trc20: { chain: 'tron', asset: 'USDT' },
  usdt_erc20: { chain: 'ethereum', asset: 'USDT' },
  usdt_polygon: { chain: 'polygon', asset: 'USDT' },
  usdt_arbitrum: { chain: 'arbitrum', asset: 'USDT' },
  usdt_solana: { chain: 'solana', asset: 'USDT' },
  usdt_lightning: { chain: 'lightning', asset: 'USDT' },
  usdt_ton: { chain: 'ton', asset: 'USDT' },
  solana: { chain: 'solana', asset: 'SOL' },
  litecoin: { chain: 'litecoin', asset: 'LTC' },
  dogecoin: { chain: 'dogecoin', asset: 'DOGE' },
  dash: { chain: 'dash', asset: 'DASH' },
  ton: { chain: 'ton', asset: 'TON' },
});

/** The network/asset an invoice demands, or null for an unknown method. */
export function invoicePaymentRequirement(
  method: string,
): { chain: string; asset: string } | null {
  return Object.hasOwn(BITREFILL_PAYMENT_METHODS, method)
    ? BITREFILL_PAYMENT_METHODS[method]!
    : null;
}

/** Monad AUSD is not a Bitrefill payment method; it is never assumed payable. */
export function treasuryCanPay(
  method: string,
  holdings: readonly { chain: string; asset: string }[],
): boolean {
  const need = invoicePaymentRequirement(method);
  return (
    !!need &&
    need.chain !== 'bitrefill-account' &&
    holdings.some((h) => h.chain === need.chain && h.asset === need.asset)
  );
}

export const BITREFILL_LIFECYCLE = [
  'DISCOVERED',
  'PRODUCT_VALIDATED',
  'QUOTED',
  'PAYMENT_METHOD_CHECKED',
  'AWAITING_REAL_MONEY_APPROVAL',
  'INVOICE_CREATED',
  'AWAITING_PAYMENT',
  'PAYMENT_DETECTED',
  'PAYMENT_CONFIRMED',
  'FULFILLING',
  'DELIVERED',
  'REJECTED',
  'PAYMENT_ERROR',
  'FAILED',
  'REFUNDED',
  'EXPIRED',
  'UNKNOWN_OUTCOME',
] as const;
export type BitrefillLifecycle = (typeof BITREFILL_LIFECYCLE)[number];

/** Maps documented invoice and order statuses onto the Synq lifecycle. */
export function lifecycleOf(
  invoiceStatus: string,
  orderStatuses: readonly string[] = [],
): BitrefillLifecycle {
  if (orderStatuses.includes('refunded')) return 'REFUNDED';
  if (orderStatuses.includes('failed')) return 'FAILED';
  switch (invoiceStatus) {
    case 'unpaid':
      return 'AWAITING_PAYMENT';
    case 'payment_detected':
      return 'PAYMENT_DETECTED';
    case 'payment_confirmed':
      return 'PAYMENT_CONFIRMED';
    case 'pending':
      return 'FULFILLING';
    case 'complete':
      return orderStatuses.every((s) => s === 'delivered')
        ? 'DELIVERED'
        : 'UNKNOWN_OUTCOME';
    case 'blocked':
    case 'denied':
      return 'REJECTED';
    case 'payment_error':
      return 'PAYMENT_ERROR';
    case 'expired':
      return 'EXPIRED';
    case 'not_delivered':
      return 'FAILED';
    default:
      return 'UNKNOWN_OUTCOME';
  }
}

export type BitrefillProduct = {
  id: string;
  name: string;
  countryCode: string;
  currency: string;
  inStock: boolean;
  packages: { id: string; value: number; price: number | null }[];
  range: {
    min: number;
    max: number;
    step: number;
    priceRate: number | null;
  } | null;
};

function toProduct(j: Json): BitrefillProduct {
  const id = str(j.id);
  if (!id) throw new BitrefillError(0, 'product without id');
  const rawPackages = Array.isArray(j.packages)
    ? (j.packages as unknown[])
    : j.packages
      ? [j.packages]
      : [];
  const range = obj(j.range);
  return {
    id,
    name: str(j.name) ?? id,
    countryCode: str(j.country_code) ?? str(j.country) ?? '',
    currency: str(j.currency) ?? '',
    inStock: j.in_stock !== false,
    packages: rawPackages.map(obj).flatMap((p) => {
      const value = Number(p.value);
      const pid = str(p.id) ?? str(p.package_id);
      return pid && Number.isFinite(value)
        ? [
            {
              id: pid,
              value,
              price: typeof p.price === 'number' ? p.price : null,
            },
          ]
        : [];
    }),
    range:
      typeof range.min === 'number' && typeof range.max === 'number'
        ? {
            min: range.min,
            max: range.max,
            step: typeof range.step === 'number' ? range.step : 1,
            priceRate:
              typeof range.price_rate === 'number' ? range.price_rate : null,
          }
        : null,
  };
}

export type BitrefillValidation =
  | {
      ok: true;
      packageId: string | null;
      value: number;
      price: number | null;
      currency: string;
    }
  | {
      ok: false;
      code:
        | 'OUT_OF_STOCK'
        | 'UNSUPPORTED_COUNTRY'
        | 'UNSUPPORTED_CURRENCY'
        | 'INVALID_DENOMINATION';
      reason: string;
    };

export function validateBitrefillPurchase(
  p: BitrefillProduct,
  want: { countryCode: string; currency: string; value: number },
): BitrefillValidation {
  if (!p.inStock) return { ok: false, code: 'OUT_OF_STOCK', reason: p.id };
  if (p.countryCode && p.countryCode !== want.countryCode)
    return { ok: false, code: 'UNSUPPORTED_COUNTRY', reason: p.countryCode };
  if (p.currency !== want.currency)
    return { ok: false, code: 'UNSUPPORTED_CURRENCY', reason: p.currency };
  const pkg = p.packages.find(
    (x) => Math.round(x.value * 100) === Math.round(want.value * 100),
  );
  if (pkg)
    return {
      ok: true,
      packageId: pkg.id,
      value: pkg.value,
      price: pkg.price,
      currency: p.currency,
    };
  const r = p.range;
  if (r && want.value >= r.min && want.value <= r.max) {
    const steps = (want.value - r.min) / r.step;
    if (Math.abs(steps - Math.round(steps)) < 1e-9)
      return {
        ok: true,
        packageId: null,
        value: want.value,
        price: r.priceRate === null ? null : want.value * r.priceRate,
        currency: p.currency,
      };
  }
  return {
    ok: false,
    code: 'INVALID_DENOMINATION',
    reason: `${want.value} not offered`,
  };
}

/** A human approval of one specific real-money payment, capped. */
export type RealMoneyApproval = {
  approvalId: string;
  invoiceId: string;
  approvedBy: string;
  humanVerified: boolean;
  capMinor: bigint;
  currency: string;
  expiresAt: number;
};
export type RealMoneyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Default-deny real-money gate: REAL_MONEY_APPROVAL_REQUIRED mode, the
 * mainnet broadcast flag, and a single-use, unexpired, human-verified
 * approval for exactly this invoice with a cap at or above the amount.
 */
export class RealMoneyGate {
  private readonly used = new Set<string>();
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}
  authorize(input: {
    mode: string;
    invoiceId: string;
    amountMinor: bigint;
    currency: string;
    approval: RealMoneyApproval | null;
    now: number;
  }): RealMoneyDecision {
    const deny = (reason: string) => ({ allowed: false as const, reason });
    if (input.mode !== 'REAL_MONEY_APPROVAL_REQUIRED')
      return deny('mode is not REAL_MONEY_APPROVAL_REQUIRED');
    if (this.env.SYNQ_ALLOW_MAINNET_BROADCAST !== 'true')
      return deny('SYNQ_ALLOW_MAINNET_BROADCAST is not true');
    const a = input.approval;
    if (!a) return deny('no human approval');
    if (!a.humanVerified) return deny('approval not human-verified');
    if (a.invoiceId !== input.invoiceId)
      return deny('approval is for another invoice');
    if (a.currency !== input.currency) return deny('approval currency differs');
    if (input.amountMinor <= 0n || input.amountMinor > a.capMinor)
      return deny('amount above the approved cap');
    if (a.expiresAt <= input.now) return deny('approval expired');
    if (this.used.has(a.approvalId)) return deny('approval already used');
    this.used.add(a.approvalId);
    return { allowed: true };
  }
}

export class BitrefillClient {
  private readonly base: string;
  constructor(
    private readonly config: BitrefillConfig,
    private readonly fetchImpl: HttpFetch,
    private readonly options: {
      /** Off by default: an unpaid crypto invoice is the only thing Synq may create. */
      allowInvoicePreview?: boolean;
      timeoutMs?: number;
    } = {},
  ) {
    const base = (config.baseUrl ?? BITREFILL_BASE).replace(/\/+$/, '');
    const url = new URL(base);
    if (url.protocol !== 'https:' || !BITREFILL_HOSTS.includes(url.host))
      throw new BitrefillError(0, 'base URL is not the Bitrefill API');
    this.base = base;
  }

  get kind() {
    return this.config.kind;
  }

  private auth(): string {
    return this.config.kind === 'PERSONAL'
      ? `Bearer ${this.config.apiKey}`
      : `Basic ${Buffer.from(`${this.config.apiId}:${this.config.apiSecret}`).toString('base64')}`;
  }

  private redact(t: string) {
    const secrets =
      this.config.kind === 'PERSONAL'
        ? [this.config.apiKey]
        : [this.config.apiId, this.config.apiSecret];
    return secrets.reduce(
      (acc, s) => (s ? acc.split(s).join('[REDACTED]') : acc),
      t,
    );
  }

  private async get(path: string): Promise<Json> {
    return this.request('GET', path);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: this.auth(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    if (res.status < 200 || res.status >= 300)
      throw new BitrefillError(
        res.status,
        this.redact(
          str(json.message) ??
            str(obj(json.error).message) ??
            str(json.error) ??
            'error',
        ),
      );
    return json;
  }

  async ping(): Promise<boolean> {
    const j = await this.get('/ping');
    return str(obj(j.data).message) === 'pong';
  }

  async searchProducts(q: string, limit = 20): Promise<BitrefillProduct[]> {
    const p = new URLSearchParams({ q, limit: String(limit), start: '0' });
    return arr((await this.get(`/products/search?${p}`)).data).flatMap((x) => {
      try {
        return [toProduct(x)];
      } catch {
        return [];
      }
    });
  }

  async product(id: string): Promise<BitrefillProduct> {
    return toProduct(
      obj((await this.get(`/products/${encodeURIComponent(id)}`)).data),
    );
  }

  async invoice(id: string): Promise<{
    id: string;
    status: string;
    paymentMethod: string;
    price: number | null;
    currency: string | null;
    orders: string[];
    lifecycle: BitrefillLifecycle;
  }> {
    const d = obj((await this.get(`/invoices/${encodeURIComponent(id)}`)).data);
    const pay = obj(d.payment);
    const orders = arr(d.orders).map((o) => str(o.status) ?? 'unknown');
    const status = str(d.status) ?? 'unknown';
    return {
      id: str(d.id) ?? id,
      status,
      paymentMethod: str(pay.method) ?? 'unknown',
      price: typeof pay.price === 'number' ? pay.price : null,
      currency: str(pay.currency) ?? null,
      orders,
      lifecycle: lifecycleOf(status, orders),
    };
  }

  /**
   * Creates an UNPAID crypto invoice so its accepted network/asset and price
   * can be inspected. Never `balance`, never `auto_pay`; off unless enabled.
   */
  async previewInvoice(input: {
    productId: string;
    packageId: string | null;
    value: number;
    paymentMethod: string;
  }): Promise<{ invoiceId: string; method: string; price: number | null }> {
    if (!this.options.allowInvoicePreview)
      throw new BitrefillError(0, 'INVOICE_PREVIEW_DISABLED');
    const need = invoicePaymentRequirement(input.paymentMethod);
    if (!need || input.paymentMethod === 'balance')
      throw new BitrefillError(
        0,
        'only crypto payment methods may be previewed',
      );
    const d = obj(
      (
        await this.request('POST', '/invoices', {
          products: [
            {
              product_id: input.productId,
              quantity: 1,
              ...(input.packageId
                ? { package_id: input.packageId }
                : { value: input.value }),
            },
          ],
          payment_method: input.paymentMethod,
          auto_pay: false,
        })
      ).data,
    );
    const pay = obj(d.payment);
    return {
      invoiceId: str(d.id) ?? '',
      method: str(pay.method) ?? input.paymentMethod,
      price: typeof pay.price === 'number' ? pay.price : null,
    };
  }

  /**
   * There is deliberately no payment path. Even an allowed gate decision ends
   * here: Synq has no Bitrefill payer, and this method never touches the API.
   */
  async payInvoice(input: {
    gate: RealMoneyGate;
    mode: string;
    invoiceId: string;
    amountMinor: bigint;
    currency: string;
    approval: RealMoneyApproval | null;
    now: number;
  }): Promise<never> {
    const d = input.gate.authorize(input);
    if (!d.allowed)
      throw new BitrefillError(0, `REAL_MONEY_DENIED: ${d.reason}`);
    throw new BitrefillError(
      0,
      'NO_BROADCAST_PATH: Synq ships no real-money payer for Bitrefill invoices',
    );
  }
}
