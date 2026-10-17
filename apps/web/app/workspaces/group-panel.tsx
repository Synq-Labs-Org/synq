'use client';

import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import { api, describeError } from '../../lib/api';

const View = z
  .object({
    contributions: z.array(
      z.object({
        id: z.string(),
        mine: z.boolean(),
        member: z.string(),
        amount: z.string(),
        state: z.string(),
        note: z.string(),
      }),
    ),
    balances: z.array(
      z.object({ member: z.string(), mine: z.boolean(), amount: z.string() }),
    ),
    refunds: z.array(
      z.object({
        id: z.string(),
        mine: z.boolean(),
        recipient: z.string(),
        amount: z.string(),
        state: z.string(),
        actionId: z.string().nullable(),
        txHash: z.string().nullable(),
      }),
    ),
  })
  .passthrough();
const Payment = z
  .object({
    id: z.string(),
    amount: z.string(),
    transaction: z.object({ to: z.string(), data: z.string() }),
  })
  .passthrough();
type Provider = {
  request(i: { method: string; params?: unknown[] }): Promise<unknown>;
};

/**
 * Group fund: members contribute from their own wallets (a Memo payment with
 * a one-time reference, credited only to the paying wallet), see everyone's
 * share, and owners wind the fund down with per-member refunds that the Safe
 * quorum signs under vault governance.
 */
export function GroupPanel({
  workspaceId,
  owner,
}: {
  workspaceId: string;
  owner: boolean;
}) {
  const [view, setView] = useState<z.output<typeof View> | null>(null),
    [amount, setAmount] = useState(''),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/contributions`;
  async function refresh() {
    setView(await api.get(base, View));
  }
  useEffect(() => {
    let active = true;
    void api
      .get(base, View)
      .then((v) => {
        if (active) setView(v);
      })
      .catch((e: unknown) => {
        if (active) setError(describeError(e));
      });
    return () => {
      active = false;
    };
  }, [base]);
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(label);
    try {
      await fn();
      await refresh();
      setStatus(null);
    } catch (e) {
      setError(describeError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }
  async function contribute() {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))
      throw new Error('Use an exact USDC amount with at most six decimals.');
    const p = (window as unknown as { ethereum?: Provider }).ethereum;
    if (!p)
      throw new Error('Connect the wallet you joined this workspace with.');
    const from = getAddress(
      z
        .array(z.string())
        .min(1)
        .parse(await p.request({ method: 'eth_requestAccounts' }))[0]!,
    );
    await p.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${(5042002).toString(16)}` }],
    });
    const req = await api.post(base, Payment, {
      amount: String(parseUnits(amount, 6)),
      note,
    });
    setStatus('Confirm the contribution in your wallet…');
    await p.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: req.transaction.to,
          data: req.transaction.data,
          value: '0x0',
        },
      ],
    });
    setAmount('');
    setNote('');
    setStatus(
      'Sent. It is credited to you once the payment is final on Arc and matches this request.',
    );
  }
  return (
    <section>
      <h2>Group fund</h2>
      <p>
        Members put in USDC from their own wallets. Each contribution counts
        only for the wallet that paid it. Spending and refunds need the Safe
        owner quorum. Arc testnet only.
      </p>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <label>
        Amount in USDC
        <input
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Note (optional)
        <input
          value={note}
          maxLength={120}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !amount}
        onClick={() => void run('Preparing contribution…', contribute)}
      >
        Contribute from my wallet
      </button>
      <h3>Shares</h3>
      {!view?.balances.length && <p>No contributions credited yet.</p>}
      {view?.balances.map((b, i) => (
        <p key={i}>
          {b.mine ? 'You' : b.member} · {formatUnits(BigInt(b.amount), 6)} USDC
        </p>
      ))}
      <h3>Contributions</h3>
      {view?.contributions.map((c) => (
        <p key={c.id}>
          {c.mine ? 'You' : c.member} · {formatUnits(BigInt(c.amount), 6)} USDC
          · {c.state}
          {c.note ? ` · ${c.note}` : ''}
        </p>
      ))}
      {owner && (
        <>
          <h3>Wind down and refund</h3>
          <p>
            Each member gets back their share, scaled down if the vault holds
            less after bills and money owed to others. Every refund is its own
            vault transfer the owners sign under vault governance.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void run('Planning refunds…', async () => {
                await api.post(`${base}/refunds`, z.unknown(), {});
              })
            }
          >
            Plan refunds
          </button>
        </>
      )}
      {view?.refunds.map((r) => (
        <p key={r.id}>
          {r.mine ? 'You' : r.recipient} · {formatUnits(BigInt(r.amount), 6)}{' '}
          USDC · {r.state}
          {owner && r.state === 'REVIEW' && (
            <button
              disabled={busy}
              onClick={() =>
                void run('Preparing the refund for signatures…', async () => {
                  await api.post(
                    `${base}/refunds/${r.id}/prepare`,
                    z.unknown(),
                    {},
                  );
                })
              }
            >
              Prepare for owner signatures
            </button>
          )}
        </p>
      ))}
    </section>
  );
}
