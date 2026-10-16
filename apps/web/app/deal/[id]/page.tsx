'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { typedDataMismatches } from '../../../lib/deal-approval';
import { api, describeError } from '../../../lib/api';

/**
 * Deal Room review page. Shows the exact version (every term with where it
 * came from) and lets a party sign it in their own wallet (EIP-712
 * eth_signTypedData_v4). The page never holds a key; a chat reply never signs.
 */

const Provenance = z.looseObject({
  kind: z.string(),
  messageId: z.string().optional(),
  quote: z.string().optional(),
  role: z.string().optional(),
  how: z.string().optional(),
  model: z.string().optional(),
  mode: z.string().optional(),
});
const DealSchema = z.looseObject({
  dealId: z.string(),
  status: z.string(),
  version: z.number(),
  termsHash: z.string(),
  parentTermsHash: z.string().nullable(),
  provenanceHash: z.string(),
  terms: z.looseObject({
    title: z.string(),
    scope: z.string(),
    deliverables: z.array(z.string()),
    asset: z.looseObject({
      symbol: z.string(),
      token: z.string(),
      chainId: z.number(),
      decimals: z.number(),
    }),
    escrow: z.string(),
    total: z.string(),
    deposit: z.string(),
    refundAfter: z.number(),
    expiresAt: z.number(),
    disputePeriodSeconds: z.number(),
    refundPolicy: z.string(),
    cancellation: z.string(),
    parties: z.array(
      z.looseObject({
        role: z.string(),
        principalId: z.string(),
        name: z.string(),
        wallet: z.string(),
        verifiedBy: z.string(),
      }),
    ),
    milestones: z.array(
      z.looseObject({
        index: z.number(),
        title: z.string(),
        amount: z.string(),
        deadline: z.number(),
        acceptanceCondition: z.string(),
        evidenceType: z.string(),
        payee: z.string(),
        status: z.string(),
      }),
    ),
  }),
  ambiguities: z.array(z.string()),
  provenance: z.record(z.string(), z.array(Provenance)),
  signatures: z.array(
    z.looseObject({
      version: z.number(),
      role: z.string(),
      signer: z.string(),
      decision: z.string(),
    }),
  ),
  signedCurrent: z.looseObject({
    CLIENT: z.boolean(),
    FREELANCER: z.boolean(),
  }),
  chain: z.looseObject({
    chainId: z.number(),
    name: z.string(),
    rpcUrl: z.string(),
    explorer: z.string(),
  }),
  acceptTypedData: z.looseObject({}),
  decision: z.looseObject({
    domain: z.looseObject({}),
    types: z.looseObject({}),
    primaryType: z.string(),
  }),
});
export type Deal = z.output<typeof DealSchema>;

type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
const injected = () =>
  (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const KIND_LABEL: Record<string, string> = {
  ORIGINAL_MESSAGE: 'quoted from chat',
  AI_INTERPRETATION: 'read by Synq',
  HUMAN_CONFIRMED: 'confirmed by a party',
  EXECUTABLE_AUTHORIZATION: 'authorized',
};

function Sources({
  list,
}: {
  list: z.output<typeof Provenance>[] | undefined;
}) {
  if (!list?.length) return <small> (from verified records)</small>;
  return (
    <small>
      {' '}
      (
      {list
        .map((p) =>
          p.kind === 'ORIGINAL_MESSAGE'
            ? `“${p.quote}” #${p.messageId}`
            : p.kind === 'HUMAN_CONFIRMED'
              ? `${p.how === 'PROPOSED' ? 'proposed' : 'signed'} by ${p.role?.toLowerCase()}`
              : (KIND_LABEL[p.kind] ?? p.kind),
        )
        .join('; ')}
      )
    </small>
  );
}

export default function DealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [token, setToken] = useState<string | null>(null);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('t'));
  }, []);
  const load = useCallback(() => {
    if (!token) return;
    api
      .get(`/v1/deals/${id}?t=${encodeURIComponent(token)}`, DealSchema)
      .then(setDeal)
      .catch((e) => setError(describeError(e)));
  }, [id, token]);
  useEffect(load, [load]);

  const wallet = async () => {
    const w = injected();
    if (!w)
      throw new Error(
        'No browser wallet found. Open this link in a wallet browser.',
      );
    const [from] = (await w.request({
      method: 'eth_requestAccounts',
    })) as string[];
    const party = deal?.terms.parties.find(
      (p) => p.wallet.toLowerCase() === from?.toLowerCase(),
    );
    if (!party || party.role === 'ARBITER')
      throw new Error('This wallet is not a contracting party of this deal.');
    return { w, from: from!, role: party.role as 'CLIENT' | 'FREELANCER' };
  };

  const sign = async () => {
    if (!deal || !token) return;
    setError(null);
    setBusy(true);
    try {
      const bad = typedDataMismatches(deal);
      if (bad.length)
        throw new Error(
          `The message to sign differs from what this page shows (${bad.join(', ')}). Nothing was signed.`,
        );
      const { w, from, role } = await wallet();
      const signature = (await w.request({
        method: 'eth_signTypedData_v4',
        params: [from, JSON.stringify(deal.acceptTypedData)],
      })) as string;
      setDeal(
        await api.post(
          `/v1/deals/${id}/sign?t=${encodeURIComponent(token)}`,
          DealSchema,
          {
            version: deal.version,
            role,
            signature,
          },
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!deal || !token) return;
    const reason = window.prompt('Why are you rejecting this version?') ?? '';
    setError(null);
    setBusy(true);
    try {
      const { w, from, role } = await wallet();
      const typed = {
        ...deal.decision,
        message: {
          dealId: deal.dealId,
          version: String(deal.version),
          termsHash: deal.termsHash,
          role,
          decision: 'REJECT',
          reason,
        },
      };
      const signature = (await w.request({
        method: 'eth_signTypedData_v4',
        params: [from, JSON.stringify(typed)],
      })) as string;
      setDeal(
        await api.post(
          `/v1/deals/${id}/decline?t=${encodeURIComponent(token)}`,
          DealSchema,
          {
            version: deal.version,
            role,
            decision: 'REJECT',
            reason,
            signature,
          },
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !deal)
    return (
      <main>
        <h1>Deal</h1>
        <p className="status bad">{error}</p>
      </main>
    );
  if (!deal)
    return (
      <main>
        <p className="lead">
          {token === null ? 'Missing deal link.' : 'Loading deal…'}
        </p>
      </main>
    );
  const t = deal.terms;
  const sym = t.asset.symbol;
  const p = deal.provenance;
  const open = ['DRAFT', 'NEGOTIATING'].includes(deal.status);
  return (
    <main>
      <h1>{t.title}</h1>
      <p className="lead">
        Version {deal.version} · {deal.status.toLowerCase()} · testnet {sym} on{' '}
        {deal.chain.name}; no real money. Signing accepts exactly this version;
        any change needs both signatures again.
      </p>
      <dl className="preview">
        <dt>Scope</dt>
        <dd>
          {t.scope}
          <Sources list={p.scope} />
        </dd>
        <dt>Deliverables</dt>
        <dd>{t.deliverables.join(', ')}</dd>
        {t.parties.map((party) => (
          <div key={party.role} style={{ display: 'contents' }}>
            <dt>{party.role.toLowerCase()}</dt>
            <dd>
              {party.name} <code>{party.wallet}</code>{' '}
              <small>({party.verifiedBy})</small>
            </dd>
          </div>
        ))}
        <dt>Total in escrow</dt>
        <dd>
          <strong>
            {t.total} {sym}
          </strong>
          <Sources list={p.total} />
        </dd>
        {t.milestones.map((m) => (
          <div key={m.index} style={{ display: 'contents' }}>
            <dt>
              Milestone {m.index + 1}: {m.title}
            </dt>
            <dd>
              {m.amount} {sym} to <code>{m.payee}</code>
              <Sources list={p[`milestones.${m.index}.amount`]} /> · due{' '}
              {day(m.deadline)}
              <Sources list={p[`milestones.${m.index}.deadline`]} /> ·{' '}
              {m.acceptanceCondition} ({m.evidenceType}) ·{' '}
              <em>{m.status.toLowerCase()}</em>
            </dd>
          </div>
        ))}
        <dt>Asset</dt>
        <dd>
          {sym} <code>{t.asset.token}</code> on chain {deal.chain.chainId}
        </dd>
        <dt>Escrow contract</dt>
        <dd>
          <code>{t.escrow}</code>
        </dd>
        <dt>Disputes</dt>
        <dd>
          The arbiter decides; a dispute freezes the client's release for{' '}
          {Math.round(t.disputePeriodSeconds / 86_400)} days. On chain the
          arbiter can also release or refund any unreleased milestone at any
          time, so you are trusting the arbiter named above.
        </dd>
        <dt>Refunds</dt>
        <dd>
          Unreleased milestones go back only to the client who funded them;
          anyone may trigger that after {day(t.refundAfter)}.
        </dd>
        <dt>Offer expires</dt>
        <dd>{day(t.expiresAt)}</dd>
        <dt>Terms hash</dt>
        <dd>
          <code>{deal.termsHash}</code>
        </dd>
        <dt>Signed</dt>
        <dd>
          client {deal.signedCurrent.CLIENT ? 'yes' : 'not yet'} · freelancer{' '}
          {deal.signedCurrent.FREELANCER ? 'yes' : 'not yet'}
        </dd>
      </dl>
      {deal.ambiguities.length ? (
        <p className="status">
          Check before signing: {deal.ambiguities.join(' ')}
        </p>
      ) : null}
      {open ? (
        <p>
          <button onClick={sign} disabled={busy}>
            {busy
              ? 'Confirm in your wallet…'
              : 'Sign this version in my wallet'}
          </button>{' '}
          <button onClick={reject} disabled={busy}>
            Reject this version
          </button>
        </p>
      ) : null}
      {error ? <p className="status bad">{error}</p> : null}
    </main>
  );
}
