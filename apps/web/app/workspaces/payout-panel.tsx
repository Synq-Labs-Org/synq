'use client';

import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import {
  FinanceViewSchema,
  PayoutViewSchema,
  payoutIntent,
  payoutMandate,
} from '@synq/workspaces/finance-contracts';
import {
  intentApprovalTypedData,
  mandateTypedData,
} from '@synq/kernel/arc-payment-data';
import { SafeActionViewSchema } from '@synq/kernel/arc-safe-action';
import { api, describeError } from '../../lib/api';

type Payout = z.output<typeof PayoutViewSchema>;
const List = z.strictObject({ payouts: z.array(PayoutViewSchema) });
export function PayoutPanel({
  workspaceId,
  vault,
  owner,
}: {
  workspaceId: string;
  vault: string;
  owner: boolean;
}) {
  const [vendors, setVendors] = useState<
      z.output<typeof FinanceViewSchema>['vendors']
    >([]),
    [items, setItems] = useState<Payout[]>([]),
    [review, setReview] = useState<Payout | null>(null);
  const [vendor, setVendor] = useState(''),
    [amount, setAmount] = useState(''),
    [purpose, setPurpose] = useState(''),
    [obligation, setObligation] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID()),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/payouts`;
  async function refresh() {
    setItems((await api.get(base, List)).payouts);
  }
  useEffect(() => {
    let active = true;
    let deepLinkSelected = false;
    const poll = async () => {
      try {
        const [f, p] = await Promise.all([
          api.get(`/v2/workspaces/${workspaceId}/finance`, FinanceViewSchema),
          api.get(base, List),
        ]);
        if (active) {
          setVendors(f.vendors);
          setItems(p.payouts);
          const requested = new URLSearchParams(window.location.search).get(
            'payout',
          );
          if (!deepLinkSelected && requested) {
            const selected = p.payouts.find((v) => v.data.id === requested);
            if (selected) {
              setReview(selected);
              setChecked(false);
              deepLinkSelected = true;
            }
          }
          setReview((current) =>
            current
              ? (p.payouts.find((v) => v.data.id === current.data.id) ??
                current)
              : current,
          );
        }
      } catch (e) {
        if (active) setError(describeError(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, base]);
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
  async function propose() {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))
      throw new Error('Use an exact USDC amount with at most six decimals.');
    const result = await api.post(base, PayoutViewSchema, {
      vendorId: vendor,
      amount: String(parseUnits(amount, 6)),
      purpose,
      obligation,
      idempotencyKey: key,
    });
    setReview(result);
    setChecked(false);
    setKey(crypto.randomUUID());
    await refresh();
  }
  async function sign() {
    if (!review || !checked) return;
    const latest = await api.get(`${base}/${review.data.id}`, PayoutViewSchema),
      p = latest.data;
    if (
      p.workspaceId !== workspaceId ||
      getAddress(p.vault) !== getAddress(vault) ||
      p.approval.deadline <= Date.now() / 1000 ||
      JSON.stringify(p) !== JSON.stringify(review.data)
    )
      throw new Error('Payout changed or expired. Reload and review it again.');
    const provider = (
      window as unknown as {
        ethereum?: {
          request(i: { method: string; params?: unknown[] }): Promise<unknown>;
        };
      }
    ).ethereum;
    if (!provider) throw new Error('Connect a current Safe owner wallet.');
    const accounts = z
        .array(z.string())
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' })),
      wallet = getAddress(accounts[0]!);
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${(5042002).toString(16)}` }],
    });
    const signData = async (data: unknown) =>
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .parse(
          await provider.request({
            method: 'eth_signTypedData_v4',
            params: [
              wallet,
              JSON.stringify(data, (_k, v: unknown) =>
                typeof v === 'bigint' ? String(v) : v,
              ),
            ],
          }),
        );
    const mandateSignature =
      wallet === p.primaryOwner && !latest.mandateSigned
        ? await signData(mandateTypedData(payoutMandate(p)))
        : undefined;
    const signature = await signData(
      intentApprovalTypedData(payoutIntent(p), p.approval),
    );
    setReview(
      await api.post(`${base}/${p.id}/approve`, PayoutViewSchema, {
        signature,
        ...(mandateSignature ? { mandateSignature } : {}),
      }),
    );
    setChecked(false);
    await refresh();
  }
  return (
    <section>
      <h2>Workspace payouts</h2>
      <p>
        Arc testnet USDC. Requests remain proposals until the current Safe
        quorum signs. The Kernel, screening, budget and on-chain policy must all
        allow execution.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working…</p>}
      <label>
        Verified vendor
        <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
          <option value="">Select a vendor</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id} disabled={v.status !== 'VERIFIED'}>
              {v.name} · {v.status}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount in USDC
        <input
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Purpose
        <input
          value={purpose}
          maxLength={160}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </label>
      <label>
        Unique invoice or obligation reference
        <input
          value={obligation}
          maxLength={120}
          onChange={(e) => setObligation(e.target.value)}
        />
      </label>
      <button
        disabled={
          busy || !vendor || !amount || !purpose.trim() || !obligation.trim()
        }
        onClick={() => void run(propose)}
      >
        Create payout proposal
      </button>
      {items.length === 0 && <p>No payout requests.</p>}
      {items.map((p) => (
        <button
          key={p.data.id}
          disabled={busy}
          onClick={() => {
            setReview(p);
            setChecked(false);
          }}
        >
          {formatUnits(BigInt(p.data.amount), 6)} USDC · {p.data.purpose} ·{' '}
          {p.state}
        </button>
      ))}
      {review && (
        <section>
          <h3>Review payment</h3>
          <p>
            {formatUnits(BigInt(review.data.amount), 6)} USDC to{' '}
            {review.data.recipient}
          </p>
          <p>
            Vault {review.data.vault} · obligation {review.data.obligation} ·{' '}
            {review.data.purpose}
          </p>
          <p>
            Mandate owner {review.data.primaryOwner}. This wallet signs the
            bounded mandate and this payment approval. Other owners sign this
            payment approval.
          </p>
          <p>
            {review.signedBy.length} signatures · {review.state}
            {review.reason ? ` · ${review.reason}` : ''}
          </p>
          {review.txHash && (
            <a
              href={`https://explorer.testnet.arc.io/tx/${review.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          )}
          {owner && ['REVIEW', 'READY', 'HOLD'].includes(review.state) && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setReview(
                    await api.post(
                      `${base}/${review.data.id}/cancel`,
                      PayoutViewSchema,
                      {},
                    ),
                  );
                  await refresh();
                })
              }
            >
              Cancel before signing by the worker
            </button>
          )}
          {owner &&
            review.state === 'REVIEW' &&
            review.data.route === 'SAFE_QUORUM' && (
              <>
                <p>
                  This amount is above the signed per-payment budget, so the
                  operator cannot pay it. Every Safe owner signs one direct
                  vault transfer for exactly these terms; it is screened and
                  reserve-checked before anything is broadcast. The prepared
                  transfer appears under vault governance for 15 minutes.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.post(
                        `/v2/workspaces/${encodeURIComponent(workspaceId)}/vault/actions`,
                        SafeActionViewSchema,
                        { kind: 'PAY_VENDOR', payoutId: review.data.id },
                      );
                      await refresh();
                    })
                  }
                >
                  Prepare vault transfer for owner signatures
                </button>
              </>
            )}
          {owner &&
            review.state === 'REVIEW' &&
            review.data.route !== 'SAFE_QUORUM' && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  I reviewed the exact amount, destination and obligation.
                </label>
                <button
                  disabled={busy || !checked}
                  onClick={() => void run(sign)}
                >
                  Sign payment approval
                </button>
              </>
            )}
        </section>
      )}
    </section>
  );
}
