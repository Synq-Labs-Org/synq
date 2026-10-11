export const BPS = 10_000n;

export function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0 || exp > 77)
    throw new RangeError(`decimal exponent ${exp}`);
  return 10n ** BigInt(exp);
}

export function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// Floor division for signed operands (BigInt `/` truncates toward zero).
export function floorDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  return -floorDiv(-n, d);
}

// value (in `outDecimals` units) of `amount` base units of an asset with
// `amountDecimals`, priced at `price` scaled by `priceDecimals`. Floors toward
// negative infinity, so signed exposures are never overstated in our favour.
export function valueOf(
  amount: bigint,
  amountDecimals: number,
  price: bigint,
  priceDecimals: number,
  outDecimals: number,
): bigint {
  return floorDiv(
    amount * price * pow10(outDecimals),
    pow10(amountDecimals + priceDecimals),
  );
}

export function bpsOf(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  const v = floorDiv(part * BPS, whole);
  return Number(
    v > 10_000_000n ? 10_000_000n : v < -10_000_000n ? -10_000_000n : v,
  );
}

export function applyBps(value: bigint, bps: bigint): bigint {
  return floorDiv(value * bps, BPS);
}
