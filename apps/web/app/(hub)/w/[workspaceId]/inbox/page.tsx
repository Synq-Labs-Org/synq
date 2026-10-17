'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import {
  InboxPageSchema,
  LeadDetailSchema,
  LeadHandlingSchema,
  LeadInviteSchema,
  LeadMessageSchema,
  LeadStageSchema,
  OfferValidationSchema,
  TakeoverResultSchema,
} from '@synq/contracts';
import type { z } from 'zod';
import { formatAmount, formatMoney, shortDate } from '../../../../../lib/money';
import { describeV3, seg, v3, V3Error } from '../../../../../lib/v3';
import { useLiveRefresh, usePaged, useV3 } from '../../../../_hub/hooks';
import {
  Async,
  CopyButton,
  Empty,
  Hash,
  Notice,
  PageHeader,
  Panel,
  humanize,
} from '../../../../_hub/ui';

type Detail = z.output<typeof LeadDetailSchema>;
type Offer = Detail['offers'][number];
type Validation = z.output<typeof OfferValidationSchema>;

const ACTIONS = [
  { action: 'HUMAN_TAKEOVER', label: 'Take over', needs: ['AGENT', 'FROZEN'] },
  {
    action: 'HAND_BACK_TO_AGENT',
    label: 'Hand back',
    needs: ['HUMAN', 'FROZEN'],
  },
  {
    action: 'FREEZE_OFFERS',
    label: 'Freeze offers',
    needs: ['AGENT', 'HUMAN'],
  },
  {
    action: 'ESCALATE_TO_OWNER',
    label: 'Escalate to owner',
    needs: ['AGENT', 'HUMAN', 'FROZEN'],
  },
] as const;

function OfferCard(props: { workspaceId: string; offer: Offer }) {
  const { offer } = props;
  const [result, setResult] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `offer-${offer.offerId}-${offer.version}`;
  return (
    <article className="hub-panel" aria-labelledby={id}>
      <h3 id={id}>
        Offer version {offer.version}{' '}
        <span className="hub-status">{humanize(offer.status)}</span>
      </h3>
      <p>
        Total <strong>{formatMoney(offer.total)}</strong> · by{' '}
        {offer.createdBy === 'AGENT' ? 'the sales agent' : 'staff'} · policy v
        {offer.policyVersion} · expires {shortDate(offer.expiresAt)}
      </p>
      {offer.lines.length > 0 && (
        <div className="hub-table-wrap">
          <table className="hub-table">
            <caption className="hub-sr">
              Lines of version {offer.version}
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col" className="num">
                  Unit
                </th>
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {offer.lines.map((l, i) => (
                <tr key={i}>
                  <th scope="row">{l.description}</th>
                  <td className="num">{l.quantity}</td>
                  <td className="num">
                    {formatAmount(l.unitUnits, offer.total.decimals)}
                  </td>
                  <td className="num">
                    {formatAmount(l.totalUnits, offer.total.decimals)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hub-table-wrap">
        <table className="hub-table">
          <caption className="hub-sr">
            Milestones of version {offer.version}
          </caption>
          <thead>
            <tr>
              <th scope="col">Milestone</th>
              <th scope="col">Due</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {offer.milestones.map((m, i) => (
              <tr key={i}>
                <th scope="row">{m.label}</th>
                <td>{m.dueAt ? shortDate(m.dueAt) : 'On agreement'}</td>
                <td className="num">
                  {formatAmount(m.units, offer.total.decimals)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hub-sub">
        Terms hash <Hash value={offer.termsHash} />
        {' · '}Previous{' '}
        {offer.previousTermsHash ? (
          <Hash value={offer.previousTermsHash} />
        ) : (
          'none (first version)'
        )}
      </p>
      <div>
        <button
          className="hub-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            v3.post(
              `/v3/workspaces/${seg(props.workspaceId)}/offers/${seg(offer.offerId)}/versions/${offer.version}/validate`,
              OfferValidationSchema,
            )
              .then(setResult)
              .catch((e: unknown) => setError(describeV3(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Checking…' : 'Re-check offer'}
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {result && (
        <div>
          <Notice tone={result.allowed ? 'positive' : 'warning'} live>
            {result.allowed
              ? `Allowed under policy v${result.policyVersion}.`
              : `Not allowed under policy v${result.policyVersion}.`}
          </Notice>
          <ul className="hub-list" aria-label="Policy checks">
            {result.checks.map((c, i) => (
              <li key={i}>
                <span className="hub-status">
                  {c.passed ? 'Passed' : 'Failed'}
                </span>
                {' · '}
                {humanize(c.rule)}
                <br />
                <small className="hub-sub">{c.detail}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function LeadView(props: {
  workspaceId: string;
  leadId: string;
  onChanged: () => void;
}) {
  const path = `/v3/workspaces/${seg(props.workspaceId)}/leads/${seg(props.leadId)}`;
  const state = useV3(path, LeadDetailSchema);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  useLiveRefresh(state.reload, {
    types: ['LEAD_UPDATED', 'LEAD_MESSAGE', 'OFFER_UPDATED'],
  });

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeV3(e));
      if (e instanceof V3Error && e.kind === 'CONFLICT') await state.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Async state={state}>
      {(d) => (
        <section className="hub-panel" aria-label={`Lead ${d.lead.label}`}>
          <div className="hub-panel-head">
            <div>
              <h2>{d.lead.label}</h2>
              <p className="hub-sub">
                {humanize(d.lead.source)} · {humanize(d.lead.stage)} ·{' '}
                <span className="hub-status">
                  Handled by {humanize(d.lead.handling)}
                </span>
                {d.lead.needsOwner ? ' · needs an owner' : ''}
              </p>
            </div>
          </div>
          <Notice tone={d.consent.granted ? 'info' : 'warning'}>
            {d.consent.granted
              ? `This client agreed that the business can read this conversation${d.consent.grantedAt ? ` (since ${shortDate(d.consent.grantedAt)})` : ''}. Scope: ${d.consent.scope}. Nothing here moves money.`
              : 'No consent to share this conversation is recorded.'}
          </Notice>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="hub-actions" role="group" aria-label="Handling">
            {ACTIONS.map((a) => (
              <button
                key={a.action}
                className="hub-btn"
                disabled={
                  busy ||
                  !(a.needs as readonly string[]).includes(d.lead.handling)
                }
                onClick={() =>
                  void guarded(async () => {
                    await v3.post(`${path}/takeover`, TakeoverResultSchema, {
                      action: a.action,
                      expectedVersion: d.handlingVersion,
                    });
                    await state.reload();
                    props.onChanged();
                  })
                }
              >
                {a.label}
              </button>
            ))}
          </div>
          <h3>Conversation</h3>
          {!d.messages.length && <Empty>No messages yet.</Empty>}
          <div className="hub-transcript" tabIndex={0} aria-label="Transcript">
            {d.messages.map((m) => (
              <div
                key={m.messageId}
                className={`hub-msg ${m.author === 'STAFF' ? 'staff' : m.author === 'LEAD' ? 'lead' : ''}`}
              >
                <p className="who">
                  {humanize(m.author)} · {shortDate(m.createdAt)}
                  {m.offerVersion ? ` · offer v${m.offerVersion}` : ''}
                </p>
                <p className="text">{m.text}</p>
              </div>
            ))}
          </div>
          {d.olderMessagesCursor && (
            <p className="hub-sub">Older messages are not shown here.</p>
          )}
          {d.lead.handling === 'HUMAN' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const body = text.trim();
                if (!body) return;
                void guarded(async () => {
                  await v3.post(`${path}/message`, LeadMessageSchema, {
                    text: body,
                  });
                  setText('');
                  await state.reload();
                  props.onChanged();
                });
              }}
            >
              <div className="hub-field">
                <label htmlFor="staff-message">Message to the client</label>
                <textarea
                  id="staff-message"
                  value={text}
                  maxLength={4000}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <p>
                <button
                  className="hub-btn hub-btn-primary"
                  disabled={busy || !text.trim()}
                >
                  Send as staff
                </button>
              </p>
            </form>
          ) : (
            <p className="hub-sub">
              Take over this lead to write to the client yourself.
            </p>
          )}
          <h3>Offers</h3>
          {!d.offers.length && <Empty>No offers yet.</Empty>}
          {d.offers.map((o) => (
            <OfferCard
              key={`${o.offerId}-${o.version}`}
              workspaceId={props.workspaceId}
              offer={o}
            />
          ))}
        </section>
      )}
    </Async>
  );
}

function InvitePanel({ workspaceId }: { workspaceId: string }) {
  const [source, setSource] = useState<'TELEGRAM' | 'WEB'>('WEB');
  const [ttl, setTtl] = useState(86400);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<z.output<
    typeof LeadInviteSchema
  > | null>(null);
  return (
    <Panel
      title="Invite a client"
      id="invite"
      note="Creates a private single-use link. Share it only with the person you are inviting. It is shown once."
    >
      <div className="hub-form-grid">
        <div className="hub-field">
          <label htmlFor="invite-source">Channel</label>
          <select
            id="invite-source"
            value={source}
            onChange={(e) =>
              setSource(e.target.value === 'TELEGRAM' ? 'TELEGRAM' : 'WEB')
            }
          >
            <option value="WEB">Web link</option>
            <option value="TELEGRAM">Telegram</option>
          </select>
        </div>
        <div className="hub-field">
          <label htmlFor="invite-ttl">Expires after</label>
          <select
            id="invite-ttl"
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
          >
            <option value={3600}>1 hour</option>
            <option value={86400}>24 hours</option>
            <option value={604800}>7 days</option>
          </select>
        </div>
      </div>
      <div>
        <button
          className="hub-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            v3.post(
              `/v3/workspaces/${seg(workspaceId)}/lead-invites`,
              LeadInviteSchema,
              {
                source,
                expiresInSeconds: ttl,
              },
            )
              .then(setInvite)
              .catch((e: unknown) => setError(describeV3(e)))
              .finally(() => setBusy(false));
          }}
        >
          Create invitation
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {invite && (
        <div role="status">
          <p>
            Expires {shortDate(invite.expiresAt)}. This is the only time the
            link is shown.
          </p>
          {invite.telegramUrl && (
            <p>
              <span className="hub-secret">{invite.telegramUrl}</span>{' '}
              <CopyButton
                value={invite.telegramUrl}
                label="Copy Telegram link"
              />
            </p>
          )}
          <p>
            <span className="hub-secret">{invite.webUrl}</span>{' '}
            <CopyButton value={invite.webUrl} label="Copy web link" />
          </p>
          <button className="hub-link" onClick={() => setInvite(null)}>
            Hide links
          </button>
        </div>
      )}
    </Panel>
  );
}

export default function InboxPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [handling, setHandling] = useState('');
  const [stage, setStage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const query = [
    handling ? `handling=${encodeURIComponent(handling)}` : '',
    stage ? `stage=${encodeURIComponent(stage)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const list = usePaged(
    `/v3/workspaces/${seg(workspaceId)}/inbox`,
    query,
    InboxPageSchema,
  );
  useLiveRefresh(list.reload, {
    types: ['LEAD_UPDATED', 'LEAD_MESSAGE', 'OFFER_UPDATED'],
  });
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Private leads. The business can read these conversations; nothing here moves money."
      />
      <InvitePanel workspaceId={workspaceId} />
      <div className="hub-split">
        <section className="hub-panel" aria-labelledby="leads-h">
          <h2 id="leads-h">Leads</h2>
          <div className="hub-filters">
            <div className="hub-field">
              <label htmlFor="f-handling">Handled by</label>
              <select
                id="f-handling"
                value={handling}
                onChange={(e) => setHandling(e.target.value)}
              >
                <option value="">Anyone</option>
                {LeadHandlingSchema.options.map((h) => (
                  <option key={h} value={h}>
                    {humanize(h)}
                  </option>
                ))}
              </select>
            </div>
            <div className="hub-field">
              <label htmlFor="f-stage">Stage</label>
              <select
                id="f-stage"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option value="">Any stage</option>
                {LeadStageSchema.options.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {list.error && <Notice tone="danger">{list.error}</Notice>}
          {list.loading && !list.items.length && <p role="status">Loading…</p>}
          {!list.loading && !list.items.length && !list.error && (
            <Empty>No leads match.</Empty>
          )}
          <div role="list">
            {list.items.map((l) => (
              <div role="listitem" key={l.leadId}>
                <button
                  className="hub-lead-row"
                  aria-current={selected === l.leadId}
                  onClick={() => setSelected(l.leadId)}
                >
                  <strong>{l.label}</strong>
                  {l.unread > 0 ? ` · ${l.unread} unread` : ''}
                  <small>
                    {humanize(l.source)} · {humanize(l.stage)} ·{' '}
                    {humanize(l.handling)}
                    {l.needsOwner ? ' · needs owner' : ''}
                  </small>
                  <small>{shortDate(l.lastActivityAt)}</small>
                </button>
              </div>
            ))}
          </div>
          {list.hasMore && (
            <div>
              <button className="hub-btn" onClick={() => void list.loadMore()}>
                Load more
              </button>
            </div>
          )}
        </section>
        <div>
          {selected ? (
            <LeadView
              key={selected}
              workspaceId={workspaceId}
              leadId={selected}
              onChanged={() => void list.reload()}
            />
          ) : (
            <section className="hub-panel">
              <Empty>Choose a lead to read the conversation.</Empty>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
