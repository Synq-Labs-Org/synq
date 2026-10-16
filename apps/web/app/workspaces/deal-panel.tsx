'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { formatUnits } from 'viem';
import {
  WorkspaceDealContactSchema,
  WorkspaceDealViewSchema,
} from '@synq/workspaces/deal-contracts';
import { api, describeError } from '../../lib/api';
const Contacts = z.strictObject({
  contacts: z.array(WorkspaceDealContactSchema),
});
const Deals = z.strictObject({ deals: z.array(WorkspaceDealViewSchema) });
export function DealPanel({
  workspaceId,
  principalId,
}: {
  workspaceId: string;
  principalId: string;
}) {
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}`;
  const [contacts, setContacts] = useState<
      z.output<typeof Contacts>['contacts']
    >([]),
    [deals, setDeals] = useState<z.output<typeof Deals>['deals']>([]);
  const [role, setRole] = useState<'CLIENT' | 'FREELANCER'>('CLIENT'),
    [counterparty, setCounterparty] = useState(''),
    [arbiter, setArbiter] = useState(''),
    [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([
      api.get(`${base}/deal-contacts`, Contacts),
      api.get(`${base}/deals`, Deals),
    ])
      .then(([c, d]) => {
        if (active) {
          setContacts(c.contacts);
          setDeals(d.deals);
        }
      })
      .catch((e) => {
        if (active) setError(describeError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base]);
  const eligible = contacts.filter(
    (c) => c.role !== 'VIEWER' && c.principalId !== principalId,
  );
  return (
    <section>
      <h2>Deals with workspace members</h2>
      <p>
        Select the contracting users and an independent arbiter. Each user
        reviews and signs in their own wallet. Synq dispute desk is unavailable.
        Escrow execution is still being connected.
      </p>
      {loading && <p role="status">Loading linked members and deals…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const d = await api.post(
                `${base}/deals`,
                WorkspaceDealViewSchema,
                {
                  clientId: role === 'CLIENT' ? principalId : counterparty,
                  freelancerId:
                    role === 'FREELANCER' ? principalId : counterparty,
                  arbiterId: arbiter,
                  request,
                  idempotencyKey: requestKey,
                },
              );
              setDeals((current) => [
                d,
                ...current.filter((v) => v.id !== d.id),
              ]);
              setRequest('');
              setRequestKey(crypto.randomUUID());
            } catch (e) {
              setError(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy || eligible.length < 2}>
            <label>
              My role
              <select
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as 'CLIENT' | 'FREELANCER')
                }
              >
                <option value="CLIENT">Client</option>
                <option value="FREELANCER">Freelancer</option>
              </select>
            </label>
            <label>
              Other contracting member
              <select
                required
                value={counterparty}
                onChange={(e) => {
                  setCounterparty(e.target.value);
                  if (arbiter === e.target.value) setArbiter('');
                }}
              >
                <option value="">Choose a linked member</option>
                {eligible.map((c) => (
                  <option key={c.principalId} value={c.principalId}>
                    {c.walletHint} · {c.role}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Independent arbiter
              <select
                required
                value={arbiter}
                onChange={(e) => setArbiter(e.target.value)}
              >
                <option value="">Choose a third linked member</option>
                {eligible
                  .filter((c) => c.principalId !== counterparty)
                  .map((c) => (
                    <option key={c.principalId} value={c.principalId}>
                      {c.walletHint} · {c.role}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Scope, total USDC, milestone payments and deadlines
              <textarea
                required
                minLength={10}
                maxLength={4000}
                value={request}
                onChange={(e) => setRequest(e.target.value)}
              />
            </label>
            <button type="submit">Draft deal for wallet review</button>
          </fieldset>
          {eligible.length < 2 && (
            <p>
              Invite at least two additional members for a counterparty and
              independent arbiter.
            </p>
          )}
        </form>
      )}
      {!loading && !deals.length && (
        <p>No deals involving your wallet in this workspace.</p>
      )}
      {deals.map((d) => (
        <article key={d.id}>
          <h3>{d.title}</h3>
          <p>
            {formatUnits(BigInt(d.total), 6)} USDC · {d.status} · version{' '}
            {d.version}
          </p>
          {d.parties.map((p) => (
            <p key={p.role}>
              {p.role}: {p.wallet}
            </p>
          ))}
          <a href={d.reviewPath}>Review terms and sign in your wallet</a>
        </article>
      ))}
    </section>
  );
}
