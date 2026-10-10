import {
  allHandlersFinished,
  condition,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  FundingActivities,
  FundingQuote,
  FundingTransferView,
} from '../activities/types.js';
import {
  cancelUpdate,
  nextScheduledEventQuery,
  stateQuery,
  validActor,
  validReason,
  type ScheduledEvent,
} from './messages.js';
import { NON_RETRYABLE, seconds } from './common.js';

export type FundingInput = {
  groupId: string;
  fundingId: string;
  amount: string;
  pollSeconds?: number;
  maxPolls?: number;
  activityTimeoutSeconds?: number;
};
export type FundingState = {
  fundingId: string;
  quotes: FundingQuote[];
  selected: FundingQuote | null;
  transferKey: string;
  transfer: FundingTransferView | null;
  credited: boolean;
  cancelRequested: boolean;
  nextEvent: ScheduledEvent;
  outcome:
    | 'CREDITED'
    | 'NO_ROUTE'
    | 'FAILED'
    | 'CANCELLED'
    | 'UNRESOLVED'
    | null;
};

/** Funding orchestration skeleton: routes are capability- and quote-driven behind FundingActivities. */
export async function FundingWorkflow(
  input: FundingInput,
): Promise<FundingState> {
  const poll = input.pollSeconds ?? 15;
  const acts = proxyActivities<FundingActivities>({
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 30),
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const s: FundingState = {
    fundingId: input.fundingId,
    quotes: [],
    selected: null,
    transferKey: `synq.funding.${input.fundingId}`,
    transfer: null,
    credited: false,
    cancelRequested: false,
    nextEvent: { kind: 'NONE', at: null },
    outcome: null,
  };
  setHandler(stateQuery, () => s);
  setHandler(nextScheduledEventQuery, () => s.nextEvent);
  setHandler(
    cancelUpdate,
    () => {
      s.cancelRequested = true;
      return { accepted: true as const, at: new Date().toISOString() };
    },
    {
      validator: ({ requestedBy, reason }) => {
        validActor(requestedBy);
        validReason(reason);
        if (s.transfer !== null)
          throw new Error('CANCEL_AFTER_SUBMISSION_FORBIDDEN');
      },
    },
  );
  const done = async (outcome: NonNullable<FundingState['outcome']>) => {
    s.outcome = outcome;
    s.nextEvent = { kind: 'NONE', at: null };
    await condition(allHandlersFinished);
    return s;
  };

  s.quotes = await acts.quoteFundingRoutes({
    groupId: input.groupId,
    fundingId: input.fundingId,
    amount: input.amount,
  });
  const usable = s.quotes
    .filter((q) => q.available && q.expiresAt * 1000 > Date.now())
    .sort((a, b) =>
      BigInt(b.expectedOutput) > BigInt(a.expectedOutput) ? 1 : -1,
    );
  s.selected = usable[0] ?? null;
  if (!s.selected) return done('NO_ROUTE');
  if (s.cancelRequested) return done('CANCELLED');
  s.transfer = await acts.executeFundingRoute({
    groupId: input.groupId,
    transferKey: s.transferKey,
    quote: s.selected,
  });
  for (
    let i = 0;
    i < (input.maxPolls ?? 240) && s.transfer.status === 'PENDING';
    i++
  ) {
    s.nextEvent = { kind: 'FUNDING_POLL', at: Date.now() + poll * 1000 };
    await sleep(seconds(poll));
    s.transfer = await acts.fundingStatus({ transferKey: s.transferKey });
  }
  if (s.transfer.status === 'FAILED') return done('FAILED');
  if (s.transfer.status !== 'SETTLED' || s.transfer.settledAmount === null)
    return done('UNRESOLVED');
  s.credited = (
    await acts.creditFunding({
      groupId: input.groupId,
      transferKey: s.transferKey,
      amount: s.transfer.settledAmount,
    })
  ).credited;
  return done('CREDITED');
}
