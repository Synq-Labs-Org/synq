import { fontFile, type CardTheme } from '../kit.js';
import { holoCard } from './layout.js';

export * as tokens from './face.js';

/** The holo trading-card theme (previous design), kept to prove theme swaps. */
export const holoTheme: CardTheme = {
  id: 'holo',
  width: 1000,
  height: 1400,
  fonts: (dir) => [
    fontFile('Inter', 'Inter-Regular.ttf', 400, dir),
    fontFile('Inter', 'Inter-SemiBold.ttf', 600, dir),
    fontFile('Inter', 'Inter-Bold.ttf', 700, dir),
  ],
  render: holoCard,
};
