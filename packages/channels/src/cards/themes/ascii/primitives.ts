import type { ContentBadge, ContentRow, Tone } from '../../content/model.js';
import { h, t, type Child, type Node, type Style } from '../kit.js';
import { icon } from './icons.js';
import { COLOR, FONT, LINE, RADIUS, SIZE, SPACE } from './tokens.js';

/*
 * Components of the ASCII system: notched panels, hairline section rules,
 * list rows, bracket buttons drawn as text, status badges and outlined
 * progress bars. Monochrome; only an "ok" badge uses the muted green.
 */

const border = `${LINE.width}px solid ${COLOR.line}`;

/** Ink colour for a tone (values and stats). */
export const toneInk = (tone: Tone) =>
  tone === 'muted' ? COLOR.ink2 : tone === 'pending' ? COLOR.ink2 : COLOR.ink;

/** Outlined rounded panel with its label notched into the top border. */
export function panel(
  label: string,
  children: Child[],
  options: { style?: Style; strong?: boolean } = {},
): Node {
  return h(
    {
      position: 'relative',
      flexDirection: 'column',
      border: options.strong
        ? `${LINE.width + 1}px ${LINE.dotted} ${COLOR.ink}`
        : border,
      borderRadius: RADIUS.panel,
      padding: `${SPACE.gap + 8}px ${SPACE.rowX}px ${SPACE.gap}px`,
      flexShrink: 0,
      ...options.style,
    },
    h(
      {
        position: 'absolute',
        top: -Math.round(SIZE.section * 0.72),
        left: SPACE.rowX - 6,
        padding: '0 8px',
        backgroundColor: COLOR.bg,
        alignItems: 'center',
        gap: 8,
      },
      t(label, {
        fontSize: SIZE.section,
        letterSpacing: 2,
        color: options.strong ? COLOR.ink : COLOR.ink2,
        fontWeight: options.strong ? 700 : 400,
      }),
    ),
    ...children,
  );
}

/** "LABEL ─────────" with an optional trailing value. */
export function sectionRule(label: string, trailing?: string | null): Node {
  return h(
    { alignItems: 'center', gap: 12, width: '100%', flexShrink: 0 },
    t(label, { fontSize: SIZE.section, letterSpacing: 2, color: COLOR.ink2 }),
    h({
      flexGrow: 1,
      borderTop: `${LINE.width}px ${LINE.dotted} ${COLOR.line}`,
    }),
    trailing
      ? t(trailing, { fontSize: SIZE.section, color: COLOR.ink2 })
      : null,
  );
}

/** Small outlined status box: ✓ approved (muted green), clock for pending. */
export function badge(b: ContentBadge, size = SIZE.small): Node {
  const ok = b.tone === 'ok';
  const bad = b.tone === 'bad';
  const glyph =
    b.tone === 'ok'
      ? icon('check', size, COLOR.approvedInk, 2.2)
      : b.tone === 'pending'
        ? icon('clock', size, COLOR.ink2, 2)
        : bad
          ? icon('cross', size - 2, COLOR.bg, 2.6)
          : null;
  return h(
    {
      alignItems: 'center',
      gap: 6,
      padding: '3px 9px',
      borderRadius: RADIUS.badge,
      flexShrink: 0,
      border: `${LINE.width}px solid ${ok ? COLOR.approvedLine : bad ? COLOR.ink : b.tone === 'pending' ? COLOR.ink3 : COLOR.line}`,
      backgroundColor: ok ? COLOR.approvedBg : bad ? COLOR.ink : 'transparent',
    },
    glyph,
    t(b.label, {
      fontSize: size,
      color: ok
        ? COLOR.approvedInk
        : bad
          ? COLOR.bg
          : b.tone === 'pending'
            ? COLOR.ink2
            : COLOR.ink,
      fontWeight: bad ? 700 : 400,
    }),
  );
}

/** Thin outlined bar with a white fill. */
export function progress(
  value: number,
  width: number | string = '100%',
  height = 10,
): Node {
  const v = Math.max(0, Math.min(1, value));
  return h(
    {
      width,
      height,
      border: `${LINE.width}px solid ${COLOR.ink3}`,
      borderRadius: 3,
      padding: 1,
      flexShrink: 0,
    },
    v > 0
      ? h({
          width: `${Math.max(2, Math.round(v * 1000) / 10)}%`,
          height: '100%',
          borderRadius: 2,
          backgroundColor: COLOR.ink,
        })
      : null,
  );
}

/** `[  label  ⇥ ]` outline button, or the strong white pill `{ ⁘ label → }`. */
export function button(
  label: string,
  strong: boolean,
  width: number | string = '100%',
): Node {
  const ink = strong ? COLOR.bg : COLOR.ink;
  const brace = (c: string) =>
    t(c, {
      fontSize: SIZE.body + 4,
      color: strong ? COLOR.ink3 : COLOR.ink,
      flexShrink: 0,
    });
  return h(
    {
      width,
      height: 60,
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 18px',
      borderRadius: strong ? RADIUS.panel + 2 : RADIUS.panel,
      border: `${LINE.width}px solid ${COLOR.ink}`,
      backgroundColor: strong ? COLOR.ink : 'transparent',
      flexShrink: 0,
    },
    brace(strong ? '{' : '['),
    h(
      { alignItems: 'center', gap: 16, minWidth: 0 },
      strong ? icon('dots', SIZE.body + 2, ink) : null,
      t(label, {
        fontSize: SIZE.body,
        fontWeight: 700,
        color: ink,
        letterSpacing: 0.5,
      }),
      icon(strong ? 'arrow' : 'enter', SIZE.body + 2, ink, 2),
    ),
    brace(strong ? '}' : ']'),
  );
}

/** `[ LABEL ]` chip for the execution mode. */
export function chip(label: string, tone: Tone): Node {
  const ok = tone === 'ok';
  return h(
    {
      alignItems: 'center',
      padding: '4px 10px',
      borderRadius: RADIUS.badge,
      border: `${LINE.width}px solid ${ok ? COLOR.approvedLine : COLOR.ink3}`,
      backgroundColor: ok ? COLOR.approvedBg : 'transparent',
      flexShrink: 0,
    },
    t(`[ ${label} ]`, {
      fontSize: SIZE.small,
      letterSpacing: 1,
      color: ok ? COLOR.approvedInk : COLOR.ink,
    }),
  );
}

/** A list row: line icon, title over detail, trailing value and badge. */
export function row(
  r: ContentRow,
  options: { dense: boolean; last: boolean },
): Node {
  return h(
    {
      alignItems: 'center',
      gap: SPACE.rowX,
      padding: `${options.dense ? SPACE.rowY - 3 : SPACE.rowY}px ${SPACE.rowX}px`,
      borderBottom: options.last ? 'none' : border,
      backgroundColor: r.highlight ? COLOR.raised : 'transparent',
      width: '100%',
      flexShrink: 0,
    },
    h(
      { width: SIZE.icon + 10, justifyContent: 'center', flexShrink: 0 },
      icon(r.icon, SIZE.icon, r.highlight ? COLOR.ink : COLOR.ink),
    ),
    h(
      {
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: 3,
      },
      h(
        { alignItems: 'center', gap: 10, minWidth: 0 },
        t(r.title, {
          fontSize: options.dense ? SIZE.body - 2 : SIZE.body,
          color: COLOR.ink,
          flexShrink: 1,
          minWidth: 0,
        }),
        r.badge ? badge(r.badge, SIZE.small - 2) : null,
      ),
      r.detail
        ? t(r.detail, { fontSize: SIZE.detail, color: COLOR.ink2, minWidth: 0 })
        : null,
      r.progress !== null
        ? h({ marginTop: 5 }, progress(r.progress, '100%', 9))
        : null,
    ),
    r.value
      ? h(
          { alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: 330 },
          r.tone === 'ok'
            ? icon('check', SIZE.body - 4, COLOR.approvedInk, 2.4)
            : r.tone === 'pending'
              ? icon('clock', SIZE.body - 4, COLOR.ink2, 2)
              : r.tone === 'bad'
                ? icon('cross', SIZE.body - 6, COLOR.ink, 2.6)
                : null,
          t(r.value, {
            fontSize: options.dense ? SIZE.body - 2 : SIZE.body,
            fontWeight: 700,
            color: r.tone === 'ok' ? COLOR.approvedInk : toneInk(r.tone),
          }),
        )
      : null,
  );
}

export const FONT_STACK = {
  mono: FONT.mono,
  display: FONT.display,
  jp: FONT.jp,
};
