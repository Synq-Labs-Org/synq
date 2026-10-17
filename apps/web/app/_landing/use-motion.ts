'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

/** True when the viewer asked the system for less motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Whether the element is near the viewport. Animations run only while true. */
export function useInView(
  ref: RefObject<Element | null>,
  margin = '160px',
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return inView;
}

/**
 * Calls `step` on animation frames while `active`. The loop stops when
 * `active` turns false (off-screen, reduced motion) and the browser already
 * pauses frames in hidden tabs. `fps` caps the rate.
 */
export function useFrameLoop(
  active: boolean,
  step: (time: number, delta: number) => void,
  fps = 60,
): void {
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    if (!active) return;
    const minGap = 1000 / fps - 1;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (last && now - last < minGap) return;
      const delta = last ? now - last : 16;
      last = now;
      stepRef.current(now, delta);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, fps]);
}
