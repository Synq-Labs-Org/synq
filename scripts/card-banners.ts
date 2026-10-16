import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardBannerRenderer } from '../packages/channels/src/cards/banner.js';
import { EDGE_CASES, SAMPLE_CARDS } from '../tests/channels/card-samples.js';

/**
 * Writes the sample and edge-case card images for design review:
 * `node --import tsx scripts/card-banners.ts [outDir]` (default docs/design/card-banners).
 */
const out = process.argv[2] ?? 'docs/design/card-banners';
mkdirSync(out, { recursive: true });
const renderer = new CardBannerRenderer();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
const cards = [
  ...Object.entries(SAMPLE_CARDS),
  ...EDGE_CASES.map(([name, card]) => [`edge-${slug(name)}`, card] as const),
];
for (const [name, card] of cards) {
  const path = join(out, `${name}.png`);
  const png = await renderer.render(card);
  writeFileSync(path, png);
  console.log(`${path} ${Math.round(png.length / 1024)} KB`);
}
