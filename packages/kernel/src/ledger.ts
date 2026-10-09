import {
  GrantExecutionObservationSchema,
  type AssetIdentity,
  type BoundActionIntent,
  type ExecutionGrant,
  type GrantExecutionObservation,
  type Mandate,
  type NativeAsset,
  type TreasuryBalance,
} from '@synq/schemas';
import { artifactHash, canonicalJson, type Hash } from './canonical.js';
import { parseAs, requireRule } from './errors.js';
import { mandateKey, onchainMandateId, onchainPluginId } from './mandates.js';

export type Budget = {
  spentToken: string;
  spentNative: string;
  reservedToken: string;
  reservedNative: string;
  issued: number;
  lastIssued: number | null;
};
export type ChainUsage = {
  spentToken: string;
  spentNative: string;
  executed: number;
  lastExecutedAt: number | null;
};
export type ChainUsageObservation = Omit<ChainUsage, 'lastExecutedAt'> & {
  groupId: string;
  mandateId: string;
  chainId: number;
  account: string;
  nonces: readonly string[];
  intentHashes: readonly string[];
};
export type BalanceRecord = {
  account: `0x${string}`;
  asset: AssetIdentity;
  balance: string;
  asOfBlock: string;
};
export const GRANT_STATES = [
  'RESERVED',
  'CONSUMED',
  'PREPARED',
  'REVERTED',
  'RELEASED',
  'RECONCILED',
] as const;
export type GrantState = (typeof GRANT_STATES)[number];
export const OUTSTANDING: readonly GrantState[] = [
  'RESERVED',
  'CONSUMED',
  'PREPARED',
  'REVERTED',
];
export type GrantClaim = {
  grantId: Hash;
  workerId: string;
  claimId: Hash;
  claimedAt: number;
};
export type Execution = {
  transactionHash: Hash;
  blockNumber: string;
  tokenAmount: string;
  nativeValue: string;
  outputAmount: string;
};
export type GrantRecord = {
  grant: ExecutionGrant;
  state: GrantState;
  claim: GrantClaim | null;
  preparedCallHash: Hash | null;
  submissions: Hash[];
  execution: Execution | null;
};
export type NonceStatus = {
  nonceUsed: boolean;
  intentUsed: boolean;
  blockNumber: number;
  blockTimestamp: number;
};

export function nativeAssetFor(chainId: number): NativeAsset {
  return {
    canonicalAssetId: `eip155:${chainId}/native`,
    chainId: chainId as NativeAsset['chainId'],
    native: true,
    symbol: 'MON',
    decimals: 18,
  };
}
export const emptyBudget = (): Budget => ({
  spentToken: '0',
  spentNative: '0',
  reservedToken: '0',
  reservedNative: '0',
  issued: 0,
  lastIssued: null,
});
const balanceKey = (account: string, asset: AssetIdentity) =>
  JSON.stringify([account.toLowerCase(), asset.canonicalAssetId]);
const nonceKey = (g: { chainId: number; account: string; nonce: string }) =>
  JSON.stringify([g.chainId, g.account, g.nonce]);
const add = (a: string, b: bigint) => (BigInt(a) + b).toString();

export class Ledger {
  readonly budgets = new Map<string, Budget>();
  readonly balances = new Map<string, BalanceRecord>();
  readonly grants = new Map<string, GrantRecord>();
  readonly nonces = new Set<string>();
  readonly chainUsage = new Map<string, ChainUsage>();
  readonly chainNonces = new Set<string>();
  readonly chainIntents = new Set<string>();

  budget(m: { groupId: string; mandateId: string }): Budget {
    const budget = structuredClone(
      this.budgets.get(mandateKey(m)) ?? emptyBudget(),
    );
    const chain = this.chainUsage.get(mandateKey(m));
    if (!chain) return budget;
    const max = (a: string, b: string) =>
      (BigInt(a) > BigInt(b) ? a : b).toString();
    return {
      ...budget,
      spentToken: max(budget.spentToken, chain.spentToken),
      spentNative: max(budget.spentNative, chain.spentNative),
      issued: Math.max(budget.issued, chain.executed),
      lastIssued:
        budget.lastIssued === null
          ? chain.lastExecutedAt
          : chain.lastExecutedAt === null
            ? budget.lastIssued
            : Math.max(budget.lastIssued, chain.lastExecutedAt),
    };
  }
  hasNonce(intent: BoundActionIntent): boolean {
    return (
      this.nonces.has(nonceKey(intent)) ||
      this.chainNonces.has(nonceKey(intent))
    );
  }
  intentUsedOnChain(intentHash: string): boolean {
    return this.chainIntents.has(intentHash.toLowerCase());
  }
  observeChainUsage(usage: ChainUsageObservation, now: number): void {
    const key = mandateKey(usage);
    const previous = this.chainUsage.get(key);
    const known = Math.max(
      previous?.executed ?? 0,
      this.budgets.get(key)?.issued ?? 0,
    );
    const big = (a: string | undefined, b: string) =>
      a !== undefined && BigInt(a) > BigInt(b) ? a : b;
    this.chainUsage.set(key, {
      spentToken: big(previous?.spentToken, usage.spentToken),
      spentNative: big(previous?.spentNative, usage.spentNative),
      executed: Math.max(previous?.executed ?? 0, usage.executed),
      lastExecutedAt:
        usage.executed > known
          ? Math.max(now, previous?.lastExecutedAt ?? 0)
          : (previous?.lastExecutedAt ?? null),
    });
    for (const nonce of usage.nonces)
      this.chainNonces.add(
        nonceKey({
          chainId: usage.chainId,
          account: usage.account.toLowerCase(),
          nonce,
        }),
      );
    for (const hash of usage.intentHashes)
      this.chainIntents.add(hash.toLowerCase());
  }
  setBalance(raw: TreasuryBalance, asOfBlock: string): void {
    const key = balanceKey(raw.account, raw.asset);
    this.balances.set(key, {
      account: raw.account,
      asset: structuredClone(raw.asset),
      balance: raw.balance,
      asOfBlock,
    });
  }
  observeBalance(raw: TreasuryBalance, blockNumber: string): void {
    const previous = this.balances.get(balanceKey(raw.account, raw.asset));
    requireRule(
      !previous || BigInt(blockNumber) >= BigInt(previous.asOfBlock),
      'BALANCE_REGRESSION',
    );
    this.setBalance(raw, blockNumber);
  }
  outstanding(account: string, asset: AssetIdentity): bigint {
    let total = 0n;
    for (const r of this.grants.values()) {
      if (!OUTSTANDING.includes(r.state) || r.grant.account !== account)
        continue;
      if ('native' in asset)
        total +=
          asset.chainId === r.grant.chainId ? BigInt(r.grant.nativeValue) : 0n;
      else if (r.grant.inputAsset?.canonicalAssetId === asset.canonicalAssetId)
        total += BigInt(r.grant.maxInputAmount);
    }
    return total;
  }
  available(account: string, asset: AssetIdentity): bigint | null {
    const record = this.balances.get(balanceKey(account, asset));
    return record ? BigInt(record.balance) : null;
  }
  gate(input: {
    intent: BoundActionIntent;
    mandate: Mandate;
    now: number;
    verifiedBalances: readonly TreasuryBalance[] | null;
  }): void {
    const { intent, mandate, now } = input;
    const budget = this.budget(mandate);
    const tokenAmount = BigInt(intent.maxInputAmount);
    const nativeValue = BigInt(intent.nativeValue);
    requireRule(!this.hasNonce(intent), 'NONCE_REPLAY');
    requireRule(
      BigInt(budget.spentToken) + BigInt(budget.reservedToken) + tokenAmount <=
        BigInt(mandate.cumulativeBudget),
      'BUDGET_EXHAUSTED',
    );
    requireRule(
      BigInt(budget.spentNative) +
        BigInt(budget.reservedNative) +
        nativeValue <=
        BigInt(mandate.cumulativeNativeBudget),
      'NATIVE_BUDGET_EXHAUSTED',
    );
    const needs: [AssetIdentity, bigint][] = [];
    if (tokenAmount > 0n) needs.push([mandate.inputAsset, tokenAmount]);
    if (nativeValue > 0n)
      needs.push([nativeAssetFor(intent.chainId), nativeValue]);
    for (const [asset, amount] of needs) {
      let balance = this.available(intent.account, asset);
      const verified = input.verifiedBalances?.find(
        (b) =>
          b.account === intent.account &&
          b.asset.canonicalAssetId === asset.canonicalAssetId,
      );
      if (balance !== null && verified)
        balance =
          BigInt(verified.balance) < balance
            ? BigInt(verified.balance)
            : balance;
      requireRule(
        balance !== null &&
          balance >= this.outstanding(intent.account, asset) + amount,
        'INSUFFICIENT_BALANCE',
      );
    }
    requireRule(budget.issued < mandate.maxExecutions, 'RECURRING_CAP');
    requireRule(
      budget.lastIssued === null ||
        now - budget.lastIssued >= mandate.minIntervalSeconds,
      'FREQUENCY_CAP',
    );
  }
  reserve(grant: ExecutionGrant, now: number): void {
    requireRule(!this.grants.has(grant.grantId), 'NONCE_REPLAY');
    const key = mandateKey(grant);
    const budget = this.budgets.get(key) ?? emptyBudget();
    this.budgets.set(key, {
      ...budget,
      reservedToken: add(budget.reservedToken, BigInt(grant.maxInputAmount)),
      reservedNative: add(budget.reservedNative, BigInt(grant.nativeValue)),
      issued: budget.issued + 1,
      lastIssued: now,
    });
    this.grants.set(grant.grantId, {
      grant: structuredClone(grant),
      state: 'RESERVED',
      claim: null,
      preparedCallHash: null,
      submissions: [],
      execution: null,
    });
    this.nonces.add(nonceKey(grant));
  }
  private unreserve(record: GrantRecord, spent: Execution | null): void {
    const key = mandateKey(record.grant);
    const budget = this.budgets.get(key)!;
    this.budgets.set(key, {
      ...budget,
      reservedToken: add(
        budget.reservedToken,
        -BigInt(record.grant.maxInputAmount),
      ),
      reservedNative: add(
        budget.reservedNative,
        -BigInt(record.grant.nativeValue),
      ),
      spentToken: add(budget.spentToken, BigInt(spent?.tokenAmount ?? '0')),
      spentNative: add(budget.spentNative, BigInt(spent?.nativeValue ?? '0')),
    });
  }
  record(grantId: string): GrantRecord {
    const record = this.grants.get(grantId);
    requireRule(record !== undefined, 'GRANT_UNKNOWN');
    return record;
  }
  claim(grantId: string, workerId: string, now: number, sequence: number) {
    const record = this.record(grantId);
    requireRule(record.state === 'RESERVED', 'GRANT_REPLAY');
    requireRule(
      workerId.length > 0 && workerId.length <= 128,
      'GRANT_CLAIM_INVALID',
    );
    const claim: GrantClaim = {
      grantId: record.grant.grantId,
      workerId,
      claimId: artifactHash({ grantId, workerId, now, sequence }),
      claimedAt: now,
    };
    record.state = 'CONSUMED';
    record.claim = claim;
    return structuredClone(claim);
  }
  prepare(claim: GrantClaim, callHash: Hash, now: number): ExecutionGrant {
    const record = this.record(claim.grantId);
    requireRule(
      record.claim !== null &&
        canonicalJson(record.claim) === canonicalJson(claim),
      'GRANT_CLAIM_INVALID',
    );
    requireRule(record.state === 'CONSUMED', 'GRANT_NOT_PREPARABLE');
    requireRule(
      now >= record.grant.validAfter && now < record.grant.validUntil,
      'GRANT_EXPIRED',
    );
    record.state = 'PREPARED';
    record.preparedCallHash = callHash;
    return structuredClone(record.grant);
  }
  recordSubmission(claim: GrantClaim, transactionHash: Hash): void {
    const record = this.record(claim.grantId);
    requireRule(
      record.claim !== null &&
        canonicalJson(record.claim) === canonicalJson(claim) &&
        record.state === 'PREPARED' &&
        /^0x[0-9a-f]{64}$/.test(transactionHash),
      'GRANT_CLAIM_INVALID',
    );
    if (!record.submissions.includes(transactionHash))
      record.submissions.push(transactionHash);
  }
  reconcile(grantId: string, raw: unknown): GrantRecord {
    const record = this.record(grantId);
    requireRule(OUTSTANDING.includes(record.state), 'RECONCILIATION_INVALID');
    const observed: GrantExecutionObservation = parseAs(
      GrantExecutionObservationSchema,
      raw,
      'RECONCILIATION_INVALID',
    );
    const g = record.grant;
    requireRule(observed.chainId === g.chainId, 'RECONCILIATION_MISMATCH');
    if (observed.receiptStatus === 'reverted') {
      requireRule(
        record.state === 'PREPARED' &&
          record.submissions.includes(observed.transactionHash),
        'RECONCILIATION_MISMATCH',
      );
      record.state = 'REVERTED';
      return structuredClone(record);
    }
    const e = observed.event!;
    const d = g.draft.grant;
    requireRule(
      observed.emitter === g.draft.domain.verifyingContract &&
        e.grantHash === g.grantId &&
        e.groupId === d.groupId &&
        e.intentHash === d.intentHash &&
        e.mandateId === onchainMandateId(g) &&
        e.mandateId === d.mandateId &&
        e.mandateVersion === d.mandateVersion &&
        e.account === d.account &&
        e.executor === d.executor &&
        e.pluginId === onchainPluginId(g.pluginId) &&
        e.chainId === d.chainId &&
        e.nonce === d.nonce &&
        e.target === d.target &&
        e.selector === d.selector &&
        e.calldataHash === d.calldataHash &&
        e.token === d.token &&
        e.recipient === d.recipient &&
        BigInt(e.tokenAmount) <= BigInt(d.maxInputAmount) &&
        BigInt(e.nativeValue) <= BigInt(d.nativeValue) &&
        BigInt(e.outputAmount) >= BigInt(d.minOutputAmount),
      'RECONCILIATION_MISMATCH',
    );
    const execution: Execution = {
      transactionHash: observed.transactionHash,
      blockNumber: observed.blockNumber,
      tokenAmount: e.tokenAmount,
      nativeValue: e.nativeValue,
      outputAmount: e.outputAmount,
    };
    this.unreserve(record, execution);
    const debits: [AssetIdentity | null, string][] = [
      [g.inputAsset, e.tokenAmount],
      [nativeAssetFor(g.chainId), e.nativeValue],
    ];
    for (const [asset, amount] of debits) {
      if (!asset || BigInt(amount) === 0n) continue;
      const balance = this.balances.get(balanceKey(g.account, asset));
      if (!balance || BigInt(balance.asOfBlock) >= BigInt(observed.blockNumber))
        continue;
      const next = BigInt(balance.balance) - BigInt(amount);
      balance.balance = (next < 0n ? 0n : next).toString();
    }
    record.state = 'RECONCILED';
    record.execution = execution;
    return structuredClone(record);
  }
  releasable(grantId: string, status: NonceStatus): boolean {
    const record = this.record(grantId);
    return (
      OUTSTANDING.includes(record.state) &&
      !status.nonceUsed &&
      !status.intentUsed &&
      Number.isSafeInteger(status.blockTimestamp) &&
      status.blockTimestamp >= record.grant.validUntil
    );
  }
  release(grantId: string, status: NonceStatus): ExecutionGrant {
    const record = this.record(grantId);
    requireRule(this.releasable(grantId, status), 'RECONCILIATION_INVALID');
    this.unreserve(record, null);
    record.state = 'RELEASED';
    return structuredClone(record.grant);
  }
  expiredOutstanding(now: number): ExecutionGrant[] {
    return [...this.grants.values()]
      .filter((r) => OUTSTANDING.includes(r.state) && r.grant.validUntil <= now)
      .map((r) => structuredClone(r.grant));
  }
  clone(): Ledger {
    const copy = new Ledger();
    for (const [k, v] of this.budgets) copy.budgets.set(k, structuredClone(v));
    for (const [k, v] of this.balances)
      copy.balances.set(k, structuredClone(v));
    for (const [k, v] of this.grants) copy.grants.set(k, structuredClone(v));
    for (const n of this.nonces) copy.nonces.add(n);
    for (const [k, v] of this.chainUsage)
      copy.chainUsage.set(k, structuredClone(v));
    for (const n of this.chainNonces) copy.chainNonces.add(n);
    for (const h of this.chainIntents) copy.chainIntents.add(h);
    return copy;
  }
}
