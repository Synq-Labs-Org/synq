'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  WORKSPACE_THEMES,
  type WorkspaceTheme,
} from '../workspaces/theme-picker';
import { Search } from './search';

export type NavSection = {
  id: string;
  title: string;
  pages: { title: string; href: string }[];
};

const KEY = 'synq.theme';
const isTheme = (v: unknown): v is WorkspaceTheme =>
  WORKSPACE_THEMES.some((t) => t.id === v);

/** Docs default to the ASCII look; a saved choice (shared with the workspace page) wins. */
function useDocsTheme() {
  const [theme, setTheme] = useState<WorkspaceTheme>('ascii');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY);
      if (isTheme(saved)) setTheme(saved);
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);
  const choose = (next: WorkspaceTheme) => {
    setTheme(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit.
    }
  };
  return [theme, choose] as const;
}

export function DocsShell(props: { nav: NavSection[]; children: ReactNode }) {
  const [theme, setTheme] = useDocsTheme();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname().replace(/\/$/, '') || '/docs';
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Copy buttons on code blocks (rendered as static HTML).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-copy]',
      );
      if (!btn) return;
      const code =
        btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
      navigator.clipboard
        ?.writeText(code)
        .then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy'), 1500);
        })
        .catch(() => {
          btn.textContent = 'Press Ctrl+C';
        });
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <div className="docs-shell" data-theme={theme}>
      <a className="docs-skip" href="#docs-main">
        Skip to content
      </a>
      <header className="docs-top">
        <button
          ref={toggleRef}
          type="button"
          className="docs-menu"
          aria-expanded={open}
          aria-controls="docs-sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
        <Link href="/docs" className="docs-brand">
          [ synq / docs ]
        </Link>
        <button
          type="button"
          className="docs-searchbtn"
          onClick={() => setSearchOpen(true)}
        >
          <span>Search docs</span>
          <kbd>Ctrl K</kbd>
        </button>
        <label className="docs-theme">
          <span className="docs-sr">Theme</span>
          <select
            value={theme}
            aria-label="Theme"
            onChange={(e) =>
              isTheme(e.target.value) && setTheme(e.target.value)
            }
          >
            {WORKSPACE_THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <a className="docs-home" href="/">
          Synq home
        </a>
      </header>
      <div className="docs-body">
        <nav
          id="docs-sidebar"
          aria-label="Documentation"
          className={`docs-side${open ? ' is-open' : ''}`}
        >
          <Link
            href="/docs"
            className={pathname === '/docs' ? 'is-current' : ''}
          >
            Overview
          </Link>
          {props.nav.map((s) => (
            <SideSection key={s.id} section={s} pathname={pathname} />
          ))}
        </nav>
        <div className="docs-content">{props.children}</div>
      </div>
      <Search open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function SideSection(props: { section: NavSection; pathname: string }) {
  const { section, pathname } = props;
  const active = section.pages.some((p) => p.href === pathname);
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return (
    <div className="docs-group">
      <button
        type="button"
        className="docs-group-title"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{open ? '[-]' : '[+]'}</span> {section.title}
      </button>
      {open && (
        <ul>
          {section.pages.map((p) => (
            <li key={p.href}>
              <Link
                href={p.href}
                aria-current={p.href === pathname ? 'page' : undefined}
                className={p.href === pathname ? 'is-current' : ''}
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
