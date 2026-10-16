import { formatEther, type Address } from 'viem';
import { money, type Money } from '@synq/domain';
import {
  chainProfile,
  token,
  type ChainName,
  type ChainProfile,
} from '@synq/chain-registry/arc';
import { PAYMASTER_SUPPORT } from '@synq/plugin-circle-paymaster';

/**
 * Network-fee planning for Arc and the Circle source chains.
 *
 * Arc: the native gas token is USDC (18 decimals natively, 6 through the
 * 0x3600… ERC-20 view of the same balance). A USDC transfer and its gas draw
 * on one balance, so amount + worst-case fee must fit together, and fee caps
 * respect Arc's 20 gwei base-fee floor. No paymaster is involved.
 *
 * Source chains pay gas in ETH. A wallet without ETH gets a plain message with
 * its options instead of a failed transaction.
 *
 * Gas Station (Circle-sponsored gas for Circle smart-contract wallets) is
 * modelled here: eligibility, the testnet daily cap and sponsorship expiry.
 * It cannot run live without a Circle API key and entity secret.
 */

const NATIVE_PER_USDC_UNIT = 10n ** 12n;
const DEFAULT_PRIORITY_FEE = 1_000_000_000n;

export type GasPlanInput = Readonly<{
  profile: ChainProfile;
  /** Gas limit already including any safety margin. */
  gas: bigint;
  fees: Readonly<{
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
  }>;
  nativeBalance: bigint;
  /**
   * Native value drawn from the same balance as gas. On Arc a USDC transfer
   * of `amount` draws `amount × 10^12` wei; elsewhere an ERC-20 transfer
   * draws nothing native.
   */
  valueWei: bigint;
  maxGasCostWei?: bigint;
}>;

export type GasPlan =
  | Readonly<{
      ok: true;
      gas: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      maxGasCostWei: bigint;
      needWei: bigint;
      /** Arc only: worst-case fee in 6-decimal USDC, rounded up. */
      maxGasCostUsdc: Money | null;
    }>
  | Readonly<{
      ok: false;
      code: 'FEE_BELOW_FLOOR' | 'FEE_ABOVE_CAP' | 'INSUFFICIENT_GAS';
      message: string;
      needWei: bigint;
      shortfallWei: bigint;
    }>;

/**
 * P16-01. Fee selection mirrors the executor: priority defaults to 1 gwei,
 * the max fee is raised to the chain floor and to the priority fee; then
 * value + gas × maxFee must fit the native balance.
 */
export function planNativeGas(input: GasPlanInput): GasPlan {
  const { profile } = input;
  const floor = profile.minMaxFeePerGasWei ?? 0n;
  const maxPriorityFeePerGas =
    input.fees.maxPriorityFeePerGas && input.fees.maxPriorityFeePerGas > 0n
      ? input.fees.maxPriorityFeePerGas
      : DEFAULT_PRIORITY_FEE;
  let maxFeePerGas = input.fees.maxFeePerGas ?? 0n;
  if (maxFeePerGas < floor) maxFeePerGas = floor;
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  const maxGasCostWei = input.gas * maxFeePerGas;
  const needWei = input.valueWei + maxGasCostWei;
  const fail = (
    code: 'FEE_BELOW_FLOOR' | 'FEE_ABOVE_CAP' | 'INSUFFICIENT_GAS',
    message: string,
  ): GasPlan => ({
    ok: false,
    code,
    message,
    needWei,
    shortfallWei:
      needWei > input.nativeBalance ? needWei - input.nativeBalance : 0n,
  });
  if (input.gas <= 0n) return fail('INSUFFICIENT_GAS', 'gas must be positive');
  if (input.valueWei < 0n) return fail('INSUFFICIENT_GAS', 'negative value');
  if (floor && maxFeePerGas < floor)
    return fail('FEE_BELOW_FLOOR', String(maxFeePerGas));
  if (input.maxGasCostWei !== undefined && maxGasCostWei > input.maxGasCostWei)
    return fail('FEE_ABOVE_CAP', `${maxGasCostWei} > ${input.maxGasCostWei}`);
  if (input.nativeBalance < needWei)
    return fail(
      'INSUFFICIENT_GAS',
      `native ${input.nativeBalance} < value+gas ${needWei}`,
    );
  const arc = profile.nativeSymbol === 'USDC';
  return {
    ok: true,
    gas: input.gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxGasCostWei,
    needWei,
    maxGasCostUsdc: arc
      ? money(
          token(profile.name, 'USDC'),
          (maxGasCostWei + NATIVE_PER_USDC_UNIT - 1n) / NATIVE_PER_USDC_UNIT,
        )
      : null,
  };
}

/**
 * The largest Arc USDC amount (6-decimal units) that still leaves room for a
 * transfer's worst-case gas. Never negative.
 */
export function arcMaxSendable(
  nativeBalanceWei: bigint,
  maxGasCostWei: bigint,
) {
  const free = nativeBalanceWei - maxGasCostWei;
  return free > 0n ? free / NATIVE_PER_USDC_UNIT : 0n;
}

// Source chains (P16-06).

export type SourceWalletKind = 'EOA' | 'EIP7702' | 'ERC4337_SCA' | 'CIRCLE_SCA';

export type SourceGasCheck =
  | Readonly<{
      ok: true;
      chain: ChainName;
      mode: 'NATIVE_GAS' | 'ARC_USDC_GAS';
    }>
  | Readonly<{
      ok: false;
      chain: ChainName;
      code: 'NEEDS_NATIVE_GAS';
      needWei: bigint;
      haveWei: bigint;
      /** Shown to the user as is. */
      userMessage: string;
      options: readonly string[];
    }>;

export function sourceGasRequirement(input: {
  chain: ChainName;
  wallet: Address;
  walletKind: SourceWalletKind;
  nativeBalance: bigint;
  estimatedGasWei: bigint;
  /** What the user is trying to do, e.g. "send USDC to Arc via CCTP". */
  action: string;
}): SourceGasCheck {
  const profile = chainProfile(input.chain);
  if (profile.nativeSymbol === 'USDC') {
    return input.nativeBalance >= input.estimatedGasWei
      ? { ok: true, chain: input.chain, mode: 'ARC_USDC_GAS' }
      : {
          ok: false,
          chain: input.chain,
          code: 'NEEDS_NATIVE_GAS',
          needWei: input.estimatedGasWei,
          haveWei: input.nativeBalance,
          userMessage: `Your Arc wallet ${input.wallet} needs about ${formatEther(input.estimatedGasWei)} USDC for network fees to ${input.action}. On Arc, fees are paid in USDC from the same balance.`,
          options: ['Add USDC to this Arc wallet'],
        };
  }
  if (input.nativeBalance >= input.estimatedGasWei)
    return { ok: true, chain: input.chain, mode: 'NATIVE_GAS' };
  const name = chainName(input.chain);
  const paymasterVersions = (['0.8', '0.7'] as const).filter((v) =>
    PAYMASTER_SUPPORT[v].includes(input.chain),
  );
  const options = [
    `Add about ${formatEther(input.estimatedGasWei)} ETH to ${input.wallet} on ${name}`,
  ];
  if (paymasterVersions.length)
    options.push(
      input.walletKind === 'EOA'
        ? `Use a smart account (EIP-7702 or ERC-4337) with Circle Paymaster v${paymasterVersions[0]} on ${name} to pay the fee in USDC`
        : `Pay the fee in USDC with Circle Paymaster v${paymasterVersions[0]} on ${name}`,
    );
  options.push(
    'Pay from a wallet that already holds USDC on Arc (Arc fees are paid in USDC)',
  );
  return {
    ok: false,
    chain: input.chain,
    code: 'NEEDS_NATIVE_GAS',
    needWei: input.estimatedGasWei,
    haveWei: input.nativeBalance,
    userMessage: `Your ${name} wallet ${input.wallet} has ${formatEther(input.nativeBalance)} ETH but needs about ${formatEther(input.estimatedGasWei)} ETH for network fees to ${input.action}. Nothing was sent.`,
    options,
  };
}

function chainName(c: ChainName) {
  return {
    'arc-testnet': 'Arc Testnet',
    'arc-mainnet': 'Arc',
    'eth-sepolia': 'Ethereum Sepolia',
    'base-sepolia': 'Base Sepolia',
    'arb-sepolia': 'Arbitrum Sepolia',
  }[c];
}

// Circle Gas Station (P16-05).

/** Live status in this deployment: no Circle API key / entity secret. */
export const GAS_STATION_LIVE_STATUS = {
  status: 'BLOCKED',
  reason:
    'Gas Station sponsors Circle Wallets transactions only; it needs CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET (absent).',
} as const;

/**
 * Testnet default policy limits (developers.circle.com/wallets/gas-station/
 * policy-management, 2026-10-16): Arc Testnet 50 USDC/day; daily limits reset
 * at 00:00 UTC. Units are the chain's native gas token base units (Arc: 18-dec
 * native USDC).
 */
export const GAS_STATION_TESTNET_DAILY_LIMIT_WEI: Readonly<
  Partial<Record<ChainName, bigint>>
> = {
  'arc-testnet': 50n * 10n ** 18n,
};

export type CircleWalletKind = 'EOA' | 'SCA' | 'MSCA' | 'EIP7702';

export type GasStationPolicy = Readonly<{
  chain: ChainName;
  active: boolean;
  dailyLimitWei: bigint;
  /**
   * Circle documents no credit expiry, only activation. Synq still binds each
   * sponsorship grant to an expiry it sets, and refuses after it.
   */
  grantExpiresAt: number | null;
  blockedAddresses: readonly Address[];
}>;

export type GasStationUsage = { dayStartUtc: number; spentWei: bigint };

export type SponsorshipDecision =
  | Readonly<{
      sponsored: true;
      remainingTodayWei: bigint;
      usage: GasStationUsage;
    }>
  | Readonly<{
      sponsored: false;
      reason:
        | 'INVALID_INPUT'
        | 'NOT_CIRCLE_WALLET'
        | 'NOT_SMART_ACCOUNT'
        | 'UNSUPPORTED_CHAIN'
        | 'POLICY_INACTIVE'
        | 'GRANT_EXPIRED'
        | 'DAILY_LIMIT'
        | 'BLOCKED_ADDRESS';
      fallback: 'USER_PAYS_GAS';
      userMessage: string;
      usage: GasStationUsage;
    }>;

export const utcDayStart = (now: number) => now - (now % 86_400_000);

/** Rolls the usage window at 00:00 UTC. */
export function rollUsage(u: GasStationUsage, now: number): GasStationUsage {
  const day = utcDayStart(now);
  return u.dayStartUtc === day ? u : { dayStartUtc: day, spentWei: 0n };
}

export function decideSponsorship(input: {
  wallet: Address;
  walletKind: CircleWalletKind;
  circleWallet: boolean;
  estimatedFeeWei: bigint;
  policy: GasStationPolicy;
  usage: GasStationUsage;
  now: number;
}): SponsorshipDecision {
  const usage = rollUsage(input.usage, input.now);
  const deny = (
    reason: Extract<SponsorshipDecision, { sponsored: false }>['reason'],
    why: string,
  ): SponsorshipDecision => ({
    sponsored: false,
    reason,
    fallback: 'USER_PAYS_GAS',
    usage,
    userMessage: `Gas sponsorship is not available (${why}). This transaction needs network fees paid by the wallet.`,
  });
  if (
    input.estimatedFeeWei <= 0n ||
    input.usage.spentWei < 0n ||
    input.policy.dailyLimitWei < 0n ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.usage.dayStartUtc) ||
    input.now < input.usage.dayStartUtc
  )
    return deny('INVALID_INPUT', 'invalid fee, usage, policy or clock');
  if (!input.circleWallet)
    return deny(
      'NOT_CIRCLE_WALLET',
      'Gas Station only sponsors Circle Wallets',
    );
  if (input.walletKind !== 'SCA' && input.walletKind !== 'MSCA')
    return deny(
      'NOT_SMART_ACCOUNT',
      'on EVM chains Gas Station requires an ERC-4337 smart-contract account',
    );
  if (GAS_STATION_TESTNET_DAILY_LIMIT_WEI[input.policy.chain] === undefined)
    return deny('UNSUPPORTED_CHAIN', `${input.policy.chain} is not configured`);
  if (!input.policy.active)
    return deny('POLICY_INACTIVE', 'policy is inactive');
  if (
    input.policy.grantExpiresAt !== null &&
    input.now >= input.policy.grantExpiresAt
  )
    return deny('GRANT_EXPIRED', 'the sponsorship grant has expired');
  if (
    input.policy.blockedAddresses.some(
      (a) => a.toLowerCase() === input.wallet.toLowerCase(),
    )
  )
    return deny('BLOCKED_ADDRESS', 'this address is blocked by policy');
  const limit =
    input.policy.dailyLimitWei <
    GAS_STATION_TESTNET_DAILY_LIMIT_WEI[input.policy.chain]!
      ? input.policy.dailyLimitWei
      : GAS_STATION_TESTNET_DAILY_LIMIT_WEI[input.policy.chain]!;
  if (usage.spentWei + input.estimatedFeeWei > limit)
    return deny(
      'DAILY_LIMIT',
      'today’s sponsorship limit is used up; it resets at 00:00 UTC',
    );
  const next = {
    dayStartUtc: usage.dayStartUtc,
    spentWei: usage.spentWei + input.estimatedFeeWei,
  };
  return {
    sponsored: true,
    remainingTodayWei: limit - next.spentWei,
    usage: next,
  };
}
