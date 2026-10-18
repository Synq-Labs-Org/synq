'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useFrameLoop, useInView, useReducedMotion } from './use-motion';

/** Device depth in CSS pixels; the body is built from this many thin slices. */
const DEPTH = 22;
const SLICES = 12;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

type Pose = { rx: number; ry: number };

/**
 * A phone modelled with CSS 3D transforms: stacked rounded slices give the
 * frame real thickness, the glass sits on the front, side buttons stand
 * proud of the edge, and a contact shadow follows the rotation. The screens
 * are live HTML. Pose follows scroll (the nearest `[data-phone-track]`
 * ancestor, else the phone's own place in the viewport) and the pointer.
 */
export function Phone({
  screens,
  active = 0,
  label,
  className,
}: {
  screens: ReactNode[];
  active?: number;
  label: string;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const inView = useInView(wrap, '200px');
  const reduced = useReducedMotion();
  const pose = useRef<Pose>({ rx: 6, ry: -18 });
  const pointer = useRef({ x: 0, y: 0, over: false });

  const write = (rx: number, ry: number) => {
    const el = wrap.current;
    if (!el) return;
    el.style.setProperty('--rx', rx.toFixed(2));
    el.style.setProperty('--ry', ry.toFixed(2));
    el.style.setProperty('--ay', Math.abs(ry).toFixed(2));
    el.style.setProperty('--gl', (ry * 1.1).toFixed(2));
  };

  useEffect(() => {
    // A resting pose that already looks like a device.
    write(6, -18);
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el || reduced) return;
    const move = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      pointer.current = {
        x: clamp(((e.clientX - box.left) / box.width - 0.5) * 2, -1.4, 1.4),
        y: clamp(((e.clientY - box.top) / box.height - 0.5) * 2, -1.4, 1.4),
        over: true,
      };
    };
    const leave = () => {
      pointer.current = { x: 0, y: 0, over: false };
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [reduced]);

  useFrameLoop(inView && !reduced, () => {
    const el = wrap.current;
    if (!el) return;
    const vh = window.innerHeight || 800;
    const track = el.closest<HTMLElement>('[data-phone-track]');
    let targetRy: number;
    let targetRx: number;
    if (track) {
      const box = track.getBoundingClientRect();
      const span = Math.max(1, box.height - vh);
      const p = clamp(-box.top / span, 0, 1);
      targetRy = (p * 2 - 1) * 32;
      targetRx = 4 + Math.sin(p * Math.PI) * 6;
    } else {
      const box = el.getBoundingClientRect();
      const center = (box.top + box.height / 2) / vh - 0.5;
      targetRy = clamp(-center * 70, -34, 34) - 8;
      targetRx = 6 + center * 10;
    }
    const pt = pointer.current;
    targetRy += pt.x * 16;
    targetRx -= pt.y * 10;
    const cur = pose.current;
    cur.ry += (targetRy - cur.ry) * 0.1;
    cur.rx += (targetRx - cur.rx) * 0.1;
    write(cur.rx, cur.ry);
  });

  const slices = Array.from({ length: SLICES + 1 }, (_, i) => {
    const t = i / SLICES;
    const z = -DEPTH / 2 + t * DEPTH;
    // Brightest at mid-depth: reads as a rolled titanium edge.
    const shade = 1 - Math.abs(t - 0.5) * 1.1;
    return { z, shade };
  });

  return (
    <div
      className={`ph ${className ?? ''}`}
      ref={wrap}
      role="img"
      aria-label={label}
    >
      <div className="ph-stage">
        <div className="ph-shadow" />
        <div className="ph-rig">
          {slices.map((s, i) => (
            <i
              key={i}
              className="ph-slice"
              style={
                {
                  transform: `translateZ(${s.z}px)`,
                  '--shade': s.shade.toFixed(3),
                } as CSSProperties
              }
            />
          ))}
          <i className="ph-btn ph-btn-l" style={{ top: 112, height: 30 }} />
          <i className="ph-btn ph-btn-l" style={{ top: 168, height: 54 }} />
          <i className="ph-btn ph-btn-l" style={{ top: 234, height: 54 }} />
          <i className="ph-btn ph-btn-r" style={{ top: 190, height: 88 }} />
          <div className="ph-back" aria-hidden="true">
            <div className="ph-camera">
              <b />
              <b />
              <b />
            </div>
          </div>
          <div className="ph-front">
            <div className="ph-screen" aria-hidden="true">
              {screens.map((s, i) => (
                <div
                  key={i}
                  className="ph-view"
                  data-active={i === active ? 'true' : 'false'}
                >
                  {s}
                </div>
              ))}
              <div className="ph-status">
                <span>9:41</span>
                <span>5G ▮▮▮</span>
              </div>
              <div className="ph-island" />
              <div className="ph-glare" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
