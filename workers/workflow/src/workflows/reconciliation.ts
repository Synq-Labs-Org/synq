import {
  continueAsNew,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type {
  OperationsActivities,
  ReconciliationSweep,
} from '../activities/types.js';
import {
  nextScheduledEventQuery,
  stateQuery,
  type ScheduledEvent,
} from './messages.js';
import { NON_RETRYABLE, seconds } from './common.js';

export type ReconciliationInput = {
  intervalSeconds: number;
  sweeps: number;
  sweepsPerRun?: number;
  activityTimeoutSeconds?: number;
};
export type ReconciliationState = {
  completedSweeps: number;
  last: ReconciliationSweep | null;
  totals: { confirmed: number; released: number; unresolved: number };
  nextEvent: ScheduledEvent;
};

/** Periodic journal reconciliation and expired-reservation release; history is bounded with continue-as-new. */
export async function ReconciliationWorkflow(
  input: ReconciliationInput,
  carried: ReconciliationState['totals'] = {
    confirmed: 0,
    released: 0,
    unresolved: 0,
  },
): Promise<ReconciliationState> {
  const acts = proxyActivities<OperationsActivities>({
    startToCloseTimeout: seconds(input.activityTimeoutSeconds ?? 120),
    heartbeatTimeout: '30s',
    retry: {
      initialInterval: '2s',
      backoffCoefficient: 2,
      maximumInterval: '60s',
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const s: ReconciliationState = {
    completedSweeps: 0,
    last: null,
    totals: { ...carried },
    nextEvent: { kind: 'NONE', at: null },
  };
  setHandler(stateQuery, () => s);
  setHandler(nextScheduledEventQuery, () => s.nextEvent);
  const perRun = input.sweepsPerRun ?? 50;
  while (s.completedSweeps < Math.min(input.sweeps, perRun)) {
    s.last = await acts.sweepJournal({});
    s.completedSweeps++;
    s.totals.confirmed += s.last.confirmed.length;
    s.totals.released += s.last.released;
    s.totals.unresolved = s.last.unresolved.length;
    if (s.completedSweeps >= input.sweeps) break;
    s.nextEvent = {
      kind: 'CONFIRMATION_POLL',
      at: Date.now() + input.intervalSeconds * 1000,
    };
    await sleep(seconds(input.intervalSeconds));
  }
  if (input.sweeps > s.completedSweeps)
    await continueAsNew<typeof ReconciliationWorkflow>(
      { ...input, sweeps: input.sweeps - s.completedSweeps },
      s.totals,
    );
  s.nextEvent = { kind: 'NONE', at: null };
  return s;
}
