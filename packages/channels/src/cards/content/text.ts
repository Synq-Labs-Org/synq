import type { CardMoney } from '@synq/schemas';

/*
 * Text helpers for card content: exact amounts (or explicitly approximate
 * fits), shortened references, dates and ages. Typographic separators live
 * here so per-type content code never spells them out.
 */

/** Separator between facts on one line. */
export const SEP = ' · ';
/** Direction between two places or parties. */
export const ARROW = ' → ';
/** Marks an elided middle or tail. */
export const ELLIPSIS = '…';
/** Placeholder for an absent value. */
export const NONE = '—';

export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max
    ? s
    : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}${ELLIPSIS}`;
}
export const shortHex = (v: string, head = 6, tail = 4) =>
  v.length > head + tail + 1
    ? `${v.slice(0, head)}${ELLIPSIS}${v.slice(-tail)}`
    : v;

/** Groups the integer part with thousands separators; the fraction is kept exactly. */
export function groupDigits(amount: string): string {
  const [i = '0', f] = amount.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${grouped}.${f}` : grouped;
}

const UNITS = ['K', 'M', 'B', 'T'];
const APPROX = '≈ ';
/**
 * Exact grouped amount when it fits in `maxChars`; otherwise an explicitly
 * approximate compact form ("≈ 1.23B"), never a silently cut-off figure.
 * The caption next to the image always carries the exact amount.
 */
export function displayAmount(amount: string, maxChars: number): string {
  const exact = groupDigits(amount);
  if (exact.length <= maxChars) return exact;
  const [i = '0', f = ''] = amount.split('.');
  if (i.length <= 3) {
    const keep = Math.max(0, maxChars - i.length - 3);
    return keep > 0 ? `${APPROX}${i}.${f.slice(0, keep)}` : `${APPROX}${i}`;
  }
  const tier = Math.floor((i.length - 1) / 3);
  if (tier > 4) return `${APPROX}${i[0]}.${i.slice(1, 3)}e${i.length - 1}`;
  const head = i.slice(0, i.length - tier * 3);
  const frac = i.slice(head.length, head.length + 2).replace(/0+$/, '');
  return `${APPROX}${head}${frac ? `.${frac}` : ''}${UNITS[tier - 1]}`;
}
/** Fiat and stablecoins shown with at least two decimals (cents). */
const CENTS = new Set([
  'USD',
  'EUR',
  'GBP',
  'INR',
  'SGD',
  'AUD',
  'CAD',
  'USDC',
  'AUSD',
  'EURC',
  'USDT',
  'PYUSD',
]);
/**
 * The exact amount string, padded with trailing zeros to two decimals for
 * cent currencies ("254.3" → "254.30"). Never rounds or drops a digit.
 */
export function moneyAmount(m: CardMoney): string {
  if (!CENTS.has(m.symbol.toUpperCase())) return m.amount;
  const [i, f = ''] = m.amount.split('.');
  return f.length >= 2 ? m.amount : `${i}.${f.padEnd(2, '0')}`;
}
export const moneyFit = (m: CardMoney, maxChars: number) =>
  `${displayAmount(moneyAmount(m), maxChars)} ${m.symbol}`;

/** Exact decimal → fixed-point bigint at 18 decimals (drawing proportions only). */
export function scaled(amount: string): bigint {
  const [i = '0', f = ''] = amount.split('.');
  return (
    BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')
  );
}
export function ratio(part: string, whole: string): number {
  const w = scaled(whole);
  if (w <= 0n) return 0;
  const r = Number((scaled(part) * 10_000n) / w) / 10_000;
  return Math.max(0, Math.min(1, r));
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export const when = (seconds: number) => {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return NONE;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)} UTC`;
};
/** "2026-12-05" → "5 Dec". */
export const dayLabel = (day: string) => {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
};
/** "3m", "2h 5m", "4d": compact ages for freshness labels. */
export function ageLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)}h${m ? ` ${m}m` : ''}`;
  }
  return `${Math.floor(s / 86_400)}d`;
}
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
/** "IN_PROGRESS" → "IN PROGRESS". */
export const words = (s: string) => s.replace(/_/g, ' ');
/** "DESTINATION_CHANGED" → "Destination changed". */
export const sentence = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, ' ');
