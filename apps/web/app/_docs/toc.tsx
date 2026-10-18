'use client';

import { useEffect, useState } from 'react';

export function Toc(props: {
  headings: { depth: number; text: string; id: string }[];
}) {
  const [active, setActive] = useState('');
  useEffect(() => {
    const els = props.headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => !!e);
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting);
        const first = vis[0];
        if (first) setActive(first.target.id);
      },
      { rootMargin: '-72px 0px -70% 0px' },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [props.headings]);
  if (!props.headings.length) return null;
  return (
    <nav className="docs-toc" aria-label="On this page">
      <p>On this page</p>
      <ul>
        {props.headings.map((h) => (
          <li key={h.id} className={h.depth === 3 ? 'd3' : ''}>
            <a href={`#${h.id}`} className={active === h.id ? 'is-active' : ''}>
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
