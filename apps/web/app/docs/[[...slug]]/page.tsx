import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Toc } from '../../_docs/toc';
import {
  REPO_EDIT_BASE,
  allPages,
  findPage,
  neighbours,
  renderMarkdown,
} from '../../../lib/docs/content';

export const dynamicParams = false;

type Props = { params: Promise<{ slug?: string[] }> };

export function generateStaticParams() {
  return allPages().map((p) => ({ slug: p.slug ? p.slug.split('/') : [] }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = findPage((await params).slug);
  if (!page) return {};
  return {
    title: page.slug ? `${page.title} | Synq docs` : 'Synq docs',
    description: page.description,
  };
}

export default async function DocPage({ params }: Props) {
  const page = findPage((await params).slug);
  if (!page) notFound();
  const { html, headings } = renderMarkdown(page.body);
  const { prev, next } = neighbours(page);
  return (
    <div className="docs-article-wrap">
      <article className="docs-article" id="docs-main">
        <nav className="docs-crumbs" aria-label="Breadcrumb">
          <Link href="/docs">Docs</Link>
          {page.section && (
            <>
              {' / '}
              <span>{page.sectionTitle}</span>
            </>
          )}
          {page.section && page.slug !== page.section && (
            <>
              {' / '}
              <span aria-current="page">{page.title}</span>
            </>
          )}
        </nav>
        <h1>{page.title}</h1>
        <p className="docs-lead">{page.description}</p>
        <div
          className="docs-prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <p className="docs-edit">
          <a href={REPO_EDIT_BASE + page.file} rel="noreferrer">
            Edit this page on GitHub
          </a>
        </p>
        <nav className="docs-pager" aria-label="Previous and next">
          {prev ? (
            <Link href={prev.href} rel="prev">
              <small>Previous</small>
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={next.href} rel="next" className="next">
              <small>Next</small>
              {next.title}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
      <Toc headings={headings} />
    </div>
  );
}
