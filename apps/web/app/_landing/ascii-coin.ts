/**
 * A spinning coin rendered as text. The classic donut trick: sample the
 * surface, rotate each point, project, keep the nearest point per cell and
 * map its lighting to a character.
 */
export const COIN_COLS = 56;
export const COIN_ROWS = 28;

const RAMP = ' .,-~:;=!*#$@';
const CAMERA = 5;
const SCALE = COIN_COLS * CAMERA * 0.4;

type Sample = {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Brightness offset for the engraved ring and reeded edge. */
  mod: number;
};

function buildCoin(): Float32Array {
  const samples: Sample[] = [];
  const half = 0.17;
  const TAU = Math.PI * 2;
  for (const side of [1, -1]) {
    for (let r = 0.04; r <= 1; r += 0.03) {
      const ring = r > 0.62 && r < 0.72;
      const hub = r < 0.34;
      const raise = ring ? 0.03 : hub ? -0.02 : 0;
      const step = 0.9 / (r * 60 + 6);
      for (let a = 0; a < TAU; a += step) {
        // A small "S" bar in the hub: three strokes of brighter cells.
        const stroke =
          hub && Math.abs(r * Math.sin(a)) < 0.05 && r < 0.3 ? 0.3 : 0;
        samples.push({
          x: r * Math.cos(a),
          y: r * Math.sin(a),
          z: side * (half + raise),
          nx: 0,
          ny: 0,
          nz: side,
          mod: (ring ? 0.22 : hub ? -0.12 : 0) + stroke,
        });
      }
    }
  }
  for (let z = -half; z <= half; z += 0.02) {
    for (let a = 0; a < TAU; a += 0.018) {
      samples.push({
        x: Math.cos(a),
        y: Math.sin(a),
        z,
        nx: Math.cos(a),
        ny: Math.sin(a),
        nz: 0,
        mod: Math.sin(a * 72) * 0.18,
      });
    }
  }
  const flat = new Float32Array(samples.length * 7);
  samples.forEach((s, i) => {
    flat.set([s.x, s.y, s.z, s.nx, s.ny, s.nz, s.mod], i * 7);
  });
  return flat;
}

let cached: Float32Array | null = null;
const zBuffer = new Float32Array(COIN_COLS * COIN_ROWS);
const cells = new Array<string>(COIN_COLS * COIN_ROWS);

/** One frame. `yaw` spins the coin, `pitch` tips it toward the viewer. */
export function renderCoin(yaw: number, pitch: number): string {
  cached ??= buildCoin();
  const data = cached;
  zBuffer.fill(0);
  cells.fill(' ');
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Light from above-left-front.
  const lx = -0.35;
  const ly = 0.6;
  const lz = -0.72;
  for (let i = 0; i < data.length; i += 7) {
    const x = data[i]!;
    const y = data[i + 1]!;
    const z = data[i + 2]!;
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const depth = 1 / (CAMERA + z2);
    const col = Math.round(COIN_COLS / 2 + SCALE * depth * x1);
    const row = Math.round(COIN_ROWS / 2 - SCALE * depth * y2 * 0.5);
    if (col < 0 || col >= COIN_COLS || row < 0 || row >= COIN_ROWS) continue;
    const at = row * COIN_COLS + col;
    if (depth <= zBuffer[at]!) continue;
    const nx = data[i + 3]!;
    const ny = data[i + 4]!;
    const nz = data[i + 5]!;
    const nx1 = nx * cy + nz * sy;
    const nz1 = -nx * sy + nz * cy;
    const ny2 = ny * cp - nz1 * sp;
    const nz2 = ny * sp + nz1 * cp;
    const lum = -(nx1 * lx + ny2 * ly + nz2 * lz) + data[i + 6]!;
    zBuffer[at] = depth;
    const idx = Math.max(1, Math.min(RAMP.length - 1, Math.round(lum * 9) + 2));
    cells[at] = RAMP[idx]!;
  }
  let out = '';
  for (let r = 0; r < COIN_ROWS; r++) {
    out += cells.slice(r * COIN_COLS, (r + 1) * COIN_COLS).join('');
    if (r < COIN_ROWS - 1) out += '\n';
  }
  return out;
}
