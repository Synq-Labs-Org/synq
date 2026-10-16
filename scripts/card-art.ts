import { writeFileSync } from 'node:fs';

/**
 * Generates the ASCII card theme's hero art: each scene is drawn from
 * procedural shapes (filled areas and ink strokes), rasterised per character
 * cell and mapped to characters: ink strokes become `- | / \` by their
 * direction in the cell (dots stay dots), filled areas an ordered-dithered
 * ramp. No source image is traced or copied.
 *
 *   node --import tsx scripts/card-art.ts
 *
 * Writes packages/channels/src/cards/themes/ascii/art-data.ts.
 */

export const COLS = 195;
export const ROWS = 40;
/** Scene space in px; each character cell covers CW x CH of it. */
const W = 936;
const H = 340;
const CW = W / COLS;
const CH = H / ROWS;

type Pt = readonly [number, number];
type Shape = {
  inside(x: number, y: number): boolean;
  tone: number;
  /** Strokes and dots: drawn as oriented line characters, not a fill. */
  ink?: boolean;
};

const RAMP = ' .·:-=+*#%@';
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));

// ------------------------------------------------------------ primitives

function poly(points: Pt[], tone: number): Shape {
  return {
    tone,
    inside(x, y) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]!;
        const [xj, yj] = points[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      return inside;
    },
  };
}
const rect = (x: number, y: number, w: number, h: number, tone: number) =>
  poly(
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    tone,
  );
const circle = (cx: number, cy: number, r: number, tone: number): Shape => ({
  tone,
  inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
});
const ellipse = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tone: number,
  deg = 0,
): Shape => {
  const a = (-deg * Math.PI) / 180;
  return {
    tone,
    inside(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * Math.cos(a) - dy * Math.sin(a);
      const v = dx * Math.sin(a) + dy * Math.cos(a);
      return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
    },
  };
};
const ring = (
  cx: number,
  cy: number,
  r: number,
  w: number,
  tone: number,
): Shape => ({
  tone,
  ink: true,
  inside: (x: number, y: number) =>
    Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2,
});
function segDist(x: number, y: number, a: Pt, b: Pt) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = l2
    ? Math.max(
        0,
        Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2),
      )
    : 0;
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}
/** A stroked polyline. */
function line(points: Pt[], w: number, tone: number): Shape {
  return {
    tone,
    ink: true,
    inside(x, y) {
      for (let i = 1; i < points.length; i++)
        if (segDist(x, y, points[i - 1]!, points[i]!) <= w / 2) return true;
      return false;
    },
  };
}
function bezier(a: Pt, c: Pt, b: Pt, n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [
      (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
      (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1],
    ] as Pt;
  });
}
const dashed = (points: Pt[], w: number, tone: number, on = 10, off = 8) => {
  const parts: Shape[] = [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = 0; s < len; s += 2) {
      if ((acc + s) % (on + off) < on) {
        const t = s / len;
        parts.push(circle(ax + t * (bx - ax), ay + t * (by - ay), w / 2, tone));
      }
    }
    acc += len;
  }
  return { ...union(parts, tone), ink: true };
};
const union = (shapes: Shape[], tone: number): Shape => ({
  tone,
  ink: shapes.every((s) => s.ink),
  inside: (x, y) => shapes.some((s) => s.inside(x, y)),
});
/** Ink outline of an ellipse. */
const oval = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  w: number,
  tone = 1,
): Shape => ({
  tone,
  ink: true,
  inside: (x, y) =>
    Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <=
    w / 2,
});
/** Ink dot. */
const dot = (cx: number, cy: number, r: number, tone = 1): Shape => ({
  ...circle(cx, cy, r, tone),
  ink: true,
});
/** A filled area with an ink outline on top. */
const shape = (points: Pt[], fill: number, w = 1.3): Shape[] => [
  poly(points, fill),
  line([...points, points[0]!], w, 1),
];
/** Deterministic sparse points (stars, petals, confetti). */
function scatter(
  seed: number,
  n: number,
  box: [number, number, number, number],
  r: number,
  tone: number,
): Shape {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const pts = Array.from({ length: n }, () => [
    box[0] + rnd() * (box[2] - box[0]),
    box[1] + rnd() * (box[3] - box[1]),
  ]);
  return {
    tone,
    ink: true,
    inside: (x, y) => pts.some(([px, py]) => Math.hypot(x - px!, y - py!) <= r),
  };
}
/** Five-petal blossom. */
const blossom = (cx: number, cy: number, r: number, tone: number) =>
  union(
    [
      ...Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return circle(
          cx + r * 0.55 * Math.cos(a),
          cy + r * 0.55 * Math.sin(a),
          r * 0.45,
          tone,
        );
      }),
    ],
    tone,
  );

// ------------------------------------------------------------ raster

/** Painter's order: later shapes cover earlier ones. */
function render(shapes: Shape[]): string[] {
  const top = (x: number, y: number) => {
    for (let i = shapes.length - 1; i >= 0; i--)
      if (shapes[i]!.inside(x, y)) return shapes[i]!;
    return null;
  };
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => f * CW);
  const ys = [0.08, 0.25, 0.42, 0.58, 0.75, 0.92].map((f) => f * CH);
  const rows: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    let out = '';
    for (let c = 0; c < COLS; c++) {
      let sum = 0;
      let gx = 0;
      let gy = 0;
      const ink: Pt[] = [];
      for (const [i, dx] of xs.entries())
        for (const [j, dy] of ys.entries()) {
          const s = top(c * CW + dx, r * CH + dy);
          if (s?.ink) {
            ink.push([dx, dy]);
            continue;
          }
          const v = s?.tone ?? 0;
          sum += v;
          gx += v * (i < 2 ? -1 : i > 2 ? 1 : 0);
          gy += v * (j < 3 ? -1 : 1);
        }
      if (ink.length >= 3) {
        if (ink.length >= 24) {
          out += '#';
          continue;
        }
        const mx = ink.reduce((a, p) => a + p[0], 0) / ink.length;
        const my = ink.reduce((a, p) => a + p[1], 0) / ink.length;
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (const [x, y] of ink) {
          sxx += (x - mx) ** 2;
          syy += (y - my) ** 2;
          sxy += (x - mx) * (y - my);
        }
        const tr = sxx + syy;
        const det = sxx * syy - sxy * sxy;
        const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
        const l2 = tr - l1;
        if (ink.length < 6 || l1 < 1e-6 || l2 / l1 > 0.45) {
          out += ink.length > 12 ? 'o' : '·';
          continue;
        }
        const a = (Math.atan2(2 * sxy, sxx - syy) * 90) / Math.PI;
        out +=
          Math.abs(a) < 25 ? '-' : Math.abs(a) > 65 ? '|' : a > 0 ? '\\' : '/';
        continue;
      }
      if (ink.length) {
        out += '.';
        continue;
      }
      const n = 30 - ink.length;
      const m = sum / n;
      const g = Math.hypot(gx / 12, gy / 15);
      if (g > 0.45) {
        const a = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
        out +=
          a < 22.5 || a >= 157.5
            ? '|'
            : a < 67.5
              ? '/'
              : a < 112.5
                ? '-'
                : '\\';
        continue;
      }
      const d = BAYER[r % 4]![c % 4]!;
      const idx = Math.max(
        0,
        Math.min(
          RAMP.length - 1,
          Math.floor(m ** 1.25 * (RAMP.length - 1) + d - 0.3),
        ),
      );
      out += RAMP[idx];
    }
    rows.push(out.replace(/\s+$/, ''));
  }
  return rows;
}

// ------------------------------------------------------------ scenes

const ground = (y: number) =>
  line(
    [
      [0, y],
      [W - 110, y],
    ],
    2,
    0.9,
  );
const waterLines = (y0: number, y1: number, x0 = 0, x1 = W - 110) =>
  union(
    Array.from({ length: Math.floor((y1 - y0) / 14) }, (_, i) =>
      dashed(
        [
          [x0 + ((i * 37) % 60), y0 + i * 14],
          [x1 - ((i * 53) % 80), y0 + i * 14],
        ],
        1.6,
        0.6,
        26 + (i % 3) * 10,
        14 + (i % 4) * 6,
      ),
    ),
    0.6,
  );
const stars = (seed: number) =>
  scatter(seed, 40, [0, 0, W - 110, 120], 1.3, 0.75);
const moon = (cx: number, cy: number, r: number) => [
  circle(cx, cy, r, 0.42),
  ring(cx, cy, r, 2.5, 1),
];

function torii(
  cx: number,
  base: number,
  w: number,
  h: number,
  tone = 1,
): Shape[] {
  const p = w * 0.36;
  return [
    rect(cx - p - 7, base - h, 14, h, 0.55),
    rect(cx + p - 7, base - h, 14, h, 0.55),
    line(
      [
        [cx - p - 7, base - h],
        [cx - p - 7, base],
      ],
      2,
      tone,
    ),
    line(
      [
        [cx + p + 7, base - h],
        [cx + p + 7, base],
      ],
      2,
      tone,
    ),
    poly(
      [
        [cx - w / 2 - 14, base - h - 16],
        [cx + w / 2 + 14, base - h - 16],
        [cx + w / 2, base - h + 4],
        [cx - w / 2, base - h + 4],
      ],
      tone,
    ),
    rect(cx - w / 2 + 10, base - h + 26, w - 20, 10, tone),
    rect(cx - 5, base - h + 4, 10, 22, 0.7),
  ];
}
function pagoda(cx: number, base: number, tiers: number, w: number) {
  const out: Shape[] = [];
  let y = base;
  for (let i = 0; i < tiers; i++) {
    const tw = w * (1 - i * 0.16);
    const hh = 34 - i * 3;
    out.push(rect(cx - tw * 0.32, y - hh, tw * 0.64, hh, 0.3));
    out.push(
      line(
        [
          [cx - tw * 0.32, y - hh],
          [cx - tw * 0.32, y],
        ],
        2,
        0.85,
      ),
    );
    out.push(
      line(
        [
          [cx + tw * 0.32, y - hh],
          [cx + tw * 0.32, y],
        ],
        2,
        0.85,
      ),
    );
    out.push(
      line(
        bezier(
          [cx - tw * 0.62, y - hh - 4],
          [cx, y - hh - 26],
          [cx + tw * 0.62, y - hh - 4],
        ),
        4,
        1,
      ),
    );
    y -= hh + 14;
  }
  out.push(
    line(
      [
        [cx, y + 10],
        [cx, y - 26],
      ],
      3,
      1,
    ),
  );
  return out;
}
function tree(cx: number, base: number, s: number) {
  return [
    line(
      [
        [cx, base],
        [cx + 4 * s, base - 40 * s],
      ],
      4 * s,
      0.85,
    ),
    ellipse(cx - 14 * s, base - 46 * s, 30 * s, 16 * s, 0.32),
    ellipse(cx + 18 * s, base - 58 * s, 26 * s, 14 * s, 0.38),
    ellipse(cx + 2 * s, base - 72 * s, 22 * s, 12 * s, 0.32),
  ];
}
function palm(x: number, base: number, lean: number, h: number) {
  const top: Pt = [x + lean, base - h];
  const trunk = bezier([x, base], [x + lean * 0.2, base - h * 0.5], top, 20);
  const fronds = [-150, -115, -70, -30, 5, 40].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const end: Pt = [top[0] + 92 * Math.cos(a), top[1] + 70 * Math.sin(a) + 34];
    const mid: Pt = [top[0] + 54 * Math.cos(a), top[1] + 56 * Math.sin(a) - 10];
    return line(bezier(top, mid, end, 16), 3, 1);
  });
  return [line(trunk, 9, 0.5), line(trunk, 2, 1), ...fronds];
}

const scenes: Record<string, () => Shape[]> = {
  treasury: () => [
    stars(7),
    ...moon(560, 78, 32),
    poly(
      [
        [40, 300],
        [270, 92],
        [318, 74],
        [372, 96],
        [640, 300],
      ],
      0.2,
    ),
    line(
      [
        [40, 300],
        [270, 92],
        [318, 74],
        [372, 96],
        [640, 300],
      ],
      2.5,
      1,
    ),
    poly(
      [
        [270, 92],
        [318, 74],
        [372, 96],
        [350, 130],
        [330, 112],
        [306, 136],
        [286, 116],
      ],
      0.85,
    ),
    ...tree(90, 300, 1.3),
    ...tree(170, 300, 0.9),
    ...pagoda(220, 300, 3, 92),
    ...torii(740, 300, 150, 120),
    ground(300),
    waterLines(312, H),
  ],
  approval: () => [
    scatter(11, 60, [0, 0, W - 110, H], 1.6, 0.8),
    poly(
      [
        [380, 300],
        [560, 150],
        [760, 300],
      ],
      0.12,
    ),
    line(
      [
        [380, 300],
        [560, 150],
        [760, 300],
      ],
      2,
      0.8,
    ),
    ...torii(330, 310, 220, 170),
    line(bezier([0, 40], [180, 30], [300, 90]), 6, 0.9),
    line(bezier([120, 36], [170, 80], [210, 120]), 4, 0.9),
    ...Array.from({ length: 16 }, (_, i) =>
      blossom(
        20 + ((i * 47) % 290),
        24 + ((i * 29) % 110),
        14,
        i % 3 ? 0.95 : 0.6,
      ),
    ),
    line(bezier([W - 110, 60], [700, 70], [620, 30]), 5, 0.9),
    ...Array.from({ length: 9 }, (_, i) =>
      blossom(620 + ((i * 41) % 200), 20 + ((i * 23) % 80), 12, 0.9),
    ),
    ground(310),
  ],
  gift: () => [
    scatter(3, 50, [0, 0, W - 110, H], 2.2, 0.85),
    rect(300, 150, 260, 160, 0.25),
    line(
      [
        [300, 150],
        [560, 150],
        [560, 310],
        [300, 310],
        [300, 150],
      ],
      3,
      1,
    ),
    rect(280, 112, 300, 42, 0.45),
    line(
      [
        [280, 112],
        [580, 112],
        [580, 154],
        [280, 154],
        [280, 112],
      ],
      3,
      1,
    ),
    rect(416, 112, 28, 198, 0.95),
    line(bezier([430, 110], [350, 20], [330, 100]), 6, 1),
    line(bezier([430, 110], [510, 20], [530, 100]), 6, 1),
    line(
      [
        [330, 100],
        [430, 110],
        [530, 100],
      ],
      5,
      1,
    ),
    circle(430, 108, 12, 1),
    ground(312),
  ],
  hotel: () => [
    stars(5),
    ...moon(640, 70, 34),
    poly(
      [
        [380, 220],
        [520, 170],
        [700, 200],
        [840, 220],
      ],
      0.18,
    ),
    line(
      [
        [380, 220],
        [520, 170],
        [700, 200],
        [840, 220],
      ],
      2,
      0.8,
    ),
    line(
      [
        [0, 222],
        [W - 110, 222],
      ],
      2,
      0.9,
    ),
    waterLines(236, 300, 300),
    poly(
      [
        [0, 330],
        [0, 250],
        [240, 270],
        [460, 330],
      ],
      0.2,
    ),
    line(
      [
        [0, 250],
        [240, 270],
        [460, 330],
      ],
      2,
      0.9,
    ),
    ...palm(120, 300, 70, 230),
    ...palm(200, 310, -50, 170),
    rect(260, 262, 70, 40, 0.35),
    line(
      [
        [250, 264],
        [295, 236],
        [340, 264],
      ],
      3,
      1,
    ),
    line(
      [
        [560, 300],
        [600, 250],
        [640, 300],
      ],
      2,
      0.9,
    ),
  ],
  dca: () => [
    stars(13),
    ...Array.from({ length: 12 }, (_, i) => {
      const a = Math.PI + (i / 11) * Math.PI;
      return line(
        [
          [430 + 92 * Math.cos(a), 200 + 92 * Math.sin(a)],
          [430 + 150 * Math.cos(a), 200 + 150 * Math.sin(a)],
        ],
        3,
        0.8,
      );
    }),
    poly(
      Array.from({ length: 25 }, (_, i) => {
        const a = Math.PI + (i / 24) * Math.PI;
        return [430 + 78 * Math.cos(a), 200 + 78 * Math.sin(a)] as Pt;
      }),
      0.6,
    ),
    ring(430, 200, 78, 3, 1),
    line(
      [
        [0, 200],
        [W - 110, 200],
      ],
      2,
      1,
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      line(
        Array.from(
          { length: 70 },
          (_, k) => [k * 12, 220 + i * 20 + 6 * Math.sin(k * 0.7 + i)] as Pt,
        ),
        2,
        0.75 - i * 0.06,
      ),
    ),
    ...[0, 1, 2, 3, 4].flatMap((i) => [
      rect(640 + i * 34, 196 - (i + 1) * 30, 24, (i + 1) * 30, 0.3),
      line(
        [
          [640 + i * 34, 196],
          [640 + i * 34, 196 - (i + 1) * 30],
          [664 + i * 34, 196 - (i + 1) * 30],
          [664 + i * 34, 196],
        ],
        2.5,
        1,
      ),
    ]),
  ],
  receipt: () => receiptScene(false),
  invoice: () => receiptScene(true),
  deal: () => [
    stars(17),
    poly(
      [
        [0, 300],
        [160, 140],
        [300, 300],
      ],
      0.14,
    ),
    line(
      [
        [0, 300],
        [160, 140],
        [300, 300],
      ],
      2,
      0.8,
    ),
    poly(
      [
        [420, 300],
        [600, 110],
        [800, 300],
      ],
      0.14,
    ),
    line(
      [
        [420, 300],
        [600, 110],
        [800, 300],
      ],
      2,
      0.8,
    ),
    ...pagoda(330, 300, 5, 150),
    ...tree(530, 300, 1),
    ...tree(110, 300, 0.8),
    ellipse(620, 60, 90, 12, 0.4),
    ellipse(140, 80, 70, 10, 0.4),
    ground(300),
    waterLines(314, H),
  ],
  escrow: () => [
    stars(19),
    circle(300, 172, 140, 0.18),
    ring(300, 172, 140, 4, 1),
    ring(300, 172, 112, 2.5, 0.9),
    ...Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return circle(300 + 126 * Math.cos(a), 172 + 126 * Math.sin(a), 4, 1);
    }),
    ...[-90, 30, 150].map((d) => {
      const a = (d * Math.PI) / 180;
      return line(
        [
          [300, 172],
          [300 + 76 * Math.cos(a), 172 + 76 * Math.sin(a)],
        ],
        8,
        1,
      );
    }),
    circle(300, 172, 18, 1),
    rect(410, 30, 54, 44, 0.85),
    line(bezier([418, 32], [437, -6], [456, 32]), 6, 1),
    ...[0, 1, 2, 3, 4, 5].flatMap((i) => [
      rect(
        520 + i * 40,
        300 - (i + 1) * 36,
        30,
        (i + 1) * 36,
        i < 3 ? 0.7 : 0.15,
      ),
      line(
        [
          [520 + i * 40, 300],
          [520 + i * 40, 300 - (i + 1) * 36],
          [550 + i * 40, 300 - (i + 1) * 36],
          [550 + i * 40, 300],
        ],
        2.5,
        1,
      ),
    ]),
    ground(302),
  ],
  risk: () => shieldScene(false),
  risk_clear: () => shieldScene(true),
  agent: () => {
    const cx = 420;
    const cy = 170;
    const nodes = Array.from({ length: 5 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
      return [cx + 300 * Math.cos(a), cy + 125 * Math.sin(a)] as Pt;
    });
    return [
      stars(23),
      dashed(
        Array.from({ length: 73 }, (_, k) => {
          const a = (k / 72) * Math.PI * 2;
          return [cx + 300 * Math.cos(a), cy + 125 * Math.sin(a)] as Pt;
        }),
        2,
        0.8,
        8,
        10,
      ),
      ...nodes.map((p) => dashed([p, [cx, cy]], 2, 0.7, 6, 8)),
      poly(
        Array.from({ length: 6 }, (_, i) => {
          const a = ((30 + i * 60) * Math.PI) / 180;
          return [cx + 58 * Math.cos(a), cy + 58 * Math.sin(a)] as Pt;
        }),
        0.35,
      ),
      line(
        Array.from({ length: 7 }, (_, i) => {
          const a = ((30 + i * 60) * Math.PI) / 180;
          return [cx + 58 * Math.cos(a), cy + 58 * Math.sin(a)] as Pt;
        }),
        3,
        1,
      ),
      ring(cx, cy, 82, 2.5, 0.9),
      circle(cx, cy, 14, 1),
      ...nodes.flatMap(([x, y]) => [
        circle(x, y, 32, 0.02),
        ring(x, y, 32, 3, 1),
        circle(x, y - 9, 9, 0.95),
        ellipse(x, y + 16, 16, 9, 0.95),
      ]),
    ];
  },
  contractor: () => [
    stars(29),
    ...moon(600, 70, 30),
    waterLines(250, H),
    poly(
      bezier([120, 250], [380, 90], [640, 250], 30).concat([
        [640, 262],
        [120, 262],
      ]),
      0.2,
    ),
    line(bezier([120, 250], [380, 90], [640, 250], 30), 4, 1),
    line(bezier([110, 216], [380, 60], [650, 216], 30), 3, 1),
    ...Array.from({ length: 9 }, (_, i) => {
      const x = 170 + i * 52;
      const t = (x - 110) / 540;
      const y = (1 - t) ** 2 * 216 + 2 * (1 - t) * t * 60 + t * t * 216;
      const t2 = (x - 120) / 520;
      const y2 = (1 - t2) ** 2 * 250 + 2 * (1 - t2) * t2 * 90 + t2 * t2 * 250;
      return line(
        [
          [x, y],
          [x, y2],
        ],
        2.5,
        0.9,
      );
    }),
    rect(60, 150, 26, 40, 0.5),
    line(
      [
        [52, 150],
        [73, 132],
        [94, 150],
      ],
      3,
      1,
    ),
    line(
      [
        [73, 190],
        [73, 250],
      ],
      3,
      1,
    ),
    ...tree(740, 250, 1),
  ],
  flight: () => {
    const a = (-7 * Math.PI) / 180;
    const T = ([x, y]: Pt): Pt => [
      440 + x * Math.cos(a) - y * Math.sin(a),
      150 + x * Math.sin(a) + y * Math.cos(a),
    ];
    const tf = (pts: Pt[]) => pts.map(T);
    const fuselage: Pt[] = [
      [-300, -17],
      [200, -22],
      ...bezier([200, -22], [332, -22], [346, 2], 10).slice(1),
      ...bezier([346, 2], [330, 22], [200, 22], 10).slice(1),
      [-215, 22],
      [-300, 6],
      [-334, -10],
    ];
    const farWing: Pt[] = [
      [112, -20],
      [44, -20],
      [-28, -78],
      [0, -78],
    ];
    const fin: Pt[] = [
      [-226, -17],
      [-300, -17],
      [-346, -118],
      [-316, -118],
    ];
    const stab: Pt[] = [
      [-246, 8],
      [-296, 8],
      [-332, 44],
      [-308, 44],
    ];
    const wing: Pt[] = [
      [156, 16],
      [-14, 150],
      [-58, 150],
      [42, 16],
    ];
    const pod = (cx: number, cy: number, rx: number, ry: number) => {
      const [x, y] = T([cx, cy]);
      return [
        ellipse(x, y, rx, ry, 0, -7),
        oval(x, y, rx, ry, 1.3),
        oval(x + rx * 0.82, y - rx * 0.1, ry * 0.32, ry * 0.95, 2),
        line(
          tf([
            [cx + 6, cy - ry],
            [cx + 18, cy - ry - 16],
          ]),
          2,
          1,
        ),
      ];
    };
    const contrail = (from: Pt, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const [x, y] = T([from[0] - 40 - i * 15, from[1] + i * 0.4]);
        return dot(x, y, 1.6, 0.8);
      });
    return [
      ...[0, 1, 2].map((i) =>
        dashed(
          [
            [20 + i * 60, 278 + i * 18],
            [300 + i * 40, 278 + i * 18],
          ],
          1.6,
          0.7,
          4,
          12,
        ),
      ),
      ...[0, 1].map((i) =>
        dashed(
          [
            [540 + i * 30, 300 + i * 16],
            [820, 300 + i * 16],
          ],
          1.6,
          0.7,
          4,
          12,
        ),
      ),
      ...contrail([84, 70], 24),
      ...contrail([16, 120], 20),
      ...shape(tf(farWing), 0),
      ...shape(tf(fin), 0),
      ...shape(tf(fuselage), 0, 1.5),
      ...shape(tf(stab), 0),
      ...Array.from({ length: 27 }, (_, i) =>
        dot(...T([-196 + i * 16, -7]), 1.8),
      ),
      line(
        tf([
          [300, -12],
          [326, -9],
        ]),
        1.3,
        1,
      ),
      line(
        tf([
          [236, -16],
          [236, 12],
        ]),
        1.6,
        1,
      ),
      ...shape(tf(wing), 0),
      ...pod(96, 62, 36, 13),
      ...pod(30, 112, 32, 11),
      dot(780, 60, 2),
      dot(120, 40, 1.6),
      dot(660, 24, 1.4),
    ];
  },
};

function receiptScene(stamp: boolean): Shape[] {
  const l = 300;
  const r = 520;
  const top = 20;
  const bottom = 300;
  const zig: Pt[] = [];
  for (let k = 0; k <= 11; k++)
    zig.push([r - k * 20, bottom + (k % 2 ? 0 : 12)]);
  const paper: Pt[] = [[l, top], [r, top], ...zig, [l, bottom]];
  return [
    scatter(37, 30, [0, 0, W - 110, H], 1.4, 0.7),
    poly(paper, 0.12),
    line([...paper, [l, top]], 3, 1),
    rect(l + 24, top + 24, 110, 12, 0.95),
    ...[0, 1, 2, 3, 4].flatMap((i) => [
      rect(l + 24, top + 66 + i * 26, 90 + ((i * 23) % 40), 5, 0.6),
      rect(r - 74, top + 66 + i * 26, 50, 5, 0.75),
    ]),
    dashed(
      [
        [l + 20, top + 200],
        [r - 20, top + 200],
      ],
      2,
      0.8,
    ),
    rect(l + 24, top + 214, 70, 9, 0.95),
    rect(r - 90, top + 212, 66, 12, 0.95),
    ...Array.from({ length: 22 }, (_, i) =>
      rect(
        l + 26 + i * 8,
        top + 236,
        i % 3 ? 3 : 5,
        26,
        i % 4 === 1 ? 0 : 0.95,
      ),
    ),
    ...(stamp
      ? [
          ring(610, 150, 62, 5, 1),
          ring(610, 150, 48, 2, 0.9),
          line(
            [
              [584, 152],
              [604, 172],
              [640, 128],
            ],
            8,
            1,
          ),
        ]
      : [
          ellipse(640, 270, 54, 16, 0.5),
          ellipse(640, 248, 54, 16, 0.5),
          ellipse(640, 226, 54, 16, 0.7),
          ring(640, 226, 54, 2, 1),
        ]),
    ground(318),
  ];
}

function shieldScene(clear: boolean): Shape[] {
  const cx = 420;
  const cy = 165;
  const s = 1.25;
  const shield: Pt[] = [
    [cx, cy - 110 * s],
    [cx + 84 * s, cy - 76 * s],
    [cx + 76 * s, cy + 18 * s],
    ...bezier(
      [cx + 76 * s, cy + 18 * s],
      [cx + 62 * s, cy + 80 * s],
      [cx, cy + 110 * s],
      10,
    ),
    ...bezier(
      [cx, cy + 110 * s],
      [cx - 62 * s, cy + 80 * s],
      [cx - 76 * s, cy + 18 * s],
      10,
    ),
    [cx - 84 * s, cy - 76 * s],
  ];
  const alert = (x: number, y: number, z: number) => [
    poly(
      [
        [x, y - z],
        [x + z * 1.1, y + z * 0.85],
        [x - z * 1.1, y + z * 0.85],
      ],
      0.25,
    ),
    line(
      [
        [x, y - z],
        [x + z * 1.1, y + z * 0.85],
        [x - z * 1.1, y + z * 0.85],
        [x, y - z],
      ],
      2.5,
      1,
    ),
    rect(x - 2, y - z * 0.4, 4, z * 0.7, 1),
    circle(x, y + z * 0.55, 2.5, 1),
  ];
  return [
    stars(41),
    ...(clear
      ? []
      : Array.from({ length: 24 }, (_, i) => {
          const a0 = (i / 24) * Math.PI * 2;
          const pts = Array.from({ length: 6 }, (_, k) => {
            const a = a0 + (k / 5) * (Math.PI / 24);
            return [cx + 168 * Math.cos(a), cy + 150 * Math.sin(a)] as Pt;
          });
          return line(pts, 8, i % 2 ? 0.95 : 0.25);
        })),
    poly(shield, 0.22),
    line([...shield, shield[0]!], 4, 1),
    line(
      shield
        .map(([x, y]) => [cx + (x - cx) * 0.82, cy + (y - cy) * 0.82] as Pt)
        .concat([[cx, cy - 110 * s * 0.82]]),
      2,
      0.8,
    ),
    ...(clear
      ? [
          line(
            [
              [cx - 40, cy + 4],
              [cx - 10, cy + 36],
              [cx + 46, cy - 30],
            ],
            12,
            1,
          ),
        ]
      : [rect(cx - 9, cy - 66, 18, 84, 1), circle(cx, cy + 46, 12, 1)]),
    ...(clear
      ? []
      : [
          ...alert(150, 120, 34),
          ...alert(700, 100, 30),
          ...alert(680, 260, 24),
          ...alert(170, 270, 22),
        ]),
  ];
}

const art = Object.fromEntries(
  Object.entries(scenes).map(([k, f]) => [k, render(f())]),
);
const out = `// Generated by scripts/card-art.ts from procedural shapes; do not edit by hand.
export const ART_COLS = ${COLS};
export const ART_ROWS = ${ROWS};
export const ART_DATA: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(art, null, 2)};
`;
writeFileSync('packages/channels/src/cards/themes/ascii/art-data.ts', out);
console.log(Object.keys(art).join(' '));
