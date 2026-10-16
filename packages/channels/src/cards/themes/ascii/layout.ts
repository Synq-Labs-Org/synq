import type { CardContent } from '../../content/model.js';
import { ageLabel, when } from '../../content/text.js';
import { h, t, type Node } from '../kit.js';
import { ART_SIZE, WORDMARK_KANA, asciiArt } from './art.js';
import {
  badge,
  button,
  chip,
  panel,
  row,
  sectionRule,
  toneInk,
} from './primitives.js';
import {
  ASCII_CARD,
  COLOR,
  FONT,
  LINE,
  MONO_ADVANCE,
  RADIUS,
  SIZE,
  SPACE,
} from './tokens.js';

/*
 * The ASCII card: a phone-screen-like portrait panel on black. Header with
 * the SYNQ wordmark, network and mode; the type title; a full-bleed
 * generated art band with a vertical Japanese tagline; the main notched
 * panel with the exact headline amount; list rows; the action drawn as a
 * bracket button; network / mode / stat cells; immutable refs and freshness.
 */

const INNER = ASCII_CARD.width - 2 * SPACE.frame;
const CONTENT = INNER - 2 * (SPACE.pad - SPACE.frame);
const GRADE: Record<CardContent['grade'], string> = {
  COMMON: 'COMMON',
  RARE: 'RARE',
  HOLO_RARE: 'HOLO RARE',
  WARNING: 'WARNING',
};

function header(c: CardContent): Node {
  return h(
    {
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      width: CONTENT,
      flexShrink: 0,
    },
    h(
      { flexDirection: 'column' },
      t('SYNQ', {
        fontFamily: FONT.display,
        fontSize: SIZE.wordmark,
        letterSpacing: 6,
        color: COLOR.ink,
        lineHeight: 1,
      }),
      t(WORDMARK_KANA, {
        fontFamily: FONT.jp,
        fontSize: SIZE.kana,
        color: COLOR.ink,
        marginTop: 2,
        marginLeft: 4,
      }),
    ),
    h(
      {
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
        paddingTop: 6,
      },
      // The chip already names Arc / Sepolia; other networks are spelled out.
      c.network &&
        !(c.mode?.label ?? '')
          .toLowerCase()
          .includes(c.network.toLowerCase().split(' ')[0]!)
        ? t(c.network, { fontSize: SIZE.small, color: COLOR.ink })
        : null,
      c.mode ? chip(c.mode.label, c.mode.tone) : chip('MODE UNKNOWN', 'muted'),
    ),
  );
}

function titleRow(c: CardContent): Node {
  return h(
    {
      alignItems: 'center',
      justifyContent: 'space-between',
      width: CONTENT,
      marginTop: 14,
      flexShrink: 0,
    },
    h(
      { alignItems: 'center', gap: 22 },
      t('←', { fontSize: SIZE.title + 2, color: COLOR.ink }),
      t(c.typeLabel, {
        fontSize: SIZE.title,
        letterSpacing: 3,
        color: COLOR.ink,
      }),
    ),
    t(`#${c.cardId.slice(-6)}`, {
      fontSize: SIZE.small,
      color: COLOR.ink3,
      letterSpacing: 1,
    }),
  );
}

function hero(c: CardContent): Node {
  const art = asciiArt(c.art);
  const ref = c.refs[0];
  const w = Math.ceil(ART_SIZE.cols * SIZE.art * MONO_ADVANCE);
  const hh = ART_SIZE.rows * SIZE.artLine;
  return h(
    {
      position: 'relative',
      width: INNER,
      height: hh,
      marginTop: 12,
      justifyContent: 'center',
      flexShrink: 0,
      borderTop: `${LINE.width}px ${LINE.dotted} ${COLOR.line}`,
      borderBottom: `${LINE.width}px ${LINE.dotted} ${COLOR.line}`,
      overflow: 'hidden',
    },
    h(
      { flexDirection: 'column', width: w, height: hh },
      ...art.lines.map((l) =>
        t(l || ' ', {
          fontSize: SIZE.art,
          lineHeight: `${SIZE.artLine}px`,
          height: SIZE.artLine,
          whiteSpace: 'pre',
          fontWeight: 700,
          color: COLOR.art,
          overflow: 'visible',
        }),
      ),
    ),
    h(
      {
        position: 'absolute',
        top: 16,
        right: SPACE.pad - SPACE.frame,
        flexDirection: 'row-reverse',
        gap: 6,
      },
      ...art.tagline.map((col) =>
        h(
          {
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: COLOR.bg,
            padding: '4px 2px',
          },
          ...[...col].map((ch) =>
            t(ch, {
              fontFamily: FONT.jp,
              fontSize: SIZE.tagline,
              lineHeight: 1.18,
              color: COLOR.ink,
            }),
          ),
        ),
      ),
    ),
    ref
      ? h(
          {
            position: 'absolute',
            top: 14,
            left: SPACE.pad - SPACE.frame,
            flexDirection: 'column',
            backgroundColor: COLOR.bg,
            padding: '2px 6px',
          },
          t(ref.label, {
            fontSize: SIZE.small - 3,
            color: COLOR.ink2,
            letterSpacing: 2,
          }),
          t(ref.value, { fontSize: SIZE.small, color: COLOR.ink }),
        )
      : null,
  );
}

function mainPanel(c: CardContent): Node {
  const head = c.headline;
  const amountSize = head
    ? Math.max(
        40,
        Math.min(
          SIZE.amount,
          Math.floor(560 / (Math.max(head.value.length, 1) * 0.6)),
        ),
      )
    : 0;
  return panel(
    c.section,
    [
      h(
        { justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 },
        h(
          { flexDirection: 'column', minWidth: 0, flexShrink: 1, gap: 4 },
          t(c.title, {
            fontSize: SIZE.title + 4,
            color: COLOR.ink,
            minWidth: 0,
          }),
          t(c.subtitle, {
            fontSize: SIZE.detail,
            color: COLOR.ink2,
            minWidth: 0,
          }),
        ),
        c.status ? badge(c.status, SIZE.small) : null,
      ),
      head
        ? h(
            { alignItems: 'flex-end', gap: 14, marginTop: 12 },
            t(head.label, {
              fontSize: SIZE.section,
              letterSpacing: 2,
              color: COLOR.ink2,
              paddingBottom: Math.round(amountSize * 0.16),
              flexShrink: 0,
            }),
            head.value.startsWith('≈')
              ? t('≈', {
                  fontSize: Math.round(amountSize * 0.6),
                  color: COLOR.ink2,
                  flexShrink: 0,
                  paddingBottom: Math.round(amountSize * 0.12),
                })
              : null,
            t(head.value.replace(/^≈\s*/, ''), {
              fontFamily: FONT.display,
              fontSize: amountSize,
              lineHeight: 1,
              color: COLOR.ink,
            }),
            head.unit
              ? t(head.unit, {
                  fontSize: SIZE.unit,
                  color: COLOR.ink,
                  paddingBottom: Math.round(amountSize * 0.1),
                  flexShrink: 0,
                })
              : null,
          )
        : null,
    ],
    { strong: c.grade === 'WARNING', style: { width: CONTENT, marginTop: 30 } },
  );
}

function rowsGroup(c: CardContent, dense: boolean): Node {
  const rows = c.rows.slice(0, dense ? 4 : 3);
  return h(
    {
      flexDirection: 'column',
      width: CONTENT,
      marginTop: 22,
      border: `${LINE.width}px solid ${COLOR.line}`,
      borderRadius: RADIUS.panel,
      overflow: 'hidden',
      flexShrink: 0,
    },
    ...rows.map((r, i) => row(r, { dense, last: i === rows.length - 1 })),
  );
}

/** Rough line count of a row detail (mono font), for fitting the note. */
function detailLines(c: CardContent, dense: boolean): number {
  return c.rows.slice(0, dense ? 4 : 3).reduce((extra, r) => {
    if (!r.detail) return extra;
    const width =
      CONTENT -
      4 * SPACE.rowX -
      SIZE.icon -
      (r.value ? r.value.length * SIZE.body * MONO_ADVANCE + 40 : 0);
    const perLine = Math.max(
      10,
      Math.floor(width / (SIZE.detail * MONO_ADVANCE)),
    );
    return extra + (r.detail.length > perLine ? 1 : 0);
  }, 0);
}

function note(c: CardContent, lines: number): Node | null {
  if (!c.note || lines < 1) return null;
  return h(
    {
      flexDirection: 'column',
      width: CONTENT,
      marginTop: 18,
      gap: 8,
      flexShrink: 0,
    },
    sectionRule('NOTE'),
    h(
      {
        fontSize: SIZE.detail,
        lineHeight: 1.4,
        color: COLOR.ink2,
        maxHeight: Math.round(SIZE.detail * 1.4 * lines) + 2,
        overflow: 'hidden',
      },
      c.note,
    ),
  );
}

function stats(c: CardContent): Node {
  const cells = [
    {
      label: 'NETWORK',
      value: `${c.network ?? '—'}${c.chainId === null ? '' : ` · ${c.chainId}`}`,
      ink: COLOR.ink,
    },
    {
      label: 'MODE',
      value: c.mode?.detail ?? '—',
      ink: c.mode?.tone === 'ok' ? COLOR.approvedInk : COLOR.ink,
    },
    ...c.stats
      .slice(0, 1)
      .map((s) => ({ label: s.label, value: s.value, ink: toneInk(s.tone) })),
  ];
  return h(
    {
      width: CONTENT,
      flexShrink: 0,
      borderTop: `${LINE.width}px solid ${COLOR.line}`,
      borderBottom: `${LINE.width}px solid ${COLOR.line}`,
      padding: '10px 0',
    },
    ...cells.map((s, i) =>
      h(
        {
          flexDirection: 'column',
          flexBasis: 0,
          flexGrow: 1,
          minWidth: 0,
          gap: 4,
          paddingLeft: i ? 16 : 0,
          borderLeft: i ? `${LINE.width}px solid ${COLOR.line}` : 'none',
        },
        t(s.label, {
          fontSize: SIZE.small - 3,
          letterSpacing: 2,
          color: COLOR.ink2,
        }),
        t(s.value, { fontSize: SIZE.detail + 1, color: s.ink }),
      ),
    ),
  );
}

function footer(c: CardContent): Node {
  const age = c.observedAt === null ? 0 : c.issuedAt - c.observedAt;
  const refs = c.refs
    .slice(1, 3)
    .map((r) => `${r.label} ${r.value}`)
    .join('  ');
  return h(
    {
      width: CONTENT,
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
      gap: 16,
      flexShrink: 0,
    },
    t(`${when(c.issuedAt)}${age > 0 ? ` · data ${ageLabel(age)} old` : ''}`, {
      fontSize: SIZE.small - 3,
      color: COLOR.ink2,
      flexShrink: 0,
    }),
    t(refs || GRADE[c.grade], {
      fontSize: SIZE.small - 3,
      color: COLOR.ink3,
      minWidth: 0,
      flexShrink: 1,
    }),
  );
}

/** The whole card for a content description. */
export function asciiCard(c: CardContent): Node {
  const dense = c.rows.length > 3;
  // Wrapped row details and a fourth row take the note's room first.
  const extra = detailLines(c, dense) + (dense ? 2 : 0);
  const noteLines = extra >= 3 ? 0 : extra >= 1 ? 1 : 2;
  const action = c.actions.find((a) => a.primary) ?? null;
  return h(
    {
      width: ASCII_CARD.width,
      height: ASCII_CARD.height,
      backgroundColor: COLOR.bg,
      padding: SPACE.frame,
      fontFamily: FONT.mono,
      color: COLOR.ink,
    },
    h(
      {
        width: INNER,
        height: ASCII_CARD.height - 2 * SPACE.frame,
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 22,
        paddingBottom: 22,
        border: `${LINE.width}px solid ${c.grade === 'WARNING' ? COLOR.ink2 : COLOR.line}`,
        borderRadius: RADIUS.frame,
      },
      header(c),
      titleRow(c),
      hero(c),
      mainPanel(c),
      rowsGroup(c, dense),
      note(c, noteLines),
      h({ flexGrow: 1, minHeight: 16 }),
      action
        ? button(action.label, true, CONTENT)
        : button('Read only, nothing to sign', false, CONTENT),
      h({ height: 18, flexShrink: 0 }),
      stats(c),
      footer(c),
    ),
  );
}
