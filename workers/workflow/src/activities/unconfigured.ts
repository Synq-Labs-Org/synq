import { ApplicationFailure } from '@temporalio/common';
import type { FundingActivities, HedgeActivities } from './types.js';

const missing = (port: string) => async (): Promise<never> => {
  throw ApplicationFailure.nonRetryable(
    `${port} is not configured on this worker`,
    'NOT_CONFIGURED',
  );
};

/** Hedge and funding venues plug in later; until then their Activities refuse without side effects. */
export function unconfiguredPorts(): HedgeActivities & FundingActivities {
  return {
    hedgeRiskSnapshot: missing('hedge risk'),
    planHedge: missing('hedge planner'),
    hedgeApprovals: missing('hedge approvals'),
    submitHedgeOrder: missing('hedge venue'),
    hedgeOrderStatus: missing('hedge venue'),
    cancelHedgeOrder: missing('hedge venue'),
    reconcileHedge: missing('hedge venue'),
    quoteFundingRoutes: missing('funding router'),
    executeFundingRoute: missing('funding router'),
    fundingStatus: missing('funding router'),
    creditFunding: missing('funding router'),
  };
}
