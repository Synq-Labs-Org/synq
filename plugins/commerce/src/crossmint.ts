import { parseTransaction, type Hex } from 'viem';
import {
  compare,
  convert,
  fromDecimal,
  type EconomicOffer,
  type FxRate,
  type Money,
  type ProviderCapability,
} from '@synq/offer-exchange';
import testnetAssets from '../../../sources/provider_testnet_assets.json' with { type: 'json' };
import { arr, obj, str, type HttpFetch, type Json } from './http.js';
import type {
  CheckoutRoute,
  PaymentEvidence,
  PlaceInput,
  PlacedOrder,
  ReconcileOutcome,
} from './checkout.js';

export const CROSSMINT = 'crossmint';
export const CROSSMINT_STAGING_HOST = 'staging.crossmint.com';
export const CROSSMINT_STAGING_BASE = `https://${CROSSMINT_STAGING_HOST}/api/2022-06-09`;

/**
 * Crossmint staging accepts EVM crypto payment only on these testnets
 * (Create Order `payment.method` enum, docs.crossmint.com, 2026-10). Monad
 * testnet is not among them. USDC addresses are Circle's testnet deployments,
 * kept with their sources in sources/provider_testnet_assets.json.
 */
export type CrossmintStagingChain =
  | 'ethereum-sepolia'
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'optimism-sepolia';
export const CROSSMINT_STAGING_CHAINS: Readonly<
  Record<CrossmintStagingChain, { chainId: number; usdc: string }>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(testnetAssets.crossmintStaging).map(([k, v]) => [
      k,
      Object.freeze({ chainId: v.chainId, usdc: v.usdc.toLowerCase() }),
    ]),
  ) as Record<CrossmintStagingChain, { chainId: number; usdc: string }>,
);

/** Staging is the only accepted Crossmint environment: no production orders, no real money. */
export class CrossmintEnvironmentError extends Error {
  constructor(detail: string) {
    super(`CROSSMINT_NOT_STAGING: ${detail}`);
    this.name = 'CrossmintEnvironmentError';
  }
}

export type CrossmintConfig = {
  apiKey: string;
  environment: string | undefined;
  baseUrl?: string;
  chain: CrossmintStagingChain;
};

export function assertCrossmintStaging(c: CrossmintConfig): string {
  if (c.environment !== 'staging')
    throw new CrossmintEnvironmentError('CROSSMINT_ENV must be staging');
  if (!c.apiKey.startsWith('sk_staging_'))
    throw new CrossmintEnvironmentError('server key is not a staging key');
  const base = c.baseUrl ?? CROSSMINT_STAGING_BASE;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CrossmintEnvironmentError('base URL invalid');
  }
  if (url.protocol !== 'https:' || url.host !== CROSSMINT_STAGING_HOST)
    throw new CrossmintEnvironmentError('base URL is not staging');
  if (!Object.hasOwn(CROSSMINT_STAGING_CHAINS, c.chain))
    throw new CrossmintEnvironmentError('payment chain is not a testnet');
  return base.replace(/\/+$/, '');
}

/** A payment transaction the route has already checked against the quote and grant. */
export type VerifiedPayment = {
  orderRef: string;
  chain: CrossmintStagingChain;
  chainId: number;
  serializedTransaction: Hex;
  token: string;
  amount: bigint;
};

/**
 * Testnet payer. Implemented by the execution side (it holds a signer); it
 * must broadcast exactly the verified transaction and report the mined status.
 * Throwing means the broadcast outcome is unknown.
 */
export interface CrossmintPayer {
  readonly address: string;
  readonly chain: CrossmintStagingChain;
  pay(
    tx: VerifiedPayment,
  ): Promise<{ txHash: string; status: 'success' | 'reverted' }>;
}

export class CrossmintError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`CROSSMINT_HTTP_${status}: ${message}`.slice(0, 300));
    this.name = 'CrossmintError';
  }
}

/** USDC is compared against USD grant caps at par, rounding cost up. */
export const USDC_USD_PAR: FxRate = {
  from: 'USDC',
  to: 'USD',
  numerator: '1',
  denominator: '1',
  source: 'usdc-par',
  observedAt: 0,
};

const TRANSFER = '0xa9059cbb';
const SECRETISH = /\b(sk|ck)_(staging|production)_[A-Za-z0-9]+/g;

/**
 * Crossmint headless checkout, staging only. Create order → verify the
 * returned quote, item and payment transaction against the grant → pay from
 * the testnet payer → report the tx → poll. Every mismatch holds before
 * paying; every ambiguous outcome is reported for reconciliation and never
 * retried.
 */
export class CrossmintCheckoutRoute implements CheckoutRoute {
  readonly mode = 'STABLECOIN_CHECKOUT' as const;
  readonly providerId = CROSSMINT;
  readonly host = CROSSMINT_STAGING_HOST;
  private readonly base: string | null;
  constructor(
    readonly capability: ProviderCapability,
    private readonly config: CrossmintConfig | undefined,
    private readonly fetchImpl: HttpFetch,
    private readonly payer: CrossmintPayer | null,
    private readonly options: {
      pollAttempts?: number;
      pollIntervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    let base: string | null = null;
    if (config) {
      // Hard guard: a non-staging configuration is a construction error.
      base = assertCrossmintStaging(config);
      if (payer && payer.chain !== config.chain)
        throw new CrossmintEnvironmentError(
          'payer chain differs from the order payment chain',
        );
    }
    this.base = base;
  }

  supports(offer: EconomicOffer) {
    return /^amazon:[A-Z0-9]{10}$/.test(offer.providerRef);
  }

  sandboxReady() {
    return this.base !== null && !!this.payer;
  }

  private redact(text: string) {
    const key = this.config?.apiKey;
    return (key ? text.split(key).join('[REDACTED]') : text).replace(
      SECRETISH,
      '[REDACTED]',
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Json> {
    if (!this.base || !this.config) throw new CrossmintError(0, 'not staging');
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY': this.config.apiKey,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    if (res.status < 200 || res.status >= 300)
      throw new CrossmintError(
        res.status,
        this.redact(str(json.message) ?? str(json.error) ?? 'error'),
      );
    return json;
  }

  async place(input: PlaceInput): Promise<PlacedOrder> {
    if (!this.sandboxReady() || !this.config || !this.payer)
      return {
        state: 'FAILED',
        reason: 'staging credentials or payer missing',
      };
    const ref = input.offer.providerRef;
    if (!this.supports(input.offer))
      return { state: 'FAILED', reason: 'unsupported product locator' };
    const qty =
      input.offer.subject.kind === 'PRODUCT' ? input.offer.subject.quantity : 1;
    if (qty !== 1)
      return { state: 'FAILED', reason: 'only single-quantity line items' };
    const r = input.recipient;
    let created: Json;
    try {
      created = await this.request('POST', '/orders', {
        recipient: {
          email: r.email,
          physicalAddress: {
            name: r.name,
            line1: r.line1,
            ...(r.line2 ? { line2: r.line2 } : {}),
            city: r.city,
            ...(r.state ? { state: r.state } : {}),
            postalCode: r.postalCode,
            country: r.country,
          },
        },
        payment: {
          method: this.config.chain,
          currency: 'usdc',
          payerAddress: this.payer.address,
        },
        lineItems: [{ productLocator: ref }],
      });
    } catch (e) {
      const err = e as Error;
      // A 4xx is a definitive rejection; anything else may have created an order.
      if (
        err instanceof CrossmintError &&
        err.status >= 400 &&
        err.status < 500 &&
        ![408, 409, 425, 429].includes(err.status)
      )
        return { state: 'FAILED', reason: err.message };
      return {
        state: 'UNKNOWN_PROVIDER_OUTCOME',
        orderRef: null,
        reason: this.redact(err.message),
      };
    }
    const order = obj(created.order);
    const orderRef = str(order.orderId);
    if (!orderRef)
      return {
        state: 'UNKNOWN_PROVIDER_OUTCOME',
        orderRef: null,
        reason: 'create returned no order id',
      };
    const checked = this.verify(order, orderRef, input);
    if (!checked.ok)
      return {
        state: 'HELD',
        orderRef,
        reason: checked.reason,
        quoted: checked.quoted ?? null,
        ...(checked.stepUp ? { stepUp: checked.stepUp } : {}),
      };
    const tx = checked.tx;
    let paid: { txHash: string; status: 'success' | 'reverted' };
    try {
      paid = await this.payer.pay(tx);
    } catch (e) {
      return {
        state: 'UNKNOWN_PROVIDER_OUTCOME',
        orderRef,
        reason: `payment broadcast outcome unknown: ${this.redact((e as Error).message).slice(0, 160)}`,
      };
    }
    const payment: PaymentEvidence = {
      chain: tx.chain,
      chainId: tx.chainId,
      txHash: paid.txHash,
    };
    if (paid.status !== 'success')
      return {
        state: 'UNKNOWN_PROVIDER_OUTCOME',
        orderRef,
        payment,
        reason: 'payment transaction reverted',
      };
    let submitNote = '';
    try {
      await this.request(
        'POST',
        `/orders/${encodeURIComponent(orderRef)}/payment`,
        {
          type: 'crypto-tx-id',
          txId: paid.txHash,
        },
      );
    } catch (e) {
      submitNote = ` (tx report: ${(e as Error).message.slice(0, 80)})`;
    }
    const attempts = this.options.pollAttempts ?? 48;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    let last = 'unknown';
    for (let i = 0; i < attempts; i++) {
      await sleep(this.options.pollIntervalMs ?? 2_500);
      let o: Json;
      try {
        o = await this.request(
          'GET',
          `/orders/${encodeURIComponent(orderRef)}`,
        );
      } catch {
        continue;
      }
      const ord = obj(o.order ?? o);
      const p = obj(ord.payment);
      last = str(p.status) ?? 'unknown';
      if (last === 'completed') {
        if (p.refunded)
          return {
            state: 'UNKNOWN_PROVIDER_OUTCOME',
            orderRef,
            payment,
            reason: 'payment completed then refunded',
          };
        return {
          state: 'ORDER_PLACED',
          orderRef,
          charged: checked.total,
          payment,
          providerStatus: `payment completed; delivery ${str(obj(obj(arr(ord.lineItems)[0]).delivery).status) ?? 'unknown'}`,
        };
      }
      if (last === 'failed')
        return {
          state: 'UNKNOWN_PROVIDER_OUTCOME',
          orderRef,
          payment,
          reason: `provider reports payment failed after broadcast${submitNote}`,
        };
    }
    return {
      state: 'UNKNOWN_PROVIDER_OUTCOME',
      orderRef,
      payment,
      reason: `payment not confirmed by provider (last ${last})${submitNote}`,
    };
  }

  /** Checks the created order against the grant before any payment. */
  private verify(
    order: Json,
    orderRef: string,
    input: PlaceInput,
  ):
    | { ok: true; tx: VerifiedPayment; total: Money }
    | { ok: false; reason: string; stepUp?: 'KYC'; quoted?: Money } {
    const fail = (reason: string, quoted?: Money) => ({
      ok: false as const,
      reason,
      ...(quoted ? { quoted } : {}),
    });
    const chain = this.config!.chain;
    const spec = CROSSMINT_STAGING_CHAINS[chain];
    const payment = obj(order.payment);
    const pStatus = str(payment.status) ?? 'unknown';
    if (['requires-kyc', 'manual-kyc', 'failed-kyc'].includes(pStatus))
      return {
        ok: false,
        reason: `STEP_UP_REQUIRED: payment ${pStatus}`,
        stepUp: 'KYC',
      };
    const quote = obj(order.quote);
    if (str(quote.status) !== 'valid')
      return fail(`quote ${str(quote.status) ?? 'missing'}`);
    const items = arr(order.lineItems);
    if (items.length !== 1) return fail('order line items differ');
    const item = items[0]!;
    const echoed = str(item.productLocator);
    if (echoed !== undefined && echoed !== input.offer.providerRef)
      return fail('order item differs from the granted product');
    if (typeof item.quantity === 'number' && item.quantity !== 1)
      return fail('order quantity differs from the grant');
    const iq = obj(item.quote);
    if (iq.status !== undefined && str(iq.status) !== 'valid')
      return fail(`line item quote ${str(iq.status)}`);
    let total: Money;
    let unit: Money;
    try {
      const t = obj(quote.totalPrice);
      const u = obj(obj(iq.charges).unit);
      if (str(t.currency)?.toLowerCase() !== 'usdc')
        return fail('quote currency is not USDC');
      if (str(u.currency)?.toLowerCase() !== 'usdc')
        return fail('unit price missing or not USDC');
      total = fromDecimal(str(t.amount) ?? '', 'USDC', 6);
      unit = fromDecimal(str(u.amount) ?? '', 'USDC', 6);
    } catch {
      return fail('quote amounts unreadable');
    }
    const fx = [USDC_USD_PAR];
    if (compare(convert(unit, input.maxUnit, fx), input.maxUnit) > 0)
      return fail('price increased since the grant', total);
    if (compare(convert(total, input.maxTotal, fx), input.maxTotal) > 0)
      return fail('quote total exceeds the grant', total);
    if (pStatus !== 'awaiting-payment')
      return fail(`payment ${pStatus}`, total);
    const prep = obj(payment.preparation);
    if (str(prep.chain) !== chain) return fail('payment chain differs', total);
    if (
      str(prep.payerAddress)?.toLowerCase() !==
      this.payer!.address.toLowerCase()
    )
      return fail('payer address differs', total);
    const serialized = str(prep.serializedTransaction);
    if (!serialized || !/^0x[0-9a-fA-F]+$/.test(serialized))
      return fail('no payment transaction', total);
    let parsed: ReturnType<typeof parseTransaction>;
    try {
      parsed = parseTransaction(serialized as Hex);
    } catch {
      return fail('payment transaction unreadable', total);
    }
    const data = (parsed.data ?? '0x').toLowerCase();
    if (
      parsed.chainId !== spec.chainId ||
      parsed.to?.toLowerCase() !== spec.usdc ||
      (parsed.value ?? 0n) !== 0n ||
      !data.startsWith(TRANSFER) ||
      data.length < 138
    )
      return fail(
        'payment transaction is not a USDC transfer on the order chain',
        total,
      );
    const amount = BigInt(`0x${data.slice(74, 138)}`);
    if (amount !== BigInt(total.amount))
      return fail('payment amount differs from the quote', total);
    return {
      ok: true,
      total,
      tx: {
        orderRef,
        chain,
        chainId: spec.chainId,
        serializedTransaction: serialized as Hex,
        token: spec.usdc,
        amount,
      },
    };
  }

  async reconcile(input: {
    orderRef: string | null;
    since: number;
  }): Promise<ReconcileOutcome> {
    if (!this.sandboxReady())
      return { status: 'UNKNOWN', reason: 'route not configured' };
    const view = (o: Json): ReconcileOutcome => ({
      status: 'FOUND',
      orderRef: str(o.orderId) ?? input.orderRef ?? 'unknown',
      paymentStatus: str(obj(o.payment).status) ?? 'unknown',
      deliveryStatus:
        str(obj(obj(arr(o.lineItems)[0]).delivery).status) ?? null,
    });
    try {
      if (input.orderRef) {
        const o = await this.request(
          'GET',
          `/orders/${encodeURIComponent(input.orderRef)}`,
        );
        return view(obj(o.order ?? o));
      }
      const list = await this.request('GET', '/orders?limit=50&sort=desc');
      const payer = this.payer!.address.toLowerCase();
      const match = arr(list.data).find((o) => {
        const p = obj(o.payment);
        const who = (
          str(obj(p.preparation).payerAddress) ??
          str(p.payerAddress) ??
          ''
        ).toLowerCase();
        if (who !== '' && who !== payer) return false;
        const created = Date.parse(str(o.createdAt) ?? '');
        // Without a timestamp, a payer match is treated as ours (conservative).
        return Number.isNaN(created) || created / 1000 >= input.since - 60;
      });
      return match ? view(match) : { status: 'NOT_FOUND' };
    } catch (e) {
      return {
        status: 'UNKNOWN',
        reason: this.redact((e as Error).message).slice(0, 200),
      };
    }
  }
}
