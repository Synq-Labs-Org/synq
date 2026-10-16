import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardBannerRenderer } from '../packages/channels/src/cards/banner.js';
import {
  ARC_EDGE_CASES,
  ARC_SAMPLES,
  EDGE_CASES,
  SAMPLE_CARDS,
} from '../tests/channels/card-samples.js';

/**
 * Writes the sample and edge-case card images for design review:
 * `node --import tsx scripts/card-banners.ts [outDir] [classic|arc|all] [theme]`
 * (defaults: docs/design/card-banners, all, SYNQ_CARD_THEME or ascii).
 */
const out = process.argv[2] ?? 'docs/design/card-banners';
const set = process.argv[3] ?? 'all';
const renderer = new CardBannerRenderer({ theme: process.argv[4] });
mkdirSync(out, { recursive: true });
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
const classic = [
  ...Object.entries(SAMPLE_CARDS),
  ...EDGE_CASES.map(([name, card]) => [`edge-${slug(name)}`, card] as const),
];
const arc = [
  ...Object.entries(ARC_SAMPLES),
  ...ARC_EDGE_CASES.map(
    ([name, card]) => [`edge-${slug(name)}`, card] as const,
  ),
];
const cards =
  set === 'classic' ? classic : set === 'arc' ? arc : [...classic, ...arc];
for (const [name, card] of cards) {
  const path = join(out, `${name}.png`);
  const started = Date.now();
  const png = await renderer.render(card);
  writeFileSync(path, png);
  console.log(
    `${path} ${Math.round(png.length / 1024)} KB ${Date.now() - started} ms`,
  );
}
