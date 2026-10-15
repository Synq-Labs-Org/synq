'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, describeError } from '../../../lib/api';

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const CheckoutSchema = z.looseObject({
  number: z.string(),
  status: z.string(),
  issuer: z.string(),
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
  asset: z.looseObject({ symbol: z.string() }),
  total: z.string(),
  paid: z.string(),
  amountDue: z.string(),
  paymentRef: Hex.nullable(),
  chain: z.looseObject({
    chainId: z.number(),
    name: z.string(),
    rpcUrl: z.string(),
    explorer: z.string(),
    nativeSymbol: z.string(),
  }),
  call: z.looseObject({ to: Hex, data: Hex, value: Hex }).nullable(),
});
type Checkout = z.output<typeof CheckoutSchema>;
const VerifySchema = z.looseObject({
  state: z.string(),
  invoice: CheckoutSchema.optional(),
});

type Eip1193 = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};
const injected = () =>
  (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;

async function switchToArc(w: Eip1193, c: Checkout['chain']) {
  const chainId = `0x${c.chainId.toString(16)}`;
  try {
    await w.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId }],
    });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await w.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'Arc Testnet',
          rpcUrls: [c.rpcUrl],
          blockExplorerUrls: [c.explorer],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        },
      ],
    });
  }
}

export default function PayInvoice({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [view, setView] = useState<Checkout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'signing' | 'confirming' | 'done'
  >('idle');

  useEffect(() => {
    api
      .get(`/v1/pay/${token}`, CheckoutSchema)
      .then(setView)
      .catch((e) => setError(describeError(e)));
  }, [token]);

  const verify = useCallback(
    async (hash: string) => {
      for (let i = 0; i < 40; i++) {
        const r = await api
          .post(`/v1/pay/${token}/verify`, VerifySchema, { txHash: hash })
          .catch(() => null);
        if (r?.invoice) setView(r.invoice);
        if (r?.state === 'VERIFIED') return setPhase('done');
        if (r?.state === 'NO_MATCHING_PAYMENT')
          return setError(
            'That transaction did not pay this invoice. Nothing was applied.',
          );
        await new Promise((res) => setTimeout(res, 3_000));
      }
      setError(
        'Still waiting for Arc to confirm. Keep this page and refresh later.',
      );
    },
    [token],
  );

  const pay = async () => {
    if (!view?.call) return;
    setError(null);
    const w = injected();
    if (!w)
      return setError(
        'No browser wallet found. Open this link in a wallet browser.',
      );
    try {
      setPhase('signing');
      const [from] = (await w.request({
        method: 'eth_requestAccounts',
      })) as string[];
      await switchToArc(w, view.chain);
      const hash = (await w.request({
        method: 'eth_sendTransaction',
        params: [
          { from, to: view.call.to, data: view.call.data, value: '0x0' },
        ],
      })) as string;
      setTx(hash);
      setPhase('confirming');
      await verify(hash);
    } catch (e) {
      setPhase('idle');
      setError(describeError(e));
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
        <p className="lead">Loading invoice…</p>
      </main>
    );
  const sym = view.asset.symbol;
  return (
    <main>
      <h1>
        {view.issuer}: invoice {view.number}
      </h1>
      <p className="lead">
        Billed to {view.payer}. Due {view.dueDate}. Testnet {sym} on{' '}
        {view.chain.name}; no real money.
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
          {view.total} {sym}
        </dd>
        <dt>Paid</dt>
        <dd>
          {view.paid} {sym}
        </dd>
        <dt>Amount due</dt>
        <dd>
          <strong>
            {view.amountDue} {sym}
          </strong>
        </dd>
        <dt>Pays to</dt>
        <dd>
          <code>{view.payTo}</code>
        </dd>
        <dt>Reference</dt>
        <dd>
          <code>{view.paymentRef}</code>
        </dd>
        <dt>Status</dt>
        <dd>{view.status}</dd>
      </dl>
      {view.call && phase !== 'done' ? (
        <button onClick={pay} disabled={phase !== 'idle'}>
          {phase === 'signing'
            ? 'Confirm in your wallet…'
            : phase === 'confirming'
              ? 'Waiting for Arc…'
              : `Pay ${view.amountDue} ${sym}`}
        </button>
      ) : null}
      {tx ? (
        <p className={`status ${phase === 'done' ? 'ok' : ''}`}>
          {phase === 'done'
            ? 'Payment verified on Arc and applied to the invoice. '
            : 'Submitted. '}
          <a href={`${view.chain.explorer}/tx/${tx}`} target="_blank">
            View transaction
          </a>
        </p>
      ) : null}
      {error ? <p className="status bad">{error}</p> : null}
    </main>
  );
}
