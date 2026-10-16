import { writeFileSync } from 'node:fs';

/**
 * Generates the ASCII card theme's hero art. Each scene is drawn from
 * procedural shapes only (no source image is traced or copied) and painted
 * onto a character grid in order:
 *
 * - fills cover the cells they contain with an ordered-dithered dot ramp
 *   (tone 0 erases, so nearer shapes hide farther strokes);
 * - strokes stamp one character per cell along their path, chosen by the
 *   path's direction (`- | / \`), or dots for dotted strokes;
 * - dots stamp `.`, `·`, `o` or `@` by size.
 *
 *   node --import tsx scripts/card-art.ts
 *
 * Writes packages/channels/src/cards/themes/ascii/art-data.ts.
 */

export const COLS = 173;
export const ROWS = 38;
/** Scene space in px; each character cell covers CW x CH of it. */
const W = 936;
const H = 340;
const CW = W / COLS;
const CH = H / ROWS;

type Pt = readonly [number, number];
type Fill = {
  kind: 'fill';
  inside: (x: number, y: number) => boolean;
  tone: number;
};
type Stroke = { kind: 'stroke'; paths: Pt[][]; dotted: boolean };
type Dots = { kind: 'dots'; pts: Pt[]; size: 0 | 1 | 2 | 3 };
type Shape = Fill | Stroke | Dots;
type Scene = (Shape | Shape[])[];

const RAMP = ' .·:=+*#%@';
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));

// ------------------------------------------------------------ geometry

const rad = (d: number) => (d * Math.PI) / 180;
function insidePoly(points: Pt[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
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
function arcPts(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  n = 48,
): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = rad(a0 + ((a1 - a0) * i) / n);
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as Pt;
  });
}
const closed = (p: Pt[]): Pt[] => [...p, p[0]!];
const rot = (p: Pt[], cx: number, cy: number, deg: number): Pt[] => {
  const a = rad(deg);
  return p.map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ]);
};
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

// ------------------------------------------------------------ primitives

const fillPoly = (points: Pt[], tone: number): Fill => ({
  kind: 'fill',
  tone,
  inside: (x, y) => insidePoly(points, x, y),
});
const fillEllipse = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tone: number,
): Fill => ({
  kind: 'fill',
  tone,
  inside: (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1,
});
const stroke = (...paths: Pt[][]): Stroke => ({
  kind: 'stroke',
  paths,
  dotted: false,
});
const dotted = (...paths: Pt[][]): Stroke => ({
  kind: 'stroke',
  paths,
  dotted: true,
});
const dots = (pts: Pt[], size: Dots['size'] = 1): Dots => ({
  kind: 'dots',
  pts,
  size,
});
/** Filled shape with its outline. */
const solid = (points: Pt[], tone = 0): Shape[] => [
  fillPoly(points, tone),
  stroke(closed(points)),
];
const oval = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tone = 0,
): Shape[] => [
  fillEllipse(cx, cy, rx, ry, tone),
  stroke(
    arcPts(cx, cy, rx, ry, 0, 360, Math.max(24, Math.round((rx + ry) / 2))),
  ),
];
const rectPts = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const dashes = (a: Pt, b: Pt, on: number, off: number): Pt[][] => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out: Pt[][] = [];
  for (let s = 0; s < len; s += on + off) {
    const e = Math.min(len, s + on);
    out.push([
      [a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len],
      [a[0] + ((b[0] - a[0]) * e) / len, a[1] + ((b[1] - a[1]) * e) / len],
    ]);
  }
  return out;
};
const stars = (
  seed: number,
  n = 34,
  box: [number, number, number, number] = [280, 4, 830, 120],
) => {
  const r = seeded(seed);
  return dots(
    Array.from(
      { length: n },
      () =>
        [
          box[0] + r() * (box[2] - box[0]),
          box[1] + r() * (box[3] - box[1]),
        ] as Pt,
    ),
    0,
  );
};
const sparkle = (x: number, y: number, s: number): Shape =>
  stroke(
    [
      [x - s, y],
      [x + s, y],
    ],
    [
      [x, y - s * 0.7],
      [x, y + s * 0.7],
    ],
  );
const water = (y0: number, y1: number, x0 = 0, x1 = 840) =>
  dotted(
    ...Array.from({ length: Math.floor((y1 - y0) / 12) }, (_, i) =>
      dashes(
        [x0 + ((i * 37) % 70), y0 + i * 12],
        [x1 - ((i * 53) % 90), y0 + i * 12],
        30 + (i % 3) * 14,
        18 + (i % 4) * 8,
      ),
    ).flat(),
  );
const moon = (cx: number, cy: number, r: number) => oval(cx, cy, r, r, 0.38);

function torii(cx: number, base: number, w: number, h: number): Shape[] {
  const p = w * 0.36;
  const top = base - h;
  return [
    ...solid(rectPts(cx - p - 7, top, 14, h), 0),
    ...solid(rectPts(cx + p - 7, top, 14, h), 0),
    ...solid(rectPts(cx - w / 2 + 12, top + 26, w - 24, 11), 0),
    ...solid(rectPts(cx - 5, top + 4, 10, 22), 0),
    ...solid(
      [
        ...bezier(
          [cx - w / 2 - 20, top - 20],
          [cx, top - 2],
          [cx + w / 2 + 20, top - 20],
          16,
        ),
        [cx + w / 2 + 4, top + 4],
        [cx - w / 2 - 4, top + 4],
      ],
      0.55,
    ),
  ];
}
function pagoda(cx: number, base: number, tiers: number, w: number): Shape[] {
  const out: Shape[] = [];
  let y = base;
  for (let i = 0; i < tiers; i++) {
    const tw = w * (1 - i * 0.15);
    const hh = 32 - i * 3;
    out.push(...solid(rectPts(cx - tw * 0.3, y - hh, tw * 0.6, hh), 0.14));
    out.push(
      ...solid(
        [
          ...bezier(
            [cx - tw * 0.62, y - hh + 2],
            [cx, y - hh - 30],
            [cx + tw * 0.62, y - hh + 2],
            16,
          ),
          [cx + tw * 0.4, y - hh - 6],
          [cx - tw * 0.4, y - hh - 6],
        ],
        0,
      ),
    );
    y -= hh + 16;
  }
  out.push(
    stroke([
      [cx, y + 14],
      [cx, y - 30],
    ]),
    dots([[cx, y - 34]], 2),
  );
  return out;
}
function pine(cx: number, base: number, s: number): Shape[] {
  return [
    stroke([
      [cx, base],
      [cx + 3 * s, base - 46 * s],
    ]),
    ...oval(cx - 16 * s, base - 50 * s, 30 * s, 13 * s, 0.22),
    ...oval(cx + 16 * s, base - 64 * s, 26 * s, 11 * s, 0.22),
    ...oval(cx, base - 80 * s, 20 * s, 10 * s, 0.22),
  ];
}
function palm(x: number, base: number, lean: number, h: number): Shape[] {
  const top: Pt = [x + lean, base - h];
  const trunk = bezier([x, base], [x + lean * 0.15, base - h * 0.55], top, 24);
  const fronds = [-160, -125, -85, -45, -10, 25].map((deg) => {
    const a = rad(deg);
    const end: Pt = [top[0] + 96 * Math.cos(a), top[1] + 64 * Math.sin(a) + 42];
    const mid: Pt = [top[0] + 58 * Math.cos(a), top[1] + 52 * Math.sin(a) - 14];
    return bezier(top, mid, end, 18);
  });
  const ticks = trunk
    .filter((_, i) => i % 3 === 1)
    .map(
      ([px, py]) =>
        [
          [px - 6, py],
          [px + 6, py - 2],
        ] as Pt[],
    );
  return [
    stroke(
      trunk.map(([px, py]) => [px - 5, py] as Pt),
      trunk.map(([px, py]) => [px + 5, py] as Pt),
    ),
    stroke(...ticks),
    stroke(...fronds),
    dots([top], 2),
  ];
}
function person(x: number, y: number, s: number): Shape[] {
  return [
    ...oval(x, y - s * 0.38, s * 0.3, s * 0.3, 0),
    stroke(
      bezier(
        [x - s * 0.6, y + s * 0.6],
        [x, y - s * 0.25],
        [x + s * 0.6, y + s * 0.6],
        14,
      ),
    ),
  ];
}
function blossom(x: number, y: number, r: number): Shape {
  return dots(
    [
      [x, y],
      ...Array.from(
        { length: 5 },
        (_, i) =>
          [
            x + r * Math.cos(rad(i * 72 - 90)),
            y + r * Math.sin(rad(i * 72 - 90)),
          ] as Pt,
      ),
    ],
    1,
  );
}

// ------------------------------------------------------------ raster

function render(scene: Scene): string[] {
  const grid: string[][] = Array.from({ length: ROWS }, () =>
    Array<string>(COLS).fill(' '),
  );
  const set = (x: number, y: number, ch: string) => {
    const c = Math.floor(x / CW);
    const r = Math.floor(y / CH);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) grid[r]![c] = ch;
  };
  for (const shape of scene.flat()) {
    if (shape.kind === 'fill') {
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
          let n = 0;
          for (const fx of [0.2, 0.5, 0.8])
            for (const fy of [0.2, 0.5, 0.8])
              if (shape.inside((c + fx) * CW, (r + fy) * CH)) n++;
          if (n < 5) continue;
          const d = BAYER[r % 4]![c % 4]!;
          const i = Math.max(
            0,
            Math.min(
              RAMP.length - 1,
              Math.floor(shape.tone * (RAMP.length - 1) + d - 0.35),
            ),
          );
          grid[r]![c] = RAMP[i]!;
        }
    } else if (shape.kind === 'stroke') {
      for (const path of shape.paths)
        for (let k = 1; k < path.length; k++) {
          const [ax, ay] = path[k - 1]!;
          const [bx, by] = path[k]!;
          const len = Math.hypot(bx - ax, by - ay);
          let a = (Math.atan2((by - ay) / CH, (bx - ax) / CW) * 180) / Math.PI;
          if (a > 90) a -= 180;
          if (a <= -90) a += 180;
          const ch = shape.dotted
            ? '.'
            : Math.abs(a) <= 22.5
              ? '-'
              : Math.abs(a) >= 67.5
                ? '|'
                : a > 0
                  ? '\\'
                  : '/';
          for (let s = 0; s <= len; s += 0.5)
            set(
              ax + ((bx - ax) * s) / (len || 1),
              ay + ((by - ay) * s) / (len || 1),
              ch,
            );
        }
    } else
      for (const [x, y] of shape.pts)
        set(x, y, ['.', '·', 'o', '@'][shape.size]!);
  }
  return grid.map((row) => row.join('').replace(/\s+$/, ''));
}

// ------------------------------------------------------------ scenes

const ground = (y: number, x0 = 0, x1 = 840) =>
  stroke([
    [x0, y],
    [x1, y],
  ]);

function receipt(stamp: boolean): Scene {
  const l = 300;
  const r = 510;
  const top = 18;
  const bottom = 296;
  const zig: Pt[] = [];
  for (let k = 0; k <= 10; k++)
    zig.push([r - k * 21, bottom + (k % 2 ? 12 : 0)]);
  const paper: Pt[] = [[l, top], [r, top], ...zig];
  const lines = [0, 1, 2, 3, 4].flatMap((i) => [
    [
      [l + 24, top + 70 + i * 24],
      [l + 104 + ((i * 23) % 40), top + 70 + i * 24],
    ] as Pt[],
    [
      [r - 66, top + 70 + i * 24],
      [r - 24, top + 70 + i * 24],
    ] as Pt[],
  ]);
  const bars = Array.from({ length: 24 }, (_, i) =>
    i % 4 === 1
      ? null
      : ([
          [l + 30 + i * 6.5, top + 236],
          [l + 30 + i * 6.5, top + 262],
        ] as Pt[]),
  ).filter((b): b is Pt[] => b !== null);
  return [
    stars(37, 20, [560, 10, 830, 120]),
    ...solid(paper, 0.08),
    fillPoly(rectPts(l + 24, top + 26, 100, 16), 0.85),
    stroke(...lines),
    dotted(...dashes([l + 20, top + 200], [r - 20, top + 200], 6, 6)),
    stroke(
      [
        [l + 24, top + 214],
        [l + 90, top + 214],
      ],
      [
        [r - 90, top + 214],
        [r - 24, top + 214],
      ],
    ),
    stroke(...bars),
    ...(stamp
      ? [
          stroke(
            arcPts(630, 150, 70, 70, 0, 360),
            arcPts(630, 150, 56, 56, 0, 360),
          ),
          stroke([
            [598, 152],
            [620, 176],
            [664, 124],
          ]),
        ]
      : [
          ...oval(640, 262, 58, 16, 0.3),
          ...oval(640, 238, 58, 16, 0.3),
          ...oval(640, 214, 58, 16, 0.45),
          sparkle(720, 160, 14),
        ]),
    ground(318, 100, 840),
  ];
}

function shield(clear: boolean): Scene {
  const cx = 420;
  const cy = 166;
  const s = 1.2;
  const outline: Pt[] = [
    [cx, cy - 110 * s],
    [cx + 84 * s, cy - 78 * s],
    [cx + 78 * s, cy + 16 * s],
    ...bezier(
      [cx + 78 * s, cy + 16 * s],
      [cx + 64 * s, cy + 80 * s],
      [cx, cy + 110 * s],
      12,
    ).slice(1),
    ...bezier(
      [cx, cy + 110 * s],
      [cx - 64 * s, cy + 80 * s],
      [cx - 78 * s, cy + 16 * s],
      12,
    ).slice(1),
    [cx - 84 * s, cy - 78 * s],
  ];
  const inner = outline.map(
    ([x, y]) => [cx + (x - cx) * 0.84, cy + (y - cy) * 0.84] as Pt,
  );
  const alert = (x: number, y: number, z: number): Shape[] => [
    ...solid(
      [
        [x, y - z],
        [x + z * 1.1, y + z * 0.85],
        [x - z * 1.1, y + z * 0.85],
      ],
      0,
    ),
    stroke([
      [x, y - z * 0.35],
      [x, y + z * 0.3],
    ]),
    dots([[x, y + z * 0.6]], 1),
  ];
  return [
    stars(41, 30),
    ...(clear
      ? [dotted(...dashes([cx - 200, 300], [cx + 200, 300], 6, 10))]
      : [
          dotted(arcPts(cx, cy, 190, 150, 0, 360, 120)),
          stroke(
            ...Array.from({ length: 18 }, (_, i) =>
              arcPts(cx, cy, 170, 136, i * 20, i * 20 + 10, 6),
            ),
          ),
        ]),
    ...solid(outline, 0.1),
    stroke(closed(inner)),
    ...(clear
      ? [
          stroke([
            [cx - 40, cy + 2],
            [cx - 12, cy + 34],
            [cx + 44, cy - 32],
          ]),
        ]
      : [
          fillPoly(rectPts(cx - 8, cy - 70, 16, 82), 1),
          fillEllipse(cx, cy + 40, 10, 9, 1),
        ]),
    ...(clear
      ? []
      : [
          ...alert(150, 118, 36),
          ...alert(700, 96, 30),
          ...alert(690, 258, 24),
          ...alert(176, 262, 22),
        ]),
  ];
}

const scenes: Record<string, () => Scene> = {
  treasury: () => [
    stars(7),
    ...moon(580, 66, 30),
    ...solid(
      [
        [40, 300],
        [250, 112],
        [282, 94],
        [336, 94],
        [368, 112],
        [600, 300],
      ],
      0.1,
    ),
    ...solid(
      [
        [250, 112],
        [282, 94],
        [336, 94],
        [368, 112],
        [348, 134],
        [326, 118],
        [306, 142],
        [286, 122],
        [266, 134],
      ],
      0.7,
    ),
    dotted(
      ...[0, 1, 2, 3].map((i) =>
        bezier(
          [290 - i * 18, 150 + i * 30],
          [250 - i * 30, 230],
          [200 - i * 34, 300 - i * 4],
          12,
        ),
      ),
    ),
    ...pine(80, 300, 1.25),
    ...pine(150, 300, 0.85),
    ...pagoda(220, 300, 3, 86),
    ...torii(730, 300, 160, 128),
    ground(300),
    water(312, 340),
  ],
  approval: () => {
    const r = seeded(11);
    return [
      dots(
        Array.from({ length: 50 }, () => [r() * 840, 60 + r() * 270] as Pt),
        0,
      ),
      dotted([
        [420, 300],
        [580, 160],
        [760, 300],
      ]),
      ...torii(330, 306, 230, 176),
      stroke(
        bezier([0, 34], [170, 26], [300, 92]),
        bezier([120, 30], [160, 70], [196, 116]),
        bezier([60, 30], [70, 70], [40, 120]),
      ),
      ...Array.from({ length: 18 }, (_, i) =>
        blossom(16 + ((i * 47) % 300), 20 + ((i * 29) % 110), 6),
      ),
      stroke(
        bezier([840, 54], [700, 64], [600, 24]),
        bezier([760, 58], [740, 100], [700, 130]),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        blossom(610 + ((i * 41) % 210), 16 + ((i * 23) % 110), 6),
      ),
      ground(306),
    ];
  },
  gift: () => {
    const r = seeded(3);
    return [
      dots(
        Array.from({ length: 40 }, () => [r() * 840, r() * 320] as Pt),
        1,
      ),
      ...solid(rectPts(300, 150, 260, 156), 0.12),
      ...solid(rectPts(282, 110, 296, 44), 0.25),
      ...solid(rectPts(416, 110, 28, 196), 0),
      stroke(
        bezier([430, 108], [340, 10], [318, 96]),
        bezier([430, 108], [520, 10], [542, 96]),
        [
          [318, 96],
          [430, 108],
          [542, 96],
        ],
      ),
      ...oval(430, 106, 12, 12, 0.8),
      sparkle(220, 90, 16),
      sparkle(660, 70, 20),
      sparkle(700, 230, 12),
      ground(306, 120, 760),
    ];
  },
  hotel: () => [
    stars(5),
    ...moon(650, 66, 32),
    dotted([
      [380, 220],
      [520, 172],
      [700, 200],
      [840, 214],
    ]),
    ground(222),
    water(234, 300, 260),
    ...solid(
      [
        [0, 340],
        [0, 250],
        [240, 268],
        [470, 340],
      ],
      0.12,
    ),
    ...palm(120, 300, 70, 230),
    ...palm(210, 314, -54, 170),
    ...solid(rectPts(268, 262, 66, 40), 0),
    stroke([
      [256, 264],
      [301, 234],
      [346, 264],
    ]),
    stroke(
      [
        [570, 300],
        [604, 254],
        [638, 300],
      ],
      [
        [604, 254],
        [604, 300],
      ],
    ),
  ],
  dca: () => [
    stars(13),
    dotted(
      ...Array.from({ length: 11 }, (_, i) => {
        const a = rad(190 + i * 16);
        return [
          [430 + 96 * Math.cos(a), 200 + 96 * Math.sin(a)],
          [430 + 150 * Math.cos(a), 200 + 150 * Math.sin(a)],
        ] as Pt[];
      }),
    ),
    ...solid(arcPts(430, 200, 80, 80, 180, 360, 40), 0.5),
    ground(200),
    stroke(
      ...Array.from({ length: 6 }, (_, i) =>
        Array.from(
          { length: 71 },
          (_, k) => [k * 12, 220 + i * 19 + 5 * Math.sin(k * 0.6 + i)] as Pt,
        ),
      ),
    ),
    ...[0, 1, 2, 3, 4].flatMap((i) =>
      solid(
        rectPts(630 + i * 38, 196 - (i + 1) * 28, 26, (i + 1) * 28),
        i === 4 ? 0.7 : 0.15,
      ),
    ),
  ],
  receipt: () => receipt(false),
  invoice: () => receipt(true),
  deal: () => [
    stars(17),
    ...solid(
      [
        [0, 300],
        [160, 140],
        [310, 300],
      ],
      0.08,
    ),
    ...solid(
      [
        [420, 300],
        [600, 110],
        [800, 300],
      ],
      0.08,
    ),
    dotted(
      bezier([560, 60], [620, 50], [700, 62]),
      bezier([90, 82], [140, 74], [210, 84]),
    ),
    ...pagoda(330, 300, 5, 150),
    ...pine(540, 300, 1),
    ...pine(110, 300, 0.8),
    ground(300),
    water(312, 340),
  ],
  escrow: () => [
    stars(19, 24),
    ...oval(290, 170, 140, 140, 0.06),
    stroke(arcPts(290, 170, 114, 114, 0, 360)),
    dots(
      Array.from(
        { length: 16 },
        (_, i) =>
          [
            290 + 127 * Math.cos(rad(i * 22.5)),
            170 + 127 * Math.sin(rad(i * 22.5)),
          ] as Pt,
      ),
      2,
    ),
    stroke(
      ...[-90, 30, 150].map(
        (d) =>
          [
            [290, 170],
            [290 + 78 * Math.cos(rad(d)), 170 + 78 * Math.sin(rad(d))],
          ] as Pt[],
      ),
    ),
    dots(
      [-90, 30, 150].map(
        (d) => [290 + 82 * Math.cos(rad(d)), 170 + 82 * Math.sin(rad(d))] as Pt,
      ),
      3,
    ),
    ...oval(290, 170, 18, 18, 0.9),
    ...solid(rectPts(398, 34, 54, 42), 0.2),
    stroke(arcPts(425, 34, 17, 22, 180, 360, 16)),
    dots([[425, 52]], 2),
    ...[0, 1, 2, 3, 4, 5].flatMap((i) =>
      solid(
        rectPts(520 + i * 42, 300 - (i + 1) * 36, 30, (i + 1) * 36),
        i < 3 ? 0.3 : 0.04,
      ),
    ),
    ground(302, 60, 840),
  ],
  risk: () => shield(false),
  risk_clear: () => shield(true),
  agent: () => {
    const cx = 420;
    const cy = 168;
    const nodes = Array.from(
      { length: 5 },
      (_, i) =>
        [
          cx + 300 * Math.cos(rad(-90 + i * 72)),
          cy + 122 * Math.sin(rad(-90 + i * 72)),
        ] as Pt,
    );
    const hex = Array.from(
      { length: 6 },
      (_, i) =>
        [
          cx + 58 * Math.cos(rad(30 + i * 60)),
          cy + 58 * Math.sin(rad(30 + i * 60)),
        ] as Pt,
    );
    return [
      stars(23, 26),
      dotted(arcPts(cx, cy, 300, 122, 0, 360, 140)),
      dotted(...nodes.map((p) => [p, [cx, cy]] as Pt[])),
      dotted(arcPts(cx, cy, 86, 86, 0, 360, 60)),
      ...solid(hex, 0.12),
      ...oval(cx, cy, 16, 16, 0.85),
      ...nodes.flatMap(([x, y]) => [
        ...oval(x, y, 34, 34, 0),
        ...person(x, y + 4, 34),
      ]),
    ];
  },
  contractor: () => {
    const deck = bezier([110, 250], [380, 92], [650, 250], 40);
    const rail = bezier([100, 214], [380, 60], [660, 214], 40);
    const at = (pts: Pt[], x: number) =>
      pts.reduce((b, p) => (Math.abs(p[0] - x) < Math.abs(b[0] - x) ? p : b));
    return [
      stars(29),
      ...moon(620, 64, 30),
      water(256, 340),
      ...solid([...deck, [650, 262], [110, 262]], 0.12),
      stroke(rail),
      stroke(
        ...Array.from({ length: 10 }, (_, i) => {
          const x = 150 + i * 50;
          return [at(rail, x), at(deck, x)];
        }),
      ),
      ...solid(rectPts(60, 150, 26, 40), 0.3),
      stroke(
        [
          [52, 150],
          [73, 132],
          [94, 150],
        ],
        [
          [73, 190],
          [73, 252],
        ],
      ),
      ...pine(760, 252, 1),
    ];
  },
  flight: () => {
    const cx = 450;
    const cy = 150;
    const T = (pts: Pt[]) =>
      rot(
        pts.map(([x, y]) => [cx + x, cy + y] as Pt),
        cx,
        cy,
        -7,
      );
    const fuselage: Pt[] = [
      [-300, -17],
      [200, -22],
      ...bezier([200, -22], [334, -22], [348, 2], 10).slice(1),
      ...bezier([348, 2], [332, 22], [200, 22], 10).slice(1),
      [-214, 22],
      [-300, 6],
      [-336, -9],
    ];
    const pod = (x: number, y: number, rx: number, ry: number): Shape[] => {
      const [c] = T([[x, y]]);
      return [
        ...oval(c![0], c![1], rx, ry, 0),
        stroke(
          arcPts(c![0] + rx * 0.82, c![1], ry * 0.35, ry * 0.9, 0, 360, 16),
        ),
        stroke(
          T([
            [x + 6, y - ry],
            [x + 16, y - ry - 14],
          ]),
        ),
      ];
    };
    const trail = (x: number, y: number, n: number) =>
      dots(
        T(
          Array.from(
            { length: n },
            (_, i) => [x - 46 - i * 15, y + i * 0.6] as Pt,
          ),
        ),
        i0(n),
      );
    const i0 = (_n: number): Dots['size'] => 0;
    return [
      stars(31, 18, [300, 4, 830, 60]),
      dotted(
        ...dashes([40, 286], [330, 286], 10, 14),
        ...dashes([90, 304], [380, 304], 10, 14),
      ),
      dotted(
        ...dashes([560, 296], [830, 296], 10, 14),
        ...dashes([610, 314], [800, 314], 10, 14),
      ),
      trail(96, 64, 22),
      trail(26, 114, 18),
      ...solid(
        T([
          [114, -20],
          [46, -20],
          [-26, -80],
          [2, -80],
        ]),
      ),
      ...solid(
        T([
          [-226, -17],
          [-300, -17],
          [-346, -120],
          [-316, -120],
        ]),
      ),
      ...solid(T(fuselage)),
      ...solid(
        T([
          [-246, 8],
          [-296, 8],
          [-334, 44],
          [-308, 44],
        ]),
      ),
      dots(
        T(Array.from({ length: 26 }, (_, i) => [-194 + i * 16, -7] as Pt)),
        1,
      ),
      stroke(
        T([
          [298, -12],
          [326, -8],
        ]),
        T([
          [238, -16],
          [238, 12],
        ]),
      ),
      ...solid(
        T([
          [158, 16],
          [-12, 150],
          [-58, 150],
          [42, 16],
        ]),
      ),
      ...pod(98, 62, 36, 13),
      ...pod(32, 112, 32, 11),
    ];
  },
};

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
