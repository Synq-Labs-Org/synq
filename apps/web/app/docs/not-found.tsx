import Link from 'next/link';

export default function NotFound() {
  return (
    <article className="docs-article">
      <h1>Page not found</h1>
      <p>That documentation page does not exist.</p>
      <p>
        <Link href="/docs">Back to the docs</Link> or <a href="/">go to Synq</a>
        .
      </p>
    </article>
  );
}
