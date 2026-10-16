import type {
  ArtSlot,
  ArtSpec,
  CardContent,
  Tone,
} from '../../content/model.js';
import type { ArtMotif, Energy, Rarity } from './art.js';

/*
 * Holo theme tokens and the mapping from card content to the holo card's
 * slots: energy colours per art slot, tone colours, and art motifs built
 * from the content's semantic art state.
 */

export const STAGE_W = 1000;
export const STAGE_H = 1400;
export const CARD_W = 830;
export const CARD_H = 1162;
export const FOIL = 16;
export const PAD_X = 30;
export const CONTENT_W = CARD_W - 2 * FOIL - 2 * PAD_X;
export const ART_H = 392;
export const ART_BORDER = 5;

export const C = {
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

/** Font size that keeps a figure of `chars` characters within `width` pixels. */
export const fit = (chars: number, width: number, max: number, min = 24) =>
  Math.max(min, Math.min(max, Math.floor(width / (Math.max(chars, 1) * 0.62))));

const TONE: Record<Tone, string> = {
  neutral: '#FFFFFF',
  ok: C.green,
  pending: C.amber,
  bad: C.red,
  info: C.blue,
  muted: C.grey,
};
export const toneColor = (tone: Tone) => TONE[tone];

const ENERGY: Record<ArtSlot, Energy> = {
  treasury: { base: '#8B5CF6', light: '#C4B5FD', deep: '#2E1065' },
  approval: { base: '#3B82F6', light: '#93C5FD', deep: '#172554' },
  gift: { base: '#EC4899', light: '#F9A8D4', deep: '#500724' },
  hotel: { base: '#14B8A6', light: '#5EEAD4', deep: '#042F2E' },
  dca: { base: '#22D3EE', light: '#A5F3FC', deep: '#083344' },
  receipt: { base: '#22C55E', light: '#86EFAC', deep: '#052E16' },
  deal: { base: '#EAB308', light: '#FDE68A', deep: '#422006' },
  escrow: { base: '#F97316', light: '#FDBA74', deep: '#431407' },
  invoice: { base: '#84CC16', light: '#D9F99D', deep: '#1A2E05' },
  risk: { base: '#EF4444', light: '#FCA5A5', deep: '#450A0A' },
  agent: { base: '#6366F1', light: '#A5B4FC', deep: '#1E1B4B' },
  contractor: { base: '#10B981', light: '#6EE7B7', deep: '#022C22' },
  flight: { base: '#38BDF8', light: '#BAE6FD', deep: '#0C4A6E' },
};
const STATUS_ENERGY: Partial<Record<Tone, Energy>> = {
  ok: { base: '#22C55E', light: '#86EFAC', deep: '#052E16' },
  pending: { base: '#F59E0B', light: '#FCD34D', deep: '#451A03' },
  bad: { base: '#EF4444', light: '#FCA5A5', deep: '#450A0A' },
};

function energyFor(art: ArtSpec): Energy {
  if (art.slot === 'receipt')
    return STATUS_ENERGY[art.tone ?? 'ok'] ?? ENERGY.receipt;
  if (art.slot === 'risk' && art.tone === 'ok') return STATUS_ENERGY.ok!;
  return ENERGY[art.slot];
}

function motifFor(art: ArtSpec): ArtMotif {
  const count = art.count ?? { lit: 0, total: 1 };
  switch (art.slot) {
    case 'treasury':
      return { kind: 'TREASURY' };
    case 'approval':
      return {
        kind: 'APPROVAL',
        counted: count.lit,
        required: Math.max(1, count.total),
        voided: art.tone === 'bad',
      };
    case 'gift':
      return { kind: 'GIFT' };
    case 'hotel':
      return { kind: 'HOTEL' };
    case 'dca':
      return { kind: 'DCA', progress: art.progress ?? 0 };
    case 'receipt':
      return {
        kind: 'RECEIPT',
        icon:
          art.tone === 'ok' ? 'check' : art.tone === 'bad' ? 'cross' : 'clock',
      };
    case 'deal':
      return {
        kind: 'DEAL',
        signed: [art.nodes?.[0] === 'ok', art.nodes?.[1] === 'ok'],
        sealed: art.tone === 'ok',
      };
    case 'escrow':
      return {
        kind: 'ESCROW',
        step: count.lit,
        steps: Math.max(1, count.total),
        locked: art.tone !== 'ok',
        tone: toneColor(art.tone ?? 'neutral'),
      };
    case 'invoice':
      return {
        kind: 'INVOICE',
        paid: art.progress ?? 0,
        stamp:
          art.tone === 'ok'
            ? 'PAID'
            : (art.progress ?? 0) > 0
              ? 'PARTIAL'
              : null,
      };
    case 'risk':
      return {
        kind: 'RISK',
        resolved: art.tone === 'ok',
        hard: art.tone === 'bad',
      };
    case 'agent':
      return {
        kind: 'COUNCIL',
        nodes: (art.nodes ?? []).map(toneColor),
        verdict: toneColor(art.tone ?? 'muted'),
      };
    case 'contractor':
      return {
        kind: 'PAYOUT',
        state:
          art.tone === 'ok'
            ? 'DONE'
            : art.tone === 'bad'
              ? 'FAILED'
              : 'PENDING',
      };
    case 'flight':
      return { kind: 'FLIGHT', roundTrip: count.total > 1 };
  }
}

export type HoloMove = {
  name: string;
  detail: string | null;
  value: string | null;
  valueColor?: string;
  highlight?: boolean;
  tag?: { label: string; color: string } | null;
  bar?: { value: number; color: string } | null;
};
export type HoloStat = { label: string; value: string; color?: string };
export type HoloFace = {
  energy: Energy;
  rarity: Rarity;
  name: string;
  headline: CardContent['headline'];
  motif: ArtMotif;
  strip: string;
  moves: HoloMove[];
  flavor: string | null;
  stats: HoloStat[];
  mode: { label: string; color: string } | null;
  network: string | null;
};

export function holoFace(c: CardContent): HoloFace {
  const e = energyFor(c.art);
  return {
    energy: e,
    rarity: c.grade,
    name: c.title,
    headline: c.headline && {
      ...c.headline,
      label: c.headline.label.slice(0, 5),
    },
    motif: motifFor(c.art),
    strip: c.subtitle,
    moves: c.rows.map((r) => ({
      name: r.title,
      detail: r.detail,
      value: r.value,
      valueColor: toneColor(r.tone),
      highlight: r.highlight,
      tag: r.badge
        ? {
            label: r.badge.label,
            color:
              r.badge.tone === 'neutral' ? e.light : toneColor(r.badge.tone),
          }
        : null,
      bar: r.progress === null ? null : { value: r.progress, color: e.light },
    })),
    flavor: c.note,
    stats: c.stats.map((s) => ({
      label: s.label,
      value: s.value,
      color: s.tone === 'neutral' ? C.ink : toneColor(s.tone),
    })),
    mode: c.mode && { label: c.mode.label, color: toneColor(c.mode.tone) },
    network: c.network,
  };
}
