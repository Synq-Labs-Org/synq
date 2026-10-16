import type { CardContent, Tone } from '../../content/model.js';
import { ageLabel, clip, when } from '../../content/text.js';
import { h, img, svgSrc, t, type Node } from '../kit.js';
import { holoArtSvg, synqMark, type Energy, type Rarity } from './art.js';
import {
  C,
  STAGE_H,
  STAGE_W,
  CARD_H,
  CARD_W,
  CONTENT_W,
  ART_BORDER,
  ART_H,
  FOIL,
  PAD_X,
  fit,
  holoFace,
  type HoloFace,
  type HoloMove,
  type HoloStat,
} from './face.js';

/*
 * Holo trading-card layout (the previous card design), kept as a second
 * theme: a foil-framed portrait card on a glowing stage, drawn from the
 * same card content as every other theme.
 */

const RARITY: Record<Rarity, { glyph: string; label: string }> = {
  COMMON: { glyph: '●', label: 'COMMON' },
  RARE: { glyph: '◆', label: 'RARE' },
  HOLO_RARE: { glyph: '★', label: 'HOLO RARE' },
  WARNING: { glyph: '▲', label: 'WARNING' },
};
const RARITY_COLOR: Record<Rarity, string> = {
  COMMON: C.dim,
  RARE: '#D7E3FF',
  HOLO_RARE: '#FFD66B',
  WARNING: '#FCA5A5',
};
/** Hazard foil for risk holds: amber/black stripes over red metal. */
const HAZARD_FOIL = [
  'linear-gradient(118deg, rgba(255,255,255,0) 14%, rgba(255,255,255,0.45) 22%, rgba(255,255,255,0) 30%, rgba(255,255,255,0) 58%, rgba(255,255,255,0.3) 66%, rgba(255,255,255,0) 73%)',
  'repeating-linear-gradient(45deg, rgba(251,191,36,0.95) 0px, rgba(251,191,36,0.95) 18px, rgba(26,10,10,0.92) 18px, rgba(26,10,10,0.92) 36px)',
].join(', ');

const FOIL_IMAGE = [
  'linear-gradient(118deg, rgba(255,255,255,0) 14%, rgba(255,255,255,0.75) 22%, rgba(255,255,255,0) 30%, rgba(255,255,255,0) 58%, rgba(255,255,255,0.5) 66%, rgba(255,255,255,0) 73%)',
  'repeating-linear-gradient(45deg, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0.10) 2px, rgba(255,255,255,0) 2px, rgba(255,255,255,0) 7px)',
  'linear-gradient(135deg, rgba(255,122,217,0.78) 0%, rgba(255,217,138,0.7) 14%, rgba(156,255,201,0.66) 28%, rgba(127,227,255,0.7) 42%, rgba(183,156,255,0.75) 56%, rgba(255,138,216,0.7) 70%, rgba(255,229,154,0.66) 84%, rgba(141,245,255,0.75) 100%)',
  'linear-gradient(160deg, #F4F4FA 0%, #8C8CA3 18%, #FFFFFF 34%, #6E6E86 52%, #E6E6F0 70%, #7A7A92 86%, #F8F8FF 100%)',
].join(', ');

const energyOrb = (e: Energy, size: number): Node =>
  h(
    {
      width: size,
      height: size,
      borderRadius: size,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundImage: `radial-gradient(circle at 35% 30%, #ffffff 0%, ${e.light} 22%, ${e.base} 58%, ${e.deep} 100%)`,
      border: '2px solid rgba(255,255,255,0.75)',
      boxShadow: `0 0 ${Math.round(size / 2)}px ${e.base}`,
    },
    img(
      svgSrc(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${synqMark(size / 2, size / 2, size * 0.27, '#ffffff', 0.95)}</svg>`,
      ),
      size,
      size,
    ),
  );

const pill = (label: string, color: string, solid = false): Node =>
  h(
    {
      alignItems: 'center',
      padding: '5px 12px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: 1.5,
      lineHeight: 1.2,
      color: solid ? '#0B0B12' : color,
      backgroundColor: solid ? color : `${color}26`,
      border: `1.5px solid ${solid ? color : `${color}99`}`,
    },
    label,
  );

function titleBar(face: HoloFace, typeLabel: string): Node {
  const e = face.energy;
  const head = face.headline;
  const headSize = head ? fit(head.value.length, 200, 58, 28) : 0;
  return h(
    { flexDirection: 'column', width: CONTENT_W, flexShrink: 0 },
    h(
      {
        alignItems: 'center',
        justifyContent: 'space-between',
        width: CONTENT_W,
      },
      h(
        { alignItems: 'center', gap: 10 },
        h({
          width: 10,
          height: 10,
          borderRadius: 10,
          backgroundColor: e.light,
          boxShadow: `0 0 10px ${e.base}`,
        }),
        t(typeLabel, {
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: 3,
          color: e.light,
        }),
      ),
      face.mode ? pill(face.mode.label, face.mode.color, true) : null,
    ),
    h(
      {
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        width: CONTENT_W,
        marginTop: 8,
        gap: 18,
      },
      t(clip(face.name, 60), {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        fontSize: face.name.length > 30 ? 32 : face.name.length > 20 ? 36 : 44,
        fontWeight: 700,
        letterSpacing: -0.8,
        color: C.ink,
        lineHeight: 1.15,
        paddingBottom: 4,
      }),
      head
        ? h(
            {
              alignItems: 'flex-end',
              gap: 8,
              flexShrink: 0,
              maxWidth: 340,
            },
            t(head.label, {
              flexShrink: 0,
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: 1.5,
              color: e.light,
              paddingBottom: Math.round(headSize * 0.2),
            }),
            t(head.value, {
              fontSize: headSize,
              fontWeight: 700,
              letterSpacing: -1.5,
              color: '#FFFFFF',
              lineHeight: 1,
              textShadow: `0 0 18px ${e.base}`,
            }),
            head.unit
              ? t(head.unit, {
                  flexShrink: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  color: C.dim,
                  paddingBottom: Math.round(headSize * 0.16),
                })
              : null,
            energyOrb(e, 40),
          )
        : energyOrb(e, 40),
    ),
  );
}

function artWindow(face: HoloFace, seed: string): Node {
  const w = CONTENT_W - 2 * ART_BORDER;
  const hh = ART_H - 2 * ART_BORDER;
  return h(
    {
      width: CONTENT_W,
      height: ART_H,
      padding: ART_BORDER,
      marginTop: 16,
      borderRadius: 18,
      flexShrink: 0,
      backgroundImage:
        'linear-gradient(145deg, #FFF6D6 0%, #C9A54B 22%, #FFF3C4 45%, #9C7A2E 70%, #FFE8A3 100%)',
      boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
    },
    h(
      { width: w, height: hh, borderRadius: 13, overflow: 'hidden' },
      img(
        svgSrc(
          holoArtSvg({
            width: w,
            height: hh,
            energy: face.energy,
            motif: face.motif,
            rarity: face.rarity,
            seed,
          }),
        ),
        w,
        hh,
      ),
    ),
  );
}

function strip(text: string): Node {
  return h(
    {
      width: CONTENT_W - 60,
      marginLeft: 30,
      marginTop: -2,
      height: 34,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 18px',
      borderRadius: '0 0 12px 12px',
      backgroundImage:
        'linear-gradient(90deg, #8E6E26 0%, #E9CF83 20%, #FFF2C2 50%, #E9CF83 80%, #8E6E26 100%)',
    },
    t(clip(text, 70), {
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: 0.6,
      color: '#2A1E05',
      maxWidth: CONTENT_W - 100,
    }),
  );
}

function moveRow(
  move: HoloMove,
  e: Energy,
  cost: number,
  compact: boolean,
  dense = false,
): Node {
  const valueChars = move.value?.length ?? 0;
  const valueSize = fit(valueChars, 280, compact ? 30 : 34, 22);
  return h(
    {
      alignItems: 'center',
      width: CONTENT_W,
      gap: 16,
      minHeight: dense ? 82 : 90,
      padding: compact ? '10px 14px' : '14px 14px',
      borderRadius: 16,
      flexShrink: 0,
      backgroundColor: move.highlight
        ? `${e.base}2E`
        : 'rgba(255,255,255,0.035)',
      border: `1.5px solid ${move.highlight ? e.light : 'rgba(255,255,255,0.08)'}`,
    },
    h(
      { gap: 4, width: 86, flexShrink: 0, justifyContent: 'center' },
      ...Array.from({ length: cost }, () => energyOrb(e, 26)),
    ),
    h(
      {
        flexDirection: 'column',
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        gap: 4,
      },
      h(
        { alignItems: 'center', gap: 10, minWidth: 0 },
        t(clip(move.name, 40), {
          fontSize: compact ? 25 : 28,
          fontWeight: 700,
          color: C.ink,
          flexShrink: 1,
          minWidth: 0,
        }),
        move.tag ? pill(move.tag.label, move.tag.color) : null,
      ),
      move.detail
        ? t(clip(move.detail, 64), {
            fontSize: compact ? 17 : 19,
            color: C.dim,
            minWidth: 0,
          })
        : null,
      move.bar
        ? h(
            {
              marginTop: 6,
              width: '100%',
              height: 8,
              borderRadius: 8,
              backgroundColor: 'rgba(255,255,255,0.10)',
              overflow: 'hidden',
            },
            move.bar.value > 0
              ? h({
                  width: `${Math.max(1.5, Math.round(move.bar.value * 1000) / 10)}%`,
                  height: 8,
                  borderRadius: 8,
                  backgroundColor: move.bar.color,
                })
              : null,
          )
        : null,
    ),
    move.value
      ? t(move.value, {
          fontSize: valueSize,
          fontWeight: 700,
          letterSpacing: -0.5,
          color: move.valueColor ?? '#FFFFFF',
          flexShrink: 0,
          maxWidth: 300,
        })
      : null,
  );
}

function statsRow(face: HoloFace): Node {
  const stats: HoloStat[] = [
    { label: 'NETWORK', value: face.network ?? '—', color: C.blue },
    {
      label: 'MODE',
      value: face.mode?.label ?? '—',
      color: face.mode?.color ?? C.grey,
    },
    ...face.stats.slice(0, 1),
  ];
  return h(
    {
      width: CONTENT_W,
      flexShrink: 0,
      borderTop: `1.5px solid ${C.line}`,
      borderBottom: `1.5px solid ${C.line}`,
      padding: '12px 0',
    },
    ...stats.map((s, i) =>
      h(
        {
          flexDirection: 'column',
          flexBasis: 0,
          flexGrow: 1,
          minWidth: 0,
          gap: 4,
          alignItems: 'center',
          borderLeft: i ? `1.5px solid ${C.line}` : 'none',
        },
        t(s.label, {
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: 2,
          color: C.faint,
        }),
        t(clip(s.value, 22), {
          fontSize: 22,
          fontWeight: 700,
          color: s.color ?? C.ink,
          maxWidth: 240,
        }),
      ),
    ),
  );
}

function footer(card: CardContent, face: HoloFace): Node {
  const r = RARITY[face.rarity];
  const rarityColor = RARITY_COLOR[face.rarity];
  // Freshness: when the card was issued, and how old its facts were then.
  const age = card.observedAt === null ? 0 : card.issuedAt - card.observedAt;
  const issued = `${when(card.issuedAt)}${age > 0 ? ` · data ${ageLabel(age)} old` : ''}`;
  return h(
    {
      width: CONTENT_W,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    h(
      { alignItems: 'center', gap: 10 },
      t('synq', {
        fontSize: 20,
        fontWeight: 700,
        letterSpacing: -0.5,
        color: C.ink,
      }),
      t(`#${card.cardId.slice(-6)}`, {
        fontSize: 16,
        fontWeight: 600,
        color: C.faint,
        letterSpacing: 1,
      }),
    ),
    t(issued, {
      fontSize: age > 0 ? 15 : 16,
      fontWeight: 600,
      color: C.dim,
    }),
    h(
      { alignItems: 'center', gap: 8 },
      t(r.glyph, { fontSize: 20, color: rarityColor }),
      t(r.label, {
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: 1.5,
        color: rarityColor,
      }),
    ),
  );
}

function cardBody(card: CardContent, face: HoloFace): Node {
  const e = face.energy;
  // Four rows (agent council: three roles and the Kernel) replace the flavour box.
  const rows = face.moves.slice(0, face.moves.length > 3 ? 4 : 3);
  const dense = rows.length > 3;
  const compact =
    dense || (face.moves.length > 2 && face.moves.some((m) => m.tag));
  const warning = face.rarity === 'WARNING';
  return h(
    {
      width: CARD_W - 2 * FOIL,
      height: CARD_H - 2 * FOIL,
      flexDirection: 'column',
      alignItems: 'flex-start',
      padding: `22px ${PAD_X}px 18px`,
      position: 'relative',
      borderRadius: 28,
      overflow: 'hidden',
      backgroundColor: '#0B0B14',
      backgroundImage: `radial-gradient(circle at 50% 0%, ${e.base}55 0%, ${e.base}00 55%), radial-gradient(circle, rgba(255,255,255,0.05) 1px, rgba(255,255,255,0) 1.5px), linear-gradient(180deg, ${e.deep} 0%, #0C0C16 42%, #08080F 100%)`,
      backgroundSize: '100% 100%, 16px 16px, 100% 100%',
      border: warning
        ? '2.5px solid rgba(252,165,165,0.75)'
        : '1.5px solid rgba(255,255,255,0.22)',
    },
    face.rarity === 'HOLO_RARE'
      ? h({
          position: 'absolute',
          top: 0,
          left: 0,
          width: CARD_W - 2 * FOIL,
          height: CARD_H - 2 * FOIL,
          backgroundImage:
            'linear-gradient(125deg, rgba(255,95,210,0) 30%, rgba(255,95,210,0.07) 40%, rgba(91,209,255,0.08) 50%, rgba(107,255,184,0.07) 60%, rgba(107,255,184,0) 70%)',
        })
      : null,
    titleBar(face, card.typeLabel),
    artWindow(face, card.cardId),
    strip(face.strip),
    h(
      {
        flexDirection: 'column',
        gap: compact ? 8 : 10,
        marginTop: 16,
        width: CONTENT_W,
        flexShrink: 0,
      },
      ...rows.map((m, i) => moveRow(m, e, Math.min(3, i + 1), compact, dense)),
    ),
    dense
      ? h({ flexGrow: 1, minHeight: 12 })
      : h(
          {
            flexGrow: 1,
            width: CONTENT_W,
            minHeight: 0,
            alignItems: 'center',
            margin: '12px 0',
            padding: '10px 20px',
            borderRadius: 14,
            border: `1.5px solid ${e.light}40`,
            backgroundImage: `linear-gradient(120deg, ${e.base}1F 0%, rgba(255,255,255,0.03) 60%, ${e.base}14 100%)`,
          },
          h({
            width: 4,
            alignSelf: 'stretch',
            borderRadius: 4,
            marginRight: 16,
            flexShrink: 0,
            backgroundColor: e.light,
          }),
          face.flavor
            ? h(
                {
                  flexGrow: 1,
                  minWidth: 0,
                  fontSize: 19,
                  lineHeight: 1.35,
                  color: '#D4D4E2',
                  maxHeight: 54,
                  overflow: 'hidden',
                },
                clip(face.flavor, 110),
              )
            : null,
        ),
    statsRow(face),
    footer(card, face),
  );
}

function stage(card: CardContent, face: HoloFace): Node {
  const e = face.energy;
  return h(
    {
      width: STAGE_W,
      height: STAGE_H,
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      fontFamily: 'Inter',
      color: C.ink,
      backgroundColor: '#05050A',
      backgroundImage: `radial-gradient(ellipse at center, ${e.base}FF 0%, ${e.base}F0 57%, ${e.base}99 61%, ${e.base}44 67%, ${e.deep}33 74%, rgba(5,5,10,0) 84%), linear-gradient(180deg, #07070D 0%, #0B0A14 50%, #040408 100%)`,
    },
    h(
      {
        width: CARD_W,
        height: CARD_H,
        padding: FOIL,
        borderRadius: 42,
        backgroundImage: face.rarity === 'WARNING' ? HAZARD_FOIL : FOIL_IMAGE,
      },
      cardBody(card, face),
    ),
  );
}

/** The holo card for a content description. */
export const holoCard = (c: CardContent): Node => stage(c, holoFace(c));
