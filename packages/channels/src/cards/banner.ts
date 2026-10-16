import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import type { InteractiveCard } from '@synq/schemas';
import { cardContent } from './content/index.js';
import type { CardContent } from './content/model.js';
import type { CardTheme, FontSpec, Node } from './themes/kit.js';
import { cardTheme } from './themes/registry.js';
import { encodeOpaquePng } from './png.js';

export {
  clip,
  displayAmount,
  groupDigits,
  shortHex,
  type CardContent,
} from './content/index.js';
export {
  CARD_THEMES,
  DEFAULT_CARD_THEME,
  cardTheme,
} from './themes/registry.js';
export type { CardTheme } from './themes/kit.js';

/*
 * Card images: one PNG per canonical card. A card is first mapped to its
 * theme-independent content (cards/content), then a theme (cards/themes)
 * draws it. Fonts are bundled; nothing is fetched at render time.
 */

/** Portrait card image, 5:7. */
export const CARD_IMAGE_WIDTH = 1000;
export const CARD_IMAGE_HEIGHT = 1400;
/** Kept for callers of the landscape banner era; same values as CARD_IMAGE_*. */
export const BANNER_WIDTH = CARD_IMAGE_WIDTH;
export const BANNER_HEIGHT = CARD_IMAGE_HEIGHT;

export type CardBannerOptions = {
  /** Theme id or module; default `SYNQ_CARD_THEME`, else "ascii". */
  theme?: string | CardTheme;
  /** Network for cards that do not carry a chain id (default "Monad Testnet"). */
  networkLabel?: string | null;
  fontsDir?: string;
  cacheSize?: number;
};

/** Renders canonical cards to 1000×1400 PNGs, offline, in one theme. */
export class CardBannerRenderer {
  readonly theme: CardTheme;
  private fonts: FontSpec[] | null = null;
  private readonly cache = new Map<string, Buffer>();
  constructor(private readonly options: CardBannerOptions = {}) {
    this.theme =
      typeof options.theme === 'object'
        ? options.theme
        : cardTheme(options.theme);
  }

  private loadFonts() {
    return (this.fonts ??= this.theme.fonts(this.options.fontsDir));
  }

  /** Cache key: theme, card id and a hash of the whole card, so any change re-renders. */
  static key(card: InteractiveCard, themeId = cardTheme().id) {
    return `${themeId}:${card.cardId}:${createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16)}`;
  }

  /** The card's theme-independent content (title, amounts, rows, network, mode). */
  content(card: InteractiveCard): CardContent {
    return cardContent(card, { networkLabel: this.options.networkLabel });
  }

  tree(card: InteractiveCard): Node {
    return this.theme.render(this.content(card));
  }

  async svg(card: InteractiveCard): Promise<string> {
    return satori(this.tree(card) as never, {
      width: this.theme.width,
      height: this.theme.height,
      fonts: this.loadFonts(),
    });
  }

  async render(card: InteractiveCard): Promise<Buffer> {
    const key = CardBannerRenderer.key(card, this.theme.id);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const svg = await this.svg(card);
    const image = new Resvg(svg, {
      fitTo: { mode: 'width', value: this.theme.width },
      font: { loadSystemFonts: false },
    }).render();
    const png = encodeOpaquePng(image.pixels, image.width, image.height);
    this.cache.set(key, png);
    while (this.cache.size > (this.options.cacheSize ?? 100))
      this.cache.delete(this.cache.keys().next().value!);
    return png;
  }
}
