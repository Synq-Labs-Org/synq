import type { ReactNode } from 'react';
import { DocsShell } from '../_docs/shell';
import { loadDocs } from '../../lib/docs/content';
import './docs.css';

export default function DocsLayout({ children }: { children: ReactNode }) {
  const nav = loadDocs().sections.map((s) => ({
    id: s.id,
    title: s.title,
    pages: s.pages.map((p) => ({ title: p.title, href: p.href })),
  }));
  return <DocsShell nav={nav}>{children}</DocsShell>;
}
