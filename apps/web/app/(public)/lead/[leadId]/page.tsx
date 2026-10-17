'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  ClientLeadDetailSchema,
  ClientOfferVersionSchema,
  ContextsSchema,
  LeadMessageSchema,
} from '@synq/contracts';
import type { z } from 'zod';
import { useWorkspaceTheme } from '../../../workspaces/theme-picker';
import { useV3 } from '../../../_hub/hooks';
import { SignInPanel } from '../../../_hub/sign-in';
import { Empty, Notice, humanize } from '../../../_hub/ui';
import '../../../_hub/hub.css';
import { formatMoney, shortDate } from '../../../../lib/money';
import { describeV3, seg, v3, V3Error } from '../../../../lib/v3';

const UUID = /^[0-9a-fA-F-]{36}$/;
type Offer = z.output<typeof ClientOfferVersionSchema>;
const AUTHOR: Record<string, string> = {
  LEAD: 'You',
  AGENT: 'Business assistant',
  STAFF: 'The business',
  SYSTEM: 'Synq',
};

function OfferCard({ offer }: { offer: Offer }) {
  return (
    <section className="hub-panel" aria-labelledby={`offer-${offer.version}-h`}>
      <h3 id={`offer-${offer.version}-h`}>
        Offer version {offer.version}{' '}
        <span className="hub-status">{humanize(offer.status)}</span>
      </h3>
      <p>
        Total <strong>{formatMoney(offer.total)}</strong>
        {offer.status === 'SENT'
          ? ` · valid until ${shortDate(offer.expiresAt)}`
          : ''}
      </p>
      <div className="hub-table-wrap">
        <table className="hub-table">
          <caption className="hub-sr">
            Items in offer version {offer.version}
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Each (USDC)
              </th>
              <th scope="col" className="num">
                Line total (USDC)
              </th>
            </tr>
          </thead>
          <tbody>
            {offer.lines.map((l, i) => (
              <tr key={i}>
                <th scope="row">{l.description}</th>
                <td className="num">{l.quantity}</td>
                <td className="num">
                  {formatMoney({ ...offer.total, units: l.unitUnits })}
                </td>
                <td className="num">
                  {formatMoney({ ...offer.total, units: l.totalUnits })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {offer.milestones.length > 0 && (
        <div className="hub-table-wrap">
          <table className="hub-table">
            <caption className="hub-sr">
              Payment milestones of offer version {offer.version}
            </caption>
            <thead>
              <tr>
                <th scope="col">Milestone</th>
                <th scope="col" className="num">
                  Amount (USDC)
                </th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {offer.milestones.map((m, i) => (
                <tr key={i}>
                  <th scope="row">{m.label}</th>
                  <td className="num">
                    {formatMoney({ ...offer.total, units: m.units })}
                  </td>
                  <td>{m.dueAt ? shortDate(m.dueAt) : 'On agreement'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Chat({ leadId }: { leadId: string }) {
  const path = `/v3/lead-sessions/${seg(leadId)}`;
  const state = useV3(path, ClientLeadDetailSchema);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const reload = state.reload;
  const count = state.data?.messages.length ?? 0;

  // The business or its assistant may reply at any time; check quietly.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 10000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  if (state.data === null) {
    if (state.loading) return <p role="status">Loading…</p>;
    if (state.errorKind === 'AUTH') return null;
    return (
      <Notice tone="danger">
        {state.errorKind === 'NOT_FOUND'
          ? 'This conversation was not found, or it is not yours.'
          : (state.error ?? 'Could not load this conversation.')}
      </Notice>
    );
  }
  const d = state.data;
  const offers = [...d.offers].sort((a, b) => b.version - a.version);
  const latest = offers[0];

  return (
    <>
      <h1>{d.lead.businessName}</h1>
      <p className="hub-sub">
        Stage: {humanize(d.lead.stage)}. {d.consent.scope}
      </p>
      <Notice tone="info">
        Nothing here moves money. Messages and offers on this page do not pay,
        deposit or sign anything. Any agreement is signed and paid separately
        from your own wallet.
      </Notice>

      <section className="hub-panel" aria-labelledby="chat-h">
        <h2 id="chat-h">Private conversation</h2>
        {!d.messages.length && <Empty>No messages yet. Say hello below.</Empty>}
        <div
          className="hub-transcript"
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          tabIndex={0}
        >
          {d.messages.map((m) => (
            <div
              key={m.messageId}
              className={`hub-msg ${m.author === 'LEAD' ? 'lead' : m.author === 'STAFF' ? 'staff' : ''}`}
            >
              <p className="who">
                {AUTHOR[m.author] ?? humanize(m.author)} ·{' '}
                {shortDate(m.createdAt)}
                {m.offerVersion ? ` · offer v${m.offerVersion}` : ''}
              </p>
              <p className="text">{m.text}</p>
            </div>
          ))}
        </div>
        {d.olderMessagesCursor && (
          <p className="hub-sub">Older messages are not shown here.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body || busy) return;
            setBusy(true);
            setError(null);
            v3.post(`${path}/message`, LeadMessageSchema, { text: body })
              .then(() => {
                setText('');
                return reload();
              })
              .catch((err: unknown) => setError(describeV3(err)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="hub-field">
            <label htmlFor="client-message">Your message</label>
            <textarea
              id="client-message"
              rows={3}
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <p>
            <button
              className="hub-btn hub-btn-primary"
              disabled={busy || !text.trim()}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </p>
        </form>
      </section>

      <section aria-labelledby="offers-h">
        <h2 id="offers-h">Offers</h2>
        {!latest ? (
          <Empty>No offer has been sent to you yet.</Empty>
        ) : (
          <>
            <OfferCard offer={latest} />
            {offers.length > 1 && (
              <p className="hub-sub">
                {offers.length - 1} earlier version
                {offers.length > 2 ? 's were' : ' was'} replaced by this one.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}

export default function LeadSessionPage() {
  const { leadId } = useParams<{ leadId: string }>();
  const [theme] = useWorkspaceTheme();
  const valid = UUID.test(leadId);
  const [phase, setPhase] = useState<'checking' | 'out' | 'in' | 'retry'>(
    valid ? 'checking' : 'in',
  );
  useEffect(() => {
    if (!valid || phase !== 'checking') return;
    let active = true;
    // Probe the session first so a signed-out visitor gets the wallet sign-in.
    v3.get('/v3/me/contexts', ContextsSchema)
      .then(() => active && setPhase('in'))
      .catch((e: unknown) => {
        if (active)
          setPhase(e instanceof V3Error && e.kind === 'AUTH' ? 'out' : 'retry');
      });
    return () => {
      active = false;
    };
  }, [valid, phase]);
  return (
    <div className="hub-shell" data-theme={theme}>
      <div className="hub-center">
        <p className="hub-network">Synq · Arc testnet</p>
        {!valid && (
          <Notice tone="danger">This conversation was not found.</Notice>
        )}
        {valid && phase === 'checking' && (
          <p role="status">Checking your session…</p>
        )}
        {valid && phase === 'out' && (
          <SignInPanel
            title="Sign in with your wallet"
            intro="Sign in with the wallet you used to accept the invitation. Signing in proves the wallet is yours and never approves a payment."
            onSignedIn={() => setPhase('checking')}
          />
        )}
        {valid && phase === 'retry' && (
          <Notice tone="warning">
            Could not reach Synq. Wait a moment and reload this page.
          </Notice>
        )}
        {valid && phase === 'in' && <Chat leadId={leadId} />}
      </div>
    </div>
  );
}
