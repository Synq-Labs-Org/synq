import {
  AddressSchema,
  AmountSchema,
  DelegationPolicySchema,
  type DelegationPolicy,
} from '@synq/schemas';

export type DelegationRequest = {
  amount: string;
  token: string;
  chainId: number;
  recipient: string;
  at: number;
};
export type DelegationUse = { amount: string; at: number };
export type DelegationDenial =
  | 'REVOKED'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'ASSET_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'NON_POSITIVE_AMOUNT'
  | 'PER_EXECUTION_CAP_EXCEEDED'
  | 'PERIOD_AMOUNT_EXCEEDED'
  | 'FREQUENCY_EXCEEDED'
  | 'MIN_INTERVAL';
export type DelegationDecision =
  | {
      allowed: true;
      periodIndex: number;
      periodStart: number;
      spentInPeriod: string;
      remainingInPeriod: string;
    }
  | { allowed: false; reason: DelegationDenial };

export function delegationPeriod(policy: DelegationPolicy, at: number) {
  const periodIndex = Math.floor(
    (at - policy.validAfter) / policy.periodSeconds,
  );
  return {
    periodIndex,
    periodStart: policy.validAfter + periodIndex * policy.periodSeconds,
  };
}

export function evaluateDelegation(
  rawPolicy: DelegationPolicy,
  history: readonly DelegationUse[],
  request: DelegationRequest,
): DelegationDecision {
  const policy = DelegationPolicySchema.parse(rawPolicy);
  const amount = BigInt(AmountSchema.parse(request.amount));
  const deny = (reason: DelegationDenial): DelegationDecision => ({
    allowed: false,
    reason,
  });
  if (!Number.isSafeInteger(request.at) || request.at < 0)
    throw new Error('invalid time');
  if (policy.revokedAt !== null && request.at >= policy.revokedAt)
    return deny('REVOKED');
  if (request.at < policy.validAfter) return deny('NOT_YET_VALID');
  if (request.at >= policy.validUntil) return deny('EXPIRED');
  if (
    request.chainId !== policy.asset.chainId ||
    AddressSchema.parse(request.token) !== policy.asset.address
  )
    return deny('ASSET_MISMATCH');
  if (AddressSchema.parse(request.recipient) !== policy.recipient)
    return deny('RECIPIENT_MISMATCH');
  if (amount <= 0n) return deny('NON_POSITIVE_AMOUNT');
  if (amount > BigInt(policy.maxAmountPerExecution))
    return deny('PER_EXECUTION_CAP_EXCEEDED');
  const { periodIndex, periodStart } = delegationPeriod(policy, request.at);
  const periodEnd = periodStart + policy.periodSeconds;
  const inPeriod = history.filter(
    (u) => u.at >= periodStart && u.at < periodEnd,
  );
  const last = history.reduce((max, u) => Math.max(max, u.at), -Infinity);
  if (request.at - last < policy.minIntervalSeconds)
    return deny('MIN_INTERVAL');
  if (inPeriod.length + 1 > policy.maxExecutionsPerPeriod)
    return deny('FREQUENCY_EXCEEDED');
  const spent = inPeriod.reduce((sum, u) => sum + BigInt(u.amount), 0n);
  const cap = BigInt(policy.maxAmountPerPeriod);
  if (spent + amount > cap) return deny('PERIOD_AMOUNT_EXCEEDED');
  return {
    allowed: true,
    periodIndex,
    periodStart,
    spentInPeriod: (spent + amount).toString(),
    remainingInPeriod: (cap - spent - amount).toString(),
  };
}
