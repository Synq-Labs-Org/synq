'use client';

import { LandingThemePicker } from './theme';

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#get-paid', label: 'Get paid' },
  { href: '#spend-safely', label: 'Spend safely' },
  { href: '#agent-payments', label: 'Agents' },
  { href: '#security', label: 'Security' },
  { href: '#surfaces', label: 'Surfaces' },
];

export function LandingHeader() {
  return (
    <header className="lp-header">
      <a href="#top" className="lp-logo" aria-label="Synq, top of page">
        SYNQ
      </a>
      <nav className="lp-nav" aria-label="Sections">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>
      <div className="lp-header-r">
        <LandingThemePicker />
        <a className="lp-nav-docs" href="/docs">
          Docs
        </a>
      </div>
    </header>
  );
}
