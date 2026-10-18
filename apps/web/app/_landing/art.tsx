'use client';

import { useRef, type ReactNode } from 'react';
import type { WorkspaceTheme } from '../workspaces/theme-picker';
import { AsciiField, AsciiHeroArt } from './ascii-hero';
import { useLandingTheme } from './theme';
import { useInView } from './use-motion';

export type GlyphName = 'vault' | 'key' | 'coin' | 'chat' | 'shield' | 'chain';

/**
 * Everything art-directed lives behind this interface. Sections ask for a
 * hero, an ambient field or a glyph and never know which theme draws it.
 * Adding a theme means adding one entry here and one token block in CSS.
 */
export type ThemeArt = {
  Hero: () => ReactNode;
  /** Ambient background art for a section; null draws nothing. */
  Field: (() => ReactNode) | null;
  Glyph: (props: { name: GlyphName }) => ReactNode;
  /** Text decoration around primary buttons (the iOS theme's bracket glyphs). */
  brackets: readonly [string, string];
};

const ASCII_GLYPHS: Record<GlyphName, string> = {
  vault: ['.-------.', '| .---. |', '| | O | |', "| '---' |", "'-------'"].join(
    '\n',
  ),
  key: [
    '  ___    ',
    ' / _ \\   ',
    '| (_) |==',
    ' \\___/ || ',
    '        ""',
  ].join('\n'),
  coin: [
    '  .---.  ',
    ' / USD \\ ',
    '|  ---  |',
    ' \\ ARC / ',
    "  '---'  ",
  ].join('\n'),
  chat: ['.--------.', '| > ...  |', "'--. .---'", "   '/     "].join('\n'),
  shield: [
    '.-------.',
    '|  _|_  |',
    '|   |   |',
    ' \\  |  / ',
    "  '---'  ",
  ].join('\n'),
  chain: ['[]--[]--[]', ' |    |   ', '[]    []  '].join('\n'),
};

const SVG_GLYPHS: Record<GlyphName, string> = {
  vault: 'M4 5h16v14H4zM12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 12h2',
  key: 'M8 15a4 4 0 1 1 3.5-6H21v3h-3v3h-3v-3h-3.5A4 4 0 0 1 8 15z',
  coin: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v10M15 9.5c0-1-1.3-1.7-3-1.7s-3 .8-3 1.9c0 2.6 6 1.4 6 4.2 0 1.1-1.3 1.9-3 1.9s-3-.8-3-1.8',
  chat: 'M4 5h16v11H10l-4 4v-4H4z',
  shield: 'M12 3l8 3v6c0 4.5-3.3 7.8-8 9-4.7-1.2-8-4.5-8-9V6z',
  chain: 'M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M9 12h6',
};

function SimpleGlyph({ name }: { name: GlyphName }) {
  return (
    <svg className="lp-glyph-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d={SVG_GLYPHS[name]} />
    </svg>
  );
}

/** Paper, Holo and Ledger share this simpler slot; tokens do the theming. */
function SimpleHero() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, '0px');
  return (
    <div
      className="lp-simple-hero"
      ref={ref}
      data-run={inView ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div className="lp-simple-word">Synq</div>
      <div className="lp-disc-wrap">
        <div className="lp-disc">
          <span>S</span>
        </div>
        <i className="lp-orbit o1" />
        <i className="lp-orbit o2" />
      </div>
    </div>
  );
}

const asciiArt: ThemeArt = {
  Hero: () => <AsciiHeroArt />,
  Field: () => <AsciiField />,
  Glyph: ({ name }) => (
    <pre className="lp-ascii lp-glyph-ascii" aria-hidden="true">
      {ASCII_GLYPHS[name]}
    </pre>
  ),
  brackets: ['[', ']'],
};

const simpleArt: ThemeArt = {
  Hero: () => <SimpleHero />,
  Field: null,
  Glyph: SimpleGlyph,
  brackets: ['', ''],
};

export const THEME_ART: Record<WorkspaceTheme, ThemeArt> = {
  ascii: asciiArt,
  ledger: simpleArt,
  paper: simpleArt,
  holo: simpleArt,
};

export const useThemeArt = () => THEME_ART[useLandingTheme().theme];

export function ArtHero() {
  const { Hero } = useThemeArt();
  return <Hero />;
}

export function ArtField() {
  const { Field } = useThemeArt();
  return Field ? <Field /> : null;
}

export function ArtGlyph({ name }: { name: GlyphName }) {
  const { Glyph } = useThemeArt();
  return <Glyph name={name} />;
}

/** Link-styled button whose decoration comes from the theme. */
export function ThemedLink({
  href,
  children,
  primary,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  const { brackets } = useThemeArt();
  return (
    <a className={primary ? 'lp-btn lp-btn-primary' : 'lp-btn'} href={href}>
      {brackets[0] ? <span aria-hidden="true">{brackets[0]}</span> : null}
      {children}
      {brackets[1] ? <span aria-hidden="true">{brackets[1]}</span> : null}
    </a>
  );
}
