import { formatUnits, parseUnits } from 'viem';

export const NETWORK_LABEL = 'Arc testnet';

/** Integer base units to a readable decimal string. Never goes through Number. */
export function formatAmount(units: string, decimals: number): string {
  const raw = formatUnits(BigInt(units), decimals);
  const [whole = '0', fraction = ''] = raw.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const padded = fraction.padEnd(Math.min(2, decimals), '0');
  return padded ? `${grouped}.${padded}` : grouped;
}

export function formatMoney(m: {
  units: string;
  decimals: number;
  symbol: string;
}): string {
  return `${formatAmount(m.units, m.decimals)} ${m.symbol}`;
}

/** Spendable is settled minus reserved, never below zero. */
export function spendableUnits(settled: string, reserved: string): string {
  const value = BigInt(settled) - BigInt(reserved);
  return (value < 0n ? 0n : value).toString();
}

/** A decimal USDC string such as "12.5" to base-unit string, or null if invalid. */
export function toBaseUnits(input: string, decimals: number): string | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  return parseUnits(trimmed, decimals).toString();
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

export function safeHttpsUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
