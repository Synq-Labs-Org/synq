'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { api, describeError } from '../../lib/api';
import { HubProvider, useHub, type HubContextInfo } from './provider';
import { SignInPanel } from './sign-in';
import { Notice } from './ui';
import './hub.css';

type NavItem = { href: string; label: string };

function navFor(context: HubContextInfo | null): NavItem[] {
  if (!context) return [];
  if (context.kind === 'PERSONAL')
    return [{ href: '/personal', label: 'Overview' }];
  const base = `/w/${encodeURIComponent(context.contextId)}`;
  const role = context.role;
  const staff = role === 'OWNER' || role === 'ADMIN';
  return [
    { href: base, label: 'Overview' },
    ...(staff ? [{ href: `${base}/inbox`, label: 'Inbox' }] : []),
    ...(role && role !== 'VIEWER'
      ? [{ href: `${base}/agents`, label: 'Agents' }]
      : []),
    { href: `${base}/money`, label: 'Money' },
    { href: `${base}/deals`, label: 'Deals' },
    ...(staff ? [{ href: `${base}/settings`, label: 'Settings' }] : []),
  ];
}

const hrefFor = (c: HubContextInfo) =>
  c.kind === 'PERSONAL' ? '/personal' : `/w/${encodeURIComponent(c.contextId)}`;

function Frame({ children }: { children: ReactNode }) {
  const hub = useHub();
  const pathname = usePathname();
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (hub.status === 'loading')
    return (
      <div className="hub-center">
        <p role="status">Loading…</p>
      </div>
    );
  if (hub.status === 'signedOut')
    return (
      <div className="hub-center">
        <SignInPanel onSignedIn={hub.signedIn} />
      </div>
    );
  if (hub.status === 'error' || !hub.contexts)
    return (
      <div className="hub-center">
        <Notice tone="danger">
          {hub.error ?? 'Could not load your data.'}
        </Notice>
        <button className="hub-btn" onClick={() => void hub.reload()}>
          Try again
        </button>
      </div>
    );

  const contexts = hub.contexts.contexts;
  const nav = navFor(hub.current);
  const isActive = (href: string) =>
    pathname === href ||
    (nav.length > 0 &&
      href !== nav[0]?.href &&
      pathname.startsWith(`${href}/`));

  return (
    <div className="hub-frame">
      <aside className="hub-side">
        <div className="hub-brand">
          <Link href="/personal">Synq</Link>
          <span className="hub-network">Arc testnet</span>
        </div>
        <div className="hub-switch-mobile">
          <label htmlFor="hub-context">Context</label>
          <select
            id="hub-context"
            value={hub.contextId ?? ''}
            onChange={(e) => {
              const next = contexts.find((c) => c.contextId === e.target.value);
              if (next) router.push(hrefFor(next));
            }}
          >
            {hub.contextId === null && (
              <option value="" disabled>
                Choose a context
              </option>
            )}
            {contexts.map((c) => (
              <option key={c.contextId} value={c.contextId}>
                {c.displayName}
                {c.role ? ` (${c.role.toLowerCase()})` : ''}
              </option>
            ))}
          </select>
        </div>
        <nav className="hub-contexts" aria-label="Contexts">
          <h2 className="hub-eyebrow">Switch context</h2>
          <ul>
            {contexts.map((c) => (
              <li key={c.contextId}>
                <Link
                  href={hrefFor(c)}
                  aria-current={
                    c.contextId === hub.contextId ? 'page' : undefined
                  }
                  className={c.contextId === hub.contextId ? 'on' : undefined}
                >
                  <span>{c.displayName}</span>
                  <small>
                    {c.kind === 'PERSONAL'
                      ? 'Personal'
                      : (c.role?.toLowerCase() ?? 'member')}
                    {c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : ''}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav className="hub-nav" aria-label="Sections">
          <ul>
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={isActive(item.href) ? 'on' : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/approvals"
                aria-current={
                  pathname.startsWith('/approvals') ? 'page' : undefined
                }
                className={pathname.startsWith('/approvals') ? 'on' : undefined}
              >
                Approvals
              </Link>
            </li>
          </ul>
        </nav>
        <div className="hub-foot">
          <p className="hub-sub">Wallet {hub.contexts.walletHint}</p>
          <button
            className="hub-link"
            onClick={() => {
              setSignOutError(null);
              api
                .post(
                  '/v2/auth/logout',
                  z.strictObject({ ok: z.literal(true) }),
                  {},
                )
                .then(() => hub.signedIn())
                .catch((e: unknown) => setSignOutError(describeError(e)));
            }}
          >
            Sign out
          </button>
          {signOutError && <Notice tone="danger">{signOutError}</Notice>}
          <Link href="/workspaces" className="hub-link">
            Workspace setup
          </Link>
        </div>
      </aside>
      <main className="hub-main" id="hub-main">
        {/* Keyed by context so nothing from the previous context stays mounted. */}
        <div key={hub.contextId ?? 'none'} className="hub-content">
          {hub.contextId !== null && hub.current === null ? (
            <Notice tone="danger">
              This workspace was not found, or you no longer have access to it.
            </Notice>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}

export function HubShell({ children }: { children: ReactNode }) {
  return (
    <HubProvider>
      <Frame>{children}</Frame>
    </HubProvider>
  );
}
