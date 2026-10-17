import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allPages,
  loadDocs,
  parseFrontmatter,
  renderMarkdown,
} from '../../apps/web/lib/docs/content';

const root = path.join(process.cwd(), 'apps/web/content/docs');

describe('docs content', () => {
  it('parses every file with a title and description', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      expect(fm.title, f).not.toBe('');
      expect(fm.description, f).not.toBe('');
      expect(() => renderMarkdown(fm.body), f).not.toThrow();
    }
  });

  it('gives every section directory a _section.json', () => {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const meta = path.join(root, e.name, '_section.json');
      expect(fs.existsSync(meta), e.name).toBe(true);
      const j = JSON.parse(fs.readFileSync(meta, 'utf8')) as {
        title: unknown;
        order: unknown;
      };
      expect(typeof j.title).toBe('string');
      expect(typeof j.order).toBe('number');
    }
    expect(loadDocs().sections.length).toBeGreaterThan(0);
  });

  it('resolves every internal /docs link to an existing page and heading', () => {
    const pages = allPages();
    const byHref = new Map(pages.map((p) => [p.href, p]));
    for (const p of pages) {
      for (const m of p.body.matchAll(/\]\((\/docs[^)\s]*)\)/g)) {
        const [pathPart, hash] = (m[1] as string).split('#');
        const target = byHref.get(
          (pathPart as string).replace(/\/$/, '') || '/docs',
        );
        expect(target, `${p.file} -> ${m[1]}`).toBeDefined();
        if (hash && target) {
          const ids = renderMarkdown(target.body).headings.map((h) => h.id);
          expect(ids, `${p.file} -> ${m[1]}`).toContain(hash);
        }
      }
    }
  });
});
