import { crc32, deflateSync } from 'node:zlib';

/*
 * Minimal opaque PNG encoder for the card images. resvg's own encoder writes
 * RGBA without per-row filter selection, which roughly doubles the size of
 * the smooth gradients these cards are made of; the cards are fully opaque,
 * so this writes 8-bit RGB with the usual minimum-sum-of-absolute-differences
 * filter heuristic and zlib level 6.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes the RGBA pixels of a fully opaque image as an RGB PNG (alpha is dropped). */
export function encodeOpaquePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Buffer {
  if (rgba.length !== width * height * 4)
    throw new Error('encodeOpaquePng: pixel buffer does not match size');
  const bpp = 3;
  const stride = width * bpp;
  const rgb = Buffer.alloc(width * height * bpp);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]!;
    rgb[j + 1] = rgba[i + 1]!;
    rgb[j + 2] = rgba[i + 2]!;
  }
  const out = Buffer.alloc(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgb.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestSum = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const c = candidates[filter]!;
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp]! : 0;
        const b = prev[x]!;
        const d = x >= bpp ? prev[x - bpp]! : 0;
        let p = 0;
        if (filter === 1) p = a;
        else if (filter === 2) p = b;
        else if (filter === 3) p = (a + b) >> 1;
        else if (filter === 4) {
          const pa = Math.abs(b - d);
          const pb = Math.abs(a - d);
          const pc = Math.abs(a + b - 2 * d);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : d;
        }
        const v = (row[x]! - p) & 255;
        c[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = filter;
      }
    }
    out[y * (stride + 1)] = best;
    candidates[best]!.copy(out, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(out, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
