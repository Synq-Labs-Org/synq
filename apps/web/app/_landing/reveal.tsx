'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/**
 * Sections assemble as they scroll in. Where the browser supports CSS
 * scroll-driven animations (`animation-timeline: view()`), the CSS does all
 * the work and this component only provides the hook. Elsewhere an
 * IntersectionObserver marks the element `data-in` and a transition plays.
 * Without JavaScript, or with reduced motion, the content is simply shown.
 */
export function Reveal({
  children,
  index = 0,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  index?: number;
  className?: string;
  as?: 'div' | 'li' | 'article';
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<'css' | 'io'>('css');
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (CSS.supports('animation-timeline: view()')) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    setMode('io');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const props = {
    ref: (el: HTMLElement | null) => {
      ref.current = el;
    },
    className: `lp-reveal ${className}`.trim(),
    'data-mode': mode,
    'data-in': seen ? 'true' : undefined,
    style: { '--i': index } as CSSProperties,
  };
  // The tag is chosen from a fixed list, so this stays a plain element.
  if (Tag === 'li') return <li {...props}>{children}</li>;
  if (Tag === 'article') return <article {...props}>{children}</article>;
  return <div {...props}>{children}</div>;
}
