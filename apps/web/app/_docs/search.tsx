'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type Entry = {
  title: string;
  section: string;
  href: string;
  description: string;
  headings: { text: string; id: string }[];
  text: string;
};
type Hit = {
  entry: Entry;
  href: string;
  label: string;
  snippet: string;
  score: number;
};

function run(index: Entry[], q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const e of index) {
    const title = e.title.toLowerCase();
    const text = e.text.toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      let s = 0;
      if (title.includes(t)) s += 10;
      if (e.description.toLowerCase().includes(t)) s += 3;
      if (e.headings.some((h) => h.text.toLowerCase().includes(t))) s += 5;
      if (text.includes(t)) s += 1;
      if (!s) ok = false;
      score += s;
    }
    if (!ok) continue;
    const h =
      e.headings.find((x) =>
        terms.every((t) => x.text.toLowerCase().includes(t)),
      ) ??
      e.headings.find((x) =>
        terms.some((t) => x.text.toLowerCase().includes(t)),
      );
    const at = text.indexOf(terms[0] as string);
    const snippet =
      at >= 0
        ? (at > 40 ? '…' : '') +
          e.text.slice(Math.max(0, at - 40), at + 110) +
          '…'
        : e.description;
    hits.push({
      entry: e,
      href: h ? `${e.href}#${h.id}` : e.href,
      label: h ? `${e.title} / ${h.text}` : e.title,
      snippet,
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 12);
}

export function Search(props: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    input.current?.focus();
    if (index) return;
    fetch('/docs/search-index.json')
      .then((r) => r.json() as Promise<Entry[]>)
      .then(setIndex)
      .catch(() => setIndex([]));
  }, [props.open, index]);

  const hits = useMemo(() => (index ? run(index, q) : []), [index, q]);
  useEffect(() => setSel(0), [q]);
  if (!props.open) return null;

  const go = (h: Hit | undefined) => {
    if (!h) return;
    props.onClose();
    setQ('');
    router.push(h.href);
  };

  return (
    <div className="docs-modal" role="presentation" onMouseDown={props.onClose}>
      <div
        className="docs-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter') go(hits[sel]);
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles, headings and text"
          aria-label="Search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="docs-results"
          aria-activedescendant={hits.length ? `docs-hit-${sel}` : undefined}
        />
        <ul id="docs-results" role="listbox">
          {hits.map((h, i) => (
            <li
              key={h.href}
              id={`docs-hit-${i}`}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'is-sel' : ''}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(h)}
            >
              <strong>{h.label}</strong>
              <small>{h.entry.section}</small>
              <span>{h.snippet}</span>
            </li>
          ))}
          {q && index && !hits.length && (
            <li className="docs-none">No results.</li>
          )}
          {!index && <li className="docs-none">Loading index…</li>}
        </ul>
        <p className="docs-hint">
          Up/Down to move, Enter to open, Esc to close.
        </p>
      </div>
    </div>
  );
}
