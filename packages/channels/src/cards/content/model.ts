import type { CardExecutionMode, InteractiveCardType } from '@synq/schemas';

/*
 * Theme-independent card content. Every card type maps to this semantic
 * description; a theme turns it into pixels. Nothing here names a colour, a
 * font, a glyph or a piece of art: tones, icons and art are semantic slots
 * that each theme resolves on its own.
 */

/** Meaning of a value, badge or status; themes pick the look. */
export type Tone = 'neutral' | 'ok' | 'pending' | 'bad' | 'info' | 'muted';

/** Collector grade: pending common, approved rare, settled holo; risk holds warn. */
export type Grade = 'COMMON' | 'RARE' | 'HOLO_RARE' | 'WARNING';

/** Semantic art slot; each theme registers art for every slot. */
export const ART_SLOTS = [
  'treasury',
  'approval',
  'gift',
  'hotel',
  'dca',
  'receipt',
  'deal',
  'escrow',
  'invoice',
  'risk',
  'agent',
  'contractor',
  'flight',
] as const;
export type ArtSlot = (typeof ART_SLOTS)[number];

/**
 * Art for a card: the slot plus optional state a theme may draw (all are
 * proportions or tones of figures the card states in text, never amounts).
 */
export type ArtSpec = Readonly<{
  slot: ArtSlot;
  /** 0..1, e.g. paid / total or spent / cap. */
  progress?: number;
  /** Discrete progress, e.g. approvals counted of required, milestone step. */
  count?: { lit: number; total: number };
  /** Overall state of the subject. */
  tone?: Tone;
  /** Per-participant tones, e.g. council roles. */
  nodes?: readonly Tone[];
}>;

/** Semantic row icon; themes map each to a glyph or drawing. */
export type IconSlot =
  | 'balance'
  | 'reserve'
  | 'pending'
  | 'person'
  | 'approvals'
  | 'status'
  | 'gift'
  | 'hotel'
  | 'vote'
  | 'provider'
  | 'chart'
  | 'calendar'
  | 'tx'
  | 'settlement'
  | 'signature'
  | 'evidence'
  | 'doc'
  | 'coin'
  | 'flag'
  | 'shield'
  | 'agent'
  | 'kernel'
  | 'route'
  | 'flight';

export type ContentBadge = Readonly<{ label: string; tone: Tone }>;

export type ContentRow = Readonly<{
  icon: IconSlot;
  title: string;
  detail: string | null;
  /** Figure on the right (exact, or an explicitly approximate fit). */
  value: string | null;
  tone: Tone;
  badge: ContentBadge | null;
  /** Proportion bar under the detail (0..1). */
  progress: number | null;
  /** The pick / preferred / decisive row. */
  highlight: boolean;
}>;

export type ContentStat = Readonly<{
  label: string;
  value: string;
  tone: Tone;
}>;

export type CardContent = Readonly<{
  type: InteractiveCardType;
  cardId: string;
  /** e.g. "DEAL ROOM". */
  typeLabel: string;
  /** Section label of the main panel, e.g. "GROUP FUND". */
  section: string;
  title: string;
  subtitle: string;
  headline: Readonly<{
    label: string;
    value: string;
    unit: string | null;
  }> | null;
  /** Overall status badge, when the card has one. */
  status: ContentBadge | null;
  rows: readonly ContentRow[];
  note: string | null;
  stats: readonly ContentStat[];
  network: string | null;
  mode: Readonly<{
    id: CardExecutionMode | 'TESTNET' | 'LOCAL';
    label: string;
    tone: Tone;
  }> | null;
  /** Immutable references (shortened), e.g. terms hash, tx, case id. */
  refs: readonly Readonly<{ label: string; value: string }>[];
  art: ArtSpec;
  grade: Grade;
  actions: readonly Readonly<{ label: string; primary: boolean }>[];
  issuedAt: number;
  /** When the facts were read; null for cards without freshness. */
  observedAt: number | null;
}>;
