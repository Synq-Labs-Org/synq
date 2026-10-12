import { z } from 'zod';
import { contentHash } from '@synq/funding';
import {
  MoneySchema,
  type EvidenceLabel,
  type Money,
} from '@synq/offer-exchange';

/**
 * Settlement Fabric v1.3 (directive §10). Providers declare what they can
 * actually execute; the router selects by executable capability, never by
 * name. Every record carries the financial execution mode it was produced
 * under, and the ledgers keep simulated, sandbox and real value apart.
 */
export const EXECUTION_CATEGORIES = [
  'NATIVE_CRYPTO',
  'DIGITAL_GOODS_SANDBOX',
  'CARD_NETWORK_SANDBOX',
  'CRYPTO_COMMERCE_REAL',
  'MERCHANT_CHECKOUT',
  'HUMAN_HANDOFF',
  'UNAVAILABLE',
] as const;
export type ExecutionCategory = (typeof EXECUTION_CATEGORIES)[number];

export const FINANCIAL_EXECUTION_MODES = [
  'TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'MAINNET_SIMULATION',
  'REAL_MONEY_APPROVAL_REQUIRED',
] as const;
export const FinancialExecutionModeSchema = z.enum(FINANCIAL_EXECUTION_MODES);
export type FinancialExecutionMode = (typeof FINANCIAL_EXECUTION_MODES)[number];

export type ExecutionProduct =
  | 'GIFT_CARD'
  | 'VIRTUAL_CARD_AUTHORIZATION'
  | 'MERCHANT_GOODS'
  | 'TOKEN_TRANSFER'
  | 'HUMAN_TASK';
export type CredentialStatus =
  | 'PRESENT'
  | 'MISSING'
  | 'INVALID'
  | 'NOT_REQUIRED'
  | 'REFUSED_NON_SANDBOX';
export type ProviderHealth = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
export type IdentityCheck =
  | 'NONE'
  | 'ACCOUNT_KYB'
  | 'CARDHOLDER_KYC'
  | 'BUYER_KYC'
  | 'HUMAN_STEP_UP';
/** Who fronts the value when the provider executes. */
export type FundingSemantics =
  | 'PREFUNDED_PROVIDER_BALANCE'
  | 'CARD_PROGRAM_FUNDING'
  | 'ONCHAIN_TRANSFER'
  | 'MERCHANT_INVOICE'
  | 'NONE';
/** What actually changes in the world when the provider reports success. */
export type EconomicEffect =
  | 'NONE_SANDBOX'
  | 'TESTNET_TOKENS'
  | 'REAL_MONEY'
  | 'NONE_READ_ONLY'
  | 'HUMAN_OFFLINE';

export type ProviderExecutionCapability = {
  providerId: string;
  displayName: string;
  category: ExecutionCategory;
  mode: FinancialExecutionMode;
  products: readonly ExecutionProduct[];
  currencies: readonly string[];
  /** Networks/assets the provider will accept payment on (empty: offchain). */
  chains: readonly { chain: string; asset: string }[];
  sandbox: { available: boolean };
  live: { available: boolean; reason: string | null };
  credentials: CredentialStatus;
  credentialEnv: readonly string[];
  identityChecks: readonly IdentityCheck[];
  identitySatisfied: boolean;
  funding: FundingSemantics;
  economicEffect: EconomicEffect;
  cancel: { supported: boolean };
  refund: { supported: boolean };
  health: ProviderHealth;
  partnerGated: boolean;
  statusReason: string | null;
  sourceRefs: readonly string[];
};

export type ExecutionNeed = {
  intentId: string;
  product: ExecutionProduct;
  currency: string;
  /** Required payment network/asset, e.g. an invoice's accepted method. */
  requiredChain: { chain: string; asset: string } | null;
  allowedModes: readonly FinancialExecutionMode[];
  /** Acceptable categories in preference order. */
  categories: readonly ExecutionCategory[];
};

export type RouteConsidered = {
  providerId: string;
  category: ExecutionCategory;
  mode: FinancialExecutionMode;
  verdict: string;
};
export type RouteDecision =
  | {
      status: 'SELECTED';
      provider: ProviderExecutionCapability;
      mode: FinancialExecutionMode;
      label: EvidenceLabel;
      considered: RouteConsidered[];
    }
  | {
      status: 'HUMAN_HANDOFF' | 'UNAVAILABLE';
      reason: string;
      considered: RouteConsidered[];
    };

export function evidenceLabelFor(mode: FinancialExecutionMode): EvidenceLabel {
  switch (mode) {
    case 'TESTNET':
      return 'REAL_TESTNET';
    case 'PROVIDER_SANDBOX':
      return 'PROVIDER_SANDBOX';
    case 'MAINNET_READ_ONLY':
      return 'MAINNET_READ_ONLY';
    case 'MAINNET_SIMULATION':
      return 'SIMULATED';
    case 'REAL_MONEY_APPROVAL_REQUIRED':
      return 'BLOCKED_EXTERNAL';
  }
}

/** Why this provider cannot execute this need right now, or null if it can. */
export function executionBlocker(
  cap: ProviderExecutionCapability,
  need: ExecutionNeed,
): string | null {
  if (cap.category === 'UNAVAILABLE')
    return `unavailable: ${cap.statusReason ?? ''}`.trim();
  if (!need.categories.includes(cap.category)) return 'category not acceptable';
  if (!cap.products.includes(need.product)) return 'product not supported';
  if (!cap.currencies.includes(need.currency))
    return `currency ${need.currency} not supported`;
  if (
    need.requiredChain &&
    !cap.chains.some(
      (c) =>
        c.chain === need.requiredChain!.chain &&
        c.asset === need.requiredChain!.asset,
    )
  )
    return `network/asset ${need.requiredChain.chain}/${need.requiredChain.asset} not accepted`;
  if (cap.mode === 'MAINNET_READ_ONLY') return 'read-only: no execution path';
  if (cap.mode === 'REAL_MONEY_APPROVAL_REQUIRED')
    return 'real money: requires explicit capped human approval';
  if (!need.allowedModes.includes(cap.mode))
    return `mode ${cap.mode} not allowed`;
  if (cap.economicEffect === 'REAL_MONEY')
    return 'real-money effect outside REAL_MONEY_APPROVAL_REQUIRED';
  if (cap.mode === 'PROVIDER_SANDBOX' && !cap.sandbox.available)
    return 'sandbox not available';
  if (cap.credentials !== 'PRESENT' && cap.credentials !== 'NOT_REQUIRED')
    return `credentials ${cap.credentials}`;
  if (cap.partnerGated) return 'partner gated';
  if (cap.health === 'DOWN')
    return `provider down${cap.statusReason ? `: ${cap.statusReason}` : ''}`;
  if (cap.identityChecks.some((c) => c !== 'NONE') && !cap.identitySatisfied)
    return `identity checks unmet: ${cap.identityChecks.join(',')}`;
  return null;
}

const HEALTH_RANK: Record<ProviderHealth, number> = {
  HEALTHY: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  DOWN: 3,
};

/**
 * Selects the best executable provider. HUMAN_HANDOFF is only a fallback;
 * real-money and read-only providers are never selected automatically.
 */
export function selectExecutionRoute(
  need: ExecutionNeed,
  providers: readonly ProviderExecutionCapability[],
): RouteDecision {
  const considered: RouteConsidered[] = [];
  const candidates: ProviderExecutionCapability[] = [];
  for (const p of providers) {
    if (p.category === 'HUMAN_HANDOFF') continue;
    const blocker = executionBlocker(p, need);
    considered.push({
      providerId: p.providerId,
      category: p.category,
      mode: p.mode,
      verdict: blocker ?? 'executable',
    });
    if (!blocker) candidates.push(p);
  }
  candidates.sort(
    (a, b) =>
      need.categories.indexOf(a.category) -
        need.categories.indexOf(b.category) ||
      HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
      a.providerId.localeCompare(b.providerId),
  );
  const best = candidates[0];
  if (best) {
    const i = considered.findIndex((c) => c.providerId === best.providerId);
    considered[i] = { ...considered[i]!, verdict: 'selected' };
    return {
      status: 'SELECTED',
      provider: best,
      mode: best.mode,
      label: evidenceLabelFor(best.mode),
      considered,
    };
  }
  if (need.categories.includes('HUMAN_HANDOFF'))
    return {
      status: 'HUMAN_HANDOFF',
      reason: 'no executable automated provider',
      considered,
    };
  return {
    status: 'UNAVAILABLE',
    reason: 'no executable provider',
    considered,
  };
}

/** Deterministic idempotency key: the same economic action always maps to the same key. */
export function settlementIdempotencyKey(parts: {
  groupId: string;
  intentId: string;
  providerId: string;
  subject: string;
  attempt?: number;
}): string {
  return `synq-${contentHash({ kind: 'SettlementIdempotency', ...parts, attempt: parts.attempt ?? 0 }).slice(2, 42)}`;
}

/** RFC 4122-shaped UUID derived from a deterministic key (for providers that require UUID keys). */
export function idempotencyUuid(key: string): string {
  const h = contentHash({ kind: 'IdempotencyUuid', key }).slice(2, 34);
  const v = `8${h.slice(13, 16)}`;
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- Domain records ---------------------------------------------------------

const Id = z.string().min(1).max(160);
const Ts = z.number().int().nonnegative();

export const SettlementIntentSchema = z.strictObject({
  intentId: Id,
  groupId: Id,
  product: z.enum([
    'GIFT_CARD',
    'VIRTUAL_CARD_AUTHORIZATION',
    'MERCHANT_GOODS',
    'TOKEN_TRANSFER',
    'HUMAN_TASK',
  ]),
  amount: MoneySchema,
  providerId: Id,
  category: z.enum(EXECUTION_CATEGORIES),
  mode: FinancialExecutionModeSchema,
  reservationIds: z.array(Id),
  grantId: z.string().max(160).nullable(),
  idempotencyKey: z.string().min(8).max(128),
  createdAt: Ts,
});
export type SettlementIntent = z.output<typeof SettlementIntentSchema>;

export const PROVIDER_ORDER_STATES = [
  'PENDING_SUBMIT',
  'SUBMITTED',
  'UNKNOWN_OUTCOME',
  /** A provider sandbox fulfilled it: no merchant was paid, no real value moved. */
  'SANDBOX_FULFILLED',
  /** Settled with testnet tokens on chain. */
  'TESTNET_SETTLED',
  /** A real merchant order, settled with real money. */
  'MERCHANT_SETTLED',
  'FAILED',
  'CANCELED',
] as const;
export type ProviderOrderState = (typeof PROVIDER_ORDER_STATES)[number];
const ORDER_TRANSITIONS: Record<ProviderOrderState, ProviderOrderState[]> = {
  PENDING_SUBMIT: ['SUBMITTED', 'FAILED'],
  SUBMITTED: [
    'UNKNOWN_OUTCOME',
    'SANDBOX_FULFILLED',
    'TESTNET_SETTLED',
    'MERCHANT_SETTLED',
    'FAILED',
  ],
  UNKNOWN_OUTCOME: [
    'SANDBOX_FULFILLED',
    'TESTNET_SETTLED',
    'MERCHANT_SETTLED',
    'FAILED',
  ],
  SANDBOX_FULFILLED: ['CANCELED'],
  TESTNET_SETTLED: ['CANCELED'],
  MERCHANT_SETTLED: ['CANCELED'],
  FAILED: [],
  CANCELED: [],
};

export const ProviderOrderSchema = z.strictObject({
  providerOrderId: Id,
  intentId: Id,
  groupId: Id,
  providerId: Id,
  mode: FinancialExecutionModeSchema,
  idempotencyKey: z.string().min(8).max(128),
  providerRef: z.string().max(200).nullable(),
  state: z.enum(PROVIDER_ORDER_STATES),
  amount: MoneySchema,
  economicEffect: z.enum([
    'NONE_SANDBOX',
    'TESTNET_TOKENS',
    'REAL_MONEY',
    'NONE_READ_ONLY',
    'HUMAN_OFFLINE',
  ]),
  reason: z.string().max(200).nullable(),
  createdAt: Ts,
  updatedAt: Ts,
});
export type ProviderOrder = z.output<typeof ProviderOrderSchema>;

export const PaymentAuthorizationSchema = z.strictObject({
  authorizationId: Id,
  providerOrderId: Id,
  intentId: Id,
  providerId: Id,
  mode: FinancialExecutionModeSchema,
  kind: z.enum([
    'CARD_AUTHORIZATION',
    'GIFT_CARD_ORDER',
    'INVOICE_PAYMENT',
    'ONCHAIN_TRANSFER',
  ]),
  providerRef: z.string().max(200).nullable(),
  amount: MoneySchema,
  status: z.enum([
    'PENDING',
    'APPROVED',
    'DECLINED',
    'VOIDED',
    'CLEARED',
    'RETURNED',
  ]),
  declineReason: z.string().max(200).nullable(),
  /** True whenever the network event was simulated (sandbox), not a real authorization. */
  simulated: z.boolean(),
  at: Ts,
});
export type PaymentAuthorization = z.output<typeof PaymentAuthorizationSchema>;

export const LEDGERS = [
  'SIMULATED_PROVIDER_OBLIGATION',
  'REAL_OFFCHAIN_OBLIGATION',
  'PROVIDER_REPORTED_REFUND',
  'CONFIRMED_REFUND',
] as const;
export type LedgerKind = (typeof LEDGERS)[number];

/**
 * The v1.3 refund record. Provider-reported refunds are only claims; a refund
 * is CONFIRMED only from on-chain evidence of value actually returned, and a
 * sandbox refund can never be confirmed into the treasury.
 */
export const SettlementRefundRecordSchema = z.strictObject({
  refundId: Id,
  providerOrderId: Id,
  intentId: Id,
  ledger: z.enum(['PROVIDER_REPORTED_REFUND', 'CONFIRMED_REFUND']),
  mode: FinancialExecutionModeSchema,
  amount: MoneySchema,
  providerRef: z.string().max(200).nullable(),
  onchain: z
    .strictObject({
      chainId: z.number().int().positive(),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .nullable(),
  treasuryCredit: z.boolean(),
  at: Ts,
});
export type SettlementRefundRecord = z.output<
  typeof SettlementRefundRecordSchema
>;

export const LedgerEntrySchema = z.strictObject({
  entryId: Id,
  ledger: z.enum(LEDGERS),
  groupId: Id,
  intentId: Id,
  providerOrderId: Id,
  mode: FinancialExecutionModeSchema,
  amount: MoneySchema,
  at: Ts,
});
export type LedgerEntry = z.output<typeof LedgerEntrySchema>;

export const SettlementReceiptSchema = z.strictObject({
  receiptId: Id,
  intentId: Id,
  groupId: Id,
  providerId: Id,
  providerOrderId: Id,
  providerRefs: z.record(z.string().max(40), z.string().max(200)),
  category: z.enum(EXECUTION_CATEGORIES),
  mode: FinancialExecutionModeSchema,
  label: z.enum([
    'REAL_TESTNET',
    'PROVIDER_SANDBOX',
    'MAINNET_READ_ONLY',
    'SIMULATED',
    'MOCKED',
    'BLOCKED_EXTERNAL',
  ]),
  amount: MoneySchema,
  treasuryEffect: z.enum(['NONE', 'TESTNET_DEBIT', 'REAL_MONEY_DEBIT']),
  /** Human-facing statement; never claims a payment that did not happen. */
  statement: z.string().min(1).max(300),
  createdAt: Ts,
});
export type SettlementReceipt = z.output<typeof SettlementReceiptSchema>;

export class SettlementFabricError extends Error {
  constructor(
    readonly code:
      | 'ORDER_TRANSITION_FORBIDDEN'
      | 'ORDER_CONFLICT'
      | 'SANDBOX_IS_NOT_MERCHANT_SETTLEMENT'
      | 'SANDBOX_REFUND_NOT_TREASURY_CREDIT'
      | 'REFUND_EVIDENCE_REQUIRED'
      | 'REFUND_EXCEEDS_ORDER'
      | 'RECORD_CONFLICT'
      | 'NOT_FOUND'
      | 'STATEMENT_UNTRUTHFUL',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SettlementFabricError';
  }
}

/** Validates an order transition and its mode/economic-effect consistency. */
export function transitionOrder(
  o: ProviderOrder,
  next: ProviderOrderState,
  patch: { providerRef?: string | null; reason?: string | null },
  now: number,
): ProviderOrder {
  if (o.state === next) return o;
  if (!ORDER_TRANSITIONS[o.state].includes(next))
    throw new SettlementFabricError(
      'ORDER_TRANSITION_FORBIDDEN',
      `${o.state} -> ${next}`,
    );
  if (
    next === 'MERCHANT_SETTLED' &&
    (o.mode !== 'REAL_MONEY_APPROVAL_REQUIRED' ||
      o.economicEffect !== 'REAL_MONEY')
  )
    throw new SettlementFabricError(
      'SANDBOX_IS_NOT_MERCHANT_SETTLEMENT',
      `a ${o.mode} order is never a settled merchant order`,
    );
  if (next === 'SANDBOX_FULFILLED' && o.economicEffect !== 'NONE_SANDBOX')
    throw new SettlementFabricError(
      'ORDER_TRANSITION_FORBIDDEN',
      'only no-effect sandbox orders are sandbox-fulfilled',
    );
  if (next === 'TESTNET_SETTLED' && o.mode !== 'TESTNET')
    throw new SettlementFabricError(
      'ORDER_TRANSITION_FORBIDDEN',
      'testnet settlement needs a TESTNET order',
    );
  return {
    ...o,
    state: next,
    providerRef:
      patch.providerRef !== undefined ? patch.providerRef : o.providerRef,
    reason:
      patch.reason !== undefined
        ? (patch.reason?.slice(0, 200) ?? null)
        : o.reason,
    updatedAt: now,
  };
}

/** The ledger an obligation belongs in, decided by mode alone. */
export function obligationLedger(mode: FinancialExecutionMode): LedgerKind {
  return mode === 'REAL_MONEY_APPROVAL_REQUIRED'
    ? 'REAL_OFFCHAIN_OBLIGATION'
    : 'SIMULATED_PROVIDER_OBLIGATION';
}

const FORBIDDEN_CLAIMS = /\b(paid with AUSD|paid with USDC|real money)\b/i;

/** Receipt statement that only states what the mode proves. */
export function receiptStatement(input: {
  category: ExecutionCategory;
  mode: FinancialExecutionMode;
  providerName: string;
}): string {
  const { category, mode, providerName } = input;
  let s: string;
  if (category === 'CARD_NETWORK_SANDBOX' && mode === 'PROVIDER_SANDBOX')
    s =
      'Synq authorized a simulated card payment using an actual card-issuing sandbox';
  else if (category === 'DIGITAL_GOODS_SANDBOX' && mode === 'PROVIDER_SANDBOX')
    s = `Synq placed a gift card order in the ${providerName} sandbox; no money moved and the code is a sandbox code`;
  else if (mode === 'TESTNET')
    s = `Synq settled with testnet tokens via ${providerName}; testnet tokens have no market value`;
  else if (mode === 'MAINNET_READ_ONLY')
    s = `Synq read ${providerName} live data only; nothing was ordered or paid`;
  else if (mode === 'MAINNET_SIMULATION')
    s = `Synq simulated this against ${providerName}; nothing was ordered or paid`;
  else
    s = `${providerName} requires explicit capped human approval; nothing was paid`;
  if (FORBIDDEN_CLAIMS.test(s))
    throw new SettlementFabricError('STATEMENT_UNTRUTHFUL', s);
  return s;
}

export function treasuryEffectFor(
  mode: FinancialExecutionMode,
  effect: EconomicEffect,
): SettlementReceipt['treasuryEffect'] {
  if (mode === 'TESTNET' && effect === 'TESTNET_TOKENS') return 'TESTNET_DEBIT';
  if (mode === 'REAL_MONEY_APPROVAL_REQUIRED' && effect === 'REAL_MONEY')
    return 'REAL_MONEY_DEBIT';
  return 'NONE';
}

export type LedgerTotals = Record<LedgerKind, Record<string, string>>;

export function emptyTotals(): LedgerTotals {
  return {
    SIMULATED_PROVIDER_OBLIGATION: {},
    REAL_OFFCHAIN_OBLIGATION: {},
    PROVIDER_REPORTED_REFUND: {},
    CONFIRMED_REFUND: {},
  };
}
export function addToTotals(t: LedgerTotals, e: LedgerEntry) {
  const k = `${e.amount.currency}/${e.amount.decimals}`;
  t[e.ledger][k] = String(
    BigInt(t[e.ledger][k] ?? '0') + BigInt(e.amount.amount),
  );
}

export const sameMoney = (a: Money, b: Money) =>
  a.amount === b.amount &&
  a.currency === b.currency &&
  a.decimals === b.decimals;
