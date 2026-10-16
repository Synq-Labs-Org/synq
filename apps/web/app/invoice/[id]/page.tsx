'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, describeError } from '../../../lib/api';
import { issueMismatches } from '../../../lib/invoice-issue';

/**
 * Issue an invoice drafted in chat. The issuer reads the exact terms and signs
 * them in their own wallet (EIP-712 eth_signTypedData_v4); the server recovers
 * the signature and refuses any other wallet. Only an issued invoice has a
 * checkout link. The page never holds a key.
 */

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const IssueSchema = z.looseObject({
  invoiceId: z.string(),
  number: z.string(),
  version: z.number(),
  status: z.string(),
  issuer: z.string(),
  issuerWallet: Hex,
  payTo: Hex,
  payer: z.string(),
  dueDate: z.string(),
  lineItems: z.array(
    z.looseObject({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.string(),
    }),
  ),
  asset: z.looseObject({
    symbol: z.string(),
    address: Hex,
    decimals: z.number(),
  }),
  total: z.string(),
  chain: z.looseObject({
    chainId: z.number(),
    name: z.string(),
    rpcUrl: z.string(),
    explorer: z.string(),
  }),
  issueTypedData: z
    .looseObject({
      domain: z.looseObject({ chainId: z.number() }),
      message: z.looseObject({
        invoiceId: z.string(),
        number: z.string(),
        payoutAddress: Hex,
        token: Hex,
        total: z.string(),
        dueDate: z.string(),
      }),
    })
    .nullable(),
  payPath: z.string().nullable(),
});
type Issue = z.output<typeof IssueSchema>;

type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
const injected = () =>
  (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;

export default function IssueInvoice({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<Issue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('t'));
  }, []);
  const load = useCallback(() => {
    if (!token) return;
    api
      .get(
        `/v1/invoices/${id}/issue?t=${encodeURIComponent(token)}`,
        IssueSchema,
      )
      .then(setView)
      .catch((e) => setError(describeError(e)));
  }, [id, token]);
  useEffect(load, [load]);

  const issue = async () => {
    if (!view || !token || !view.issueTypedData) return;
    setError(null);
    setBusy(true);
    try {
      const bad = issueMismatches(view);
      if (bad.length)
        throw new Error(
          `The message to sign differs from what this page shows (${bad.join(', ')}). Nothing was signed.`,
        );
      const w = injected();
      if (!w)
        throw new Error(
          'No browser wallet found. Open this link in a wallet browser.',
        );
      const [from] = (await w.request({
        method: 'eth_requestAccounts',
      })) as string[];
      if (from?.toLowerCase() !== view.issuerWallet.toLowerCase())
        throw new Error(
          `Only the issuer wallet ${view.issuerWallet} can issue this invoice.`,
        );
      const signature = (await w.request({
        method: 'eth_signTypedData_v4',
        params: [from, JSON.stringify(view.issueTypedData)],
      })) as string;
      setView(
        await api.post(
          `/v1/invoices/${id}/issue?t=${encodeURIComponent(token)}`,
          IssueSchema,
          { signature },
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !view)
    return (
      <main>
        <h1>Invoice</h1>
        <p className="status bad">{error}</p>
      </main>
    );
  if (!view)
    return (
      <main>
        <p className="lead">{token ? 'Loading invoice…' : 'Missing link.'}</p>
      </main>
    );
  const sym = view.asset.symbol;
  const payUrl = view.payPath
    ? `${window.location.origin}${view.payPath}`
    : null;
  return (
    <main>
      <h1>
        {view.issuer}: invoice {view.number}
      </h1>
      <p className="lead">
        For {view.payer}. Due {view.dueDate}. Testnet {sym} on {view.chain.name}
        ; no real money.
      </p>
      <dl className="preview">
        {view.lineItems.map((l, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <dt>
              {l.description} × {l.quantity}
            </dt>
            <dd>
              {l.unitPrice} {sym}
            </dd>
          </div>
        ))}
        <dt>Total</dt>
        <dd>
          <strong>
            {view.total} {sym}
          </strong>
        </dd>
        <dt>Pays to</dt>
        <dd>
          <code>{view.payTo}</code>
        </dd>
        <dt>Issuer wallet</dt>
        <dd>
          <code>{view.issuerWallet}</code>
        </dd>
        <dt>Status</dt>
        <dd>{view.status}</dd>
      </dl>
      {view.status === 'DRAFT' ? (
        <button onClick={issue} disabled={busy}>
          {busy ? 'Confirm in your wallet…' : 'Sign and issue in your wallet'}
        </button>
      ) : null}
      {payUrl ? (
        <p className="status ok">
          Issued. Checkout link: <a href={payUrl}>{payUrl}</a>
        </p>
      ) : null}
      {error ? <p className="status bad">{error}</p> : null}
    </main>
  );
}
