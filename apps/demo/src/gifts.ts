import { createHash } from 'node:crypto';
import { LithicSandboxClient, type HttpFetch } from '@synq/plugin-commerce';
import type { FulfilResult, TripOption, TripPorts } from './fund-trips.js';

/**
 * Gift picks for a fund. Search is live (SearchApi.io Google Shopping, read
 * only). The purchase runs after the group's approved payment lands: a Lithic
 * SANDBOX virtual card is issued with a spend limit of exactly the paid total and
 * a simulated merchant authorization runs against it. No real order is placed
 * and no real card is charged.
 */
const SEARCHAPI = 'https://www.searchapi.io/api/v1/search';

const fetchJson: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

type Row = {
  title?: unknown;
  extracted_price?: unknown;
  source?: unknown;
  seller?: unknown;
  product_link?: unknown;
  link?: unknown;
};

const text = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

export function giftPorts(input: {
  searchApiKey: string;
  lithicApiKey: string;
}): NonNullable<TripPorts['gifts']> {
  const lithic = new LithicSandboxClient(
    { apiKey: input.lithicApiKey, environment: 'sandbox' },
    fetchJson,
  );

  async function search(q: {
    query: string;
    maxPrice: string;
  }): Promise<TripOption[]> {
    const params = new URLSearchParams({
      engine: 'google_shopping',
      q: q.query,
      gl: 'us',
      hl: 'en',
    });
    const res = await fetch(`${SEARCHAPI}?${params}`, {
      headers: { Authorization: `Bearer ${input.searchApiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`gift search failed (${res.status})`);
    const body = (await res.json()) as { shopping_results?: Row[] };
    const max = Number(q.maxPrice);
    const seen = new Set<string>();
    const options: TripOption[] = [];
    for (const r of body.shopping_results ?? []) {
      const title = text(r.title, 120);
      const price =
        typeof r.extracted_price === 'number' ? r.extracted_price : NaN;
      if (!title || !(price > 0) || price > max || seen.has(title)) continue;
      seen.add(title);
      const merchant = text(r.source ?? r.seller, 60) || 'Online store';
      const link = text(r.product_link ?? r.link, 500);
      options.push({
        optionId: createHash('sha256')
          .update(`${title}|${merchant}|${price}`)
          .digest('hex')
          .slice(0, 12),
        title,
        detail: merchant,
        total: price.toFixed(2),
        currency: 'USD',
        refundable: false,
        offer: { merchant, link: /^https:\/\//.test(link) ? link : null },
      });
      if (options.length === 3) break;
    }
    return options;
  }

  async function buy(b: {
    option: TripOption;
    maxTotal: string;
    idempotencyKey: string;
  }): Promise<FulfilResult> {
    const cents = Math.round(Number(b.option.total) * 100);
    if (!(cents > 0) || cents > Math.round(Number(b.maxTotal) * 100))
      return {
        status: 'FAILED',
        reason: 'The price is above what the group paid.',
      };
    const memo = `synq-gift-${b.idempotencyKey}`.slice(0, 120);
    const issued = await lithic.createCard({
      spendLimitCents: cents,
      duration: 'TRANSACTION',
      memo,
      idempotencyKey: createHash('sha256')
        .update(memo)
        .digest('hex')
        .slice(0, 32),
    });
    const secret =
      issued.secret ?? (await lithic.getCard(issued.card.token)).secret;
    if (!secret)
      return { status: 'FAILED', reason: 'The sandbox card has no number.' };
    const merchant =
      (b.option.offer as { merchant?: string } | null)?.merchant ??
      'Online store';
    const auth = await lithic.simulateAuthorization(secret, {
      amountCents: cents,
      descriptor: merchant,
    });
    if (!auth.approved || !auth.transactionToken) {
      await lithic
        .setCardState(issued.card.token, 'CLOSED')
        .catch(() => undefined);
      return {
        status: 'FAILED',
        reason: `The sandbox card was declined (${auth.message ?? 'no reason'}).`,
      };
    }
    await lithic.simulateClearing(auth.transactionToken).catch(() => undefined);
    await lithic
      .setCardState(issued.card.token, 'CLOSED')
      .catch(() => undefined);
    return {
      status: 'BOOKED',
      reference: `card ••${issued.card.lastFour ?? ''}`.trim(),
      bookingId: auth.transactionToken,
    };
  }

  return { search, buy };
}
