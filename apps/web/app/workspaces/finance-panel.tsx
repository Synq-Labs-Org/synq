'use client';

import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import {
  FinanceViewSchema,
  FinanceChangeViewSchema,
  financeChangeTypedData,
  financeChangeHash,
  describeFinanceEdit,
} from '@synq/workspaces/finance-contracts';
import { api, describeError } from '../../lib/api';

type View = z.output<typeof FinanceViewSchema>;
type Change = z.output<typeof FinanceChangeViewSchema>;
export function FinancePanel({
  workspaceId,
  vault,
  owner,
}: {
  workspaceId: string;
  vault: string;
  owner: boolean;
}) {
  const [view, setView] = useState<View | null>(null),
    [change, setChange] = useState<Change | null>(null);
  const [name, setName] = useState(''),
    [address, setAddress] = useState(''),
    [vendorId, setVendorId] = useState('');
  const [payment, setPayment] = useState(''),
    [daily, setDaily] = useState(''),
    [reserve, setReserve] = useState(''),
    [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reviewed, setReviewed] = useState(false);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/finance`;
  async function refresh() {
    setView(await api.get(base, FinanceViewSchema));
  }
  useEffect(() => {
    let active = true;
    void api
      .get(base, FinanceViewSchema)
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
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  function units(v: string) {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(v))
      throw new Error('Use exact USDC amounts with at most six decimals.');
    return String(parseUnits(v, 6));
  }
  async function propose(edit: unknown) {
    const c = await api.post(`${base}/changes`, FinanceChangeViewSchema, edit);
    setChange(c);
    setReviewed(false);
    await refresh();
  }
  async function sign() {
    if (!change || !reviewed) return;
    const c = change.change;
    if (
      c.workspaceId !== workspaceId ||
      getAddress(c.vault) !== getAddress(vault) ||
      financeChangeHash(c) !== change.hash ||
      c.expiresAt <= Date.now() / 1000
    )
      throw new Error('The change is stale or belongs to another vault.');
    const provider = (
      window as unknown as {
        ethereum?: {
          request(i: { method: string; params?: unknown[] }): Promise<unknown>;
        };
      }
    ).ethereum;
    if (!provider) throw new Error('Connect an owner wallet.');
    const accounts = z
      .array(z.string())
      .min(1)
      .parse(await provider.request({ method: 'eth_requestAccounts' }));
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${c.chainId.toString(16)}` }],
    });
    const typed = financeChangeTypedData(c);
    const signature = z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .parse(
        await provider.request({
          method: 'eth_signTypedData_v4',
          params: [
            getAddress(accounts[0]!),
            JSON.stringify(typed, (_k, v: unknown) =>
              typeof v === 'bigint' ? String(v) : v,
            ),
          ],
        }),
      );
    setChange(
      await api.post(
        `${base}/changes/${change.hash}/approve`,
        FinanceChangeViewSchema,
        { signature },
      ),
    );
    setReviewed(false);
    await refresh();
  }
  return (
    <section>
      <h2>Vendors and signed budgets</h2>
      <p>
        Arc testnet USDC. Every edit requires the current Safe owner quorum. A
        verified vendor still needs the on-chain allowlist before payouts.
        Changed addresses wait at least 24 hours.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Saving…</p>}
      {!view && !error && <p role="status">Loading finance settings…</p>}
      {view && (
        <>
          <ul>
            {view.vendors.map((v) => (
              <li key={v.id}>
                {v.name} · {v.address} · {v.status}
                {v.status === 'COOLING'
                  ? ` until ${new Date(v.eligibleAt * 1000).toISOString()}`
                  : ''}
                {owner && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setVendorId(v.id);
                      setName(v.name);
                      setAddress(v.address);
                    }}
                  >
                    Edit vendor
                  </button>
                )}
              </li>
            ))}
          </ul>
          {view.vendors.length === 0 && <p>No verified vendors yet.</p>}
          {view.budget ? (
            <p>
              Per payment {formatUnits(BigInt(view.budget.perPayment), 6)} USDC
              · daily {formatUnits(BigInt(view.budget.daily), 6)} USDC · reserve{' '}
              {formatUnits(BigInt(view.budget.reserve), 6)} USDC · AI daily{' '}
              {formatUnits(BigInt(view.budget.aiDaily), 6)} USDC.
            </p>
          ) : (
            <p>No signed budget. Payouts remain blocked.</p>
          )}
          {owner && (
            <>
              <label>
                Vendor name
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Verified payout wallet
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
              <p>
                Signing attests that you independently verified this vendor and
                address.
              </p>
              <button
                disabled={busy || !name.trim() || !address}
                onClick={() =>
                  void run(() =>
                    propose({
                      kind: 'VENDOR',
                      vendorId: vendorId || crypto.randomUUID(),
                      name,
                      address,
                      verification: 'OWNER_ATTESTATION',
                    }),
                  )
                }
              >
                Review vendor attestation
              </button>
              {vendorId && (
                <button
                  onClick={() => {
                    setVendorId('');
                    setName('');
                    setAddress('');
                  }}
                >
                  Add another vendor
                </button>
              )}
              <label>
                Per-payment USDC limit
                <input
                  value={payment}
                  inputMode="decimal"
                  onChange={(e) => setPayment(e.target.value)}
                />
              </label>
              <label>
                Daily USDC budget
                <input
                  value={daily}
                  inputMode="decimal"
                  onChange={(e) => setDaily(e.target.value)}
                />
              </label>
              <label>
                Minimum USDC reserve
                <input
                  value={reserve}
                  inputMode="decimal"
                  onChange={(e) => setReserve(e.target.value)}
                />
              </label>
              <label>
                AI daily USDC limit
                <input
                  value={ai}
                  inputMode="decimal"
                  onChange={(e) => setAi(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !payment || !daily || !reserve || !ai}
                onClick={() =>
                  void run(() =>
                    propose({
                      kind: 'BUDGET',
                      perPayment: units(payment),
                      daily: units(daily),
                      reserve: units(reserve),
                      aiDaily: units(ai),
                    }),
                  )
                }
              >
                Review budget policy
              </button>
              {view.budget && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      propose({
                        kind: 'REVOKE_BUDGET',
                        reason:
                          'Owner quorum revoked the workspace payout budget.',
                      }),
                    )
                  }
                >
                  Review budget revocation
                </button>
              )}
              <p>
                Revocation blocks payments the worker has not signed. Signed
                transactions must still be reconciled.
              </p>
              <h3>Pending edits</h3>
              {view.pending.map((c) => (
                <button
                  key={c.hash}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setChange(
                        await api.get(
                          `${base}/changes/${c.hash}`,
                          FinanceChangeViewSchema,
                        ),
                      );
                      setReviewed(false);
                    })
                  }
                >
                  {c.change.edit.kind} · revision {c.change.revision}
                </button>
              ))}
            </>
          )}
        </>
      )}
      {change && (
        <section>
          <h3>Review exact change</h3>
          <p>
            Vault {change.change.vault} · revision {change.change.revision} ·
            expires {new Date(change.change.expiresAt * 1000).toISOString()}
          </p>
          <p>{describeFinanceEdit(change.change.edit)}</p>
          <p>
            {change.signedBy.length} owner signatures · {change.state}
          </p>
          {owner && change.state === 'PENDING' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed every term of this change.
              </label>
              <button
                disabled={busy || !reviewed}
                onClick={() => void run(sign)}
              >
                Sign this finance change
              </button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
