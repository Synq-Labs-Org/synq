'use client';
import { useEffect, useState } from 'react';
import { getAddress } from 'viem';
import { z } from 'zod';
import {
  SafeActionViewSchema,
  safeActionApprovalTypedData,
  safeActionTypedData,
} from '@synq/kernel/arc-safe-action';
import { FinanceViewSchema } from '@synq/workspaces/finance-contracts';
import { api, describeError } from '../../lib/api';
const List = z.strictObject({ actions: z.array(SafeActionViewSchema) });
type Action = z.output<typeof SafeActionViewSchema>;
export function GovernancePanel({
  workspaceId,
  vault,
  owner,
}: {
  workspaceId: string;
  vault: string;
  owner: boolean;
}) {
  const [items, setItems] = useState<Action[]>([]),
    [vendors, setVendors] = useState<
      z.output<typeof FinanceViewSchema>['vendors']
    >([]),
    [selected, setSelected] = useState<Action | null>(null),
    [vendor, setVendor] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reviewed, setReviewed] = useState(false);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/vault/actions`;
  const chosen = vendors.find((v) => v.id === vendor);
  const readyAt = Math.max(
    0,
    ...items
      .filter(
        (a) =>
          a.action.kind === 'QUEUE_VENDOR' &&
          a.state === 'CONFIRMED' &&
          a.action.vendorId === vendor &&
          a.action.vendorAddress === chosen?.address,
      )
      .map((a) => Number(a.evidence?.readyAt) || 0),
  );

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [a, f] = await Promise.all([
          api.get(base, List),
          api.get(`/v2/workspaces/${workspaceId}/finance`, FinanceViewSchema),
        ]);
        if (active) {
          setItems(a.actions);
          setVendors(f.vendors);
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
  }, [base, workspaceId]);
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
  async function propose(
    kind: 'QUEUE_VENDOR' | 'ALLOW_VENDOR' | 'REMOVE_VENDOR',
  ) {
    setSelected(
      await api.post(base, SafeActionViewSchema, { kind, vendorId: vendor }),
    );
    setReviewed(false);
    setItems((await api.get(base, List)).actions);
  }
  async function sign() {
    if (!selected || !reviewed) return;
    const latest = await api.get(
        `${base}/${selected.action.id}`,
        SafeActionViewSchema,
      ),
      a = latest.action;
    if (
      a.workspaceId !== workspaceId ||
      getAddress(a.safe) !== getAddress(vault) ||
      a.expiresAt <= Date.now() / 1000 ||
      JSON.stringify(a) !== JSON.stringify(selected.action)
    )
      throw new Error('The action expired or changed. Review a fresh action.');
    const provider = (
      window as unknown as {
        ethereum?: {
          request(i: { method: string; params?: unknown[] }): Promise<unknown>;
        };
      }
    ).ethereum;
    if (!provider) throw new Error('Connect your current Safe owner wallet.');
    const accounts = z
        .array(z.string())
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' })),
      wallet = getAddress(accounts[0]!);
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${a.chainId.toString(16)}` }],
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
    const approvalSignature = await signData(safeActionApprovalTypedData(a)),
      safeSignature = await signData(safeActionTypedData(a));
    setSelected(
      await api.post(`${base}/${a.id}/approve`, SafeActionViewSchema, {
        approvalSignature,
        safeSignature,
      }),
    );
    setReviewed(false);
    setItems((await api.get(base, List)).actions);
  }
  return (
    <section>
      <h2>Vault vendor allowlist</h2>
      <p>
        Adding a vendor needs two Safe transactions: queue the exact address,
        wait the vault’s governance delay, then sign and execute the addition.
        Removing a recipient reduces its permissions immediately. Each
        transaction needs the current Safe quorum and a separate bounded Synq
        approval.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working…</p>}
      {owner && (
        <>
          <label>
            Verified vendor
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">Select vendor</option>
              {vendors.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name} · {v.status}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !vendor || chosen?.status !== 'VERIFIED'}
            onClick={() => void run(() => propose('QUEUE_VENDOR'))}
          >
            Review queue transaction
          </button>
          <button
            disabled={
              busy ||
              !vendor ||
              chosen?.status !== 'VERIFIED' ||
              !readyAt ||
              Date.now() / 1000 < readyAt
            }
            onClick={() => void run(() => propose('ALLOW_VENDOR'))}
          >
            Review addition after delay
          </button>
          {readyAt > 0 && (
            <p>
              Queued addition is eligible after{' '}
              {new Date(readyAt * 1000).toLocaleString()}.
            </p>
          )}
          <button
            disabled={busy || !vendor}
            onClick={() => void run(() => propose('REMOVE_VENDOR'))}
          >
            Review removal
          </button>
        </>
      )}
      {items.length === 0 && <p>No vault governance actions.</p>}
      {items.map((v) => (
        <button
          key={v.action.id}
          disabled={busy}
          onClick={() => {
            setSelected(v);
            setReviewed(false);
          }}
        >
          {v.action.kind} · Safe nonce {v.action.nonce} · {v.state}
        </button>
      ))}
      {selected && (
        <section>
          <h3>Review exact governance call</h3>
          <p>
            {selected.action.kind} · recipient {selected.action.vendorAddress}
          </p>
          <p>
            Safe {selected.action.safe} · policy {selected.action.policy} ·
            nonce {selected.action.nonce}
          </p>
          <p>
            {selected.signedBy.length} signatures · {selected.state}
            {selected.lastError ? ` · ${selected.lastError}` : ''}
          </p>
          {typeof selected.evidence?.readyAt === 'string' && (
            <p>
              Ready after{' '}
              {new Date(
                Number(selected.evidence.readyAt) * 1000,
              ).toLocaleString()}
              .
            </p>
          )}
          {typeof selected.evidence?.hash === 'string' && (
            <a
              href={`https://explorer.testnet.arc.io/tx/${selected.evidence.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View governance receipt
            </a>
          )}
          {owner && selected.state === 'REVIEW' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed this exact address and governance operation. The
                wallet will ask for a bounded Synq approval and a Safe
                transaction signature.
              </label>
              <button
                disabled={busy || !reviewed}
                onClick={() => void run(sign)}
              >
                Sign governance action
              </button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
