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
import {
  holoArtSvg,
  synqMark,
  type ArtMotif,
  type Energy,
  type Rarity,
} from './holo-art.js';
export type { ArtMotif, Energy, Rarity } from './holo-art.js';
import { encodeOpaquePng } from './png.js';

/*
 * Card banners: one PNG per canonical card, drawn as a holo trading card
 * on a dark stage, only from the card's own fields (amounts as the backend's
 * exact decimal strings, addresses and hashes shortened). Fonts are bundled;
 * nothing is fetched at render time. Art, bars and pips are decorative or
 * proportional to figures the card states exactly in text.
 */

/** Portrait trading-card image, 5:7. */
export const CARD_IMAGE_WIDTH = 1000;
export const CARD_IMAGE_HEIGHT = 1400;
/** Kept for callers of the landscape banner era; same values as CARD_IMAGE_*. */
export const BANNER_WIDTH = CARD_IMAGE_WIDTH;
export const BANNER_HEIGHT = CARD_IMAGE_HEIGHT;

/** The card itself inside the stage (5:7) and its layout boxes. */
const CARD_W = 830;
const CARD_H = 1162;
const FOIL = 16;
const PAD_X = 30;
const CONTENT_W = CARD_W - 2 * FOIL - 2 * PAD_X;
const ART_H = 392;
const ART_BORDER = 5;

type Style = Record<string, string | number>;
type Child = Node | string | null | undefined | false;
type Node = {
  type: string;
  props: {
    style?: Style;
    children?: Child[] | Child;
    src?: string;
    width?: number;
    height?: number;
  };
};

const h = (style: Style, ...children: Child[]): Node => ({
  type: 'div',
  props: {
    style: { display: 'flex', boxSizing: 'border-box', ...style },
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
const img = (src: string, width: number, height: number, style: Style = {}) =>
  ({
    type: 'img',
    props: { src, width, height, style: { width, height, ...style } },
  }) satisfies Node;
const svgSrc = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const C = {
  ink: '#F7F7FB',
  dim: '#B4B4C8',
  faint: '#7E7E96',
  line: 'rgba(255,255,255,0.12)',
  green: '#22C55E',
  amber: '#F5A524',
  red: '#EF4444',
  grey: '#9A9AB0',
  blue: '#60A5FA',
};

/** Type colours ("energy"); receipts take theirs from their status. */
const ENERGY: Record<
  Exclude<InteractiveCard['type'], 'EXECUTION_RECEIPT'>,
  Energy
> = {
  GROUP_TREASURY: { base: '#8B5CF6', light: '#C4B5FD', deep: '#2E1065' },
  APPROVAL_PROPOSAL: { base: '#3B82F6', light: '#93C5FD', deep: '#172554' },
  GROUP_GIFT: { base: '#EC4899', light: '#F9A8D4', deep: '#500724' },
  HOTEL_COMPARISON: { base: '#14B8A6', light: '#5EEAD4', deep: '#042F2E' },
  DCA_MANDATE: { base: '#22D3EE', light: '#A5F3FC', deep: '#083344' },
};
const RECEIPT_ENERGY = {
  GREEN: { base: '#22C55E', light: '#86EFAC', deep: '#052E16' },
  AMBER: { base: '#F59E0B', light: '#FCD34D', deep: '#451A03' },
  RED: { base: '#EF4444', light: '#FCA5A5', deep: '#450A0A' },
} satisfies Record<string, Energy>;

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
/**
 * Mode for cards that carry no execution mode, read off the network label
 * only (never guessed): testnets and local chains say so, anything else "—".
 */
const networkMode = (network: string | null) =>
  network === null
    ? null
    : /testnet|sepolia/i.test(network)
      ? { label: 'TESTNET', color: C.green }
      : /local/i.test(network)
        ? { label: 'LOCAL', color: C.grey }
        : null;

const RARITY: Record<Rarity, { glyph: string; label: string }> = {
  COMMON: { glyph: '●', label: 'COMMON' },
  RARE: { glyph: '◆', label: 'RARE' },
  HOLO_RARE: { glyph: '★', label: 'HOLO RARE' },
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
const fit = (chars: number, width: number, max: number, min = 24) =>
  Math.max(min, Math.min(max, Math.floor(width / (Math.max(chars, 1) * 0.62))));

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

/* ------------------------------------------------------------------ */
/* Card content model: every type maps to the same trading-card slots. */
/* ------------------------------------------------------------------ */

export type CardMove = {
  /** CardMove name (left, bold). */
  name: string;
  /** One line of detail under the name. */
  detail: string | null;
  /** Figure on the right (exact or explicitly approximate). */
  value: string | null;
  valueColor?: string;
  /** Highlighted row (final pick, preferred option). */
  highlight?: boolean;
  tag?: { label: string; color: string } | null;
  /** Optional progress bar under the detail (0..1). */
  bar?: { value: number; color: string } | null;
};

export type CardStat = { label: string; value: string; color?: string };

/** A card mapped onto the trading-card slots (exported for tests and previews). */
export type CardFace = {
  energy: Energy;
  rarity: Rarity;
  /** Card name in the title bar. */
  name: string;
  /** Headline figure in the "HP" slot. */
  headline: { label: string; value: string; unit: string | null } | null;
  motif: ArtMotif;
  /** Gold strip under the art. */
  strip: string;
  moves: CardMove[];
  /** Flavour box: the card's own description or latest activity. */
  flavor: string | null;
  stats: CardStat[];
  mode: { label: string; color: string } | null;
  network: string | null;
};

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

const headlineMoney = (label: string, m: CardMoney, maxChars = 9) => ({
  label,
  value: displayAmount(m.amount, maxChars),
  unit: m.symbol,
});
/** Lowest of several prices when they share one currency, else null. */
function lowest(prices: CardMoney[]): CardMoney | null {
  const first = prices[0];
  if (!first || prices.some((p) => p.symbol !== first.symbol)) return null;
  return prices.reduce((min, p) =>
    scaled(p.amount) < scaled(min.amount) ? p : min,
  );
}
const fromHeadline = (prices: CardMoney[]) => {
  const min = lowest(prices);
  return min ? headlineMoney('FROM', min) : null;
};

function treasuryFace(
  card: CardOf<'GROUP_TREASURY'>,
): Omit<CardFace, 'mode' | 'network'> {
  const total = card.balance.amount;
  const e = ENERGY.GROUP_TREASURY;
  const latest = card.activity[0];
  return {
    energy: e,
    rarity: 'HOLO_RARE',
    name: card.groupLabel,
    headline: headlineMoney('BAL', card.balance),
    motif: { kind: 'TREASURY' },
    strip: `Group treasury · ${card.memberCount === null ? 'members unknown' : `${card.memberCount} ${card.memberCount === 1 ? 'member' : 'members'}`} · ${card.asOf}`,
    moves: [
      {
        name: 'Available',
        detail: 'Free to spend with approvals',
        value: moneyFit(card.available, 14),
        bar: { value: ratio(card.available.amount, total), color: e.light },
      },
      {
        name: 'Reserved',
        detail: 'Held for approved plans',
        value: moneyFit(card.reserved, 14),
        bar: { value: ratio(card.reserved.amount, total), color: C.amber },
      },
      {
        name: 'Pending',
        detail: 'Waiting to settle',
        value: moneyFit(card.pending, 14),
        bar: { value: ratio(card.pending.amount, total), color: C.grey },
      },
    ],
    flavor: latest
      ? `${latest.label}${latest.at ? ` · ${latest.at}` : ''}`
      : 'No recent activity',
    stats: [
      {
        label: 'MEMBERS',
        value: card.memberCount === null ? '—' : String(card.memberCount),
      },
      { label: 'ACCOUNT', value: shortHex(card.account) },
    ],
  };
}

function proposalFace(
  card: CardOf<'APPROVAL_PROPOSAL'>,
): Omit<CardFace, 'mode' | 'network'> {
  const q = card.quorum;
  const statusColor = STATUS_COLOR[card.status] ?? C.grey;
  const kind =
    card.proposalKind === 'SEND'
      ? 'Send'
      : card.proposalKind === 'MANDATE'
        ? 'Mandate change'
        : 'Action';
  const moves: CardMove[] = [];
  if (card.recipient)
    moves.push({
      name: `→ ${card.recipient.label}`,
      detail: card.recipient.address
        ? shortHex(card.recipient.address)
        : 'Recipient',
      value: card.amount ? moneyFit(card.amount, 14) : null,
    });
  else
    moves.push({
      name: kind,
      detail: card.amount
        ? 'Amount to authorize'
        : 'No single amount moves with this proposal',
      value: card.amount ? moneyFit(card.amount, 14) : null,
    });
  moves.push({
    name: 'Approvals',
    detail:
      card.status === 'PENDING'
        ? 'Approve on Synq with your passkey'
        : card.status === 'SATISFIED'
          ? 'Quorum reached'
          : 'Closed before quorum',
    value: `${q.counted} of ${q.required}`,
    bar: {
      value: Math.min(1, q.counted / q.required),
      color:
        card.status === 'INVALIDATED' ? C.red : ENERGY.APPROVAL_PROPOSAL.light,
    },
  });
  moves.push({
    name: 'Status',
    detail:
      card.statusReason ??
      (card.status === 'PENDING'
        ? 'Waiting for signatures'
        : card.status === 'SATISFIED'
          ? 'Quorum reached'
          : `${kind} proposal`),
    value: card.status,
    valueColor: statusColor,
  });
  return {
    energy: ENERGY.APPROVAL_PROPOSAL,
    rarity: card.status === 'SATISFIED' ? 'RARE' : 'COMMON',
    name: `${kind}${card.recipient ? ` to ${card.recipient.label}` : ''}`,
    headline: card.amount
      ? headlineMoney('AMT', card.amount)
      : { label: 'SIGS', value: `${q.counted}/${q.required}`, unit: null },
    motif: {
      kind: 'APPROVAL',
      counted: q.counted,
      required: q.required,
      voided: card.status === 'INVALIDATED',
    },
    strip: `${kind} proposal · ${q.required} ${q.required === 1 ? 'signature' : 'signatures'} needed · passkey only`,
    moves,
    flavor: card.reason,
    stats: [{ label: 'QUORUM', value: `${q.counted}/${q.required}` }],
  };
}

function giftFace(
  card: CardOf<'GROUP_GIFT'>,
): Omit<CardFace, 'mode' | 'network'> {
  const e = ENERGY.GROUP_GIFT;
  const ordered = [...card.options].sort(
    (a, b) =>
      Number(b.optionId === card.finalOptionId) -
        Number(a.optionId === card.finalOptionId) || b.votes - a.votes,
  );
  const shown = ordered.slice(0, 3);
  const more = card.options.length - shown.length;
  const pick =
    card.options.find((o) => o.optionId === card.finalOptionId) ?? null;
  const totalVotes = card.options.reduce((s, o) => s + o.votes, 0);
  return {
    energy: e,
    rarity: pick ? 'RARE' : 'COMMON',
    name: card.occasion,
    headline: pick
      ? headlineMoney('PICK', pick.price)
      : fromHeadline(card.options.map((o) => o.price)),
    motif: { kind: 'GIFT' },
    strip: `Group gift · ${card.options.length} ${card.options.length === 1 ? 'option' : 'options'} · via ${card.provider}`,
    moves: [
      ...shown.map((o) => ({
        name: o.product,
        detail: `${o.delivery} · ${o.votes} ${o.votes === 1 ? 'vote' : 'votes'}`,
        value: moneyFit(o.price, 10),
        highlight: o.optionId === card.finalOptionId,
        tag:
          o.optionId === card.finalOptionId
            ? { label: 'FINAL PICK', color: e.light }
            : null,
      })),
      ...summaryMoves(shown.length, totalVotes, card.provider, !!pick),
    ],
    flavor:
      more > 0
        ? `+${more} more option${more === 1 ? '' : 's'} to compare · vote in the group`
        : pick
          ? 'Final pick chosen; the group approves the purchase with passkeys'
          : 'Vote for a favourite; the group approves the purchase with passkeys',
    stats: [{ label: 'OPTIONS', value: String(card.options.length) }],
  };
}

/** Fills option cards up to three rows with the vote tally and the provider. */
function summaryMoves(
  shown: number,
  votes: number,
  provider: string,
  decided: boolean,
): CardMove[] {
  const rows: CardMove[] = [
    {
      name: 'Group vote',
      detail: decided ? 'Final pick chosen' : 'Vote for a favourite',
      value: `${votes} ${votes === 1 ? 'vote' : 'votes'}`,
    },
    {
      name: 'Provider',
      detail: 'Quotes and fulfilment',
      value: clip(provider, 16),
    },
  ];
  return rows.slice(0, Math.max(0, 3 - shown));
}

const nonRefundable = (text: string) =>
  /non[- ]?refundable|no refund/i.test(text);

function hotelFace(
  card: CardOf<'HOTEL_COMPARISON'>,
): Omit<CardFace, 'mode' | 'network'> {
  const e = ENERGY.HOTEL_COMPARISON;
  const ordered = [...card.options].sort(
    (a, b) =>
      Number(b.optionId === card.preferredOptionId) -
        Number(a.optionId === card.preferredOptionId) ||
      b.preferenceVotes - a.preferenceVotes,
  );
  const shown = ordered.slice(0, 3);
  const more = card.options.length - shown.length;
  const preferred =
    card.options.find((o) => o.optionId === card.preferredOptionId) ?? null;
  return {
    energy: e,
    rarity: preferred ? 'RARE' : 'COMMON',
    name: card.stay,
    headline: preferred
      ? headlineMoney('PICK', preferred.total)
      : fromHeadline(card.options.map((o) => o.total)),
    motif: { kind: 'HOTEL' },
    strip: `Hotel comparison · ${card.options.length} ${card.options.length === 1 ? 'stay' : 'stays'} · via ${card.provider}`,
    moves: [
      ...shown.map((o) => {
        const preferred = o.optionId === card.preferredOptionId;
        const warn = !preferred && nonRefundable(o.cancellation);
        return {
          name: o.hotel,
          detail: warn ? o.room : `${o.room} · ${o.cancellation}`,
          value: moneyFit(o.total, 9),
          highlight: preferred,
          tag: preferred
            ? { label: 'PREFERRED', color: e.light }
            : warn
              ? { label: 'Non-refundable', color: C.red }
              : null,
        };
      }),
      ...summaryMoves(
        shown.length,
        card.options.reduce((s, o) => s + o.preferenceVotes, 0),
        card.provider,
        !!preferred,
      ),
    ],
    flavor:
      more > 0
        ? `+${more} more stay${more === 1 ? '' : 's'} · compare and vote in the group`
        : 'Compare and vote; booking needs passkey approvals',
    stats: [{ label: 'OPTIONS', value: String(card.options.length) }],
  };
}

function dcaFace(
  card: CardOf<'DCA_MANDATE'>,
): Omit<CardFace, 'mode' | 'network'> {
  const e = ENERGY.DCA_MANDATE;
  const r = ratio(card.spent.amount, card.cumulativeLimit.amount);
  const statusColor = STATUS_COLOR[card.status] ?? C.grey;
  return {
    energy: e,
    rarity: card.status === 'ACTIVE' ? 'RARE' : 'COMMON',
    name: `Buy ${card.asset}`,
    headline: headlineMoney('PER', card.perExecutionLimit),
    motif: { kind: 'DCA', progress: r },
    strip: `DCA mandate · ${card.frequency}`,
    moves: [
      {
        name: 'Spent',
        detail: `of ${moneyFit(card.cumulativeLimit, 18)} cap`,
        value: moneyFit(card.spent, 14),
        bar: {
          value: r,
          color: card.status === 'ACTIVE' ? e.light : C.grey,
        },
      },
      {
        name: 'Per execution',
        detail: card.frequency,
        value: moneyFit(card.perExecutionLimit, 14),
      },
      {
        name: 'Next execution',
        detail:
          card.status === 'ACTIVE' && card.nextExecutionAt !== null
            ? when(card.nextExecutionAt)
            : 'None scheduled',
        value: card.status,
        valueColor: statusColor,
      },
    ],
    flavor: `Mandate ${card.mandateId}${card.status === 'ACTIVE' || card.status === 'PAUSED' ? ' · pause or revoke from Synq' : ''}`,
    stats: [{ label: 'STATUS', value: card.status, color: statusColor }],
  };
}

const RECEIPT_STYLE: Record<
  CardOf<'EXECUTION_RECEIPT'>['status'],
  {
    energy: Energy;
    color: string;
    icon: 'check' | 'cross' | 'clock' | 'refund';
  }
> = {
  CONFIRMED: { energy: RECEIPT_ENERGY.GREEN, color: C.green, icon: 'check' },
  RECONCILED: { energy: RECEIPT_ENERGY.GREEN, color: C.green, icon: 'check' },
  SUBMITTED: { energy: RECEIPT_ENERGY.AMBER, color: C.amber, icon: 'clock' },
  FAILED: { energy: RECEIPT_ENERGY.RED, color: C.red, icon: 'cross' },
  REFUNDED: { energy: RECEIPT_ENERGY.AMBER, color: C.amber, icon: 'refund' },
};

function receiptFace(
  card: CardOf<'EXECUTION_RECEIPT'>,
): Omit<CardFace, 'mode' | 'network'> {
  const s = RECEIPT_STYLE[card.status];
  const ref = card.transactionHash
    ? { name: 'Transaction', value: shortHex(card.transactionHash, 10, 8) }
    : card.orderId
      ? {
          name: 'Order',
          value:
            card.orderId.length > 20
              ? shortHex(card.orderId, 8, 6)
              : card.orderId,
        }
      : null;
  const settled = card.settlementStatus === 'SETTLED';
  const done = card.status === 'CONFIRMED' || card.status === 'RECONCILED';
  return {
    energy: s.energy,
    rarity: done && settled ? 'HOLO_RARE' : done ? 'RARE' : 'COMMON',
    name: card.status.charAt(0) + card.status.slice(1).toLowerCase(),
    headline: null,
    motif: { kind: 'RECEIPT', icon: s.icon },
    strip: `Execution receipt · ${card.subjectId}`,
    moves: [
      {
        name: ref ? ref.name : 'Reference',
        detail: ref ? 'Shortened; full id in the caption' : 'No reference yet',
        value: ref ? ref.value : '—',
      },
      {
        name: 'Settlement',
        detail: settled ? 'Funds settled' : 'Settlement state',
        value: card.settlementStatus.replace('_', ' '),
        valueColor: settled ? C.green : C.ink,
      },
      {
        name: 'Status',
        detail: card.explorerUrl
          ? 'Verifiable on the explorer'
          : 'Execution status',
        value: card.status,
        valueColor: s.color,
      },
    ],
    flavor: card.label,
    stats: [],
  };
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Rainbow foil, layered under white sheen bands and a fine line texture. */
const FOIL_IMAGE = [
  'linear-gradient(118deg, rgba(255,255,255,0) 14%, rgba(255,255,255,0.75) 22%, rgba(255,255,255,0) 30%, rgba(255,255,255,0) 58%, rgba(255,255,255,0.5) 66%, rgba(255,255,255,0) 73%)',
  'repeating-linear-gradient(45deg, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0.10) 2px, rgba(255,255,255,0) 2px, rgba(255,255,255,0) 7px)',
  'linear-gradient(135deg, rgba(255,122,217,0.78) 0%, rgba(255,217,138,0.7) 14%, rgba(156,255,201,0.66) 28%, rgba(127,227,255,0.7) 42%, rgba(183,156,255,0.75) 56%, rgba(255,138,216,0.7) 70%, rgba(255,229,154,0.66) 84%, rgba(141,245,255,0.75) 100%)',
  'linear-gradient(160deg, #F4F4FA 0%, #8C8CA3 18%, #FFFFFF 34%, #6E6E86 52%, #E6E6F0 70%, #7A7A92 86%, #F8F8FF 100%)',
].join(', ');

const energyOrb = (e: Energy, size: number): Node =>
  h(
    {
      width: size,
      height: size,
      borderRadius: size,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundImage: `radial-gradient(circle at 35% 30%, #ffffff 0%, ${e.light} 22%, ${e.base} 58%, ${e.deep} 100%)`,
      border: '2px solid rgba(255,255,255,0.75)',
      boxShadow: `0 0 ${Math.round(size / 2)}px ${e.base}`,
    },
    img(
      svgSrc(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${synqMark(size / 2, size / 2, size * 0.27, '#ffffff', 0.95)}</svg>`,
      ),
      size,
      size,
    ),
  );

const pill = (label: string, color: string, solid = false): Node =>
  h(
    {
      alignItems: 'center',
      padding: '5px 12px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: 1.5,
      lineHeight: 1.2,
      color: solid ? '#0B0B12' : color,
      backgroundColor: solid ? color : `${color}26`,
      border: `1.5px solid ${solid ? color : `${color}99`}`,
    },
    label,
  );

function titleBar(face: CardFace, typeLabel: string): Node {
  const e = face.energy;
  const head = face.headline;
  const headSize = head ? fit(head.value.length, 200, 58, 28) : 0;
  return h(
    { flexDirection: 'column', width: CONTENT_W, flexShrink: 0 },
    h(
      {
        alignItems: 'center',
        justifyContent: 'space-between',
        width: CONTENT_W,
      },
      h(
        { alignItems: 'center', gap: 10 },
        h({
          width: 10,
          height: 10,
          borderRadius: 10,
          backgroundColor: e.light,
          boxShadow: `0 0 10px ${e.base}`,
        }),
        t(typeLabel, {
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: 3,
          color: e.light,
        }),
      ),
      face.mode ? pill(face.mode.label, face.mode.color, true) : null,
    ),
    h(
      {
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        width: CONTENT_W,
        marginTop: 8,
        gap: 18,
      },
      t(clip(face.name, 60), {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        fontSize: face.name.length > 30 ? 32 : face.name.length > 20 ? 36 : 44,
        fontWeight: 700,
        letterSpacing: -0.8,
        color: C.ink,
        lineHeight: 1.15,
        paddingBottom: 4,
      }),
      head
        ? h(
            {
              alignItems: 'flex-end',
              gap: 8,
              flexShrink: 0,
              maxWidth: 340,
            },
            t(head.label, {
              flexShrink: 0,
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: 1.5,
              color: e.light,
              paddingBottom: Math.round(headSize * 0.2),
            }),
            t(head.value, {
              fontSize: headSize,
              fontWeight: 700,
              letterSpacing: -1.5,
              color: '#FFFFFF',
              lineHeight: 1,
              textShadow: `0 0 18px ${e.base}`,
            }),
            head.unit
              ? t(head.unit, {
                  flexShrink: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  color: C.dim,
                  paddingBottom: Math.round(headSize * 0.16),
                })
              : null,
            energyOrb(e, 40),
          )
        : energyOrb(e, 40),
    ),
  );
}

function artWindow(face: CardFace, seed: string): Node {
  const w = CONTENT_W - 2 * ART_BORDER;
  const hh = ART_H - 2 * ART_BORDER;
  return h(
    {
      width: CONTENT_W,
      height: ART_H,
      padding: ART_BORDER,
      marginTop: 16,
      borderRadius: 18,
      flexShrink: 0,
      backgroundImage:
        'linear-gradient(145deg, #FFF6D6 0%, #C9A54B 22%, #FFF3C4 45%, #9C7A2E 70%, #FFE8A3 100%)',
      boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
    },
    h(
      { width: w, height: hh, borderRadius: 13, overflow: 'hidden' },
      img(
        svgSrc(
          holoArtSvg({
            width: w,
            height: hh,
            energy: face.energy,
            motif: face.motif,
            rarity: face.rarity,
            seed,
          }),
        ),
        w,
        hh,
      ),
    ),
  );
}

function strip(text: string): Node {
  return h(
    {
      width: CONTENT_W - 60,
      marginLeft: 30,
      marginTop: -2,
      height: 34,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 18px',
      borderRadius: '0 0 12px 12px',
      backgroundImage:
        'linear-gradient(90deg, #8E6E26 0%, #E9CF83 20%, #FFF2C2 50%, #E9CF83 80%, #8E6E26 100%)',
    },
    t(clip(text, 70), {
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: 0.6,
      color: '#2A1E05',
      maxWidth: CONTENT_W - 100,
    }),
  );
}

function moveRow(
  move: CardMove,
  e: Energy,
  cost: number,
  compact: boolean,
): Node {
  const valueChars = move.value?.length ?? 0;
  const valueSize = fit(valueChars, 280, compact ? 30 : 34, 22);
  return h(
    {
      alignItems: 'center',
      width: CONTENT_W,
      gap: 16,
      minHeight: 90,
      padding: compact ? '10px 14px' : '14px 14px',
      borderRadius: 16,
      flexShrink: 0,
      backgroundColor: move.highlight
        ? `${e.base}2E`
        : 'rgba(255,255,255,0.035)',
      border: `1.5px solid ${move.highlight ? e.light : 'rgba(255,255,255,0.08)'}`,
    },
    h(
      { gap: 4, width: 86, flexShrink: 0, justifyContent: 'center' },
      ...Array.from({ length: cost }, () => energyOrb(e, 26)),
    ),
    h(
      {
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: 4,
      },
      h(
        { alignItems: 'center', gap: 10, minWidth: 0 },
        t(clip(move.name, 40), {
          fontSize: compact ? 25 : 28,
          fontWeight: 700,
          color: C.ink,
          flexShrink: 1,
          minWidth: 0,
        }),
        move.tag ? pill(move.tag.label, move.tag.color) : null,
      ),
      move.detail
        ? t(clip(move.detail, 64), {
            fontSize: compact ? 17 : 19,
            color: C.dim,
            minWidth: 0,
          })
        : null,
      move.bar
        ? h(
            {
              marginTop: 6,
              width: '100%',
              height: 8,
              borderRadius: 8,
              backgroundColor: 'rgba(255,255,255,0.10)',
              overflow: 'hidden',
            },
            move.bar.value > 0
              ? h({
                  width: `${Math.max(1.5, Math.round(move.bar.value * 1000) / 10)}%`,
                  height: 8,
                  borderRadius: 8,
                  backgroundColor: move.bar.color,
                })
              : null,
          )
        : null,
    ),
    move.value
      ? t(move.value, {
          fontSize: valueSize,
          fontWeight: 700,
          letterSpacing: -0.5,
          color: move.valueColor ?? '#FFFFFF',
          flexShrink: 0,
          maxWidth: 300,
        })
      : null,
  );
}

function statsRow(face: CardFace): Node {
  const stats: CardStat[] = [
    { label: 'NETWORK', value: face.network ?? '—', color: C.blue },
    {
      label: 'MODE',
      value: face.mode?.label ?? '—',
      color: face.mode?.color ?? C.grey,
    },
    ...face.stats.slice(0, 1),
  ];
  return h(
    {
      width: CONTENT_W,
      flexShrink: 0,
      borderTop: `1.5px solid ${C.line}`,
      borderBottom: `1.5px solid ${C.line}`,
      padding: '12px 0',
    },
    ...stats.map((s, i) =>
      h(
        {
          flexDirection: 'column',
          flexBasis: 0,
          flexGrow: 1,
          minWidth: 0,
          gap: 4,
          alignItems: 'center',
          borderLeft: i ? `1.5px solid ${C.line}` : 'none',
        },
        t(s.label, {
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: 2,
          color: C.faint,
        }),
        t(clip(s.value, 22), {
          fontSize: 22,
          fontWeight: 700,
          color: s.color ?? C.ink,
          maxWidth: 240,
        }),
      ),
    ),
  );
}

function footer(card: InteractiveCard, face: CardFace): Node {
  const r = RARITY[face.rarity];
  const rarityColor =
    face.rarity === 'HOLO_RARE'
      ? '#FFD66B'
      : face.rarity === 'RARE'
        ? '#D7E3FF'
        : C.dim;
  return h(
    {
      width: CONTENT_W,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    h(
      { alignItems: 'center', gap: 10 },
      t('synq', {
        fontSize: 20,
        fontWeight: 700,
        letterSpacing: -0.5,
        color: C.ink,
      }),
      t(`#${card.cardId.slice(-6)}`, {
        fontSize: 16,
        fontWeight: 600,
        color: C.faint,
        letterSpacing: 1,
      }),
    ),
    t(when(card.issuedAt), { fontSize: 16, fontWeight: 600, color: C.dim }),
    h(
      { alignItems: 'center', gap: 8 },
      t(r.glyph, { fontSize: 20, color: rarityColor }),
      t(r.label, {
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: 1.5,
        color: rarityColor,
      }),
    ),
  );
}

function cardBody(card: InteractiveCard, face: CardFace): Node {
  const e = face.energy;
  const compact = face.moves.length > 2 && face.moves.some((m) => m.tag);
  return h(
    {
      width: CARD_W - 2 * FOIL,
      height: CARD_H - 2 * FOIL,
      flexDirection: 'column',
      alignItems: 'flex-start',
      padding: `22px ${PAD_X}px 18px`,
      position: 'relative',
      borderRadius: 28,
      overflow: 'hidden',
      backgroundColor: '#0B0B14',
      backgroundImage: `radial-gradient(circle at 50% 0%, ${e.base}55 0%, ${e.base}00 55%), radial-gradient(circle, rgba(255,255,255,0.05) 1px, rgba(255,255,255,0) 1.5px), linear-gradient(180deg, ${e.deep} 0%, #0C0C16 42%, #08080F 100%)`,
      backgroundSize: '100% 100%, 16px 16px, 100% 100%',
      border: '1.5px solid rgba(255,255,255,0.22)',
    },
    face.rarity === 'HOLO_RARE'
      ? h({
          position: 'absolute',
          top: 0,
          left: 0,
          width: CARD_W - 2 * FOIL,
          height: CARD_H - 2 * FOIL,
          backgroundImage:
            'linear-gradient(125deg, rgba(255,95,210,0) 30%, rgba(255,95,210,0.07) 40%, rgba(91,209,255,0.08) 50%, rgba(107,255,184,0.07) 60%, rgba(107,255,184,0) 70%)',
        })
      : null,
    titleBar(face, TYPE_LABEL[card.type]),
    artWindow(face, card.cardId),
    strip(face.strip),
    h(
      {
        flexDirection: 'column',
        gap: compact ? 8 : 10,
        marginTop: 16,
        width: CONTENT_W,
        flexShrink: 0,
      },
      ...face.moves
        .slice(0, 3)
        .map((m, i) => moveRow(m, e, Math.min(3, i + 1), compact)),
    ),
    h(
      {
        flexGrow: 1,
        width: CONTENT_W,
        minHeight: 0,
        alignItems: 'center',
        margin: '12px 0',
        padding: '10px 20px',
        borderRadius: 14,
        border: `1.5px solid ${e.light}40`,
        backgroundImage: `linear-gradient(120deg, ${e.base}1F 0%, rgba(255,255,255,0.03) 60%, ${e.base}14 100%)`,
      },
      h({
        width: 4,
        alignSelf: 'stretch',
        borderRadius: 4,
        marginRight: 16,
        flexShrink: 0,
        backgroundColor: e.light,
      }),
      face.flavor
        ? h(
            {
              flexGrow: 1,
              minWidth: 0,
              fontSize: 19,
              lineHeight: 1.35,
              color: '#D4D4E2',
              maxHeight: 54,
              overflow: 'hidden',
            },
            clip(face.flavor, 110),
          )
        : null,
    ),
    statsRow(face),
    footer(card, face),
  );
}

function stage(card: InteractiveCard, face: CardFace): Node {
  const e = face.energy;
  return h(
    {
      width: CARD_IMAGE_WIDTH,
      height: CARD_IMAGE_HEIGHT,
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      fontFamily: 'Inter',
      color: C.ink,
      backgroundColor: '#05050A',
      backgroundImage: `radial-gradient(ellipse at center, ${e.base}FF 0%, ${e.base}F0 57%, ${e.base}99 61%, ${e.base}44 67%, ${e.deep}33 74%, rgba(5,5,10,0) 84%), linear-gradient(180deg, #07070D 0%, #0B0A14 50%, #040408 100%)`,
    },
    h(
      {
        width: CARD_W,
        height: CARD_H,
        padding: FOIL,
        borderRadius: 42,
        backgroundImage: FOIL_IMAGE,
      },
      cardBody(card, face),
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

/** Renders canonical cards to 1000×1400 holo trading-card PNGs, offline. */
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

  /** The card's trading-card content (name, headline, moves, stats, rarity). */
  face(card: InteractiveCard): CardFace {
    const network =
      card.type === 'GROUP_TREASURY'
        ? networkLabel(card.chainId)
        : this.options.networkLabel === undefined
          ? 'Monad Testnet'
          : this.options.networkLabel;
    const mode =
      card.type === 'GROUP_GIFT' ||
      card.type === 'HOTEL_COMPARISON' ||
      card.type === 'EXECUTION_RECEIPT'
        ? MODE[card.executionMode]
        : networkMode(network);
    const face =
      card.type === 'GROUP_TREASURY'
        ? treasuryFace(card)
        : card.type === 'APPROVAL_PROPOSAL'
          ? proposalFace(card)
          : card.type === 'GROUP_GIFT'
            ? giftFace(card)
            : card.type === 'HOTEL_COMPARISON'
              ? hotelFace(card)
              : card.type === 'DCA_MANDATE'
                ? dcaFace(card)
                : receiptFace(card);
    return { ...face, network, mode };
  }

  tree(card: InteractiveCard): Node {
    return stage(card, this.face(card));
  }

  async svg(card: InteractiveCard): Promise<string> {
    return satori(this.tree(card) as never, {
      width: CARD_IMAGE_WIDTH,
      height: CARD_IMAGE_HEIGHT,
      fonts: this.loadFonts(),
    });
  }

  async render(card: InteractiveCard): Promise<Buffer> {
    const key = CardBannerRenderer.key(card);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const svg = await this.svg(card);
    const image = new Resvg(svg, {
      fitTo: { mode: 'width', value: CARD_IMAGE_WIDTH },
      font: { loadSystemFonts: false },
    }).render();
    const png = encodeOpaquePng(image.pixels, image.width, image.height);
    this.cache.set(key, png);
    while (this.cache.size > (this.options.cacheSize ?? 100))
      this.cache.delete(this.cache.keys().next().value!);
    return png;
  }
}
