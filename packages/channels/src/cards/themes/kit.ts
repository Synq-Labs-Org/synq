import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CardContent } from '../content/model.js';

/*
 * Theme-neutral building blocks: the satori element tree and font loading.
 * Themes compose these; nothing here has a look of its own.
 */

export type Style = Record<string, string | number>;
export type Child = Node | string | null | undefined | false;
export type Node = {
  type: string;
  props: {
    style?: Style;
    children?: Child[] | Child;
    src?: string;
    width?: number;
    height?: number;
  };
};

export const h = (style: Style, ...children: Child[]): Node => ({
  type: 'div',
  props: {
    style: { display: 'flex', boxSizing: 'border-box', ...style },
    children: children.filter(
      (c) => c !== null && c !== undefined && c !== false,
    ),
  },
});
/** One line of text, ellipsised if it overflows. */
export const t = (text: string, style: Style = {}): Node =>
  h(
    {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      ...style,
    },
    text,
  );
export const img = (
  src: string,
  width: number,
  height: number,
  style: Style = {},
): Node => ({
  type: 'img',
  props: { src, width, height, style: { width, height, ...style } },
});
export const svgSrc = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

export type FontSpec = {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: 'normal';
};

/** Bundled font directory (packages/channels/assets/fonts). */
export const FONT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../assets/fonts',
);
export const fontFile = (
  name: string,
  file: string,
  weight: FontSpec['weight'] = 400,
  dir = FONT_DIR,
): FontSpec => ({
  name,
  data: readFileSync(join(dir, file)),
  weight,
  style: 'normal',
});

/**
 * A card theme: one module that turns theme-independent card content into a
 * satori tree. It owns its tokens, fonts, primitives and art registry.
 */
export interface CardTheme {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Fonts the theme draws with; called once per renderer. */
  fonts(dir?: string): FontSpec[];
  render(content: CardContent): Node;
}
