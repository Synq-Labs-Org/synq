export type CanaryEnvironment = {
  SYNQ_ALLOW_MAINNET_BROADCAST?: string;
  SYNQ_MAINNET_CANARY_MAX_USD?: string;
};
export type CanaryDecision = {
  broadcast: false;
  mode: 'CANARY_READY';
  reasons: string[];
};

export function usdCents(value: string | undefined): bigint {
  const match = /^([0-9]{1,12})(?:\.([0-9]{1,2}))?$/.exec(value ?? '');
  if (!match) return 0n;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/**
 * Mainnet canary gate. Broadcasting would need SYNQ_ALLOW_MAINNET_BROADCAST=true, a positive
 * SYNQ_MAINNET_CANARY_MAX_USD covering the trade notional and an on-chain execution path for swaps. The swap path is
 * not deployed (ADR-0013 is a proposal), so the decision type itself cannot express a broadcast here.
 */
export function canaryGate(input: {
  env: CanaryEnvironment;
  notionalUsdCents: bigint;
  executionPathAvailable: boolean;
}): CanaryDecision {
  const reasons: string[] = [];
  if (input.env.SYNQ_ALLOW_MAINNET_BROADCAST !== 'true')
    reasons.push('SYNQ_ALLOW_MAINNET_BROADCAST is not true');
  const cap = usdCents(input.env.SYNQ_MAINNET_CANARY_MAX_USD);
  if (cap <= 0n)
    reasons.push('SYNQ_MAINNET_CANARY_MAX_USD is not a positive cap');
  else if (input.notionalUsdCents > cap)
    reasons.push('trade notional exceeds SYNQ_MAINNET_CANARY_MAX_USD');
  if (!input.executionPathAvailable)
    reasons.push(
      'no on-chain swap execution path: ExecutionModule executes only exact transfers (ADR-0013 bounded swap action not deployed)',
    );
  return { broadcast: false, mode: 'CANARY_READY', reasons };
}
