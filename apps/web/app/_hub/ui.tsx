'use client';

import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { BalanceSchema, CapabilitySchema } from '@synq/contracts';
import { formatAmount, NETWORK_LABEL, spendableUnits } from '../../lib/money';
import type { Loaded } from './hooks';

export function Notice(props: {
  tone?: 'info' | 'warning' | 'danger' | 'positive';
  children: ReactNode;
  live?: boolean;
}) {
  const tone = props.tone ?? 'info';
  return (
    <p
      className={`hub-notice hub-notice-${tone}`}
      role={tone === 'danger' ? 'alert' : props.live ? 'status' : undefined}
    >
      {props.children}
    </p>
  );
}

export function PageHeader(props: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="hub-page-header">
      <div>
        <h1>{props.title}</h1>
        {props.subtitle && <p className="hub-sub">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="hub-actions">{props.actions}</div>}
    </header>
  );
}

export function Panel(props: {
  title: string;
  id?: string;
  note?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const id = props.id ?? props.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <section className="hub-panel" aria-labelledby={`${id}-h`}>
      <div className="hub-panel-head">
        <h2 id={`${id}-h`}>{props.title}</h2>
        {props.actions}
      </div>
      {props.note && <p className="hub-sub">{props.note}</p>}
      {props.children}
    </section>
  );
}

/** Loading, error and not-found states for any loaded resource. */
export function Async<T>(props: {
  state: Loaded<T>;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading, errorKind } = props.state;
  if (data !== null) {
    return (
      <>
        {error && <Notice tone="warning">{error}</Notice>}
        {props.children(data)}
      </>
    );
  }
  if (loading) return <p role="status">Loading…</p>;
  return (
    <Notice tone="danger">
      {errorKind === 'NOT_FOUND'
        ? 'Not found, or not visible to you.'
        : (error ?? 'Could not load this.')}{' '}
      <button className="hub-link" onClick={() => void props.state.reload()}>
        Try again
      </button>
    </Notice>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hub-empty">{children}</p>;
}

export function CopyButton(props: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="hub-btn"
      onClick={() => {
        navigator.clipboard
          .writeText(props.value)
          .then(() => setState('copied'))
          .catch(() => setState('failed'));
      }}
    >
      {state === 'copied'
        ? 'Copied'
        : state === 'failed'
          ? 'Copy failed'
          : props.label}
    </button>
  );
}

export function NetworkNote() {
  return <p className="hub-network">{NETWORK_LABEL} · test funds only</p>;
}

type Balance = z.output<typeof BalanceSchema>;

/**
 * Settled money is final on chain. Spendable = settled minus reserved.
 * Pending and quarantined are shown on their own and never added in.
 */
export function BalanceTable({ balances }: { balances: Balance[] }) {
  if (!balances.length) return <Empty>No balances yet.</Empty>;
  return (
    <div className="hub-table-wrap">
      <table className="hub-table">
        <caption className="hub-sr">Balances on {NETWORK_LABEL}</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col" className="num">
              Spendable
            </th>
            <th scope="col" className="num">
              Reserved
            </th>
            <th scope="col" className="num">
              Pending (not final)
            </th>
            <th scope="col" className="num">
              Quarantined (not spendable)
            </th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr key={`${b.chainId}:${b.assetId}`}>
              <th scope="row">{b.symbol}</th>
              <td className="num strong">
                {formatAmount(
                  spendableUnits(b.settled, b.reserved),
                  b.decimals,
                )}
              </td>
              <td className="num">{formatAmount(b.reserved, b.decimals)}</td>
              <td className="num">{formatAmount(b.pending, b.decimals)}</td>
              <td className="num">{formatAmount(b.quarantined, b.decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Capability = z.output<typeof CapabilitySchema>;

export function CapabilityList(props: {
  capabilities: Record<string, Capability>;
  showAvailable?: boolean;
}) {
  const entries = Object.entries(props.capabilities).filter(
    ([, c]) => props.showAvailable || c.status !== 'AVAILABLE',
  );
  if (!entries.length) return <Empty>Every capability is available.</Empty>;
  return (
    <dl className="hub-defs">
      {entries.map(([name, c]) => (
        <div key={name}>
          <dt>{humanize(name)}</dt>
          <dd>
            <span className="hub-status">{humanize(c.status)}</span>
            {c.reason ? ` — ${c.reason}` : ''}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function Hash({ value }: { value: string }) {
  return (
    <code className="hub-hash" title={value}>
      {value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value}
    </code>
  );
}

const NOT_FINAL = new Set([
  'PENDING',
  'BROADCAST',
  'REORG_PENDING',
  'AUTHORIZED',
]);

/** Status text that never presents an unfinished step as final. */
export function runStatusLabel(status: string): string {
  if (status === 'FINALIZED') return 'Final on chain';
  if (status === 'RECONCILED') return 'Reconciled';
  if (NOT_FINAL.has(status)) return `${humanize(status)} (not final)`;
  return humanize(status);
}

export const ACTOR_LABEL: Record<string, string> = {
  MODEL: 'Model (advisory, cannot authorize)',
  DETERMINISTIC: 'Deterministic rule',
  HUMAN: 'Person',
  CHAIN: 'Chain',
  PROVIDER: 'Provider',
};
