import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  revalidateOffer,
  searchOffers,
  selectOffers,
  type EconomicIntent,
} from '@synq/offer-exchange';
import {
  SearchApiDiscovery,
  SerpApiDiscovery,
  commerceCapabilities,
  type HttpFetch,
  type Json,
  type SearchResponseCache,
} from '@synq/plugin-commerce';

const T = 1_780_000_000;
const now = () => T;
const KEY = 'searchapi-secret-key-0123456789';
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function fetcher(status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f: HttpFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const u = new URL(url);
    const engine = u.searchParams.get('engine');
    const body =
      status !== 200
        ? `{"error":"Invalid API key ${KEY}"}`
        : engine === 'amazon_search'
          ? fixture('searchapi-amazon-search.json')
          : engine === 'amazon_product'
            ? fixture('searchapi-amazon-product.json')
            : fixture('searchapi-google-shopping.json');
    return { status, text: async () => body };
  };
  return { f, calls };
}

const intent: EconomicIntent = EconomicIntentSchema.parse({
  id: 'cable-1',
  groupId: 'group-1',
  domain: 'COMMERCE',
  objective: 'buy a USB-C cable',
  subject: {
    kind: 'PRODUCT',
    title: 'Amazon Basics USB-C to USB-C cable',
    brand: 'Amazon Basics',
    condition: 'NEW',
  },
  hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
  preferences: [],
  budget: { max: { amount: '1000', currency: 'USD', decimals: 2 } },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  maxPriceDriftBps: 100,
  validUntil: T + 3_600,
});
const env = { SEARCHAPI_KEY: KEY };

describe('SearchApi.io discovery (recorded live responses)', () => {
  it('amazon_search yields Crossmint-fulfilled ASIN offers; the key never enters a URL', async () => {
    const { f, calls } = fetcher();
    const amazon = new SearchApiDiscovery('searchapi-amazon', KEY, f, now, {
      evidence: 'MOCKED',
      priceMax: 9,
    });
    const offers = await amazon.search(intent, AbortSignal.timeout(1_000));
    expect(offers.length).toBeGreaterThan(5);
    const first = offers[0]!;
    expect(first.providerRef).toBe('amazon:B01GGKZ1VA');
    expect(first.fulfillmentProviderId).toBe('crossmint');
    expect(first.executable).toBe(false);
    expect(first.price.base).toEqual({
      amount: '629',
      currency: 'USD',
      decimals: 2,
    });
    expect(first.subject).toMatchObject({ asin: 'B01GGKZ1VA' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.url).toContain('engine=amazon_search');
    expect(calls[0]!.url).toContain('price_max=9');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('google_shopping offers are discovery-only and pre-owned listings are USED', async () => {
    const { f } = fetcher();
    const g = new SearchApiDiscovery('searchapi-google-shopping', KEY, f, now, {
      evidence: 'MOCKED',
    });
    const offers = await g.search(intent, AbortSignal.timeout(1_000));
    expect(offers.length).toBeGreaterThan(3);
    expect(new Set(offers.map((o) => o.offerId)).size).toBe(offers.length);
    expect(offers.every((o) => o.execution.mode === 'DISCOVERY_ONLY')).toBe(
      true,
    );
    expect(offers[0]!.subject).toMatchObject({
      condition: 'USED',
      seller: 'eBay - link8249',
    });
  });

  it('a cache serves repeated identical requests without spending credits', async () => {
    const { f, calls } = fetcher();
    const store = new Map<string, Json>();
    const cache: SearchResponseCache = {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    };
    const amazon = new SearchApiDiscovery('searchapi-amazon', KEY, f, now, {
      evidence: 'MOCKED',
      cache,
    });
    await amazon.search(intent, AbortSignal.timeout(1_000));
    await amazon.search(intent, AbortSignal.timeout(1_000));
    expect(calls).toHaveLength(1);
    expect([...store.keys()].join()).not.toContain(KEY);
  });

  it('revalidation reads the live ASIN buy box and makes the offer executable', async () => {
    // The group picked this exact listing: the purchase intent names the ASIN.
    const exact = EconomicIntentSchema.parse({
      ...intent,
      subject: { ...intent.subject, asin: 'B01GGKZ1VA' },
    });
    const { f } = fetcher();
    const graph = new ProviderCapabilityGraph(commerceCapabilities(env));
    const amazon = new SearchApiDiscovery('searchapi-amazon', KEY, f, now, {
      evidence: 'MOCKED',
    });
    const search = await searchOffers({
      intent: exact,
      providers: [amazon],
      graph,
      now,
    });
    const sel = selectOffers({ intent: exact, search, now: T });
    expect(sel.ranked.map((c) => c.offer.providerRef)).toEqual([
      'amazon:B01GGKZ1VA',
    ]);
    expect(sel.ranked[0]!.match.basis).toBe('ASIN');
    const candidate = sel.ranked[0]!;
    const r = await revalidateOffer({
      intent: exact,
      candidate,
      provider: amazon,
      graph,
      approvedMax: { amount: '1000', currency: 'USD', decimals: 2 },
      now,
    });
    expect(r).toMatchObject({
      status: 'EXECUTABLE',
      landed: { amount: '629' },
      offer: { executable: true, price: { revalidatedAt: T } },
    });
  });

  it('a provider error never leaks the key; SerpAPI keeps working beside it', async () => {
    const { f } = fetcher(401);
    const graph = new ProviderCapabilityGraph(commerceCapabilities(env));
    const amazon = new SearchApiDiscovery('searchapi-amazon', KEY, f, now, {
      evidence: 'MOCKED',
    });
    const serp = new SerpApiDiscovery(
      'serpapi-amazon',
      'serp',
      async () => ({
        status: 200,
        text: async () => fixture('serpapi-amazon.json'),
      }),
      now,
      { evidence: 'MOCKED' },
    );
    const r = await searchOffers({
      intent,
      providers: [amazon, serp],
      graph: new ProviderCapabilityGraph(
        commerceCapabilities({ ...env, SERPAPI_KEY: 'serp' }),
      ),
      now,
    });
    expect(
      r.outcomes.find((o) => o.providerId === 'searchapi-amazon')?.status,
    ).toBe('FAILED');
    expect(
      r.offers.some((o) => o.discoveryProviderId === 'serpapi-amazon'),
    ).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(graph.health(T))).not.toContain(KEY);
  });

  it('missing SEARCHAPI_KEY is explicit', () => {
    expect(
      commerceCapabilities({}).find((c) => c.providerId === 'searchapi-amazon')
        ?.status,
    ).toBe('MISSING_CREDENTIALS');
  });
});
