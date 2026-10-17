import fs from 'node:fs';
import path from 'node:path';
import { Marked, type Tokens } from 'marked';
import { highlight } from './highlight';

export type Heading = { depth: 2 | 3; text: string; id: string };

export type DocPage = {
  section: string; // '' for the docs home
  sectionTitle: string;
  slug: string; // '' for /docs, otherwise 'section' or 'section/page'
  href: string;
  title: string;
  description: string;
  file: string; // path relative to content/docs
  body: string;
};

export type DocSection = {
  id: string;
  title: string;
  order: number;
  pages: DocPage[];
};

export const REPO_EDIT_BASE =
  'https://github.com/Synq-Labs-Org/synq/blob/main/apps/web/content/docs/';

export function docsRoot(): string {
  const candidates = [
    path.join(process.cwd(), 'content', 'docs'),
    path.join(process.cwd(), 'apps', 'web', 'content', 'docs'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('docs content directory not found');
  return found;
}

export function parseFrontmatter(raw: string): {
  title: string;
  description: string;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('missing frontmatter');
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1] as string] = (kv[2] ?? '').trim();
  }
  return {
    title: meta.title ?? '',
    description: meta.description ?? '',
    body: m[2] ?? '',
  };
}

const stripOrder = (name: string) =>
  name.replace(/^\d+-/, '').replace(/\.md$/, '');

let cache: { home: DocPage; sections: DocSection[] } | undefined;

export function loadDocs(): { home: DocPage; sections: DocSection[] } {
  if (cache) return cache;
  const root = docsRoot();
  const read = (
    rel: string,
    section: string,
    sectionTitle: string,
    slug: string,
  ) => {
    const fm = parseFrontmatter(fs.readFileSync(path.join(root, rel), 'utf8'));
    return {
      section,
      sectionTitle,
      slug,
      href: slug ? `/docs/${slug}` : '/docs',
      title: fm.title,
      description: fm.description,
      file: rel,
      body: fm.body,
    } satisfies DocPage;
  };
  const home = read('index.md', '', 'Docs', '');
  const sections: DocSection[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const metaPath = path.join(root, dir.name, '_section.json');
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      title: string;
      order: number;
    };
    const files = fs
      .readdirSync(path.join(root, dir.name))
      .filter((f) => f.endsWith('.md'))
      .sort();
    const pages = files.map((f) => {
      const name = stripOrder(f);
      const slug = name === 'index' ? dir.name : `${dir.name}/${name}`;
      return read(`${dir.name}/${f}`, dir.name, meta.title, slug);
    });
    sections.push({
      id: dir.name,
      title: meta.title,
      order: meta.order,
      pages,
    });
  }
  sections.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  cache = { home, sections };
  return cache;
}

export function allPages(): DocPage[] {
  const { home, sections } = loadDocs();
  return [home, ...sections.flatMap((s) => s.pages)];
}

export function findPage(slug: string[] | undefined): DocPage | undefined {
  const key = (slug ?? []).join('/');
  return allPages().find((p) => p.slug === key);
}

export function neighbours(page: DocPage): {
  prev?: DocPage;
  next?: DocPage;
} {
  const list = allPages();
  const i = list.findIndex((p) => p.slug === page.slug);
  return { prev: list[i - 1], next: list[i + 1] };
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const CALLOUTS: Record<string, string> = {
  note: 'Note',
  warning: 'Warning',
  testnet: 'Testnet',
  security: 'Security',
};

export function renderMarkdown(body: string): {
  html: string;
  headings: Heading[];
} {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        let id = slugify(token.text) || 'section';
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (token.depth === 2 || token.depth === 3) {
          headings.push({ depth: token.depth, text: token.text, id });
        }
        return `<h${token.depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const l = (lang ?? '').split(/\s+/)[0] ?? '';
        if (l === 'text' || l === 'ascii') {
          return `<figure class="diagram"><pre><code>${highlight(text, 'plain')}</code></pre></figure>\n`;
        }
        return `<div class="codeblock"><div class="codebar"><span class="codelang">${escAttr(l || 'code')}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code class="lang-${escAttr(l)}">${highlight(text, l)}</code></pre></div>\n`;
      },
      table(this, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: string) =>
          `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const rows = token.rows
          .map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`)
          .join('');
        return `<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
      blockquote(this, token: Tokens.Blockquote) {
        const first = token.tokens[0];
        let kind = '';
        let tokens = token.tokens;
        if (first && first.type === 'paragraph') {
          const m = /^\*\*(Note|Warning|Testnet|Security)\*\*\s*/.exec(
            first.text,
          );
          if (m) {
            kind = (m[1] ?? '').toLowerCase();
            const rest = first.text.slice(m[0].length);
            const lead: Tokens.Paragraph = {
              type: 'paragraph',
              raw: rest,
              text: rest,
              tokens: marked.Lexer.lexInline(rest),
            };
            tokens = rest
              ? [lead, ...token.tokens.slice(1)]
              : token.tokens.slice(1);
          }
        }
        const inner = this.parser.parse(tokens);
        if (!kind) return `<blockquote>${inner}</blockquote>\n`;
        return `<aside class="callout callout-${kind}"><div class="callout-title">${CALLOUTS[kind]}</div>${inner}</aside>\n`;
      },
    },
  });
  return { html: marked.parse(body) as string, headings };
}

export type SearchEntry = {
  title: string;
  section: string;
  href: string;
  description: string;
  headings: { text: string; id: string }[];
  text: string;
};

export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*/g, ' '))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSearchIndex(): SearchEntry[] {
  return allPages().map((p) => ({
    title: p.title,
    section: p.sectionTitle,
    href: p.href,
    description: p.description,
    headings: renderMarkdown(p.body).headings.map(({ text, id }) => ({
      text,
      id,
    })),
    text: plainText(p.body),
  }));
}
