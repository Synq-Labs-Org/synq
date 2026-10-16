import type { CardTheme } from '../kit.js';
import { asciiCard } from './layout.js';
import { ASCII_CARD, asciiFonts } from './tokens.js';

export * as tokens from './tokens.js';
export * as primitives from './primitives.js';
export { asciiArt, ART_SIZE } from './art.js';

/** Monochrome ASCII / dot-matrix theme (the owner's design system). */
export const asciiTheme: CardTheme = {
  id: 'ascii',
  width: ASCII_CARD.width,
  height: ASCII_CARD.height,
  fonts: asciiFonts,
  render: asciiCard,
};
