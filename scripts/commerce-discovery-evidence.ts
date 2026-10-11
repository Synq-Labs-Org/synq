import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
  type OfferProvider,
} from '@synq/offer-exchange';
import {
  EbayBrowseDiscovery,
  SerpApiDiscovery,
  commerceCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';

const env = process.env;
const now = () => Math.floor(Date.now() / 1000);
const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: () => res.text() };
};

async function main() {
  const dir = join(process.cwd(), 'bounty-evidence', 'commerce');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `commerce-discovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const graph = new ProviderCapabilityGraph(commerceCapabilities(env));
  const providers: OfferProvider[] = [];
  if (env.SERPAPI_KEY) {
    providers.push(
      new SerpApiDiscovery('serpapi-amazon', env.SERPAPI_KEY, realFetch, now, {
        evidence: 'MAINNET_READ_ONLY',
      }),
    );
    providers.push(
      new SerpApiDiscovery(
        'serpapi-google-shopping',
        env.SERPAPI_KEY,
        realFetch,
        now,
        { evidence: 'MAINNET_READ_ONLY' },
      ),
    );
  }
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    const production = env.EBAY_ENV === 'production';
    providers.push(
      new EbayBrowseDiscovery(
        {
          clientId: env.EBAY_CLIENT_ID,
          clientSecret: env.EBAY_CLIENT_SECRET,
          environment: production ? 'production' : 'sandbox',
        },
        realFetch,
        now,
        { evidence: production ? 'MAINNET_READ_ONLY' : 'PROVIDER_SANDBOX' },
      ),
    );
  }
  if (!providers.length) {
    writeFileSync(
      file,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          label: 'BLOCKED_EXTERNAL',
          reason: 'SERPAPI_KEY and EBAY_CLIENT_ID/EBAY_CLIENT_SECRET absent',
          capabilities: graph.health(now()),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`BLOCKED_EXTERNAL -> ${file}`);
    return;
  }
  const intent = EconomicIntentSchema.parse({
    id: `commerce-${now()}`,
    groupId: 'evidence-group',
    domain: 'COMMERCE',
    objective: env.SYNQ_COMMERCE_QUERY ?? 'Apple AirPods Pro 2 USB-C',
    subject: {
      kind: 'PRODUCT',
      title: env.SYNQ_COMMERCE_QUERY ?? 'Apple AirPods Pro 2 USB-C',
      ...(env.SYNQ_COMMERCE_GTIN ? { gtin: env.SYNQ_COMMERCE_GTIN } : {}),
      brand: 'Apple',
      condition: 'NEW',
    },
    hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
    preferences: [],
    budget: { max: { amount: '40000', currency: 'USD', decimals: 2 } },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
  const search = await searchOffers({
    intent,
    providers,
    graph,
    now,
    timeoutMs: 30_000,
  });
  const sel = selectOffers({ intent, search, now: now() });
  const report = {
    generatedAt: new Date().toISOString(),
    label:
      'MAINNET_READ_ONLY discovery (production read-only APIs); no checkout',
    coverage: search.coverage,
    outcomes: search.outcomes,
    ranked: sel.ranked
      .slice(0, 5)
      .map((r) => ({ offerId: r.offer.offerId, explanation: r.explanation })),
    recommendations: sel.recommendations.slice(0, 5).map((r) => ({
      offerId: r.offer.offerId,
      level: r.match.level,
      reasons: r.match.reasons,
    })),
    rejected: sel.rejected.length,
  };
  const text = JSON.stringify(report, null, 2);
  for (const secret of [env.SERPAPI_KEY, env.EBAY_CLIENT_SECRET])
    if (secret && text.includes(secret)) throw new Error('secret leaked');
  writeFileSync(file, text + '\n');
  console.log(`${search.coverage.label} -> ${file}`);
}

await main();
