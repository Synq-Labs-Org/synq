import type { IconSlot } from '../../content/model.js';
import { img, svgSrc, type Node } from '../kit.js';
import { COLOR } from './tokens.js';

/*
 * Line icons (24 x 24, 1.6 stroke) for row slots and status glyphs, drawn
 * as SVG so they do not depend on font coverage.
 */

const PATHS: Record<
  IconSlot | 'clock' | 'check' | 'cross' | 'dots' | 'arrow' | 'enter',
  string
> = {
  balance:
    '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M15 14.5h3"/><path d="M6 6l9-3 2 3"/>',
  reserve:
    '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  pending:
    '<path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9s8 4 8 9"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/>',
  approvals:
    '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>',
  status: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>',
  gift: '<rect x="4" y="9" width="16" height="12" rx="1"/><path d="M3 9h18v-3H3zM12 6v15M12 6c-2-4-7-3-5 0M12 6c2-4 7-3 5 0"/>',
  hotel:
    '<path d="M4 21V5h10v16M14 9h6v12M2 21h20"/><path d="M7 8h1M10 8h1M7 12h1M10 12h1M7 16h1M10 16h1M17 13h1M17 17h1"/>',
  vote: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/>',
  provider: '<path d="M4 10h16l-1-5H5zM5 10v10h14V10M10 20v-5h4v5"/>',
  chart: '<path d="M4 20h16"/><path d="M6 17v-4M10 17v-7M14 17v-5M18 17V6"/>',
  calendar:
    '<rect x="4" y="6" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v5M16 3v5"/>',
  tx: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  settlement: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12l3 3 5-6"/>',
  signature:
    '<path d="M3 19c3-1 4-6 6-6s1 5 3 5 2-3 4-3 2 2 5 1"/><path d="M15 3l5 5-7 7H8v-5z"/>',
  evidence: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 14l2 2 4-4"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/>',
  flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  shield:
    '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/><path d="M12 8v5M12 16v.5"/>',
  agent:
    '<circle cx="12" cy="9" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/><path d="M3 9h2M19 9h2M12 2v2"/>',
  kernel:
    '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><circle cx="12" cy="12" r="2.5"/>',
  route:
    '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/>',
  flight:
    '<path d="M21 4c-1-1-3 0-4 1l-3 3-8-2-2 2 6 4-3 3H4l-1 1 4 2 2 4 1-1v-3l3-3 4 6 2-2-2-8 3-3c1-1 2-3 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  dots: '<circle cx="8" cy="8" r="1.6"/><circle cx="16" cy="8" r="1.6"/><circle cx="8" cy="16" r="1.6"/><circle cx="16" cy="16" r="1.6"/><circle cx="12" cy="12" r="1.6"/>',
  arrow: '<path d="M4 12h15M14 6l6 6-6 6"/>',
  enter: '<path d="M4 12h12M11 7l5 5-5 5M20 5v14"/>',
};

export type IconName = keyof typeof PATHS;

export function icon(
  name: IconName,
  size: number,
  color: string = COLOR.ink,
  width = 1.6,
): Node {
  const fill = name === 'dots' ? color : 'none';
  return img(
    svgSrc(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`,
    ),
    size,
    size,
    { flexShrink: 0 },
  );
}
