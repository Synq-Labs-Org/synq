import { z } from 'zod';
import { AmountSchema } from '@synq/schemas';
import { formatDecimal, parseDecimal } from '@synq/domain';

export const CurrencySchema = z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/);
export const MoneySchema = z.strictObject({
  amount: AmountSchema,
  currency: CurrencySchema,
  decimals: z.number().int().min(0).max(18),
});
export type Money = z.output<typeof MoneySchema>;

export const FxRateSchema = z.strictObject({
  from: CurrencySchema,
  to: CurrencySchema,
  numerator: AmountSchema,
  denominator: AmountSchema.refine((v) => BigInt(v) > 0n, 'zero denominator'),
  source: z.string().min(1).max(64),
  observedAt: z.number().int().nonnegative(),
});
export type FxRate = z.output<typeof FxRateSchema>;

export class MoneyMismatchError extends Error {
  constructor(a: Money, b: Money) {
    super(
      `MONEY_MISMATCH: ${a.currency}/${a.decimals} vs ${b.currency}/${b.decimals}`,
    );
    this.name = 'MoneyMismatchError';
  }
}

export const money = (amount: bigint, currency: string, decimals: number) =>
  MoneySchema.parse({ amount: amount.toString(), currency, decimals });

export const zero = (currency: string, decimals: number): Money =>
  money(0n, currency, decimals);

export function fromDecimal(
  value: string,
  currency: string,
  decimals: number,
): Money {
  return money(parseDecimal(value, decimals), currency, decimals);
}

export const toDecimal = (m: Money) =>
  formatDecimal(BigInt(m.amount), m.decimals);

export function sameUnit(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.decimals === b.decimals;
}

function unit(a: Money, b: Money) {
  if (!sameUnit(a, b)) throw new MoneyMismatchError(a, b);
}

export function add(a: Money, ...rest: Money[]): Money {
  let total = BigInt(a.amount);
  for (const b of rest) {
    unit(a, b);
    total += BigInt(b.amount);
  }
  return money(total, a.currency, a.decimals);
}

export function sub(a: Money, b: Money): Money {
  unit(a, b);
  const v = BigInt(a.amount) - BigInt(b.amount);
  if (v < 0n) throw new RangeError('NEGATIVE_MONEY');
  return money(v, a.currency, a.decimals);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  unit(a, b);
  const x = BigInt(a.amount);
  const y = BigInt(b.amount);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function rescale(
  amount: bigint,
  from: number,
  to: number,
  round: 'up' | 'down' = 'up',
): bigint {
  if (from === to) return amount;
  if (from < to) return amount * 10n ** BigInt(to - from);
  const d = 10n ** BigInt(from - to);
  const q = amount / d;
  return round === 'up' && q * d !== amount ? q + 1n : q;
}

/** Converts conservatively (rounds up) so a budget check never understates cost. */
export function convert(
  m: Money,
  target: { currency: string; decimals: number },
  rates: readonly FxRate[],
): Money {
  if (m.currency === target.currency)
    return money(
      rescale(BigInt(m.amount), m.decimals, target.decimals),
      target.currency,
      target.decimals,
    );
  const rate = rates.find(
    (r) => r.from === m.currency && r.to === target.currency,
  );
  if (!rate)
    throw new Error(`FX_RATE_MISSING: ${m.currency}->${target.currency}`);
  const num = BigInt(m.amount) * BigInt(rate.numerator);
  const den = BigInt(rate.denominator);
  const scaledNum = num * 10n ** BigInt(target.decimals);
  const scaledDen = den * 10n ** BigInt(m.decimals);
  const q = scaledNum / scaledDen;
  const out = q * scaledDen === scaledNum ? q : q + 1n;
  return money(out, target.currency, target.decimals);
}

export function applyBps(m: Money, bps: number, round: 'up' | 'down' = 'down') {
  const n = BigInt(m.amount) * BigInt(bps);
  const q = n / 10_000n;
  const v = round === 'up' && q * 10_000n !== n ? q + 1n : q;
  return money(v, m.currency, m.decimals);
}
