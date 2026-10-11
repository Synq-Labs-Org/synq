import type { ProviderCapabilityGraph } from './capability.js';
import {
  EconomicOfferSchema,
  type EconomicIntent,
  type EconomicOffer,
  type EconomicOfferInput,
  type PriceQuote,
  type Subject,
} from './schemas.js';

export type RevalidatedQuote = {
  price: PriceQuote;
  subject: Subject;
  available: boolean;
  providerRef: string;
};

export interface OfferProvider {
  readonly providerId: string;
  search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<EconomicOfferInput[]>;
  revalidate?(
    offer: EconomicOffer,
    signal: AbortSignal,
  ): Promise<RevalidatedQuote>;
}

export type ProviderOutcome =
  | { providerId: string; status: 'OK'; offers: number; latencyMs: number }
  | {
      providerId: string;
      status: 'FAILED' | 'TIMEOUT' | 'SKIPPED';
      reason: string;
    };

export type SearchResult = {
  offers: EconomicOffer[];
  invalid: { providerId: string; reason: string }[];
  outcomes: ProviderOutcome[];
  coverage: { healthy: number; total: number; label: string };
};

export class ProviderTimeoutError extends Error {
  constructor(providerId: string, ms: number) {
    super(`PROVIDER_TIMEOUT: ${providerId} after ${ms}ms`);
    this.name = 'ProviderTimeoutError';
  }
}

export async function withDeadline<T>(
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parallel, failure-tolerant discovery (Bible §81): one provider outage never
 * cancels valid offers from the others; every outcome is reported to the graph.
 */
export async function searchOffers(input: {
  intent: EconomicIntent;
  providers: readonly OfferProvider[];
  graph: ProviderCapabilityGraph;
  now: () => number;
  timeoutMs?: number;
  clockMs?: () => number;
}): Promise<SearchResult> {
  const { intent, graph } = input;
  const timeoutMs = input.timeoutMs ?? 8_000;
  const clockMs = input.clockMs ?? (() => Date.now());
  const outcomes: ProviderOutcome[] = [];
  const eligible = input.providers.filter((p) => {
    const cap = graph.capability(p.providerId);
    const ok =
      cap !== null &&
      cap.domains.includes(intent.domain) &&
      graph.usable(p.providerId, 'DISCOVER', input.now());
    if (!ok)
      outcomes.push({
        providerId: p.providerId,
        status: 'SKIPPED',
        reason: cap
          ? `${cap.status}${cap.statusReason ? `: ${cap.statusReason}` : ''}`
          : 'unknown provider',
      });
    return ok;
  });
  const settled = await Promise.allSettled(
    eligible.map(async (p) => {
      const started = clockMs();
      const offers = await withDeadline(timeoutMs, p.providerId, (signal) =>
        p.search(intent, signal),
      );
      return { p, offers, latencyMs: clockMs() - started };
    }),
  );
  const offers: EconomicOffer[] = [];
  const invalid: SearchResult['invalid'] = [];
  settled.forEach((r, i) => {
    const p = eligible[i]!;
    if (r.status === 'rejected') {
      const timeout = r.reason instanceof ProviderTimeoutError;
      const reason =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      graph.recordFailure(p.providerId, reason, input.now());
      outcomes.push({
        providerId: p.providerId,
        status: timeout ? 'TIMEOUT' : 'FAILED',
        reason: reason.slice(0, 200),
      });
      return;
    }
    graph.recordSuccess(p.providerId, r.value.latencyMs, input.now());
    let count = 0;
    for (const raw of r.value.offers) {
      const parsed = EconomicOfferSchema.safeParse(raw);
      if (!parsed.success) {
        invalid.push({
          providerId: p.providerId,
          reason: parsed.error.issues[0]?.message ?? 'invalid offer',
        });
        continue;
      }
      if (
        parsed.data.discoveryProviderId !== p.providerId ||
        parsed.data.intentId !== intent.id
      ) {
        invalid.push({
          providerId: p.providerId,
          reason: 'offer not bound to provider/intent',
        });
        continue;
      }
      offers.push({ ...parsed.data, executable: false });
      count++;
    }
    outcomes.push({
      providerId: p.providerId,
      status: 'OK',
      offers: count,
      latencyMs: r.value.latencyMs,
    });
  });
  const total = input.providers.length;
  const healthy = outcomes.filter((o) => o.status === 'OK').length;
  outcomes.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return {
    offers,
    invalid,
    outcomes,
    coverage: {
      healthy,
      total,
      label: `${healthy}/${total} providers healthy`,
    },
  };
}
