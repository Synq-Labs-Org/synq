import { requireKuru } from './errors.js';
import type { PreparedSwap } from './flow.js';

/** Receipt observations only: a partial fill cannot settle or credit the full planned amount. */
export function reconcileSwapBalances(
  swap: PreparedSwap,
  observation: {
    chainId: number;
    account: string;
    transactionSucceeded: boolean;
    confirmed: boolean;
    inputBefore: bigint;
    inputAfter: bigint;
    outputBefore: bigint;
    outputAfter: bigint;
  },
) {
  requireKuru(observation.chainId === swap.chainId, 'WRONG_CHAIN');
  requireKuru(
    observation.account.toLowerCase() === swap.account.toLowerCase(),
    'CALLDATA_MISMATCH',
    'reconciliation account',
  );
  if (!observation.confirmed)
    return {
      state: 'PENDING' as const,
      inputSpent: '0',
      outputReceived: '0',
      remainingInput: swap.amountIn.toString(),
    };
  if (!observation.transactionSucceeded)
    return {
      state: 'REVERTED' as const,
      inputSpent: '0',
      outputReceived: '0',
      remainingInput: swap.amountIn.toString(),
    };
  const spent = observation.inputBefore - observation.inputAfter;
  const received = observation.outputAfter - observation.outputBefore;
  requireKuru(
    spent >= 0n && spent <= swap.amountIn && received >= 0n,
    'MAX_INPUT_BREACH',
  );
  requireKuru(spent > 0n || received === 0n, 'MIN_OUTPUT_BREACH');
  requireKuru(
    spent === 0n || received * swap.amountIn >= swap.minOutput * spent,
    'MIN_OUTPUT_BREACH',
  );
  return {
    state: spent === swap.amountIn ? ('FILLED' as const) : ('PARTIAL' as const),
    inputSpent: spent.toString(),
    outputReceived: received.toString(),
    remainingInput: (swap.amountIn - spent).toString(),
  };
}
