import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { profileForChainId } from '@synq/chain-registry';
import type {
  CardMoney,
  CardOf,
  ExecutionMode,
  InteractiveCard,
} from '@synq/schemas';

/*
 * Card banners: one PNG per canonical card, drawn only from the card's own
 * fields (amounts as the backend's exact decimal strings, addresses and
 * hashes shortened). Fonts are bundled; nothing is fetched at render time.
 * Bar and ring proportions are computed for drawing only.
 */

export const BANNER_WIDTH = 1200;
export const BANNER_HEIGHT = 630;

type Style = Record<string, string | number>;
type Child = Node | string | null | undefined | false;
type Node = {
  type: string;
  props: { style?: Style; children?: Child[] | Child };
};

const h = (style: Style, ...children: Child[]): Node => ({
  type: 'div',
  props: {
    style: { display: 'flex', ...style },
    children: children.filter(
      (c) => c !== null && c !== undefined && c !== false,
    ),
  },
});
const t = (text: string, style: Style = {}): Node =>
  h(
    {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      ...style,
    },
    text,
  );

const C = {
  ink: '#F4F4F8',
  dim: '#A3A3B8',
  faint: '#6B6B80',
  panel: 'rgba(255,255,255,0.06)',
  line: 'rgba(255,255,255,0.10)',
  green: '#22C55E',
  amber: '#F5A524',
  red: '#EF4444',
  grey: '#8B8BA0',
  blue: '#60A5FA',
};
const ACCENT: Record<InteractiveCard['type'], string> = {
  GROUP_TREASURY: '#8B5CF6',
  APPROVAL_PROPOSAL: '#3B82F6',
  GROUP_GIFT: '#EC4899',
  HOTEL_COMPARISON: '#14B8A6',
  DCA_MANDATE: '#22D3EE',
  EXECUTION_RECEIPT: '#22C55E',
};
const TYPE_LABEL: Record<InteractiveCard['type'], string> = {
  GROUP_TREASURY: 'GROUP TREASURY',
  APPROVAL_PROPOSAL: 'APPROVAL',
  GROUP_GIFT: 'GROUP GIFT',
  HOTEL_COMPARISON: 'HOTEL COMPARISON',
  DCA_MANDATE: 'DCA MANDATE',
  EXECUTION_RECEIPT: 'RECEIPT',
};
const MODE: Record<ExecutionMode, { label: string; color: string }> = {
  REAL_TESTNET: { label: 'REAL TESTNET', color: C.green },
  PROVIDER_SANDBOX: { label: 'SANDBOX', color: C.amber },
  SIMULATION: { label: 'SIMULATED', color: C.grey },
  MAINNET_SIMULATION: { label: 'SIMULATED', color: C.grey },
  CANARY_READY: { label: 'NOT EXECUTED', color: C.grey },
  MAINNET_READ_ONLY: { label: 'READ ONLY', color: C.grey },
};
const PROFILE_LABEL: Record<string, string> = {
  'sandbox/monad-testnet': 'Monad Testnet',
  'proof/monad-mainnet': 'Monad',
  'local/anvil': 'Local chain',
};
const networkLabel = (chainId: number) => {
  const profile = profileForChainId(chainId)?.network.profile;
  return (profile && PROFILE_LABEL[profile]) ?? `Chain ${chainId}`;
};

export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
export const shortHex = (v: string, head = 6, tail = 4) =>
  v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;

/** Groups the integer part with thousands separators; the fraction is kept exactly. */
export function groupDigits(amount: string): string {
  const [i = '0', f] = amount.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${grouped}.${f}` : grouped;
}

const UNITS = ['K', 'M', 'B', 'T'];
/**
 * Exact grouped amount when it fits in `maxChars`; otherwise an explicitly
 * approximate compact form ("≈ 1.23B"), never a silently cut-off figure.
 * The caption next to the banner always carries the exact amount.
 */
export function displayAmount(amount: string, maxChars: number): string {
  const exact = groupDigits(amount);
  if (exact.length <= maxChars) return exact;
  const [i = '0', f = ''] = amount.split('.');
  if (i.length <= 3) {
    const keep = Math.max(0, maxChars - i.length - 3);
    return keep > 0 ? `≈ ${i}.${f.slice(0, keep)}` : `≈ ${i}`;
  }
  const tier = Math.floor((i.length - 1) / 3);
  if (tier > 4) return `≈ ${i[0]}.${i.slice(1, 3)}e${i.length - 1}`;
  const head = i.slice(0, i.length - tier * 3);
  const frac = i.slice(head.length, head.length + 2).replace(/0+$/, '');
  return `≈ ${head}${frac ? `.${frac}` : ''}${UNITS[tier - 1]}`;
}
const moneyFit = (m: CardMoney, maxChars: number) =>
  `${displayAmount(m.amount, maxChars)} ${m.symbol}`;

/** Exact decimal → fixed-point bigint at 18 decimals (drawing proportions only). */
function scaled(amount: string): bigint {
  const [i = '0', f = ''] = amount.split('.');
  return (
    BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')
  );
}
function ratio(part: string, whole: string): number {
  const w = scaled(whole);
  if (w <= 0n) return 0;
  const r = Number((scaled(part) * 10_000n) / w) / 10_000;
  return Math.max(0, Math.min(1, r));
}
/** Font size that keeps a figure of `chars` characters within `width` pixels. */
const fit = (chars: number, width: number, max: number, min = 28) =>
  Math.max(min, Math.min(max, Math.floor(width / (Math.max(chars, 1) * 0.6))));

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
const when = (seconds: number) => {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)} UTC`;
};

const chip = (label: string, color: string, solid = false): Node =>
  h(
    {
      alignItems: 'center',
      padding: '6px 14px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: 1,
      lineHeight: 1.2,
      color: solid ? '#0B0B12' : color,
      backgroundColor: solid ? color : `${color}22`,
      border: `1.5px solid ${color}88`,
    },
    label,
  );

const dot = (color: string, size = 12): Node =>
  h({ width: size, height: size, borderRadius: size, backgroundColor: color });

/** Horizontal bar; `segments` are fractions that sum to ≤ 1. */
const bar = (
  segments: { value: number; color: string }[],
  height = 18,
  width: number | string = '100%',
): Node =>
  h(
    {
      width,
      height,
      borderRadius: height,
      backgroundColor: C.line,
      overflow: 'hidden',
    },
    ...segments
      .filter((s) => s.value > 0)
      .map((s) =>
        h({
          width: `${Math.max(1, Math.round(s.value * 1000) / 10)}%`,
          height,
          backgroundColor: s.color,
        }),
      ),
  );

const icon = (kind: 'check' | 'cross' | 'clock' | 'refund', color: string) => {
  const ring = (inner: Node) =>
    h(
      {
        width: 64,
        height: 64,
        borderRadius: 64,
        backgroundColor: `${color}26`,
        border: `3px solid ${color}`,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      },
      inner,
    );
  if (kind === 'check')
    return ring(
      h({
        width: 16,
        height: 30,
        borderRight: `5px solid ${color}`,
        borderBottom: `5px solid ${color}`,
        transform: 'rotate(45deg) translate(-2px, -3px)',
      }),
    );
  if (kind === 'cross')
    return ring(
      h(
        { width: 30, height: 30, position: 'relative' },
        h({
          position: 'absolute',
          left: 12,
          top: -2,
          width: 5,
          height: 34,
          backgroundColor: color,
          transform: 'rotate(45deg)',
        }),
        h({
          position: 'absolute',
          left: 12,
          top: -2,
          width: 5,
          height: 34,
          backgroundColor: color,
          transform: 'rotate(-45deg)',
        }),
      ),
    );
  if (kind === 'refund')
    return ring(t('←', { fontSize: 34, fontWeight: 700, color }));
  return ring(
    h(
      { width: 30, height: 30, position: 'relative' },
      h({
        position: 'absolute',
        left: 13,
        top: 2,
        width: 5,
        height: 15,
        backgroundColor: color,
      }),
      h({
        position: 'absolute',
        left: 13,
        top: 13,
        width: 13,
        height: 5,
        backgroundColor: color,
      }),
    ),
  );
};

function frame(
  card: InteractiveCard,
  accent: string,
  options: { network: string | null; mode: ExecutionMode | null },
  body: Node,
): Node {
  const mode = options.mode ? MODE[options.mode] : null;
  return h(
    {
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT,
      boxSizing: 'border-box',
      overflow: 'hidden',
      flexDirection: 'column',
      padding: '44px 56px 40px',
      color: C.ink,
      fontFamily: 'Inter',
      backgroundColor: '#0A0A12',
      backgroundImage: `radial-gradient(circle at 92% 0%, ${accent}55 0%, ${accent}00 45%), linear-gradient(135deg, #0B0B14 0%, #11111C 55%, ${accent}2E 100%)`,
    },
    h(
      { alignItems: 'center', justifyContent: 'space-between', width: '100%' },
      h(
        { alignItems: 'center', gap: 18 },
        h(
          { alignItems: 'center', gap: 8 },
          t('synq', { fontSize: 34, fontWeight: 700, letterSpacing: -1 }),
          dot(accent, 11),
        ),
        h({ width: 1.5, height: 28, backgroundColor: C.line }),
        t(clip(card.groupLabel, 38), {
          fontSize: 22,
          fontWeight: 600,
          color: C.dim,
          maxWidth: 520,
        }),
      ),
      h(
        { alignItems: 'center', gap: 10 },
        options.network ? chip(options.network, C.blue) : null,
        mode ? chip(mode.label, mode.color, true) : null,
      ),
    ),
    h(
      { alignItems: 'center', gap: 10, marginTop: 26 },
      h({ width: 28, height: 4, borderRadius: 4, backgroundColor: accent }),
      t(TYPE_LABEL[card.type], {
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: 3,
        color: accent,
      }),
    ),
    h(
      {
        flexGrow: 1,
        flexDirection: 'column',
        marginTop: 14,
        width: '100%',
        minHeight: 0,
      },
      body,
    ),
  );
}

const label = (text: string, style: Style = {}) =>
  t(text, {
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: 2,
    color: C.faint,
    ...style,
  });

function treasury(card: CardOf<'GROUP_TREASURY'>, accent: string): Node {
  const figure = displayAmount(card.balance.amount, 30);
  const total = card.balance.amount;
  const legend = (name: string, m: CardMoney, color: string) =>
    h(
      { alignItems: 'center', gap: 10 },
      dot(color, 14),
      t(name, { fontSize: 20, color: C.dim }),
      t(moneyFit(m, 14), { fontSize: 22, fontWeight: 600 }),
    );
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    label('BALANCE'),
    h(
      { alignItems: 'flex-end', gap: 16, marginTop: 6 },
      t(figure, {
        fontSize: fit(figure.length + 4, 900, 104),
        fontWeight: 700,
        letterSpacing: -2,
        maxWidth: 900,
      }),
      t(card.balance.symbol, {
        fontSize: 36,
        fontWeight: 600,
        color: C.dim,
        marginBottom: 14,
      }),
    ),
    h(
      { marginTop: 18, width: '100%' },
      bar(
        [
          { value: ratio(card.available.amount, total), color: accent },
          { value: ratio(card.reserved.amount, total), color: C.amber },
          { value: ratio(card.pending.amount, total), color: C.grey },
        ],
        20,
      ),
    ),
    h(
      { marginTop: 16, gap: 36 },
      legend('Available', card.available, accent),
      legend('Reserved', card.reserved, C.amber),
      legend('Pending', card.pending, C.grey),
    ),
    h(
      {
        marginTop: 'auto',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        width: '100%',
      },
      h(
        { flexDirection: 'column', gap: 8, maxWidth: 760 },
        ...(card.activity.length
          ? card.activity.slice(0, 2).map((a) =>
              h(
                { alignItems: 'center', gap: 10 },
                dot(C.faint, 8),
                t(clip(`${a.label}${a.at ? ` · ${a.at}` : ''}`, 60), {
                  fontSize: 20,
                  color: C.dim,
                }),
              ),
            )
          : [t('No recent activity', { fontSize: 20, color: C.faint })]),
      ),
      h(
        { flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
        t(card.memberCount === null ? '—' : String(card.memberCount), {
          fontSize: 44,
          fontWeight: 700,
        }),
        label(card.memberCount === 1 ? 'MEMBER' : 'MEMBERS'),
      ),
    ),
  );
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: C.amber,
  SATISFIED: C.green,
  INVALIDATED: C.red,
  ACTIVE: C.green,
  PROPOSED: C.amber,
  PAUSED: C.amber,
  REVOKED: C.red,
  EXPIRED: C.grey,
};

function proposal(card: CardOf<'APPROVAL_PROPOSAL'>, accent: string): Node {
  const figure = card.amount ? displayAmount(card.amount.amount, 30) : null;
  const q = card.quorum;
  const segments = Math.min(q.required, 12);
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    h(
      { alignItems: 'center', gap: 12 },
      chip(card.proposalKind, accent),
      chip(card.status, STATUS_COLOR[card.status] ?? C.grey),
    ),
    figure
      ? h(
          { alignItems: 'flex-end', gap: 14, marginTop: 16 },
          t(figure, {
            fontSize: fit(figure.length + 4, 860, 100),
            fontWeight: 700,
            letterSpacing: -2,
            maxWidth: 860,
          }),
          t(card.amount!.symbol, {
            fontSize: 34,
            fontWeight: 600,
            color: C.dim,
            marginBottom: 12,
          }),
        )
      : h(
          {
            fontSize: 46,
            fontWeight: 700,
            marginTop: 18,
            maxWidth: 1088,
            lineHeight: 1.2,
            maxHeight: 112,
            overflow: 'hidden',
          },
          clip(card.reason, 90),
        ),
    card.recipient
      ? h(
          { alignItems: 'center', gap: 14, marginTop: 6 },
          t('→', { fontSize: 34, color: accent, fontWeight: 700 }),
          t(clip(card.recipient.label, 32), {
            fontSize: 32,
            fontWeight: 600,
            maxWidth: 560,
          }),
          card.recipient.address
            ? t(shortHex(card.recipient.address), {
                fontSize: 24,
                color: C.dim,
              })
            : null,
        )
      : null,
    figure
      ? t(clip(card.reason, 80), {
          fontSize: 24,
          color: C.dim,
          marginTop: 10,
          maxWidth: 1080,
        })
      : null,
    h(
      { marginTop: 'auto', flexDirection: 'column', gap: 12, width: '100%' },
      h(
        {
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          width: '100%',
        },
        t(`${q.counted} of ${q.required} approvals`, {
          fontSize: 30,
          fontWeight: 700,
        }),
        t(
          card.status === 'PENDING'
            ? 'Approve on Synq with your passkey'
            : clip(card.statusReason ?? card.status.toLowerCase(), 48),
          {
            fontSize: 20,
            color: C.dim,
          },
        ),
      ),
      h(
        { gap: 8, width: '100%' },
        ...Array.from({ length: segments }, (_, i) =>
          h({
            flexGrow: 1,
            height: 16,
            borderRadius: 16,
            backgroundColor:
              i < Math.round((q.counted / q.required) * segments)
                ? card.status === 'INVALIDATED'
                  ? C.red
                  : accent
                : C.line,
          }),
        ),
      ),
    ),
  );
}

function votes(n: number, max: number, color: string): Node {
  return h(
    { alignItems: 'center', gap: 10, width: '100%' },
    h(
      { flexGrow: 1, display: 'flex' },
      bar([{ value: max > 0 ? n / max : 0, color }], 10),
    ),
    t(`${n} ${n === 1 ? 'vote' : 'votes'}`, { fontSize: 16, color: C.dim }),
  );
}

function gift(card: CardOf<'GROUP_GIFT'>, accent: string): Node {
  const options = card.options.slice(0, 3);
  const max = Math.max(...options.map((o) => o.votes), 0);
  const more = card.options.length - options.length;
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    t(clip(card.occasion, 46), {
      fontSize: 46,
      fontWeight: 700,
      maxWidth: 1088,
    }),
    h(
      { gap: 18, marginTop: 22, width: '100%' },
      ...options.map((o) => {
        const final = o.optionId === card.finalOptionId;
        return h(
          {
            flexDirection: 'column',
            flexBasis: 0,
            flexGrow: 1,
            padding: '20px 22px',
            borderRadius: 22,
            backgroundColor: final ? `${accent}22` : C.panel,
            border: `2px solid ${final ? accent : C.line}`,
            gap: 8,
            minWidth: 0,
          },
          final
            ? t('FINAL PICK', {
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: 2,
                color: accent,
              })
            : t(' ', { fontSize: 15 }),
          t(clip(o.product, options.length > 2 ? 22 : 34), {
            fontSize: 26,
            fontWeight: 600,
          }),
          t(moneyFit(o.price, options.length > 2 ? 10 : 16), {
            fontSize: 34,
            fontWeight: 700,
          }),
          t(clip(o.delivery, options.length > 2 ? 24 : 36), {
            fontSize: 18,
            color: C.dim,
          }),
          h({ marginTop: 6, width: '100%' }, votes(o.votes, max, accent)),
        );
      }),
    ),
    h(
      { marginTop: 'auto', justifyContent: 'space-between', width: '100%' },
      t(`via ${clip(card.provider, 40)}`, { fontSize: 20, color: C.dim }),
      more > 0
        ? t(`+${more} more option${more === 1 ? '' : 's'}`, {
            fontSize: 20,
            color: C.dim,
          })
        : null,
    ),
  );
}

function cancellationTag(text: string): Node {
  if (/non[- ]?refundable|no refund/i.test(text))
    return chip('Non-refundable', C.red);
  if (/free/i.test(text))
    return chip(
      clip(
        `Free cancel${/until|before/i.test(text) ? ` · ${text.replace(/^.*?(until|before)/i, '$1')}` : ''}`,
        30,
      ),
      C.green,
    );
  return chip(clip(text, 28), C.grey);
}

function hotel(card: CardOf<'HOTEL_COMPARISON'>, accent: string): Node {
  const rows = card.options.slice(0, 4);
  const max = Math.max(...rows.map((o) => o.preferenceVotes), 0);
  const more = card.options.length - rows.length;
  const rowHeight = rows.length > 3 ? 70 : 84;
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    t(clip(card.stay, 54), { fontSize: 40, fontWeight: 700, maxWidth: 1088 }),
    h(
      { flexDirection: 'column', gap: 10, marginTop: 18, width: '100%' },
      ...rows.map((o) => {
        const preferred = o.optionId === card.preferredOptionId;
        return h(
          {
            alignItems: 'center',
            height: rowHeight,
            padding: '0 22px',
            borderRadius: 18,
            gap: 18,
            backgroundColor: preferred ? `${accent}22` : C.panel,
            border: `2px solid ${preferred ? accent : C.line}`,
            width: '100%',
          },
          h(
            { flexDirection: 'column', width: 330, gap: 2, flexShrink: 0 },
            preferred
              ? t('PREFERRED', {
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: 2,
                  color: accent,
                })
              : null,
            t(clip(o.hotel, 26), { fontSize: 26, fontWeight: 600 }),
            t(clip(o.room, 32), { fontSize: 18, color: C.dim }),
          ),
          t(moneyFit(o.total, 9), {
            fontSize: 28,
            fontWeight: 700,
            width: 230,
            flexShrink: 0,
          }),
          h({ width: 330, flexShrink: 0 }, cancellationTag(o.cancellation)),
          h(
            {
              alignItems: 'center',
              gap: 8,
              flexGrow: 1,
              justifyContent: 'flex-end',
            },
            t(
              `${o.preferenceVotes} ${o.preferenceVotes === 1 ? 'vote' : 'votes'}`,
              {
                fontSize: 22,
                fontWeight: 700,
                color: max > 0 && o.preferenceVotes === max ? accent : C.dim,
              },
            ),
          ),
        );
      }),
    ),
    h(
      { marginTop: 'auto', justifyContent: 'space-between', width: '100%' },
      t(`via ${clip(card.provider, 40)}`, { fontSize: 20, color: C.dim }),
      more > 0 ? t(`+${more} more`, { fontSize: 20, color: C.dim }) : null,
    ),
  );
}

function dca(card: CardOf<'DCA_MANDATE'>, accent: string): Node {
  const r = ratio(card.spent.amount, card.cumulativeLimit.amount);
  const stat = (name: string, value: string) =>
    h(
      {
        flexDirection: 'column',
        gap: 6,
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 0,
      },
      label(name),
      t(clip(value, 26), { fontSize: 28, fontWeight: 600 }),
    );
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    h(
      { alignItems: 'center', gap: 18 },
      t(`Buy ${card.asset}`, { fontSize: 56, fontWeight: 700 }),
      chip(card.status, STATUS_COLOR[card.status] ?? C.grey),
    ),
    t(clip(card.frequency, 50), { fontSize: 28, color: C.dim, marginTop: 4 }),
    h(
      { flexDirection: 'column', gap: 10, marginTop: 30, width: '100%' },
      h(
        { justifyContent: 'space-between', width: '100%' },
        t(`${moneyFit(card.spent, 18)} spent`, {
          fontSize: 26,
          fontWeight: 600,
        }),
        t(`of ${moneyFit(card.cumulativeLimit, 18)}`, {
          fontSize: 26,
          color: C.dim,
        }),
      ),
      bar(
        [{ value: r, color: card.status === 'ACTIVE' ? accent : C.grey }],
        22,
      ),
    ),
    h(
      { marginTop: 'auto', gap: 24, width: '100%' },
      stat('PER EXECUTION', moneyFit(card.perExecutionLimit, 18)),
      stat(
        'NEXT EXECUTION',
        card.status === 'ACTIVE' && card.nextExecutionAt !== null
          ? when(card.nextExecutionAt)
          : 'None scheduled',
      ),
    ),
  );
}

const RECEIPT_STYLE: Record<
  CardOf<'EXECUTION_RECEIPT'>['status'],
  { color: string; icon: 'check' | 'cross' | 'clock' | 'refund' }
> = {
  CONFIRMED: { color: C.green, icon: 'check' },
  RECONCILED: { color: C.green, icon: 'check' },
  SUBMITTED: { color: C.blue, icon: 'clock' },
  FAILED: { color: C.red, icon: 'cross' },
  REFUNDED: { color: '#A78BFA', icon: 'refund' },
};

function receipt(card: CardOf<'EXECUTION_RECEIPT'>): Node {
  const s = RECEIPT_STYLE[card.status];
  const ref = card.transactionHash
    ? { name: 'TRANSACTION', value: shortHex(card.transactionHash, 10, 8) }
    : card.orderId
      ? {
          name: 'ORDER',
          value:
            card.orderId.length > 20
              ? shortHex(card.orderId, 8, 6)
              : card.orderId,
        }
      : null;
  const stat = (name: string, value: string, color: string = C.ink) =>
    h(
      {
        flexDirection: 'column',
        gap: 6,
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 0,
      },
      label(name),
      t(value, { fontSize: 26, fontWeight: 600, color }),
    );
  return h(
    { flexDirection: 'column', width: '100%', flexGrow: 1 },
    h(
      { alignItems: 'center', gap: 22 },
      icon(s.icon, s.color),
      t(card.status, {
        fontSize: 64,
        fontWeight: 700,
        color: s.color,
        letterSpacing: -1,
      }),
    ),
    h(
      {
        fontSize: 30,
        fontWeight: 600,
        marginTop: 20,
        maxWidth: 1088,
        lineHeight: 1.3,
        maxHeight: 80,
        overflow: 'hidden',
      },
      clip(card.label, 120),
    ),
    h(
      { marginTop: 'auto', gap: 24, width: '100%' },
      ref ? stat(ref.name, ref.value) : stat('REFERENCE', '—', C.dim),
      stat(
        'SETTLEMENT',
        card.settlementStatus.replace('_', ' '),
        card.settlementStatus === 'SETTLED' ? C.green : C.ink,
      ),
      stat('ISSUED', when(card.issuedAt)),
    ),
  );
}

export type CardBannerOptions = {
  /** Network chip for cards that do not carry a chain id (default "Monad Testnet"). */
  networkLabel?: string | null;
  fontsDir?: string;
  cacheSize?: number;
};

const FONT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../assets/fonts',
);

/** Renders canonical cards to 1200×630 PNG banners, offline. */
export class CardBannerRenderer {
  private fonts:
    | { name: string; data: Buffer; weight: 400 | 600 | 700; style: 'normal' }[]
    | null = null;
  private readonly cache = new Map<string, Buffer>();
  constructor(private readonly options: CardBannerOptions = {}) {}

  private loadFonts() {
    if (!this.fonts) {
      const dir = this.options.fontsDir ?? FONT_DIR;
      this.fonts = (
        [
          ['Inter-Regular.ttf', 400],
          ['Inter-SemiBold.ttf', 600],
          ['Inter-Bold.ttf', 700],
        ] as const
      ).map(([file, weight]) => ({
        name: 'Inter',
        data: readFileSync(join(dir, file)),
        weight,
        style: 'normal' as const,
      }));
    }
    return this.fonts;
  }

  /** Banner key: card id plus a hash of the whole card, so any state change re-renders. */
  static key(card: InteractiveCard) {
    return `${card.cardId}:${createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16)}`;
  }

  tree(card: InteractiveCard): Node {
    const network =
      card.type === 'GROUP_TREASURY'
        ? networkLabel(card.chainId)
        : this.options.networkLabel === undefined
          ? 'Monad Testnet'
          : this.options.networkLabel;
    const accent =
      card.type === 'EXECUTION_RECEIPT'
        ? RECEIPT_STYLE[card.status].color
        : ACCENT[card.type];
    const mode =
      card.type === 'GROUP_GIFT' ||
      card.type === 'HOTEL_COMPARISON' ||
      card.type === 'EXECUTION_RECEIPT'
        ? card.executionMode
        : null;
    const body =
      card.type === 'GROUP_TREASURY'
        ? treasury(card, accent)
        : card.type === 'APPROVAL_PROPOSAL'
          ? proposal(card, accent)
          : card.type === 'GROUP_GIFT'
            ? gift(card, accent)
            : card.type === 'HOTEL_COMPARISON'
              ? hotel(card, accent)
              : card.type === 'DCA_MANDATE'
                ? dca(card, accent)
                : receipt(card);
    return frame(card, accent, { network, mode }, body);
  }

  async svg(card: InteractiveCard): Promise<string> {
    return satori(this.tree(card) as never, {
      width: BANNER_WIDTH,
      height: BANNER_HEIGHT,
      fonts: this.loadFonts(),
    });
  }

  async render(card: InteractiveCard): Promise<Buffer> {
    const key = CardBannerRenderer.key(card);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const svg = await this.svg(card);
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: BANNER_WIDTH },
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    this.cache.set(key, png);
    while (this.cache.size > (this.options.cacheSize ?? 100))
      this.cache.delete(this.cache.keys().next().value!);
    return png;
  }
}
