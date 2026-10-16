import { fontFile, type FontSpec } from '../kit.js';

/*
 * Tokens of the Synq ASCII design system (reports/handoff/design/
 * ASCII_DESIGN_SYSTEM.md). Colours and line weights are the spec's values;
 * sizes are the spec's points, drawn at SCALE px per pt on the 1000 px card.
 */

export const COLOR = {
  bg: '#000000',
  raised: '#0B0B0B',
  ink: '#F2F2F2',
  ink2: '#A0A0A0',
  ink3: '#5A5A5A',
  line: '#3A3A3A',
  approvedInk: '#9BE59B',
  approvedBg: '#0E1F0E',
  approvedLine: '#2E5E2E',
  /** ASCII art is a touch dimmer than text so labels stay on top. */
  art: '#D6D6D6',
} as const;

export const FONT = {
  mono: 'JetBrains Mono',
  display: 'Departure Mono',
  jp: 'Noto Sans JP',
} as const;

/** px per pt: the 1000 px card is drawn like a ~520 pt wide screen. */
export const SCALE = 1.9;
const pt = (n: number) => Math.round(n * SCALE);

export const SIZE = {
  wordmark: pt(32),
  kana: pt(9.5),
  title: pt(14),
  section: pt(11),
  body: pt(13),
  detail: pt(11),
  small: pt(10),
  amount: pt(38),
  unit: pt(16),
  /** ASCII art: 9 px bold mono on an 8 px line, one cell = 5.4 x 8 px. */
  art: 9,
  artLine: 8,
  tagline: pt(12),
  icon: pt(13),
} as const;

export const SPACE = {
  frame: 20,
  pad: 44,
  gap: pt(7),
  rowY: pt(5.5),
  rowX: pt(8),
} as const;

export const RADIUS = {
  frame: 44,
  panel: pt(7),
  badge: pt(3),
  pill: 999,
} as const;

/** Advance width of the mono font, in em. */
export const MONO_ADVANCE = 0.6;

export const LINE = {
  /** 1 pt hairline. */
  width: 2,
  dotted: 'dashed',
} as const;

export const ASCII_CARD = { width: 1000, height: 1400 } as const;

export function asciiFonts(dir?: string): FontSpec[] {
  return [
    fontFile(FONT.mono, 'JetBrainsMono-Regular.ttf', 400, dir),
    fontFile(FONT.mono, 'JetBrainsMono-Bold.ttf', 700, dir),
    fontFile(FONT.display, 'DepartureMono-Regular.otf', 400, dir),
    fontFile(FONT.jp, 'NotoSansJP-Subset.ttf', 400, dir),
  ];
}
