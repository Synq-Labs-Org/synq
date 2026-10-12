import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  money,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type Money,
  type ProviderBookingOutcome,
  type ProviderBookingPort,
} from '@synq/offer-exchange';
import { arr, obj, str, type HttpFetch, type Json } from './http.js';

export const LITHIC = 'lithic-sandbox';
export const LITHIC_SANDBOX_HOST = 'sandbox.lithic.com';
export const LITHIC_SANDBOX_BASE = `https://${LITHIC_SANDBOX_HOST}/v1`;
export const LITHIC_SOURCES = [
  'https://docs.lithic.com/docs/enviornments',
  'https://docs.lithic.com/reference/postcards',
  'https://docs.lithic.com/docs/simulating-transactions',
  'https://docs.lithic.com/docs/events-api#verifying-webhooks',
];

/** Lithic is accepted only against the sandbox: a production base URL is a construction error. */
export class LithicEnvironmentError extends Error {
  constructor(detail: string) {
    super(`LITHIC_NOT_SANDBOX: ${detail}`);
    this.name = 'LithicEnvironmentError';
  }
}

export type LithicConfig = {
  apiKey: string;
  environment: string | undefined;
  baseUrl?: string;
};

export function assertLithicSandbox(c: LithicConfig): string {
  if (c.environment !== 'sandbox')
    throw new LithicEnvironmentError('LITHIC_ENV must be sandbox');
  if (!c.apiKey || /\s/.test(c.apiKey))
    throw new LithicEnvironmentError('API key missing or malformed');
  let url: URL;
  try {
    url = new URL(c.baseUrl ?? LITHIC_SANDBOX_BASE);
  } catch {
    throw new LithicEnvironmentError('base URL invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== LITHIC_SANDBOX_HOST ||
    url.pathname.replace(/\/+$/, '') !== '/v1'
  )
    throw new LithicEnvironmentError('base URL is not the Lithic sandbox');
  return LITHIC_SANDBOX_BASE;
}

export class LithicError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`LITHIC_HTTP_${status}: ${message}`.slice(0, 300));
    this.name = 'LithicError';
  }
}

const PANISH = /\b\d{12,19}\b/g;
/** Strips anything shaped like a PAN or CVV value from text bound for logs or errors. */
export function redactCardData(text: string, apiKey?: string): string {
  let t = apiKey ? text.split(apiKey).join('[REDACTED]') : text;
  t = t.replace(PANISH, '[PAN]');
  return t.replace(
    /("?(cvv|pan|pin)"?\s*[:=]\s*"?)[^",}\s]+/gi,
    '$1[REDACTED]',
  );
}

/**
 * Opaque handle to a card's PAN. The number is held in a private field and
 * never serializes: JSON, string conversion and inspection all yield a
 * redacted value. Only the sandbox client reads it, to simulate network events.
 */
export class CardSecret {
  readonly #pan: string;
  constructor(
    pan: string,
    readonly lastFour: string,
  ) {
    if (!/^\d{12,19}$/.test(pan)) throw new Error('CARD_SECRET_INVALID');
    this.#pan = pan;
  }
  /** @internal */
  reveal(caller: LithicSandboxClient): string {
    if (!(caller instanceof LithicSandboxClient))
      throw new Error('CARD_SECRET_ACCESS_DENIED');
    return this.#pan;
  }
  toJSON() {
    return `[CARD ****${this.lastFour}]`;
  }
  toString() {
    return `[CARD ****${this.lastFour}]`;
  }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `[CARD ****${this.lastFour}]`;
  }
}

export type LithicCard = {
  token: string;
  lastFour: string;
  state: string;
  type: string;
  memo: string;
  spendLimit: number;
  spendLimitDuration: string;
};
export type LithicTransaction = {
  token: string;
  cardToken: string;
  status: string;
  result: string;
  /** Authorization/settled amount in cents (absolute value). */
  amountCents: number;
  descriptor: string | null;
  created: string | null;
};
export type SimulatedAuthorization = {
  approved: boolean;
  transactionToken: string | null;
  message: string | null;
  debuggingRequestId: string | null;
};

function toCard(j: Json): { card: LithicCard; secret: CardSecret | null } {
  const token = str(j.token);
  if (!token) throw new LithicError(0, 'card response without token');
  const lastFour = str(j.last_four) ?? '????';
  const pan = str(j.pan);
  return {
    card: {
      token,
      lastFour,
      state: str(j.state) ?? 'UNKNOWN',
      type: str(j.type) ?? 'UNKNOWN',
      memo: str(j.memo) ?? '',
      spendLimit: typeof j.spend_limit === 'number' ? j.spend_limit : 0,
      spendLimitDuration: str(j.spend_limit_duration) ?? 'UNKNOWN',
    },
    secret: pan ? new CardSecret(pan, lastFour) : null,
  };
}

function toTransaction(j: Json): LithicTransaction {
  const amounts = obj(j.amounts);
  const pick = [
    j.amount,
    obj(amounts.hold).amount,
    obj(amounts.cardholder).amount,
    j.authorization_amount,
  ].find((v) => typeof v === 'number' && v !== 0);
  return {
    token: str(j.token) ?? '',
    cardToken: str(j.card_token) ?? '',
    status: str(j.status) ?? 'UNKNOWN',
    result: str(j.result) ?? 'UNKNOWN',
    amountCents: Math.abs(typeof pick === 'number' ? pick : 0),
    descriptor: str(obj(j.merchant).descriptor) ?? null,
    created: str(j.created) ?? null,
  };
}

/**
 * Lithic sandbox issuing client: cards, simulated network events and
 * transaction reads. PAN and CVV never leave CardSecret; errors are redacted.
 */
export class LithicSandboxClient {
  private readonly base: string;
  constructor(
    private readonly config: LithicConfig,
    private readonly fetchImpl: HttpFetch,
    private readonly options: {
      timeoutMs?: number;
      rateLimitRetries?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.base = assertLithicSandbox(config);
  }

  /** 429 means the request was not processed, so it is safe to retry with backoff. */
  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; json: Json }> {
    const retries = this.options.rateLimitRetries ?? 5;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; ; i++) {
      const out = await this.once(method, path, body, idempotencyKey);
      if (out.status !== 429 || i >= retries) return out;
      await sleep(Math.min(2_000 * 2 ** i, 30_000));
    }
  }

  private async once(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; json: Json }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: this.config.apiKey,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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
    return { status: res.status, json };
  }

  private fail(status: number, json: Json): never {
    throw new LithicError(
      status,
      redactCardData(
        str(json.message) ?? str(json.error) ?? 'error',
        this.config.apiKey,
      ),
    );
  }

  private async ok(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Json> {
    const { status, json } = await this.call(
      method,
      path,
      body,
      idempotencyKey,
    );
    if (status < 200 || status >= 300) this.fail(status, json);
    return json;
  }

  async createCard(input: {
    spendLimitCents: number;
    duration: 'TRANSACTION' | 'MONTHLY' | 'ANNUALLY' | 'FOREVER';
    memo: string;
    idempotencyKey: string;
  }): Promise<{ card: LithicCard; secret: CardSecret | null }> {
    if (!Number.isInteger(input.spendLimitCents) || input.spendLimitCents <= 0)
      throw new LithicError(0, 'spend limit must be positive cents');
    return toCard(
      await this.ok(
        'POST',
        '/cards',
        {
          type: 'VIRTUAL',
          memo: input.memo.slice(0, 120),
          spend_limit: input.spendLimitCents,
          spend_limit_duration: input.duration,
          state: 'OPEN',
        },
        input.idempotencyKey,
      ),
    );
  }

  async getCard(token: string) {
    return toCard(await this.ok('GET', `/cards/${encodeURIComponent(token)}`));
  }

  async findCardByMemo(memo: string): Promise<LithicCard | null> {
    const j = await this.ok(
      'GET',
      `/cards?memo=${encodeURIComponent(memo)}&page_size=10`,
    );
    const hit = arr(j.data).find((c) => str(c.memo) === memo);
    return hit ? toCard(hit).card : null;
  }

  async setCardState(token: string, state: 'OPEN' | 'PAUSED' | 'CLOSED') {
    return toCard(
      await this.ok('PATCH', `/cards/${encodeURIComponent(token)}`, { state }),
    ).card;
  }

  /**
   * Simulated merchant authorization. Declines are reported, not thrown: the
   * sandbox answers 2xx (or 422) for a decline, so approval is read from the
   * resulting transaction's result.
   */
  async simulateAuthorization(
    secret: CardSecret,
    input: { amountCents: number; descriptor: string },
  ): Promise<SimulatedAuthorization> {
    const { status, json } = await this.call('POST', '/simulate/authorize', {
      amount: input.amountCents,
      descriptor: input.descriptor.slice(0, 60),
      pan: secret.reveal(this),
    });
    if (status === 201 || status === 200) {
      // The sandbox answers 2xx for declines too; the transaction is the truth.
      const token = str(json.token) ?? null;
      const tx = token ? await this.awaitTransaction(token) : null;
      const approved =
        !!tx && tx.result === 'APPROVED' && tx.status !== 'DECLINED';
      return {
        approved,
        transactionToken: token,
        message: approved ? null : (tx?.result ?? 'no transaction token'),
        debuggingRequestId: str(json.debugging_request_id) ?? null,
      };
    }
    if (status === 422)
      return {
        approved: false,
        transactionToken: str(json.token) ?? null,
        message: redactCardData(str(json.message) ?? 'declined'),
        debuggingRequestId: str(json.debugging_request_id) ?? null,
      };
    this.fail(status, json);
  }

  /** Omitting the amount voids/clears the full authorization (an explicit 0 moves nothing, observed in sandbox). */
  async simulateVoid(transactionToken: string, amountCents?: number) {
    await this.ok('POST', '/simulate/void', {
      token: transactionToken,
      ...(amountCents !== undefined ? { amount: amountCents } : {}),
    });
  }
  async simulateClearing(transactionToken: string, amountCents?: number) {
    await this.ok('POST', '/simulate/clearing', {
      token: transactionToken,
      ...(amountCents !== undefined ? { amount: amountCents } : {}),
    });
  }
  async simulateReturn(
    secret: CardSecret,
    input: { amountCents: number; descriptor: string },
  ): Promise<string | null> {
    const j = await this.ok('POST', '/simulate/return', {
      amount: input.amountCents,
      descriptor: input.descriptor.slice(0, 60),
      pan: secret.reveal(this),
    });
    return str(j.token) ?? null;
  }

  /**
   * A just-simulated transaction can take a moment to become readable; poll
   * briefly. If it never appears the outcome is unknown and the error stands.
   */
  private async awaitTransaction(token: string): Promise<LithicTransaction> {
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; ; i++) {
      try {
        return await this.getTransaction(token);
      } catch (e) {
        if (!(e instanceof LithicError) || e.status !== 404 || i >= 6) throw e;
        await sleep(500 * (i + 1));
      }
    }
  }

  async getTransaction(token: string): Promise<LithicTransaction> {
    return toTransaction(
      await this.ok('GET', `/transactions/${encodeURIComponent(token)}`),
    );
  }
  async listTransactions(cardToken: string): Promise<LithicTransaction[]> {
    const j = await this.ok(
      'GET',
      `/transactions?card_token=${encodeURIComponent(cardToken)}&page_size=50`,
    );
    return arr(j.data).map(toTransaction);
  }
}

// ---- Webhooks ---------------------------------------------------------------

export class LithicWebhookError extends Error {
  constructor(detail: string) {
    super(`LITHIC_WEBHOOK_INVALID: ${detail}`);
    this.name = 'LithicWebhookError';
  }
}

/**
 * Verifies a Lithic event webhook (docs: Verifying Webhooks): HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${rawBody}` keyed with the base64 part
 * of the `whsec_` secret, compared in constant time against every `v1,`
 * signature, with a timestamp tolerance against replay.
 */
export function verifyLithicWebhook(input: {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  secret: string;
  now: number;
  toleranceSeconds?: number;
}): { id: string; timestamp: number; event: Json } {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers))
    if (typeof v === 'string') h[k.toLowerCase()] = v;
  const id = h['webhook-id'];
  const ts = h['webhook-timestamp'];
  const sigs = h['webhook-signature'];
  if (!id || !ts || !sigs) throw new LithicWebhookError('missing headers');
  if (!/^\d{1,12}$/.test(ts)) throw new LithicWebhookError('bad timestamp');
  const timestamp = Number(ts);
  const tol = input.toleranceSeconds ?? 300;
  if (Math.abs(input.now - timestamp) > tol)
    throw new LithicWebhookError('timestamp outside tolerance');
  const secret = input.secret.startsWith('whsec_')
    ? input.secret.slice(6)
    : input.secret;
  const key = Buffer.from(secret, 'base64');
  if (key.length < 16) throw new LithicWebhookError('secret too short');
  const expected = createHmac('sha256', key)
    .update(`${id}.${ts}.${input.rawBody}`)
    .digest();
  const match = sigs.split(' ').some((versioned) => {
    const [version, b64] = versioned.split(',');
    if (version !== 'v1' || !b64) return false;
    const got = Buffer.from(b64, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!match) throw new LithicWebhookError('signature mismatch');
  let event: Json;
  try {
    event = obj(JSON.parse(input.rawBody));
  } catch {
    throw new LithicWebhookError('body is not JSON');
  }
  return { id, timestamp, event };
}

/** Deduplicates webhook deliveries by `webhook-id` (stable across resends). */
export interface WebhookDeduper {
  /** True the first time an id is seen; false for every redelivery. */
  firstSeen(id: string): Promise<boolean>;
}
export class MemoryWebhookDeduper implements WebhookDeduper {
  private readonly seen = new Set<string>();
  async firstSeen(id: string) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

// ---- Booking port -----------------------------------------------------------

const cents = (m: Money): number => {
  if (m.currency !== 'USD' || m.decimals !== 2)
    throw new LithicError(0, 'card authorizations are USD cents only');
  const n = Number(m.amount);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new LithicError(0, 'amount out of range');
  return n;
};
/** Lithic's Idempotency-Key header is a UUID: derive one deterministically. */
export function lithicIdempotencyKey(key: string): string {
  const h = createHash('sha256').update(`lithic:${key}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const memoFor = (idempotencyKey: string) => `synq:${idempotencyKey}`;
export const lithicMerchantRef = (descriptor: string) =>
  `lithic-merchant:${descriptor}`;
const descriptorOf = (offer: EconomicOffer) => {
  const m = /^lithic-merchant:([A-Za-z0-9 .*'&-]{3,40})$/.exec(
    offer.providerRef,
  );
  return m ? m[1]! : null;
};
const landed = (offer: EconomicOffer) => {
  const p = offer.price;
  const t =
    BigInt(p.base.amount) +
    BigInt(p.shipping.amount) +
    BigInt(p.tax.amount) +
    BigInt(p.fees.amount);
  return money(t, p.base.currency, p.base.decimals);
};

/**
 * Card-network sandbox execution: issues a virtual card whose spend limit is
 * the granted amount and simulates the merchant authorization against it.
 * Nothing is paid: Lithic sandbox is not connected to card networks.
 */
export class LithicSandboxCardPort implements ProviderBookingPort {
  readonly providerId = LITHIC;
  readonly host = LITHIC_SANDBOX_HOST;
  readonly settlement = {
    category: 'CARD_NETWORK_SANDBOX',
    mode: 'PROVIDER_SANDBOX',
    economicEffect: 'NONE_SANDBOX' as const,
    providerName: 'Lithic',
  };
  constructor(private readonly client: LithicSandboxClient) {}

  async book(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome> {
    const descriptor = descriptorOf(input.offer);
    if (!descriptor)
      return { status: 'FAILED', reason: 'offer is not a Lithic merchant' };
    let amount: number;
    let total: Money;
    try {
      total = landed(input.offer);
      amount = cents(total);
    } catch (e) {
      return { status: 'FAILED', reason: (e as Error).message };
    }
    let issued: Awaited<ReturnType<LithicSandboxClient['createCard']>>;
    try {
      issued = await this.client.createCard({
        spendLimitCents: amount,
        duration: 'FOREVER',
        memo: memoFor(input.idempotencyKey),
        idempotencyKey: lithicIdempotencyKey(input.idempotencyKey),
      });
    } catch (e) {
      const status = e instanceof LithicError ? e.status : 0;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429)
        return { status: 'FAILED', reason: (e as Error).message };
      return {
        status: 'UNKNOWN',
        reason: `card create outcome unknown: ${(e as Error).message}`,
      };
    }
    if (issued.card.spendLimit !== amount)
      return {
        status: 'UNKNOWN',
        reason: 'issued card spend limit differs from the grant',
      };
    const secret =
      issued.secret ?? (await this.client.getCard(issued.card.token)).secret;
    if (!secret)
      return { status: 'UNKNOWN', reason: 'card issued without PAN access' };
    let auth: SimulatedAuthorization;
    try {
      auth = await this.client.simulateAuthorization(secret, {
        amountCents: amount,
        descriptor,
      });
    } catch (e) {
      return {
        status: 'UNKNOWN',
        reason: `authorization outcome unknown: ${(e as Error).message}`,
      };
    }
    if (!auth.approved || !auth.transactionToken) {
      await this.client
        .setCardState(issued.card.token, 'CLOSED')
        .catch(() => undefined);
      return {
        status: 'FAILED',
        reason: `authorization declined: ${auth.message ?? 'no token'}`,
      };
    }
    return {
      status: 'CONFIRMED',
      providerRef: auth.transactionToken,
      reference: issued.card.token,
      charged: total,
    };
  }

  async find(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome | null> {
    const card = await this.client.findCardByMemo(
      memoFor(input.idempotencyKey),
    );
    if (!card) return null;
    const txs = await this.client.listTransactions(card.token);
    const amount = cents(landed(input.offer));
    const approved = txs.find(
      (t) =>
        ['PENDING', 'SETTLED'].includes(t.status) &&
        t.result === 'APPROVED' &&
        t.amountCents === amount,
    );
    if (approved)
      return {
        status: 'CONFIRMED',
        providerRef: approved.token,
        reference: card.token,
        charged: landed(input.offer),
      };
    if (txs.length && txs.every((t) => t.status === 'DECLINED'))
      return { status: 'FAILED', reason: 'authorization declined' };
    return {
      status: 'UNKNOWN',
      reason: `card ${card.state} with no approved authorization of the granted amount`,
    };
  }

  /** Voids the pending authorization and closes the card. Sandbox: no refund value. */
  async cancel(input: { offer: EconomicOffer; providerRef: string }) {
    try {
      const tx = await this.client.getTransaction(input.providerRef);
      if (tx.status === 'PENDING')
        await this.client.simulateVoid(input.providerRef);
      if (tx.cardToken) await this.client.setCardState(tx.cardToken, 'CLOSED');
      return {
        confirmed: true,
        refund: null,
        reason: 'sandbox authorization voided and card closed; no value moved',
      };
    } catch (e) {
      return {
        confirmed: false,
        refund: null,
        reason: (e as Error).message.slice(0, 200),
      };
    }
  }
}

/**
 * The merchant side of the card scenario is simulated: a fixed quote from a
 * named test merchant. Offers are labelled SIMULATED on the merchant side;
 * only the card issuing and authorization run against the Lithic sandbox.
 */
export class SimulatedCardMerchant {
  readonly providerId = LITHIC;
  constructor(
    private readonly merchant: {
      descriptor: string;
      title: string;
      priceCents: number;
    },
    private readonly now: () => number,
  ) {}
  offer(intent: EconomicIntent): EconomicOfferInput {
    const t = this.now();
    const usd = (n: number) => ({
      amount: String(n),
      currency: 'USD',
      decimals: 2,
    });
    return {
      offerId: `lithic-${intent.id}`,
      intentId: intent.id,
      domain: 'COMMERCE',
      discoveryProviderId: LITHIC,
      fulfillmentProviderId: LITHIC,
      providerRef: lithicMerchantRef(this.merchant.descriptor),
      subject: {
        kind: 'PRODUCT',
        title: this.merchant.title,
        brand: this.merchant.descriptor,
        model: 'merchant-payment',
        quantity: 1,
        seller: this.merchant.descriptor,
      },
      price: {
        quoteId: `sim-${this.merchant.descriptor}-${this.merchant.priceCents}`,
        base: usd(this.merchant.priceCents),
        shipping: usd(0),
        tax: usd(0),
        fees: usd(0),
        fx: [],
        quotedAt: t,
        expiresAt: t + 900,
        revalidatedAt: t,
      },
      cancellation: {
        kind: 'FREE_UNTIL',
        refundable: true,
        freeUntil: t + 900,
        penalty: null,
        changeable: false,
      },
      settlement: {
        accepts: [{ rail: 'SCOPED_CARD', currency: 'USD' }],
        payee: this.merchant.descriptor,
      },
      execution: {
        mode: 'SCOPED_CARD',
        requiresQuote: true,
        requiresKyc: false,
        requiresStepUp: false,
        piiFields: [],
      },
      environment: 'SANDBOX',
      evidence: 'SIMULATED',
      retrievedAt: t,
      executable: true,
    };
  }
  async search(intent: EconomicIntent) {
    return [this.offer(intent)];
  }
  async revalidate(offer: EconomicOffer) {
    const fresh = this.offer({ id: offer.intentId } as EconomicIntent);
    return {
      price: fresh.price as EconomicOffer['price'],
      subject: offer.subject,
      available: true,
      providerRef: offer.providerRef,
    };
  }
}
