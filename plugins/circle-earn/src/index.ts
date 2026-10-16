export * from './allocation-reserves.js';
import { z } from 'zod';
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { money, moneyToDecimal, type Money } from '@synq/domain';
import {
  CHAINS,
  contract,
  token,
  usdcToArcNativeWei,
  type ContractKind,
} from '@synq/chain-registry/arc';
import {
  appKitAdapter,
  kitDecimalToUnits,
  type KitStep,
} from '@synq/plugin-circle-app-kit';

/**
 * Circle App Kit Earn on Arc testnet: vault discovery, quote hygiene, the
 * yield decision gate and share accounting. Planner-side and pure: the kit
 * call and every signature happen in a script or the executor, which feeds
 * raw kit output in here and signs only what `earnTxPlan` allows.
 *
 * Rules enforced here:
 * - A vault is usable only if it is pinned in the registry and both the
 *   provider metadata and the vault's own `asset()` say its underlying is Arc
 *   USDC (0x3600…, 6 decimals).
 * - APY is a variable observation with `observedAt`; it is never described as
 *   guaranteed, and a stale observation cannot justify a deposit.
 * - Money owed soon (payroll, rent) blocks a deposit through `YieldReservePort`
 *   (implemented by `@synq/allocations`); an unknown answer also blocks.
 * - Shares and assets reconcile exactly; on Arc, gas comes out of the same USDC
 *   balance, so the round trip is checked in 18-decimal native wei.
 */

export class EarnError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_CHAIN'
      | 'UNREGISTERED_VAULT'
      | 'UNDERLYING_MISMATCH'
      | 'CODE_HASH_MISMATCH'
      | 'MALFORMED_QUOTE'
      | 'WITHDRAWAL_RESTRICTED'
      | 'ACCOUNTING',
    message: string = code,
  ) {
    super(message);
    this.name = 'EarnError';
  }
}

const VAULT_KINDS = [
  'CIRCLE_EARN_VAULT_USDC',
  'CIRCLE_EARN_VAULT_MOCK_MORPHO',
] as const satisfies readonly ContractKind[];

/** Vaults this deployment may touch: the registry pins, nothing else. */
export function registeredVaults() {
  return VAULT_KINDS.map((kind) => ({
    ...contract('arc-testnet', kind),
    kind,
  }));
}

export function registeredVault(address: string) {
  const v = registeredVaults().find((x) =>
    isAddressEqual(x.address, address as Address),
  );
  if (!v)
    throw new EarnError(
      'UNREGISTERED_VAULT',
      `${address} is not a registry-pinned Earn vault`,
    );
  return v;
}

const Decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);

/** Shape returned by `EarnKit.exploreVaults` (extra fields are ignored). */
export const KitVaultSchema = z.looseObject({
  vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chain: z.string(),
  name: z.string().max(200),
  protocol: z.string().max(64),
  asset: z.string().max(16),
  assetAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  currentApy: z.number().min(0).max(10),
  vaultFee: z.number().min(0).max(1).optional(),
  status: z.string(),
  circleGuarded: z.boolean().optional(),
  asOf: z.string().optional(),
  totalDeposits: Decimal.optional(),
  liquidity: Decimal.optional(),
  apyProfile: z
    .looseObject({ source: z.string().optional(), asOf: z.string().optional() })
    .optional(),
  riskSignals: z
    .looseObject({
      circleSentinel: z.boolean().optional(),
      warnings: z.array(z.unknown()).optional(),
      earnKitWarnings: z.array(z.unknown()).optional(),
    })
    .optional(),
});

/** A variable-rate observation. `guaranteed` is a type-level `false`. */
export type ApyQuote = Readonly<{
  apyBps: number;
  /** When Synq fetched it (ms). Freshness is judged from this. */
  observedAt: number;
  /** The provider's own `asOf` (ms), when given. */
  providerAsOf: number | null;
  source: string;
  guaranteed: false;
}>;

export type EarnVault = Readonly<{
  address: Address;
  kind: (typeof VAULT_KINDS)[number];
  chainId: number;
  name: string;
  protocol: string;
  underlying: ReturnType<typeof token>;
  active: boolean;
  circleGuarded: boolean;
  /** Circle test vault on a testnet: APY and TVL are illustrative. */
  testVault: boolean;
  apy: ApyQuote;
  risk: Readonly<{
    warnings: readonly string[];
    reportedTotalDeposits: string | null;
    reportedLiquidity: string | null;
    vaultFeeBps: number;
  }>;
}>;

const KIT_CHAIN = { Arc_Testnet: 'arc-testnet' } as const;

export function normalizeVault(
  raw: unknown,
  opts: { observedAt: number },
): EarnVault {
  const v = KitVaultSchema.parse(raw);
  const chainName = KIT_CHAIN[v.chain as keyof typeof KIT_CHAIN];
  if (!chainName)
    throw new EarnError(
      'UNSUPPORTED_CHAIN',
      `${v.chain}: only Arc testnet vaults are enabled`,
    );
  const pinned = registeredVault(v.vaultAddress);
  const usdc = token(chainName, 'USDC');
  if (
    !isAddressEqual(v.assetAddress as Address, usdc.address) ||
    v.asset !== 'USDC'
  )
    throw new EarnError(
      'UNDERLYING_MISMATCH',
      `vault underlying ${v.asset}@${v.assetAddress} is not Arc USDC`,
    );
  const asOf = v.apyProfile?.asOf ?? v.asOf;
  const providerAsOf = asOf ? Date.parse(asOf) : NaN;
  const warnings = [
    ...(v.riskSignals?.warnings ?? []),
    ...(v.riskSignals?.earnKitWarnings ?? []),
  ].map((w) => (typeof w === 'string' ? w : JSON.stringify(w)).slice(0, 200));
  if (v.riskSignals?.circleSentinel) warnings.push('CIRCLE_SENTINEL_FLAG');
  return Object.freeze({
    address: getAddress(v.vaultAddress),
    kind: pinned.kind,
    chainId: CHAINS[chainName].chainId,
    name: v.name,
    protocol: v.protocol,
    underlying: usdc,
    active: v.status === 'active',
    circleGuarded: v.circleGuarded === true,
    testVault:
      CHAINS[chainName].environment === 'ARC_TESTNET' ||
      /mock|test/i.test(v.name),
    apy: Object.freeze({
      apyBps: Math.round(v.currentApy * 10_000),
      observedAt: opts.observedAt,
      providerAsOf: Number.isFinite(providerAsOf) ? providerAsOf : null,
      source: v.apyProfile?.source ?? 'circle-earn-kit',
      guaranteed: false as const,
    }),
    risk: Object.freeze({
      warnings,
      reportedTotalDeposits: v.totalDeposits ?? null,
      reportedLiquidity: v.liquidity ?? null,
      vaultFeeBps: Math.round((v.vaultFee ?? 0) * 10_000),
    }),
  });
}

/**
 * What the vault contract itself says, read by the caller (script/indexer).
 * Provider metadata is never enough: the on-chain `asset()` and the code hash
 * must match before a deposit is planned.
 */
export type VaultChainFacts = Readonly<{
  asset: Address;
  shareDecimals: number;
  codeHash: Hex;
}>;

export function assertVaultOnChain(vault: EarnVault, facts: VaultChainFacts) {
  const pinned = registeredVault(vault.address);
  if (pinned.codeHash && facts.codeHash.toLowerCase() !== pinned.codeHash)
    throw new EarnError(
      'CODE_HASH_MISMATCH',
      `${vault.address} code ${facts.codeHash} != pinned ${pinned.codeHash}`,
    );
  if (!isAddressEqual(facts.asset, vault.underlying.address))
    throw new EarnError(
      'UNDERLYING_MISMATCH',
      `on-chain asset() ${facts.asset} is not Arc USDC`,
    );
  return true;
}

export const APY_MAX_AGE_MS = 5 * 60_000;
export const PROVIDER_MAX_AGE_MS = 24 * 3_600_000;

export type ApyFreshness =
  | { fresh: true }
  | { fresh: false; reason: 'STALE_APY' | 'FUTURE_APY' | 'NO_PROVIDER_TIME' };

/** P15-04: a quote is usable only while recent, by our clock and theirs. */
export function apyFreshness(
  q: ApyQuote,
  now: number,
  maxAgeMs = APY_MAX_AGE_MS,
  providerMaxAgeMs = PROVIDER_MAX_AGE_MS,
): ApyFreshness {
  if (q.observedAt > now || (q.providerAsOf ?? 0) > now + 60_000)
    return { fresh: false, reason: 'FUTURE_APY' };
  if (now - q.observedAt > maxAgeMs)
    return { fresh: false, reason: 'STALE_APY' };
  if (q.providerAsOf === null)
    return { fresh: false, reason: 'NO_PROVIDER_TIME' };
  if (now - q.providerAsOf > providerMaxAgeMs)
    return { fresh: false, reason: 'STALE_APY' };
  return { fresh: true };
}

export function describeApy(q: ApyQuote): string {
  const pct = (q.apyBps / 100).toFixed(2);
  return `${pct}% variable APY observed ${new Date(q.observedAt).toISOString()} (${q.source}); not guaranteed, can change or go to zero`;
}

/**
 * Port for the cash floor (P15-07). `@synq/allocations` implements it from due
 * payroll, rent and other reserved obligations; the integrator wires it.
 */
export interface YieldReservePort {
  canDeployToYield(req: {
    amount: Money;
    at: number;
  }): Promise<
    | { allowed: true; freeAfter?: Money }
    | { allowed: false; reason: string; dueReserve?: Money }
  >;
}

export type YieldPolicy = Readonly<{
  minApyBps: number;
  maxDeposit: Money;
  apyMaxAgeMs?: number;
  providerMaxAgeMs?: number;
  /** Testnet proofs may use Circle test vaults; production policy must not. */
  allowTestVaults: boolean;
}>;

export type YieldRejection =
  | 'VAULT_INACTIVE'
  | 'TEST_VAULT_NOT_ALLOWED'
  | 'RISK_WARNINGS'
  | 'ASSET_MISMATCH'
  | 'NON_POSITIVE_AMOUNT'
  | 'AMOUNT_ABOVE_CAP'
  | 'STALE_APY'
  | 'FUTURE_APY'
  | 'NO_PROVIDER_TIME'
  | 'BELOW_MIN_APY'
  | 'RESERVES_DUE'
  | 'RESERVES_UNKNOWN';

export type YieldDecision =
  | Readonly<{
      decision: 'DEPOSIT';
      vault: Address;
      amount: Money;
      apy: ApyQuote;
      justification: string;
    }>
  | Readonly<{ decision: 'REJECT'; reason: YieldRejection; detail: string }>;

/**
 * The only path to a yield deposit decision. Deterministic given its inputs;
 * the reserve port is consulted last so that cheap local checks fail first,
 * and any error from it rejects (fail closed).
 */
export async function decideYieldDeposit(input: {
  vault: EarnVault;
  amount: Money;
  now: number;
  policy: YieldPolicy;
  reserves: YieldReservePort;
}): Promise<YieldDecision> {
  const { vault, amount, now, policy } = input;
  const reject = (reason: YieldRejection, detail: string): YieldDecision => ({
    decision: 'REJECT',
    reason,
    detail,
  });
  if (!vault.active) return reject('VAULT_INACTIVE', vault.name);
  if (vault.testVault && !policy.allowTestVaults)
    return reject('TEST_VAULT_NOT_ALLOWED', vault.name);
  if (vault.risk.warnings.length)
    return reject('RISK_WARNINGS', vault.risk.warnings.join('; '));
  if (amount.asset.assetId !== vault.underlying.assetId)
    return reject('ASSET_MISMATCH', amount.asset.assetId);
  if (amount.baseUnits <= 0n) return reject('NON_POSITIVE_AMOUNT', '0');
  if (
    policy.maxDeposit.asset.assetId !== amount.asset.assetId ||
    amount.baseUnits > policy.maxDeposit.baseUnits
  )
    return reject('AMOUNT_ABOVE_CAP', `${moneyToDecimal(amount)} USDC`);
  const f = apyFreshness(
    vault.apy,
    now,
    policy.apyMaxAgeMs,
    policy.providerMaxAgeMs,
  );
  if (!f.fresh)
    return reject(
      f.reason,
      `observed ${new Date(vault.apy.observedAt).toISOString()}`,
    );
  if (vault.apy.apyBps < policy.minApyBps)
    return reject('BELOW_MIN_APY', `${vault.apy.apyBps} bps`);
  let gate;
  try {
    gate = await input.reserves.canDeployToYield({ amount, at: now });
  } catch (error) {
    return reject(
      'RESERVES_UNKNOWN',
      String(error instanceof Error ? error.message : error).slice(0, 200),
    );
  }
  if (!gate.allowed) return reject('RESERVES_DUE', gate.reason);
  return {
    decision: 'DEPOSIT',
    vault: vault.address,
    amount,
    apy: vault.apy,
    justification: `${vault.name}: ${describeApy(vault.apy)}`,
  };
}

/** Kit deposit/withdraw quote normalised to integer units. */
export const KitDepositQuoteSchema = z.looseObject({
  vaultAddress: z.string(),
  deposit: z.looseObject({ symbol: z.literal('USDC'), amount: Decimal }),
  expectedShares: z.looseObject({ amount: Decimal }),
  sharePrice: Decimal.optional(),
  fees: z.array(z.looseObject({ amount: Decimal.optional() })).default([]),
});

export type DepositQuote = Readonly<{
  vault: Address;
  assetsIn: Money;
  expectedShares: bigint;
  observedAt: number;
  feeCount: number;
}>;

export function normalizeDepositQuote(
  raw: unknown,
  opts: { shareDecimals: number; observedAt: number },
): DepositQuote {
  const q = KitDepositQuoteSchema.parse(raw);
  registeredVault(q.vaultAddress);
  const usdc = token('arc-testnet', 'USDC');
  return Object.freeze({
    vault: getAddress(q.vaultAddress),
    assetsIn: money(usdc, kitDecimalToUnits(q.deposit.amount, usdc.decimals)),
    expectedShares: kitDecimalToUnits(
      q.expectedShares.amount,
      opts.shareDecimals,
    ),
    observedAt: opts.observedAt,
    feeCount: q.fees.length,
  });
}

/**
 * Withdrawal restrictions: a withdrawal is bounded by the provider's
 * `maxWithdrawable` and by what the held shares are worth on chain
 * (`previewRedeem(balanceOf)`); the smaller wins. ERC-4626 `maxWithdraw` is
 * not used: Circle's Arc test vault reports 0 there while the kit's Adapter
 * path redeems normally.
 */
export function assertWithdrawable(input: {
  requested: bigint;
  positionValue: bigint;
  providerMaxWithdrawable: bigint;
}) {
  const cap =
    input.providerMaxWithdrawable < input.positionValue
      ? input.providerMaxWithdrawable
      : input.positionValue;
  if (input.requested <= 0n || input.requested > cap)
    throw new EarnError(
      'WITHDRAWAL_RESTRICTED',
      `requested ${input.requested} > withdrawable ${cap}`,
    );
  return cap;
}

/** Transactions the kit may ask the owner to sign for a deposit. */
export function earnDepositPlan(input: {
  owner: Address;
  vault: EarnVault;
  assetsIn: bigint;
  minShares: bigint;
  /** Circle fee in USDC from the deposit quote (0 when none). */
  maxFee: bigint;
  nowSec: bigint;
}): KitStep[] {
  const usdc = input.vault.underlying.address;
  const adapter = appKitAdapter();
  return [
    {
      kind: 'ALLOWANCE',
      token: usdc,
      spender: adapter,
      // The kit rounds the allowance up by one base unit.
      maxAmount: input.assetsIn + 1n,
      optional: true,
    },
    {
      kind: 'EXECUTE',
      adapter,
      beneficiary: input.owner,
      tokenIn: usdc,
      maxAmountIn: input.assetsIn + 1n,
      tokenOut: input.vault.address,
      minOut: input.minShares,
      maxFeeIn: input.maxFee,
      allowedTokens: [usdc, input.vault.address],
      nowSec: input.nowSec,
      maxDeadlineAheadSec: 3_600n,
    },
  ];
}

/** Transactions the kit may ask the owner to sign for a withdrawal. */
export function earnWithdrawPlan(input: {
  owner: Address;
  vault: EarnVault;
  maxShares: bigint;
  minAssets: bigint;
  /** Circle fee in vault shares' input token from the withdrawal quote. */
  maxFee: bigint;
  nowSec: bigint;
}): KitStep[] {
  const usdc = input.vault.underlying.address;
  const adapter = appKitAdapter();
  return [
    {
      kind: 'ALLOWANCE',
      token: input.vault.address,
      spender: adapter,
      // Same one-unit round-up as deposits; a transfer can never exceed the
      // shares actually held.
      maxAmount: input.maxShares + 1n,
      optional: true,
    },
    {
      kind: 'EXECUTE',
      adapter,
      beneficiary: input.owner,
      tokenIn: input.vault.address,
      maxAmountIn: input.maxShares + 1n,
      tokenOut: usdc,
      minOut: input.minAssets,
      maxFeeIn: input.maxFee,
      allowedTokens: [usdc, input.vault.address],
      nowSec: input.nowSec,
      maxDeadlineAheadSec: 3_600n,
    },
  ];
}

/**
 * Share position for one vault and one owner. Every deposit/withdrawal is
 * recorded from on-chain deltas (not quotes); `reconcile` compares the book to
 * the vault's `balanceOf` exactly.
 */
export class VaultShareLedger {
  shares = 0n;
  principalIn = 0n;
  principalOut = 0n;
  readonly entries: {
    kind: 'DEPOSIT' | 'WITHDRAW';
    assets: bigint;
    shares: bigint;
    txHash: Hex;
  }[] = [];

  constructor(
    readonly vault: Address,
    readonly owner: Address,
    openingShares = 0n,
  ) {
    if (openingShares < 0n) throw new EarnError('ACCOUNTING', 'negative');
    this.shares = openingShares;
  }

  deposit(assets: bigint, sharesMinted: bigint, txHash: Hex) {
    if (assets <= 0n || sharesMinted <= 0n)
      throw new EarnError('ACCOUNTING', 'deposit must mint shares for assets');
    if (this.entries.some((e) => e.txHash === txHash))
      throw new EarnError('ACCOUNTING', `duplicate ${txHash}`);
    this.shares += sharesMinted;
    this.principalIn += assets;
    this.entries.push({
      kind: 'DEPOSIT',
      assets,
      shares: sharesMinted,
      txHash,
    });
  }

  withdraw(assets: bigint, sharesBurned: bigint, txHash: Hex) {
    if (sharesBurned <= 0n || sharesBurned > this.shares)
      throw new EarnError(
        'ACCOUNTING',
        `burn ${sharesBurned} exceeds held ${this.shares}`,
      );
    if (this.entries.some((e) => e.txHash === txHash))
      throw new EarnError('ACCOUNTING', `duplicate ${txHash}`);
    this.shares -= sharesBurned;
    this.principalOut += assets;
    this.entries.push({
      kind: 'WITHDRAW',
      assets,
      shares: sharesBurned,
      txHash,
    });
  }

  reconcile(onchainShares: bigint) {
    if (onchainShares !== this.shares)
      throw new EarnError(
        'ACCOUNTING',
        `book ${this.shares} shares != vault balanceOf ${onchainShares}`,
      );
    return true;
  }

  /** Realised result once flat: positive is yield, negative is rounding/fees. */
  realised(): bigint {
    if (this.shares !== 0n)
      throw new EarnError('ACCOUNTING', 'position still open');
    return this.principalOut - this.principalIn;
  }
}

/**
 * P15-03 on Arc: one USDC balance pays both principal and gas. The wallet's
 * native wei must move by exactly −deposit −fees +withdrawal (no rounding),
 * and the vault position must return to its opening share balance.
 */
export function reconcileRoundTrip(input: {
  nativeBeforeWei: bigint;
  nativeAfterWei: bigint;
  feesWei: readonly bigint[];
  deposited: Money;
  withdrawn: Money;
  sharesBefore: bigint;
  sharesAfter: bigint;
  sharesMinted: bigint;
  sharesBurned: bigint;
}) {
  const fees = input.feesWei.reduce((a, b) => a + b, 0n);
  const expectedAfter =
    input.nativeBeforeWei -
    fees -
    usdcToArcNativeWei(input.deposited) +
    usdcToArcNativeWei(input.withdrawn);
  const walletDeltaWei = input.nativeAfterWei - expectedAfter;
  const shareDelta =
    input.sharesAfter -
    input.sharesBefore -
    (input.sharesMinted - input.sharesBurned);
  return {
    ok: walletDeltaWei === 0n && shareDelta === 0n,
    walletDeltaWei,
    shareDelta,
    feesWei: fees,
    netYieldUnits: input.withdrawn.baseUnits - input.deposited.baseUnits,
  };
}
