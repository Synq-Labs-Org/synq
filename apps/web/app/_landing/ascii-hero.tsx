'use client';

import { useEffect, useRef, useState } from 'react';
import { renderCoin } from './ascii-coin';
import { useFrameLoop, useInView, useReducedMotion } from './use-motion';

const LETTERS: readonly (readonly string[])[] = [
  [' ____  ', '/ ___| ', String.raw`\___ \ `, ' ___) |', String.raw`|____/ `],
  [
    String.raw`__   __`,
    String.raw`\ \ / /`,
    String.raw` \ V / `,
    '  | |  ',
    '  |_|  ',
  ],
  [
    ' _   _ ',
    String.raw`| \ | |`,
    String.raw`|  \| |`,
    String.raw`| |\  |`,
    String.raw`|_| \_|`,
  ],
  ['  ___  ', String.raw` / _ \ `, '| | | |', '| |_| |', String.raw` \__\_\ `],
];

/** The wordmark, one string per row. */
export const WORDMARK_LINES: readonly string[] = Array.from(
  { length: 5 },
  (_, row) => LETTERS.map((letter) => letter[row]!).join(' '),
);
const SCRAMBLE = '01#%&@$*+=<>/\\|{}[]';

function scrambleFrame(now: number, start: number, seed: number): string {
  const elapsed = now - start;
  const width = WORDMARK_LINES[0]!.length;
  return WORDMARK_LINES.map((line, row) => {
    let out = '';
    for (let col = 0; col < width; col++) {
      const final = line[col] ?? ' ';
      if (final === ' ') {
        out += ' ';
        continue;
      }
      // Columns resolve left to right with a little row jitter.
      const resolveAt = 220 + col * 26 + ((row * 37 + seed) % 5) * 28;
      if (elapsed >= resolveAt) {
        out += final;
      } else {
        const pick = Math.floor((now / 40 + col * 7 + row * 13 + seed) % 97);
        out += SCRAMBLE[pick % SCRAMBLE.length];
      }
    }
    return out;
  }).join('\n');
}

const FINAL_WORDMARK = WORDMARK_LINES.join('\n');
/** Rendered on the server too, so the art has its size before any script runs. */
const INITIAL_COIN = renderCoin(0.7, 0.35);

/** Big decoding wordmark beside a spinning ASCII coin. */
export function AsciiHeroArt() {
  const root = useRef<HTMLDivElement>(null);
  const coinRef = useRef<HTMLPreElement>(null);
  const markRef = useRef<HTMLPreElement>(null);
  const inView = useInView(root);
  const reduced = useReducedMotion();
  const [armed, setArmed] = useState(false);
  const startRef = useRef(0);
  const seedRef = useRef(0);
  const pointer = useRef(0);

  useEffect(() => setArmed(true), []);
  const running = armed && inView && !reduced;
  useFrameLoop(
    running,
    (now) => {
      const coin = coinRef.current;
      if (coin) {
        const spin = now / 1400 + pointer.current * 0.9;
        coin.textContent = renderCoin(spin, 0.42 + Math.sin(now / 2300) * 0.16);
      }
      const mark = markRef.current;
      if (!mark) return;
      if (!startRef.current) startRef.current = now;
      // Decode on load, then a short re-scramble every ~9 seconds.
      const cycle = (now - startRef.current) % 9000;
      if (cycle < 1600) {
        if (cycle < 40) seedRef.current = Math.floor(now / 1000) % 50;
        mark.textContent = scrambleFrame(cycle, 0, seedRef.current);
      } else if (mark.textContent !== FINAL_WORDMARK) {
        mark.textContent = FINAL_WORDMARK;
      }
    },
    40,
  );

  useEffect(() => {
    if (!running) return;
    const el = root.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      pointer.current = ((e.clientX - box.left) / box.width - 0.5) * 2;
    };
    el.addEventListener('pointermove', move);
    return () => el.removeEventListener('pointermove', move);
  }, [running]);

  return (
    <div className="lp-hero-art" ref={root}>
      <pre className="lp-ascii lp-wordmark" ref={markRef} aria-hidden="true">
        {FINAL_WORDMARK}
      </pre>
      <pre className="lp-ascii lp-coin" ref={coinRef} aria-hidden="true">
        {INITIAL_COIN}
      </pre>
    </div>
  );
}

/** Slow-moving field of characters behind a section. */
export function AsciiField({
  density = 'hero',
}: {
  density?: 'hero' | 'soft';
}) {
  const root = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const grid = useRef({ cols: 0, rows: 0 });
  const inView = useInView(root, '0px');
  const reduced = useReducedMotion();
  const ramp = ' .·:-=+*#';

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      grid.current = {
        cols: Math.min(220, Math.ceil(box.width / 7.2)),
        rows: Math.min(80, Math.ceil(box.height / 13)),
      };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paint = (t: number) => {
    const { cols, rows } = grid.current;
    const target = pre.current;
    if (!target || cols === 0) return;
    let out = '';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v =
          Math.sin(x * 0.11 + t) +
          Math.sin(y * 0.19 - t * 0.8) +
          Math.sin((x + y) * 0.07 + t * 0.55) +
          Math.sin(Math.hypot(x - cols * 0.7, (y - rows * 0.4) * 2) * 0.13 - t);
        const n = (v + 4) / 8;
        out +=
          ramp[
            Math.min(ramp.length - 1, Math.floor(n * n * ramp.length * 1.2))
          ];
      }
      out += '\n';
    }
    target.textContent = out;
  };

  useEffect(() => {
    if (reduced) paint(1.3);
  });

  useFrameLoop(inView && !reduced, (now) => paint(now / 1800), 24);

  return (
    <div
      className={`lp-field lp-field-${density}`}
      ref={root}
      aria-hidden="true"
    >
      <pre className="lp-ascii" ref={pre} />
    </div>
  );
}
