import { FundingError } from './errors.js';
import type { FundingPlan, FundingRouter } from './router.js';
import {
  applyProviderStatus,
  authorizeSession,
  creditSession,
  markIndexed,
  observeDestination,
  openSession,
  recordSourceSubmission,
  timeoutSession,
  type DestinationReceipt,
  type FundingSession,
  type FundingSessionStore,
  type ProviderStatus,
} from './session.js';
import type { FundingRequestInput } from './types.js';

export interface ProviderStatusPort {
  status(
    session: FundingSession,
  ): Promise<{ status: ProviderStatus; updatedAt: string } | null>;
}
export interface DestinationObserverPort {
  /** Destination-chain transfer into the quote recipient (read model or RPC), or null. */
  find(session: FundingSession): Promise<DestinationReceipt | null>;
}
export interface IndexedObserverPort {
  indexed(
    receipt: DestinationReceipt,
  ): Promise<{ indexedThroughBlock: number; eventPresent: boolean }>;
}

/**
 * Deterministic activity surface for the FundingWorkflow (Temporal). Every
 * activity is idempotent on the session id; none of them signs or moves
 * value — source debits are user-signed outside this package.
 */
export interface FundingActivities {
  planRoute(request: FundingRequestInput): Promise<FundingPlan>;
  openFromPlan(input: {
    groupId: string;
    plan: FundingPlan;
    now: number;
  }): Promise<FundingSession>;
  authorize(sessionId: string, now: number): Promise<FundingSession>;
  recordSource(
    sessionId: string,
    transactionHash: `0x${string}`,
    now: number,
  ): Promise<FundingSession>;
  pollProvider(sessionId: string, now: number): Promise<FundingSession>;
  observeDestination(sessionId: string, now: number): Promise<FundingSession>;
  confirmIndexed(sessionId: string, now: number): Promise<FundingSession>;
  credit(sessionId: string, now: number): Promise<FundingSession>;
  timeout(sessionId: string, now: number): Promise<FundingSession>;
}

export function createFundingActivities(deps: {
  router: FundingRouter;
  store: FundingSessionStore;
  provider?: ProviderStatusPort;
  destination: DestinationObserverPort;
  indexed: IndexedObserverPort;
}): FundingActivities {
  const load = async (id: string) => {
    const s = await deps.store.get(id);
    if (!s)
      throw new FundingError('INVALID_TRANSITION', `unknown session ${id}`);
    return s;
  };
  const update = async (
    id: string,
    f: (s: FundingSession) => FundingSession | Promise<FundingSession>,
  ) => {
    const before = await load(id);
    const after = await f(before);
    if (after !== before) await deps.store.save(after);
    return after;
  };
  return {
    planRoute: (request) => deps.router.plan(request),
    async openFromPlan({ groupId, plan, now }) {
      if (plan.status !== 'ROUTED' || !plan.quote)
        throw new FundingError('ROUTE_UNAVAILABLE', plan.status);
      return deps.store.open(openSession({ groupId, quote: plan.quote, now }));
    },
    authorize: (id, now) => update(id, (s) => authorizeSession(s, now)),
    recordSource: (id, hash, now) =>
      update(id, (s) => recordSourceSubmission(s, hash, now)),
    pollProvider: (id, now) =>
      update(id, async (s) => {
        const status = deps.provider ? await deps.provider.status(s) : null;
        return status ? applyProviderStatus(s, status, now) : s;
      }),
    observeDestination: (id, now) =>
      update(id, async (s) => {
        if (s.receipt) return s;
        const receipt = await deps.destination.find(s);
        return receipt ? observeDestination(s, receipt, now) : s;
      }),
    confirmIndexed: (id, now) =>
      update(id, async (s) =>
        s.receipt
          ? markIndexed(s, await deps.indexed.indexed(s.receipt), now)
          : s,
      ),
    credit: (id, now) => update(id, (s) => creditSession(s, now)),
    timeout: (id, now) => update(id, (s) => timeoutSession(s, now)),
  };
}
