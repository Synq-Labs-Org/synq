/*
 * Generated "art window" illustrations for the holo trading-card banners.
 * Pure SVG strings (gradients, geometric motifs, orbit rings, the Synq mark)
 * embedded as an image by the satori layout. Shapes are decorative; the only
 * data drawn here are proportions the card text states exactly (quorum pips,
 * DCA progress), never an amount.
 */

export type Energy = {
  /** Main energy colour. */
  base: string;
  /** Light tint for highlights and text accents. */
  light: string;
  /** Deep tint for shadows and the card body. */
  deep: string;
};

/** WARNING is not a grade: risk holds wear hazard foil instead of holo. */
export type Rarity = 'COMMON' | 'RARE' | 'HOLO_RARE' | 'WARNING';

export type ArtMotif =
  | { kind: 'TREASURY' }
  | { kind: 'APPROVAL'; counted: number; required: number; voided: boolean }
  | { kind: 'GIFT' }
  | { kind: 'HOTEL' }
  | { kind: 'DCA'; progress: number }
  | { kind: 'RECEIPT'; icon: 'check' | 'cross' | 'clock' | 'refund' }
  | { kind: 'DEAL'; signed: [boolean, boolean]; sealed: boolean }
  | {
      kind: 'ESCROW';
      step: number;
      steps: number;
      locked: boolean;
      /** Colour of the current step (state colour). */
      tone: string;
    }
  | { kind: 'INVOICE'; paid: number; stamp: 'PAID' | 'PARTIAL' | 'VOID' | null }
  | { kind: 'RISK'; resolved: boolean; hard: boolean }
  | { kind: 'COUNCIL'; nodes: string[]; verdict: string }
  | { kind: 'PAYOUT'; state: 'PENDING' | 'DONE' | 'FAILED' }
  | { kind: 'FLIGHT'; roundTrip: boolean };

/** Small deterministic PRNG so the same card always gets the same sparkles. */
function prng(seed: string) {
  let s = 2166136261;
  for (const ch of seed) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507);
    s = Math.imul(s ^ (s >>> 13), 3266489909);
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

/** Four-point sparkle centred on (x, y). */
const sparkle = (x: number, y: number, r: number, opacity: number) =>
  `<path d="M${f(x)} ${f(y - r)} Q${f(x + r * 0.16)} ${f(y - r * 0.16)} ${f(x + r)} ${f(y)} Q${f(x + r * 0.16)} ${f(y + r * 0.16)} ${f(x)} ${f(y + r)} Q${f(x - r * 0.16)} ${f(y + r * 0.16)} ${f(x - r)} ${f(y)} Q${f(x - r * 0.16)} ${f(y - r * 0.16)} ${f(x)} ${f(y - r)}Z" fill="#fff" fill-opacity="${opacity}"/>`;

/** The Synq mark: two chasing arcs with arrowheads around a core. */
export function synqMark(
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity = 1,
): string {
  const w = Math.max(2, r * 0.2);
  const arc = (from: number, to: number) => {
    const a = (from * Math.PI) / 180;
    const b = (to * Math.PI) / 180;
    return `M${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))} A${r} ${r} 0 0 1 ${f(cx + r * Math.cos(b))} ${f(cy + r * Math.sin(b))}`;
  };
  const head = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const s = w * 1.5;
    return `<path d="M${f(x + tx * s)} ${f(y + ty * s)} L${f(x - ty * s * 0.9 - tx * s * 0.2)} ${f(y + tx * s * 0.9 - ty * s * 0.2)} L${f(x + ty * s * 0.9 - tx * s * 0.2)} ${f(y - tx * s * 0.9 - ty * s * 0.2)}Z" fill="${color}"/>`;
  };
  return `<g opacity="${opacity}"><path d="${arc(200, 330)}" stroke="${color}" stroke-width="${f(w)}" fill="none" stroke-linecap="round"/><path d="${arc(20, 150)}" stroke="${color}" stroke-width="${f(w)}" fill="none" stroke-linecap="round"/>${head(330)}${head(150)}<circle cx="${cx}" cy="${cy}" r="${f(r * 0.32)}" fill="${color}"/></g>`;
}

function motif(m: ArtMotif, e: Energy, cx: number, cy: number): string {
  switch (m.kind) {
    case 'TREASURY': {
      // Faceted gem: crown and pavilion facets in light/base/deep shades.
      const w = 150;
      const top = cy - 92;
      const girdle = cy - 30;
      const tip = cy + 118;
      const crownL = cx - w * 0.55;
      const crownR = cx + w * 0.55;
      const pts = (p: [number, number][]) =>
        p.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
      const facets: [[number, number][], string, number][] = [
        [
          [
            [cx - w, girdle],
            [crownL, top],
            [cx - w * 0.2, girdle],
          ],
          e.light,
          0.95,
        ],
        [
          [
            [crownL, top],
            [cx, top],
            [cx - w * 0.2, girdle],
          ],
          '#ffffff',
          0.85,
        ],
        [
          [
            [cx, top],
            [cx + w * 0.2, girdle],
            [cx - w * 0.2, girdle],
          ],
          e.light,
          0.7,
        ],
        [
          [
            [cx, top],
            [crownR, top],
            [cx + w * 0.2, girdle],
          ],
          e.base,
          0.95,
        ],
        [
          [
            [crownR, top],
            [cx + w, girdle],
            [cx + w * 0.2, girdle],
          ],
          e.deep,
          0.9,
        ],
        [
          [
            [cx - w, girdle],
            [cx - w * 0.2, girdle],
            [cx, tip],
          ],
          e.base,
          0.95,
        ],
        [
          [
            [cx - w * 0.2, girdle],
            [cx + w * 0.2, girdle],
            [cx, tip],
          ],
          e.light,
          0.8,
        ],
        [
          [
            [cx + w * 0.2, girdle],
            [cx + w, girdle],
            [cx, tip],
          ],
          e.deep,
          0.95,
        ],
      ];
      return `${facets
        .map(
          ([p, c, o]) =>
            `<polygon points="${pts(p)}" fill="${c}" fill-opacity="${o}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.6" stroke-linejoin="round"/>`,
        )
        .join('')}<polygon points="${pts([
        [crownL + 18, top + 8],
        [cx - 8, top + 8],
        [crownL + 30, girdle - 14],
      ])}" fill="#fff" fill-opacity="0.55"/>${sparkle(crownR - 6, top + 4, 26, 0.95)}${sparkle(cx - w + 18, girdle + 6, 14, 0.8)}`;
    }
    case 'APPROVAL': {
      // Shield with keyhole; signer nodes on an orbit, lit for counted approvals.
      const s = 1.15;
      const shield = `M${cx} ${f(cy - 105 * s)} L${f(cx + 82 * s)} ${f(cy - 72 * s)} L${f(cx + 74 * s)} ${f(cy + 18 * s)} Q${f(cx + 62 * s)} ${f(cy + 78 * s)} ${cx} ${f(cy + 108 * s)} Q${f(cx - 62 * s)} ${f(cy + 78 * s)} ${f(cx - 74 * s)} ${f(cy + 18 * s)} L${f(cx - 82 * s)} ${f(cy - 72 * s)}Z`;
      const n = Math.min(Math.max(m.required, 1), 12);
      const lit = Math.round(
        (Math.min(m.counted, m.required) / Math.max(m.required, 1)) * n,
      );
      const nodes = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const x = cx + 168 * Math.cos(a);
        const y = cy + 150 * Math.sin(a);
        const on = i < lit;
        const color = m.voided ? '#FCA5A5' : on ? '#ffffff' : e.light;
        return `<circle cx="${f(x)}" cy="${f(y)}" r="${on ? 15 : 12}" fill="${on ? e.base : e.deep}" fill-opacity="${on ? 1 : 0.85}" stroke="${color}" stroke-width="3" stroke-opacity="${on ? 1 : 0.55}"/>${on ? `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="#fff"/>` : ''}`;
      }).join('');
      return `<ellipse cx="${cx}" cy="${cy}" rx="168" ry="150" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="2" stroke-dasharray="4 10"/><path d="${shield}" fill="${e.deep}" stroke="${e.light}" stroke-width="5"/><path d="${shield}" fill="url(#facet)" opacity="0.9"/><circle cx="${cx}" cy="${f(cy - 18)}" r="24" fill="#fff"/><path d="M${cx - 12} ${f(cy - 6)} L${cx + 12} ${f(cy - 6)} L${cx + 7} ${f(cy + 46)} L${cx - 7} ${f(cy + 46)}Z" fill="#fff"/>${nodes}`;
    }
    case 'GIFT': {
      const w = 210;
      const hgt = 150;
      const x = cx - w / 2;
      const y = cy - 40;
      return `<rect x="${x}" y="${y}" width="${w}" height="${hgt}" rx="14" fill="${e.base}" stroke="#fff" stroke-opacity="0.5" stroke-width="2"/><rect x="${x}" y="${y}" width="${w}" height="${hgt}" rx="14" fill="url(#facet)" opacity="0.8"/><rect x="${x - 14}" y="${y - 44}" width="${w + 28}" height="50" rx="12" fill="${e.light}" stroke="#fff" stroke-opacity="0.6" stroke-width="2"/><rect x="${cx - 16}" y="${y - 44}" width="32" height="${hgt + 44}" fill="#fff" fill-opacity="0.92"/><path d="M${cx} ${y - 44} C${cx - 30} ${y - 120} ${cx - 120} ${y - 96} ${cx - 64} ${y - 50} Z" fill="none" stroke="#fff" stroke-width="12" stroke-linejoin="round"/><path d="M${cx} ${y - 44} C${cx + 30} ${y - 120} ${cx + 120} ${y - 96} ${cx + 64} ${y - 50} Z" fill="none" stroke="#fff" stroke-width="12" stroke-linejoin="round"/><circle cx="${cx}" cy="${y - 46}" r="14" fill="#fff"/>${[
        [-190, -60, 8, e.light],
        [170, -90, 6, '#fff'],
        [210, 40, 9, e.light],
        [-220, 70, 6, '#fff'],
        [140, 120, 5, e.light],
        [-150, -130, 5, '#fff'],
      ]
        .map(
          ([dx, dy, r, c]) =>
            `<rect x="${cx + Number(dx)}" y="${cy + Number(dy)}" width="${Number(r) * 2}" height="${Number(r)}" rx="2" fill="${String(c)}" transform="rotate(${Number(dx) % 50} ${cx + Number(dx)} ${cy + Number(dy)})"/>`,
        )
        .join('')}`;
    }
    case 'HOTEL': {
      const ground = cy + 92;
      const towers: [number, number, number][] = [
        [-170, 110, 60],
        [-104, 190, 74],
        [-24, 150, 62],
        [44, 220, 80],
        [130, 130, 64],
      ];
      const windows = (x: number, top: number, w: number) => {
        let out = '';
        for (let yy = top + 18; yy < ground - 16; yy += 26)
          for (let xx = x + 12; xx < x + w - 14; xx += 20)
            out += `<rect x="${xx}" y="${yy}" width="9" height="12" rx="2" fill="#fff" fill-opacity="${(xx + yy) % 3 === 0 ? 0.9 : 0.28}"/>`;
        return out;
      };
      return `<mask id="crescent"><circle cx="${cx + 170}" cy="${cy - 100}" r="46" fill="#fff"/><circle cx="${cx + 192}" cy="${cy - 116}" r="40" fill="#000"/></mask><circle cx="${cx + 170}" cy="${cy - 100}" r="46" fill="#fff" fill-opacity="0.95" mask="url(#crescent)"/>${towers
        .map(
          ([dx, hh, w]) =>
            `<rect x="${cx + dx}" y="${ground - hh}" width="${w}" height="${hh}" rx="6" fill="${e.deep}" stroke="${e.light}" stroke-opacity="0.8" stroke-width="2.5"/>${windows(cx + dx, ground - hh, w)}`,
        )
        .join(
          '',
        )}<path d="M${cx - 260} ${ground + 18} Q${cx - 195} ${ground + 2} ${cx - 130} ${ground + 18} T${cx} ${ground + 18} T${cx + 130} ${ground + 18} T${cx + 260} ${ground + 18}" fill="none" stroke="${e.light}" stroke-width="5" stroke-linecap="round"/><path d="M${cx - 220} ${ground + 40} Q${cx - 165} ${ground + 26} ${cx - 110} ${ground + 40} T${cx} ${ground + 40} T${cx + 110} ${ground + 40} T${cx + 220} ${ground + 40}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="4" stroke-linecap="round"/>`;
    }
    case 'DCA': {
      // Ascending bars and a progress ring for spent / cumulative limit.
      const p = Math.max(0, Math.min(1, m.progress));
      const r = 132;
      const a = -Math.PI / 2 + p * Math.PI * 2;
      const large = p > 0.5 ? 1 : 0;
      const ring =
        p >= 0.999
          ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width="14"/>`
          : p > 0
            ? `<path d="M${cx} ${cy - r} A${r} ${r} 0 ${large} 1 ${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/>`
            : '';
      const bars = [0.28, 0.42, 0.58, 0.76, 0.96]
        .map((hh, i) => {
          const bw = 30;
          const x = cx - 95 + i * 40;
          const bh = 150 * hh;
          return `<rect x="${x}" y="${f(cy + 70 - bh)}" width="${bw}" height="${f(bh)}" rx="7" fill="${i === 4 ? '#fff' : e.light}" fill-opacity="${0.55 + i * 0.1}"/>`;
        })
        .join('');
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${e.deep}" fill-opacity="0.65" stroke="#fff" stroke-opacity="0.18" stroke-width="14"/>${ring}${bars}<path d="M${cx - 110} ${cy + 40} L${cx - 30} ${cy - 10} L${cx + 10} ${cy + 10} L${cx + 96} ${cy - 62}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M${cx + 70} ${cy - 66} L${cx + 102} ${cy - 66} L${cx + 102} ${cy - 34}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case 'RECEIPT': {
      const r = 104;
      const rays = Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2;
        return `<path d="M${f(cx + 128 * Math.cos(a))} ${f(cy + 128 * Math.sin(a))} L${f(cx + 176 * Math.cos(a + 0.05))} ${f(cy + 176 * Math.sin(a + 0.05))} L${f(cx + 176 * Math.cos(a - 0.05))} ${f(cy + 176 * Math.sin(a - 0.05))}Z" fill="#fff" fill-opacity="0.35"/>`;
      }).join('');
      const glyph =
        m.icon === 'check'
          ? `<path d="M${cx - 46} ${cy + 2} L${cx - 12} ${cy + 36} L${cx + 50} ${cy - 34}" fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>`
          : m.icon === 'cross'
            ? `<path d="M${cx - 38} ${cy - 38} L${cx + 38} ${cy + 38} M${cx + 38} ${cy - 38} L${cx - 38} ${cy + 38}" stroke="#fff" stroke-width="22" stroke-linecap="round"/>`
            : m.icon === 'refund'
              ? `<path d="M${cx + 40} ${cy + 30} A44 44 0 1 0 ${cx - 30} ${cy - 30}" fill="none" stroke="#fff" stroke-width="18" stroke-linecap="round"/><path d="M${cx - 62} ${cy - 46} L${cx - 22} ${cy - 62} L${cx - 26} ${cy - 18}Z" fill="#fff" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>`
              : `<circle cx="${cx}" cy="${cy}" r="56" fill="none" stroke="#fff" stroke-width="12"/><path d="M${cx} ${cy - 32} L${cx} ${cy} L${cx + 26} ${cy + 14}" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `${rays}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${e.base}" stroke="#fff" stroke-opacity="0.8" stroke-width="6"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#facet)" opacity="0.85"/><circle cx="${cx}" cy="${cy}" r="${r - 16}" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="2"/>${glyph}`;
    }
    case 'DEAL':
      return dealArt(m, e, cx, cy);
    case 'ESCROW':
      return escrowArt(m, e, cx, cy);
    case 'INVOICE':
      return invoiceArt(m, e, cx, cy);
    case 'RISK':
      return riskArt(m, e, cx, cy);
    case 'COUNCIL':
      return councilArt(m, e, cx, cy);
    case 'PAYOUT':
      return payoutArt(m, e, cx, cy);
    case 'FLIGHT':
      return flightArt(m, e, cx, cy);
  }
}

type MotifOf<K extends ArtMotif['kind']> = Extract<ArtMotif, { kind: K }>;

const check = (x: number, y: number, s: number, color = '#fff', w = 0) =>
  `<path d="M${f(x - s)} ${f(y + s * 0.05)} L${f(x - s * 0.28)} ${f(y + s * 0.72)} L${f(x + s)} ${f(y - s * 0.62)}" fill="none" stroke="${color}" stroke-width="${f(w || s * 0.42)}" stroke-linecap="round" stroke-linejoin="round"/>`;
const cross = (x: number, y: number, s: number, color = '#fff') =>
  `<path d="M${f(x - s)} ${f(y - s)} L${f(x + s)} ${f(y + s)} M${f(x + s)} ${f(y - s)} L${f(x - s)} ${f(y + s)}" stroke="${color}" stroke-width="${f(s * 0.45)}" stroke-linecap="round"/>`;
/** Head-and-shoulders glyph centred on (x, y). */
const person = (x: number, y: number, s: number, color: string, o = 1) =>
  `<g opacity="${o}"><circle cx="${f(x)}" cy="${f(y - s * 0.42)}" r="${f(s * 0.34)}" fill="${color}"/><path d="M${f(x - s * 0.62)} ${f(y + s * 0.62)} Q${f(x - s * 0.6)} ${f(y + s * 0.02)} ${f(x)} ${f(y + s * 0.02)} Q${f(x + s * 0.6)} ${f(y + s * 0.02)} ${f(x + s * 0.62)} ${f(y + s * 0.62)}Z" fill="${color}"/></g>`;
/** Alert triangle with an exclamation mark. */
const alertSign = (
  x: number,
  y: number,
  s: number,
  fill: string,
  ink: string,
) =>
  `<path d="M${f(x)} ${f(y - s)} L${f(x + s * 1.1)} ${f(y + s * 0.85)} L${f(x - s * 1.1)} ${f(y + s * 0.85)}Z" fill="${fill}" stroke="#fff" stroke-opacity="0.7" stroke-width="2.5" stroke-linejoin="round"/><rect x="${f(x - s * 0.1)}" y="${f(y - s * 0.42)}" width="${f(s * 0.2)}" height="${f(s * 0.72)}" rx="${f(s * 0.1)}" fill="${ink}"/><circle cx="${f(x)}" cy="${f(y + s * 0.55)}" r="${f(s * 0.12)}" fill="${ink}"/>`;

/** Contract sheet with both parties' signatures and a wax seal. */
function dealArt(m: MotifOf<'DEAL'>, e: Energy, cx: number, cy: number) {
  const dw = 184;
  const dh = 236;
  const dx = cx - dw / 2 - 26;
  const dy = cy - dh / 2 - 8;
  const widths = [92, 140, 118, 146, 104, 132];
  const lines = widths
    .map(
      (w, i) =>
        `<rect x="${dx + 24}" y="${dy + 26 + i * 24 + (i ? 10 : 0)}" width="${w}" height="${i ? 7 : 13}" rx="3.5" fill="${e.deep}" fill-opacity="${i ? 0.3 : 0.8}"/>`,
    )
    .join('');
  const sig = (x: number, y: number, on: boolean) =>
    `<path d="M${x} ${y} q7 -18 14 0 t14 0 t14 0 t14 0" fill="none" stroke="${on ? e.deep : '#9A9AB0'}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"${on ? '' : ' stroke-dasharray="1 8"'}/><rect x="${x - 6}" y="${y + 12}" width="68" height="2.5" fill="${e.deep}" fill-opacity="0.5"/>`;
  const doc = `<g transform="rotate(-6 ${cx} ${cy})"><rect x="${dx + 10}" y="${dy + 12}" width="${dw}" height="${dh}" rx="14" fill="#000" fill-opacity="0.3"/><rect x="${dx}" y="${dy}" width="${dw}" height="${dh}" rx="14" fill="#FFFBEB" stroke="${e.light}" stroke-width="4"/>${lines}${sig(dx + 24, dy + dh - 42, m.signed[0])}${sig(dx + 108, dy + dh - 42, m.signed[1])}</g>`;
  const sx = cx + 66;
  const sy = cy + 52;
  const bumps = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2;
    return `<circle cx="${f(sx + 54 * Math.cos(a))}" cy="${f(sy + 54 * Math.sin(a))}" r="11" fill="${e.base}"/>`;
  }).join('');
  const tail = (dir: 1 | -1) =>
    `<path d="M${sx + dir * 6} ${sy + 30} L${sx + dir * 40} ${sy + 112} L${sx + dir * 18} ${sy + 98} L${sx + dir * 2} ${sy + 118} L${sx - dir * 14} ${sy + 40}Z" fill="${dir > 0 ? e.deep : e.base}" stroke="${e.light}" stroke-opacity="0.6" stroke-width="2"/>`;
  const seal = `${tail(-1)}${tail(1)}<circle cx="${sx + 4}" cy="${sy + 6}" r="62" fill="#000" fill-opacity="0.3"/>${bumps}<circle cx="${sx}" cy="${sy}" r="56" fill="${e.base}"/><circle cx="${sx}" cy="${sy}" r="56" fill="url(#facet)"/><circle cx="${sx}" cy="${sy}" r="42" fill="none" stroke="#fff" stroke-opacity="0.65" stroke-width="2.5"/>${m.sealed ? check(sx, sy, 22) : synqMark(sx, sy, 20, '#fff', 0.95)}`;
  const node = (x: number, on: boolean, dir: 1 | -1) =>
    `<path d="M${x + dir * 40} ${cy - 6} L${x + dir * 92} ${cy - 6}" stroke="#fff" stroke-opacity="0.45" stroke-width="3" stroke-dasharray="3 8" stroke-linecap="round"/><circle cx="${x}" cy="${cy - 6}" r="48" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="2" stroke-dasharray="4 8"/><circle cx="${x}" cy="${cy - 6}" r="34" fill="${on ? e.base : e.deep}" stroke="${on ? '#fff' : e.light}" stroke-width="4"/>${on ? check(x, cy - 6, 15) : person(x, cy - 4, 30, e.light, 0.75)}`;
  return `${node(cx - 244, m.signed[0], 1)}${node(cx + 244, m.signed[1], -1)}${doc}${seal}${sparkle(sx + 52, sy - 58, 18, 0.95)}${sparkle(dx - 6, dy + 18, 12, 0.8)}`;
}

/** Vault door with a padlock, beside the deal's milestone steps. */
function escrowArt(m: MotifOf<'ESCROW'>, e: Energy, cx: number, cy: number) {
  const vx = cx - 132;
  const vy = cy + 2;
  const R = 122;
  const bolts = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return `<circle cx="${f(vx + (R - 15) * Math.cos(a))}" cy="${f(vy + (R - 15) * Math.sin(a))}" r="5.5" fill="${e.light}" fill-opacity="0.9"/>`;
  }).join('');
  const spokes = [-90, 30, 150]
    .map((d) => {
      const a = (d * Math.PI) / 180;
      const x = vx + 60 * Math.cos(a);
      const y = vy + 60 * Math.sin(a);
      return `<path d="M${vx} ${vy} L${f(x)} ${f(y)}" stroke="#fff" stroke-width="12" stroke-linecap="round"/><circle cx="${f(x)}" cy="${f(y)}" r="11" fill="#fff"/>`;
    })
    .join('');
  const lx = vx + R * 0.74;
  const ly = vy - R * 0.74;
  const shackle = m.locked
    ? `M${lx - 10} ${ly - 4} v-9 a10 10 0 0 1 20 0 v9`
    : `M${lx - 10} ${ly - 4} v-17 a10 10 0 0 1 20 0 v-2`;
  const lock = `<circle cx="${lx}" cy="${ly}" r="36" fill="${m.locked ? e.deep : e.base}" stroke="#fff" stroke-width="3.5"/><path d="${shackle}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><rect x="${lx - 16}" y="${ly - 5}" width="32" height="25" rx="5" fill="#fff"/><circle cx="${lx}" cy="${ly + 6}" r="4" fill="${e.deep}"/>`;
  const vault = `<circle cx="${vx + 6}" cy="${vy + 10}" r="${R + 4}" fill="#000" fill-opacity="0.35"/><circle cx="${vx}" cy="${vy}" r="${R}" fill="${e.deep}" stroke="${e.light}" stroke-width="6"/><circle cx="${vx}" cy="${vy}" r="${R}" fill="url(#facet)" opacity="0.7"/>${bolts}<circle cx="${vx}" cy="${vy}" r="${R - 34}" fill="${e.base}" stroke="#fff" stroke-opacity="0.5" stroke-width="3"/><circle cx="${vx}" cy="${vy}" r="${R - 34}" fill="url(#facet)"/>${spokes}<circle cx="${vx}" cy="${vy}" r="22" fill="${e.deep}" stroke="#fff" stroke-width="5"/>${lock}`;
  const n = Math.max(1, Math.min(m.steps, 8));
  const cur =
    m.steps > 8
      ? Math.round((m.step * (n - 1)) / Math.max(1, m.steps - 1))
      : Math.min(m.step, n - 1);
  const x0 = cx + 40;
  const x1 = cx + 318;
  const gap = 8;
  const sw = (x1 - x0 - gap * (n - 1)) / n;
  const base = cy + 124;
  const steps = Array.from({ length: n }, (_, i) => {
    const hh = n === 1 ? 140 : 46 + (i / (n - 1)) * 176;
    const x = x0 + i * (sw + gap);
    const y = base - hh;
    const done = i < cur;
    const now = i === cur;
    const body = `<rect x="${f(x)}" y="${f(y)}" width="${f(sw)}" height="${f(hh)}" rx="8" fill="${now ? m.tone : done ? e.light : e.deep}" fill-opacity="${now ? 1 : done ? 0.85 : 0.8}" stroke="${now ? '#fff' : e.light}" stroke-opacity="${now ? 1 : 0.5}" stroke-width="${now ? 3.5 : 2}"/>`;
    const mark = now
      ? `<circle cx="${f(x + sw / 2)}" cy="${f(y - 26)}" r="16" fill="${m.tone}" stroke="#fff" stroke-width="3"/><circle cx="${f(x + sw / 2)}" cy="${f(y - 26)}" r="5" fill="#fff"/>`
      : done
        ? check(x + sw / 2, y + 22, Math.min(10, sw / 4), e.deep, 4)
        : '';
    return body + mark;
  }).join('');
  return `<path d="M${x0 - 12} ${base + 2} L${x1 + 12} ${base + 2}" stroke="#fff" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round"/>${steps}${vault}`;
}

/** Receipt sheet with a Memo reference barcode, beside a paid gauge. */
function invoiceArt(m: MotifOf<'INVOICE'>, e: Energy, cx: number, cy: number) {
  const px = cx - 120;
  const top = cy - 146;
  const w = 210;
  const hgt = 268;
  const l = px - w / 2;
  const r = px + w / 2;
  let zig = '';
  const teeth = 10;
  for (let k = 0; k < teeth; k++) {
    const xa = r - (k + 0.5) * (w / teeth);
    const xb = r - (k + 1) * (w / teeth);
    zig += ` L${f(xa)} ${top + hgt + 12} L${f(xb)} ${top + hgt}`;
  }
  const paper = `M${l} ${top + 14} Q${l} ${top} ${l + 14} ${top} L${r - 14} ${top} Q${r} ${top} ${r} ${top + 14} L${r} ${top + hgt}${zig} Z`;
  const rows = [0, 1, 2, 3]
    .map(
      (i) =>
        `<rect x="${l + 22}" y="${top + 70 + i * 26}" width="${[96, 74, 110, 64][i]}" height="7" rx="3.5" fill="${e.deep}" fill-opacity="0.32"/><rect x="${r - 70}" y="${top + 70 + i * 26}" width="48" height="7" rx="3.5" fill="${e.deep}" fill-opacity="0.5"/>`,
    )
    .join('');
  const bars = [
    3, 1, 2, 4, 1, 3, 2, 1, 4, 2, 1, 3, 1, 2, 4, 1, 2, 3, 1, 2, 1, 3,
  ];
  let bx = l + 24;
  let code = '';
  for (const [i, bw] of bars.entries()) {
    if (bx + bw * 2.4 > r - 24) break;
    if (i % 2 === 0)
      code += `<rect x="${f(bx)}" y="${top + 214}" width="${f(bw * 2.4)}" height="30" fill="${e.deep}" fill-opacity="0.85"/>`;
    bx += bw * 2.4 + 2.2;
  }
  const sheet = `<g transform="rotate(-4 ${px} ${cy})"><path d="${paper}" transform="translate(9 11)" fill="#000" fill-opacity="0.3"/><path d="${paper}" fill="#FCFFF5" stroke="${e.light}" stroke-width="3.5"/><rect x="${l + 22}" y="${top + 24}" width="92" height="14" rx="5" fill="${e.deep}" fill-opacity="0.8"/><circle cx="${r - 34}" cy="${top + 31}" r="14" fill="${e.base}"/><path d="M${l + 20} ${top + 186} L${r - 20} ${top + 186}" stroke="${e.deep}" stroke-opacity="0.4" stroke-width="2" stroke-dasharray="5 6"/>${rows}${code}${
    m.stamp === 'PAID' || m.stamp === 'VOID'
      ? `<g transform="rotate(-16 ${px + 30} ${top + 128})"><circle cx="${px + 30}" cy="${top + 128}" r="50" fill="${m.stamp === 'PAID' ? e.base : '#9A9AB0'}" fill-opacity="0.16" stroke="${m.stamp === 'PAID' ? e.base : '#9A9AB0'}" stroke-width="6"/><circle cx="${px + 30}" cy="${top + 128}" r="38" fill="none" stroke="${m.stamp === 'PAID' ? e.base : '#9A9AB0'}" stroke-width="2.5"/>${m.stamp === 'PAID' ? check(px + 30, top + 128, 20, e.deep) : cross(px + 30, top + 128, 17, '#6B6B80')}</g>`
      : ''
  }</g>`;
  const gx = cx + 156;
  const gy = cy;
  const gr = 98;
  const p = Math.max(0, Math.min(1, m.paid));
  const a = -Math.PI / 2 + p * Math.PI * 2;
  const ring =
    p >= 0.999
      ? `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="none" stroke="#fff" stroke-width="16"/>`
      : p > 0
        ? `<path d="M${gx} ${gy - gr} A${gr} ${gr} 0 ${p > 0.5 ? 1 : 0} 1 ${f(gx + gr * Math.cos(a))} ${f(gy + gr * Math.sin(a))}" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>`
        : '';
  const center =
    m.stamp === 'PAID'
      ? check(gx, gy, 38)
      : m.stamp === 'VOID'
        ? cross(gx, gy, 30)
        : [2, 1, 0]
            .map(
              (i) =>
                `<ellipse cx="${gx}" cy="${gy + 36 - i * 24}" rx="42" ry="13" fill="${e.base}" stroke="#fff" stroke-opacity="0.85" stroke-width="2.5"/>`,
            )
            .reverse()
            .join('');
  return `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="${e.deep}" fill-opacity="0.7" stroke="#fff" stroke-opacity="0.18" stroke-width="16"/>${ring}${center}${sheet}${sparkle(gx + 92, gy - 92, 16, 0.9)}`;
}

/** Shield with an alert mark inside a hazard ring. */
function riskArt(m: MotifOf<'RISK'>, e: Energy, cx: number, cy: number) {
  const s = 1.08;
  const shield = `M${cx} ${f(cy - 105 * s)} L${f(cx + 82 * s)} ${f(cy - 72 * s)} L${f(cx + 74 * s)} ${f(cy + 18 * s)} Q${f(cx + 62 * s)} ${f(cy + 78 * s)} ${cx} ${f(cy + 108 * s)} Q${f(cx - 62 * s)} ${f(cy + 78 * s)} ${f(cx - 74 * s)} ${f(cy + 18 * s)} L${f(cx - 82 * s)} ${f(cy - 72 * s)}Z`;
  const R = 152;
  const hazard = m.resolved
    ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="10" stroke-dasharray="3 14" stroke-linecap="round"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#FBBF24" stroke-width="16"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1A0A0A" stroke-width="16" stroke-dasharray="18 18"/>`;
  const rings = [178, 204]
    .map(
      (r, i) =>
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${e.light}" stroke-opacity="${i ? 0.14 : 0.28}" stroke-width="2.5"/>`,
    )
    .join('');
  const glyph = m.resolved
    ? check(cx, cy - 6, 36)
    : `<rect x="${cx - 12}" y="${cy - 70}" width="24" height="80" rx="12" fill="#fff"/><circle cx="${cx}" cy="${cy + 40}" r="14" fill="#fff"/>`;
  const signs = m.resolved
    ? ''
    : [
        [-262, -58, 30],
        [258, -76, 26],
        [236, 96, 22],
        [-238, 104, 20],
      ]
        .map(([dx, dy, sz]) =>
          alertSign(
            cx + dx!,
            cy + dy!,
            sz!,
            m.hard ? e.light : '#FBBF24',
            m.hard ? e.deep : '#3A2600',
          ),
        )
        .join('');
  return `${rings}${hazard}<path d="${shield}" fill="#000" fill-opacity="0.35" transform="translate(6 10)"/><path d="${shield}" fill="${e.deep}" stroke="${e.light}" stroke-width="5"/><path d="${shield}" fill="url(#facet)" opacity="0.9"/>${glyph}${signs}`;
}

/** The council: role nodes on an orbit around the Kernel core. */
function councilArt(m: MotifOf<'COUNCIL'>, e: Energy, cx: number, cy: number) {
  const k = Math.max(1, Math.min(m.nodes.length, 6));
  const rx = 248;
  const ry = 128;
  const offset = k === 2 ? 0 : -90;
  const pts = Array.from({ length: k }, (_, i) => {
    const a = ((offset + (i * 360) / k) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as const;
  });
  const links = pts
    .map(
      ([x, y], i) =>
        `<path d="M${f(x)} ${f(y)} L${cx} ${cy}" stroke="${m.nodes[i]}" stroke-opacity="0.75" stroke-width="3.5" stroke-dasharray="6 8" stroke-linecap="round"/>`,
    )
    .join('');
  const nodes = pts
    .map(
      ([x, y], i) =>
        `<circle cx="${f(x)}" cy="${f(y)}" r="48" fill="${m.nodes[i]}" fill-opacity="0.16"/><circle cx="${f(x)}" cy="${f(y)}" r="33" fill="${e.deep}" stroke="${m.nodes[i]}" stroke-width="5"/>${person(x, y + 2, 32, m.nodes[i]!, 0.95)}`,
    )
    .join('');
  const hex = Array.from({ length: 6 }, (_, i) => {
    const a = ((30 + i * 60) * Math.PI) / 180;
    return `${f(cx + 68 * Math.cos(a))},${f(cy + 68 * Math.sin(a))}`;
  }).join(' ');
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="2" stroke-dasharray="4 10"/>${links}<circle cx="${cx}" cy="${cy}" r="96" fill="none" stroke="${m.verdict}" stroke-width="9" stroke-opacity="0.95"/><circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="${m.verdict}" stroke-width="2" stroke-opacity="0.45"/><polygon points="${hex}" fill="${e.base}" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><polygon points="${hex}" fill="url(#facet)"/>${synqMark(cx, cy, 28, '#fff', 0.95)}${nodes}`;
}

/** A coin flowing to a verified recipient. */
function payoutArt(m: MotifOf<'PAYOUT'>, e: Energy, cx: number, cy: number) {
  const ox = cx - 168;
  const R = 100;
  const ridges = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return `<path d="M${f(ox + (R - 11) * Math.cos(a))} ${f(cy + (R - 11) * Math.sin(a))} L${f(ox + (R - 2) * Math.cos(a))} ${f(cy + (R - 2) * Math.sin(a))}" stroke="#fff" stroke-opacity="0.55" stroke-width="3" stroke-linecap="round"/>`;
  }).join('');
  const coin = `<circle cx="${ox + 7}" cy="${cy + 11}" r="${R}" fill="#000" fill-opacity="0.35"/><circle cx="${ox}" cy="${cy}" r="${R}" fill="${e.base}" stroke="${e.light}" stroke-width="5"/><circle cx="${ox}" cy="${cy}" r="${R}" fill="url(#facet)"/>${ridges}<circle cx="${ox}" cy="${cy}" r="${R - 26}" fill="none" stroke="#fff" stroke-opacity="0.6" stroke-width="3"/>${synqMark(ox, cy, 32, '#fff', 0.95)}`;
  const failed = m.state === 'FAILED';
  const chevrons = [0, 1, 2]
    .map((i) => {
      const x = cx - 34 + i * 44;
      const o =
        m.state === 'DONE' ? 0.5 + i * 0.25 : failed ? 0.4 : 0.35 + i * 0.15;
      return `<path d="M${x} ${cy - 30} L${x + 26} ${cy} L${x} ${cy + 30}" fill="none" stroke="${failed ? e.light : '#fff'}" stroke-opacity="${o}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
  const rx = cx + 206;
  const recipient = `<circle cx="${rx}" cy="${cy}" r="92" fill="${e.base}" fill-opacity="0.14"/><circle cx="${rx}" cy="${cy}" r="72" fill="${e.deep}" stroke="${e.light}" stroke-width="5"/>${person(rx, cy + 6, 66, '#fff', 0.95)}<circle cx="${rx + 52}" cy="${cy - 52}" r="22" fill="${failed ? '#EF4444' : m.state === 'DONE' ? e.base : e.light}" stroke="#fff" stroke-width="3"/>${failed ? cross(rx + 52, cy - 52, 9) : check(rx + 52, cy - 52, 10, failed ? '#fff' : e.deep, 4.5)}`;
  return `${coin}${chevrons}${recipient}${failed ? cross(cx + 10, cy - 62, 20, '#FCA5A5') : ''}${sparkle(ox + 70, cy - 82, 18, 0.95)}`;
}

/** Plane on the outbound arc; a return trip adds the homebound arc. */
function flightArt(m: MotifOf<'FLIGHT'>, e: Energy, cx: number, cy: number) {
  const O = [cx - 264, cy + 92] as const;
  const D = [cx + 264, cy + 92] as const;
  const at = (
    a: readonly [number, number],
    c: readonly [number, number],
    b: readonly [number, number],
    t: number,
  ) => {
    const x = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0];
    const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1];
    const dx = 2 * (1 - t) * (c[0] - a[0]) + 2 * t * (b[0] - c[0]);
    const dy = 2 * (1 - t) * (c[1] - a[1]) + 2 * t * (b[1] - c[1]);
    return { x, y, deg: (Math.atan2(dy, dx) * 180) / Math.PI };
  };
  const plane = (x: number, y: number, deg: number, s: number, fill: string) =>
    `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(deg)}) scale(${s})"><path d="M36 0 C36 -4 30 -6 24 -6 L8 -6 L-8 -32 L-17 -32 L-9 -6 L-24 -6 L-32 -17 L-39 -17 L-35 0 L-39 17 L-32 17 L-24 6 L-9 6 L-17 32 L-8 32 L8 6 L24 6 C30 6 36 4 36 0Z" fill="${fill}" stroke="${e.deep}" stroke-width="2" stroke-linejoin="round"/></g>`;
  const C1 = [cx, cy - 196] as const;
  const out = at(O, C1, D, 0.6);
  const C2 = [cx, cy + 24] as const;
  const back = at(D, C2, O, 0.42);
  const clouds = [
    [-200, 140, 1],
    [40, 152, 1.3],
    [250, 138, 0.9],
  ]
    .map(
      ([dx, dy, s]) =>
        `<g opacity="0.22"><ellipse cx="${cx + dx!}" cy="${cy + dy!}" rx="${f(70 * s!)}" ry="${f(20 * s!)}" fill="#fff"/><ellipse cx="${cx + dx! - 24 * s!}" cy="${cy + dy! - 14 * s!}" rx="${f(30 * s!)}" ry="${f(18 * s!)}" fill="#fff"/><ellipse cx="${cx + dx! + 18 * s!}" cy="${cy + dy! - 18 * s!}" rx="${f(36 * s!)}" ry="${f(22 * s!)}" fill="#fff"/></g>`,
    )
    .join('');
  const pin = ([x, y]: readonly [number, number]) =>
    `<circle cx="${x}" cy="${y}" r="24" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="12" fill="#fff"/><circle cx="${x}" cy="${y}" r="5" fill="${e.base}"/>`;
  return `<circle cx="${cx + 236}" cy="${cy - 118}" r="54" fill="#fff" fill-opacity="0.12"/><circle cx="${cx + 236}" cy="${cy - 118}" r="30" fill="#fff" fill-opacity="0.9"/>${clouds}<path d="M${O[0]} ${O[1]} Q${C1[0]} ${C1[1]} ${D[0]} ${D[1]}" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="2 13" stroke-linecap="round"/>${
    m.roundTrip
      ? `<path d="M${D[0]} ${D[1]} Q${C2[0]} ${C2[1]} ${O[0]} ${O[1]}" fill="none" stroke="${e.light}" stroke-opacity="0.85" stroke-width="4" stroke-dasharray="2 12" stroke-linecap="round"/>${plane(back.x, back.y, back.deg, 0.8, e.light)}`
      : ''
  }${pin(O)}${pin(D)}${plane(out.x, out.y, out.deg, 1.35, '#fff')}`;
}

/** Full art-window SVG for a card: scene, motif, Synq mark and holo overlay. */
export function holoArtSvg(options: {
  width: number;
  height: number;
  energy: Energy;
  motif: ArtMotif;
  rarity: Rarity;
  seed: string;
}): string {
  const { width: W, height: H, energy: e, rarity } = options;
  const rand = prng(options.seed);
  const cx = W / 2;
  const cy = H / 2 + 6;
  const rays = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const d = Math.hypot(W, H);
    return `<path d="M${cx} ${cy} L${f(cx + d * Math.cos(a))} ${f(cy + d * Math.sin(a))} L${f(cx + d * Math.cos(a + 0.07))} ${f(cy + d * Math.sin(a + 0.07))}Z" fill="#fff" fill-opacity="${i % 2 ? 0.035 : 0.06}"/>`;
  }).join('');
  const sparkles = Array.from(
    { length: rarity === 'COMMON' || rarity === 'WARNING' ? 6 : 14 },
    () =>
      sparkle(
        rand() * W,
        rand() * H,
        4 + rand() * (rarity === 'HOLO_RARE' ? 12 : 8),
        0.35 + rand() * 0.55,
      ),
  ).join('');
  const holo =
    rarity === 'WARNING'
      ? `<rect width="${W}" height="${H}" fill="#EF4444" fill-opacity="0.08"/><rect width="${W}" height="16" fill="url(#hazard)"/><rect y="${H - 16}" width="${W}" height="16" fill="url(#hazard)"/>`
      : rarity === 'COMMON'
        ? ''
        : `<rect width="${W}" height="${H}" fill="url(#holo)" opacity="${rarity === 'HOLO_RARE' ? 0.55 : 0.32}" style="mix-blend-mode:screen"/><rect width="${W}" height="${H}" fill="url(#sheen)" style="mix-blend-mode:screen"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="bg" cx="50%" cy="48%" r="70%"><stop offset="0" stop-color="${e.light}"/><stop offset="0.32" stop-color="${e.base}"/><stop offset="0.75" stop-color="${e.deep}"/><stop offset="1" stop-color="#05050A"/></radialGradient>
<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.45" stop-color="${e.light}" stop-opacity="0.3"/><stop offset="1" stop-color="${e.base}" stop-opacity="0"/></radialGradient>
<linearGradient id="facet" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#000" stop-opacity="0.35"/></linearGradient>
<linearGradient id="holo" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0" stop-color="#FF5FD2"/><stop offset="0.18" stop-color="#FFD66B"/><stop offset="0.36" stop-color="#6BFFB8"/><stop offset="0.54" stop-color="#5BD1FF"/><stop offset="0.72" stop-color="#9A7BFF"/><stop offset="0.9" stop-color="#FF5FD2"/><stop offset="1" stop-color="#FFD66B"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0.18" stop-color="#fff" stop-opacity="0"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.38" stop-color="#fff" stop-opacity="0"/><stop offset="0.62" stop-color="#fff" stop-opacity="0"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.2"/><stop offset="0.76" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="vignette" cx="50%" cy="50%" r="75%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>
<pattern id="hazard" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="28" fill="#FBBF24"/><rect x="14" width="14" height="28" fill="#1A0A0A"/></pattern>
<pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.2" fill="#fff" fill-opacity="0.12"/></pattern>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${rays}
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<ellipse cx="${cx}" cy="${cy + 8}" rx="${f(W * 0.42)}" ry="${f(H * 0.2)}" fill="none" stroke="#fff" stroke-opacity="0.28" stroke-width="2" transform="rotate(-14 ${cx} ${cy})"/>
<ellipse cx="${cx}" cy="${cy}" rx="${f(W * 0.34)}" ry="${f(H * 0.3)}" fill="none" stroke="${e.light}" stroke-opacity="0.3" stroke-width="1.5" transform="rotate(22 ${cx} ${cy})"/>
<circle cx="${f(cx + W * 0.41)}" cy="${f(cy - 34)}" r="7" fill="#fff" fill-opacity="0.85"/>
<circle cx="${f(cx - W * 0.3)}" cy="${f(cy + H * 0.25)}" r="5" fill="${e.light}"/>
<circle cx="${cx}" cy="${cy}" r="${f(H * 0.46)}" fill="url(#glow)"/>
${motif(options.motif, e, cx, cy)}
${sparkles}
${holo}
${synqMark(W - 42, H - 38, 17, '#ffffff', 0.7)}
<rect width="${W}" height="${H}" fill="url(#vignette)"/>
</svg>`;
}
