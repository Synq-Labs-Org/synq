import { asciiTheme } from './ascii/index.js';
import { holoTheme } from './holo/index.js';
import type { CardTheme } from './kit.js';

/** Every registered card theme, by id. */
export const CARD_THEMES: Readonly<Record<string, CardTheme>> = {
  [asciiTheme.id]: asciiTheme,
  [holoTheme.id]: holoTheme,
};
export const DEFAULT_CARD_THEME = asciiTheme.id;

/** A theme by id; unknown ids fall back to the default theme. */
export function cardTheme(
  id: string | null | undefined = process.env.SYNQ_CARD_THEME,
): CardTheme {
  return (id && CARD_THEMES[id]) || CARD_THEMES[DEFAULT_CARD_THEME]!;
}
