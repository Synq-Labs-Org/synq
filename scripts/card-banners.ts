import { writeFileSync } from 'node:fs';
import { CardBannerRenderer } from '../packages/channels/src/cards/banner.js';
import { SAMPLE_CARDS } from '../tests/channels/card-samples.js';

/** Writes the sample card banners to docs/design/card-banners for design review. */
const renderer = new CardBannerRenderer();
for (const [name, card] of Object.entries(SAMPLE_CARDS)) {
  writeFileSync(
    `docs/design/card-banners/${name}.png`,
    await renderer.render(card),
  );
  console.log(`docs/design/card-banners/${name}.png`);
}
