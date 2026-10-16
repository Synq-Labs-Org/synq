import {
  landedTotal,
  searchOffers,
  type EconomicIntent,
  type OfferProvider,
  type ProviderCapabilityGraph,
} from '@synq/offer-exchange';
import { AgentRuntimeError } from '../subagents.js';
import type { CapabilityGuard } from './guard.js';

/**
 * Deal, Commerce, Travel and Research specialists. They read and compare;
 * anything with an economic effect leaves as a typed proposal for the
 * Kernel (purchases, bookings) or as a capped x402 purchase that the Kernel
 * grants and the execution worker signs. Every call goes through the
 * external guard with the calling instance's id.
 */

// ---------------------------------------------------------------- Commerce / Travel

export type OfferSummary = Readonly<{
  offerId: string;
  providerId: string;
  title: string;
  amount: string;
  currency: string;
  decimals: number;
}>;

/** Read-only offer search over the existing offer exchange. */
export interface OfferSearchPort {
  search(
    intent: EconomicIntent,
    signal: AbortSignal,
  ): Promise<{
    offers: OfferSummary[];
    coverage: string;
  }>;
}

/**
 * Adapter to `@synq/offer-exchange` `searchOffers`: plug in the providers
 * from `@synq/plugin-commerce` or `@synq/plugin-duffel` and their capability
 * graph. Discovery only; no booking or purchase port is reachable from here.
 */
export function offerSearchPort(input: {
  providers: readonly OfferProvider[];
  graph: ProviderCapabilityGraph;
  now: () => number;
  timeoutMs?: number;
}): OfferSearchPort {
  return {
    async search(intent) {
      const r = await searchOffers({
        intent,
        providers: input.providers,
        graph: input.graph,
        now: input.now,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      const unit = {
        currency: intent.budget.max.currency,
        decimals: intent.budget.max.decimals,
      };
      return {
        offers: r.offers.slice(0, 10).map((o) => {
          const total = landedTotal(o, unit);
          const subject = o.subject as { title?: unknown; kind: string };
          return {
            offerId: o.offerId,
            providerId: o.fulfillmentProviderId,
            title: String(subject.title ?? subject.kind).slice(0, 120),
            amount: total.amount,
            currency: total.currency,
            decimals: total.decimals,
          };
        }),
        coverage: r.coverage.label,
      };
    },
  };
}

export type PurchaseProposal = Readonly<{
  kind: 'PURCHASE' | 'BOOKING';
  offerId: string;
  providerId: string;
  amount: string;
  currency: string;
  /** Execution is the Kernel's and the fulfillment worker's, never the agent's. */
  requires: 'KERNEL_GRANT_AND_OWNER_APPROVAL';
}>;

export async function compareOffers(input: {
  guard: CapabilityGuard;
  agentId: string;
  domain: 'COMMERCE' | 'TRAVEL';
  port: OfferSearchPort;
  intent: EconomicIntent;
}): Promise<{
  offers: OfferSummary[];
  coverage: string;
  proposal: PurchaseProposal | null;
}> {
  const search =
    input.domain === 'TRAVEL' ? 'travel.search' : 'commerce.search';
  const propose =
    input.domain === 'TRAVEL'
      ? 'travel.proposeBooking'
      : 'commerce.proposePurchase';
  const { value } = await input.guard.run(input.agentId, search, {}, (signal) =>
    input.port.search(input.intent, signal),
  );
  const comparable = value.offers.filter(
    (o) =>
      o.currency === 'USDC' &&
      Number.isInteger(o.decimals) &&
      o.decimals >= 0 &&
      o.decimals <= 18 &&
      /^\d+$/.test(o.amount),
  );
  const normalized = (o: OfferSummary) =>
    o.decimals <= 6
      ? BigInt(o.amount) * 10n ** BigInt(6 - o.decimals)
      : (BigInt(o.amount) + 10n ** BigInt(o.decimals - 6) - 1n) /
        10n ** BigInt(o.decimals - 6);
  const best = [...comparable].sort((a, b) =>
    normalized(a) < normalized(b) ? -1 : 1,
  )[0];
  if (!best) return { ...value, proposal: null };
  input.guard.authorize(input.agentId, propose, {
    amountBaseUnits: normalized(best),
  });
  return {
    ...value,
    proposal: {
      kind: input.domain === 'TRAVEL' ? 'BOOKING' : 'PURCHASE',
      offerId: best.offerId,
      providerId: best.providerId,
      amount: best.amount,
      currency: best.currency,
      requires: 'KERNEL_GRANT_AND_OWNER_APPROVAL',
    },
  };
}

// ---------------------------------------------------------------- Deal

export type MilestoneView = Readonly<{
  milestoneId: string;
  title: string;
  amountBaseUnits: string;
  status:
    | 'PENDING'
    | 'DELIVERED'
    | 'ACCEPTED'
    | 'DISPUTED'
    | 'RELEASED'
    | 'REFUNDED';
}>;

/** Read-only view of a deal room (implemented over the deal-room store by the integrator). */
export interface DealReadPort {
  agreement(dealId: string): Promise<{
    dealId: string;
    termsHash: string;
    parties: readonly string[];
    milestones: readonly MilestoneView[];
  } | null>;
}

/**
 * The Deal Agent summarises; a contested delivery is never decided here.
 * It returns who decides (the payer's signature, or the arbiter on a
 * dispute) instead of a decision.
 */
export async function dealAgentReview(input: {
  guard: CapabilityGuard;
  agentId: string;
  port: DealReadPort;
  dealId: string;
}): Promise<{
  summary: string;
  contested: readonly string[];
  decidedBy: 'PAYER_SIGNATURE' | 'ARBITER';
}> {
  const { value } = await input.guard.run(input.agentId, 'deal.read', {}, () =>
    input.port.agreement(input.dealId),
  );
  if (!value)
    throw new AgentRuntimeError(
      'VALIDATION_REJECTED',
      `no deal ${input.dealId}`,
    );
  const contested = value.milestones
    .filter((m) => m.status === 'DISPUTED')
    .map((m) => m.milestoneId);
  return {
    summary: `${value.milestones.length} milestones (terms ${value.termsHash.slice(0, 10)}…): ${value.milestones.map((m) => `${m.title} ${m.status}`).join(', ')}`,
    contested,
    decidedBy: contested.length ? 'ARBITER' : 'PAYER_SIGNATURE',
  };
}

// ---------------------------------------------------------------- Research

export type PaidDataReceipt = Readonly<{
  status: 'PAID' | 'REFUSED' | 'UNSETTLED';
  amount: string | null;
  reason: string | null;
  body: string | null;
  label: 'LIVE' | 'LOCAL_FIXTURE';
}>;

/**
 * The x402 path, implemented by the integrator over `@synq/settlement`
 * `payForResource` with the execution worker's `X402AuthorizationSigner`.
 * The allowance comes from the Research instance's effective capability.
 */
export interface PaidDataPort {
  buy(
    url: string,
    allowance: { hosts: readonly string[]; maxPerRequest: bigint },
    signal: AbortSignal,
  ): Promise<PaidDataReceipt>;
}

export async function researchPaidRead(input: {
  guard: CapabilityGuard;
  agentId: string;
  port: PaidDataPort;
  url: string;
  /** Price the seller quoted (base units); checked against the cap first. */
  quotedBaseUnits: bigint;
}): Promise<PaidDataReceipt> {
  const host = new URL(input.url).host.toLowerCase();
  const cap = input.guard.capability(input.agentId);
  if (!cap) throw new AgentRuntimeError('CANCELLED', 'unknown agent');
  const { value } = await input.guard.runPaid(
    input.agentId,
    'research.x402Purchase',
    { amountBaseUnits: input.quotedBaseUnits, host, chain: 'arc-testnet' },
    async (signal, maxPerRequest) => {
      const receipt = await input.port.buy(
        input.url,
        { hosts: cap.domains, maxPerRequest },
        signal,
      );
      return {
        value: receipt,
        paidBaseUnits:
          receipt.status === 'PAID'
            ? receipt.amount && /^\d+$/.test(receipt.amount)
              ? BigInt(receipt.amount)
              : maxPerRequest
            : 0n,
      };
    },
  );
  return value;
}
