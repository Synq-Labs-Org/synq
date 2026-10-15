/**
 * Chain-and-precision-explicit money for the Arc build. Every amount is an
 * integer count of base units of one concrete asset on one concrete network;
 * JavaScript numbers never carry money. Assets come only from a registry
 * (see `@synq/chain-registry/arc`): callers, including model output, cannot
 * mint an asset identity from a free-form string.
 */

export type Caip2 = `eip155:${number}`;

/** Where a financial effect happened; sandbox and testnet ledgers never mix with real money. */
export const SETTLEMENT_ENVIRONMENTS = [
  'LOCAL_SIM',
  'ANVIL_ARC_FORK',
  'ARC_TESTNET',
  'CIRCLE_SANDBOX',
  'CCTP_TESTNET_ROUTE',
  'GATEWAY_TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'CANARY_READY_AWAITING_HUMAN',
  'ARC_MAINNET_CANARY',
  'REAL_MAINNET',
  'LEGACY_MONAD_TESTNET',
] as const;
export type SettlementEnvironment = (typeof SETTLEMENT_ENVIRONMENTS)[number];

/** Evidence ladder for a capability; levels cannot be skipped. */
export const PROOF_LEVELS = [
  'NOT_STARTED',
  'IMPLEMENTED',
  'FIXTURE_TESTED',
  'SANDBOX_PROVEN',
  'ARC_TESTNET_PROVEN',
  'SECURITY_REVIEWED',
  'CANARY_READY_AWAITING_HUMAN',
  'ARC_MAINNET_PROVEN',
] as const;
export type ProofLevel = (typeof PROOF_LEVELS)[number];

/**
 * One asset on one network. `canonical` names the economic asset (USDC is USDC
 * whether read through Arc's 18-decimal native view or its 6-decimal ERC-20
 * view); `assetId` is the CAIP-19 identity of the interface the amount is in.
 */
export type AssetRef = Readonly<{
  assetId: string;
  network: Caip2;
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  canonical: string;
  decimals: number;
  environment: SettlementEnvironment;
}>;

export type Money = Readonly<{ asset: AssetRef; baseUnits: bigint }>;

export class AmountError extends Error {
  constructor(
    readonly code:
      | 'ASSET_MISMATCH'
      | 'NOT_AN_INTEGER'
      | 'NEGATIVE_AMOUNT'
      | 'BAD_DECIMAL'
      | 'TOO_PRECISE'
      | 'UNKNOWN_CHAIN'
      | 'UNKNOWN_ASSET'
      | 'LEGACY_UNSUPPORTED',
    message: string = code,
  ) {
    super(message);
    this.name = 'AmountError';
  }
}

export const caip2 = (chainId: number): Caip2 => `eip155:${chainId}`;

export const assetKey = (a: Pick<AssetRef, 'network' | 'address'>) =>
  `${a.network}/erc20:${a.address.toLowerCase()}`;

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return (
    a.network === b.network &&
    a.address.toLowerCase() === b.address.toLowerCase() &&
    a.decimals === b.decimals
  );
}

export function money(asset: AssetRef, baseUnits: bigint): Money {
  if (typeof baseUnits !== 'bigint')
    throw new AmountError('NOT_AN_INTEGER', 'money takes bigint base units');
  return { asset, baseUnits };
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Exact decimal string → base units; rejects floats, signs and excess precision. */
export function moneyFromDecimal(asset: AssetRef, value: string): Money {
  if (typeof value !== 'string' || !DECIMAL.test(value))
    throw new AmountError(
      'BAD_DECIMAL',
      `not a decimal string: ${String(value)}`,
    );
  const [whole, frac = ''] = value.split('.');
  const digits = frac.replace(/^\./, '');
  if (digits.length > asset.decimals)
    throw new AmountError(
      'TOO_PRECISE',
      `${asset.symbol} has ${asset.decimals} decimals`,
    );
  const units =
    BigInt(whole!) * 10n ** BigInt(asset.decimals) +
    BigInt(
      (digits + '0'.repeat(asset.decimals)).slice(0, asset.decimals) || '0',
    );
  return money(asset, units);
}

export function moneyToDecimal(m: Money): string {
  const d = BigInt(m.asset.decimals);
  const sign = m.baseUnits < 0n ? '-' : '';
  const abs = m.baseUnits < 0n ? -m.baseUnits : m.baseUnits;
  const whole = abs / 10n ** d;
  const frac = (abs % 10n ** d)
    .toString()
    .padStart(m.asset.decimals, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

function same(a: Money, b: Money) {
  if (!sameAsset(a.asset, b.asset))
    throw new AmountError(
      'ASSET_MISMATCH',
      `${a.asset.assetId} vs ${b.asset.assetId}`,
    );
}

export function addMoney(a: Money, b: Money): Money {
  same(a, b);
  return money(a.asset, a.baseUnits + b.baseUnits);
}

export function subMoney(a: Money, b: Money): Money {
  same(a, b);
  return money(a.asset, a.baseUnits - b.baseUnits);
}

/** Subtraction that may not go below zero (balances, amounts due). */
export function subMoneyNonNegative(a: Money, b: Money): Money {
  const r = subMoney(a, b);
  if (r.baseUnits < 0n)
    throw new AmountError('NEGATIVE_AMOUNT', moneyToDecimal(r));
  return r;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.baseUnits < b.baseUnits ? -1 : a.baseUnits > b.baseUnits ? 1 : 0;
}

export function isZero(m: Money): boolean {
  return m.baseUnits === 0n;
}
