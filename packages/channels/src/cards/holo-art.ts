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

export type Rarity = 'COMMON' | 'RARE' | 'HOLO_RARE';

export type ArtMotif =
  | { kind: 'TREASURY' }
  | { kind: 'APPROVAL'; counted: number; required: number; voided: boolean }
  | { kind: 'GIFT' }
  | { kind: 'HOTEL' }
  | { kind: 'DCA'; progress: number }
  | { kind: 'RECEIPT'; icon: 'check' | 'cross' | 'clock' | 'refund' };

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
  }
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
  const sparkles = Array.from({ length: rarity === 'COMMON' ? 6 : 14 }, () =>
    sparkle(
      rand() * W,
      rand() * H,
      4 + rand() * (rarity === 'HOLO_RARE' ? 12 : 8),
      0.35 + rand() * 0.55,
    ),
  ).join('');
  const holo =
    rarity === 'COMMON'
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
