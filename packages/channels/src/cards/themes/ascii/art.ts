import type { ArtSlot, ArtSpec } from '../../content/model.js';
import { ART_COLS, ART_DATA, ART_ROWS } from './art-data.js';

/*
 * ASCII art registry: one generated character grid per semantic slot (see
 * scripts/card-art.ts), plus the vertical Japanese tagline beside it. The
 * taglines are flavour only; every functional label stays in English.
 * After changing a tagline, rerun scripts/card-fonts.py so the Japanese
 * font subset covers it.
 */

export type AsciiArt = Readonly<{
  lines: readonly string[];
  /** Vertical tagline columns, read right to left. */
  tagline: readonly string[];
}>;

const TAGLINE: Record<ArtSlot, readonly string[]> = {
  treasury: ['旅を共に'],
  approval: ['みんなで決める'],
  gift: ['小さな贈り物'],
  hotel: ['一緒に、', 'もっと遠くへ'],
  dca: ['少しずつ、', '確かに'],
  receipt: ['記録に残す'],
  deal: ['約束を形に'],
  escrow: ['預けて、守る'],
  invoice: ['請求と支払い'],
  risk: ['立ち止まって確認'],
  agent: ['皆の知恵'],
  contractor: ['小さな支払いが、', '大きな思い出に。'],
  flight: ['空へ、共に'],
};

/** Japanese reading of the wordmark. */
export const WORDMARK_KANA = 'シンク';

export const ART_SIZE = { cols: ART_COLS, rows: ART_ROWS } as const;

export function asciiArt(spec: ArtSpec): AsciiArt {
  // State variants: a cleared hold, and a paid stamp only once settled.
  const key =
    spec.slot === 'risk' && spec.tone === 'ok'
      ? 'risk_clear'
      : spec.slot === 'invoice' || spec.slot === 'receipt'
        ? spec.tone === 'ok'
          ? 'stamped'
          : 'receipt'
        : spec.slot;
  return {
    lines: ART_DATA[key] ?? ART_DATA[spec.slot] ?? [],
    tagline: TAGLINE[spec.slot],
  };
}
