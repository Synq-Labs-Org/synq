'use client';
import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import { WorkspaceInvoiceViewSchema } from '@synq/workspaces/invoice-contracts';
import { issueTypedData } from '@synq/invoices/invoice-data';
import { api, describeError } from '../../lib/api';
type Invoice = z.output<typeof WorkspaceInvoiceViewSchema>;
const List = z.strictObject({ invoices: z.array(WorkspaceInvoiceViewSchema) });
export function InvoicePanel({
  workspaceId,
  vault,
  owner,
}: {
  workspaceId: string;
  vault: string;
  owner: boolean;
}) {
  const [items, setItems] = useState<Invoice[]>([]),
    [selected, setSelected] = useState<Invoice | null>(null);
  const [number, setNumber] = useState(''),
    [payer, setPayer] = useState(''),
    [due, setDue] = useState(''),
    [tax, setTax] = useState(''),
    [taxLabel, setTaxLabel] = useState(''),
    [memo, setMemo] = useState('');
  const [lines, setLines] = useState([
    { id: crypto.randomUUID(), description: '', quantity: '1', price: '' },
  ]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reviewed, setReviewed] = useState(false);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/invoices`;
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const r = await api.get(base, List);
        if (active) {
          setItems(r.invoices);
          setSelected((current) =>
            current
              ? (r.invoices.find((i) => i.invoiceId === current.invoiceId) ??
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
  async function refresh() {
    setItems((await api.get(base, List)).invoices);
  }
  async function create() {
    const lineItems = lines.map((l) => {
      if (
        !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(l.price) ||
        !/^[1-9][0-9]*$/.test(l.quantity)
      )
        throw new Error(
          'Use positive whole quantities and exact USDC prices with up to six decimals.',
        );
      return {
        description: l.description,
        quantity: Number(l.quantity),
        unitPrice: String(parseUnits(l.price, 6)),
      };
    });
    if (tax && !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(tax))
      throw new Error('Enter a tax percentage with at most two decimals.');
    setSelected(
      await api.post(base, WorkspaceInvoiceViewSchema, {
        number,
        payerName: payer,
        dueDate: due,
        lineItems,
        taxRateBps: Number(parseUnits(tax || '0', 2)),
        taxLabel: taxLabel.trim() || null,
        memo,
      }),
    );
    setReviewed(false);
    await refresh();
  }
  async function sign() {
    if (!selected || !reviewed) return;
    const i = await api.get(
      `${base}/${selected.invoiceId}`,
      WorkspaceInvoiceViewSchema,
    );
    if (
      i.workspaceId !== workspaceId ||
      getAddress(i.issuer.payoutAddress) !== getAddress(vault) ||
      i.status !== 'DRAFT' ||
      JSON.stringify(i) !== JSON.stringify(selected)
    )
      throw new Error('Invoice changed. Review the latest terms.');
    const provider = (
      window as unknown as {
        ethereum?: {
          request(i: { method: string; params?: unknown[] }): Promise<unknown>;
        };
      }
    ).ethereum;
    if (!provider) throw new Error('Connect the issuing owner wallet.');
    const accounts = z
        .array(z.string())
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' })),
      wallet = getAddress(accounts[0]!);
    if (wallet !== i.issuer.wallet)
      throw new Error(
        'Connect the owner wallet shown as this invoice’s signer.',
      );
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${i.asset.chainId.toString(16)}` }],
    });
    const typed = issueTypedData({
      ...i,
      total: BigInt(i.total),
      lineItems: i.lineItems.map((l) => ({
        ...l,
        unitPrice: BigInt(l.unitPrice),
      })),
    });
    const signature = z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .parse(
        await provider.request({
          method: 'eth_signTypedData_v4',
          params: [
            wallet,
            JSON.stringify(typed, (_k, v: unknown) =>
              typeof v === 'bigint' ? String(v) : v,
            ),
          ],
        }),
      );
    setSelected(
      await api.post(
        `${base}/${i.invoiceId}/issue`,
        WorkspaceInvoiceViewSchema,
        { signature },
      ),
    );
    setReviewed(false);
    await refresh();
  }
  return (
    <section>
      <h2>Workspace invoices</h2>
      <p>
        Issued by this workspace, payable to its vault in Arc testnet USDC. Any
        external wallet can pay through the checkout link. Drafts create no
        payment request until an owner signs.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Working…</p>}
      {owner && (
        <>
          <label>
            Invoice number
            <input
              value={number}
              maxLength={80}
              onChange={(e) => setNumber(e.target.value)}
            />
          </label>
          <label>
            Customer label
            <input
              value={payer}
              maxLength={120}
              onChange={(e) => setPayer(e.target.value)}
            />
          </label>
          <p>The label does not restrict which wallet may pay.</p>
          <label>
            Due date
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          {lines.map((l, index) => (
            <section key={l.id}>
              <h3>Line {index + 1}</h3>
              <label>
                Description
                <input
                  value={l.description}
                  maxLength={200}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r) =>
                        r.id === l.id
                          ? { ...r, description: e.target.value }
                          : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Quantity
                <input
                  inputMode="numeric"
                  value={l.quantity}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r) =>
                        r.id === l.id ? { ...r, quantity: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Unit price in USDC
                <input
                  inputMode="decimal"
                  value={l.price}
                  onChange={(e) =>
                    setLines((rows) =>
                      rows.map((r) =>
                        r.id === l.id ? { ...r, price: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              {lines.length > 1 && (
                <button
                  disabled={busy}
                  onClick={() =>
                    setLines((rows) => rows.filter((r) => r.id !== l.id))
                  }
                >
                  Remove line
                </button>
              )}
            </section>
          ))}
          <button
            disabled={busy || lines.length >= 30}
            onClick={() =>
              setLines((rows) => [
                ...rows,
                {
                  id: crypto.randomUUID(),
                  description: '',
                  quantity: '1',
                  price: '',
                },
              ])
            }
          >
            Add line
          </button>
          <label>
            Tax percentage
            <input
              inputMode="decimal"
              value={tax}
              onChange={(e) => setTax(e.target.value)}
            />
          </label>
          <label>
            Tax label
            <input
              value={taxLabel}
              maxLength={80}
              onChange={(e) => setTaxLabel(e.target.value)}
            />
          </label>
          <label>
            Memo
            <textarea
              value={memo}
              maxLength={300}
              onChange={(e) => setMemo(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              !number.trim() ||
              !payer.trim() ||
              !due ||
              lines.some(
                (l) => !l.description.trim() || !l.price || !l.quantity,
              )
            }
            onClick={() => void run(create)}
          >
            Create invoice draft
          </button>
        </>
      )}
      {items.length === 0 && !error && <p>No workspace invoices.</p>}
      {items.map((i) => (
        <button
          key={i.invoiceId}
          disabled={busy}
          onClick={() => {
            setSelected(i);
            setReviewed(false);
          }}
        >
          {i.number} · {formatUnits(BigInt(i.total), 6)} USDC · {i.status}
        </button>
      ))}
      {selected && (
        <section>
          <h3>{selected.number}</h3>
          <p>
            {selected.issuer.name} · {selected.status} · due {selected.dueDate}
          </p>
          {selected.reconciliation === 'REVIEW' && (
            <p role="alert">
              Payment proof needs review after chain reconciliation. Recorded
              accounting is preserved; do not treat this invoice as finalized.
            </p>
          )}
          {selected.reconciliation === 'PENDING' && (
            <p role="status">Waiting for finalized receipt reconciliation.</p>
          )}
          {selected.lineItems.map((l, index) => (
            <p key={index}>
              {l.quantity} × {formatUnits(BigInt(l.unitPrice), 6)} USDC ·{' '}
              {l.description}
            </p>
          ))}
          <p>
            Total {formatUnits(BigInt(selected.total), 6)} USDC · paid{' '}
            {formatUnits(BigInt(selected.paid), 6)} USDC · due{' '}
            {formatUnits(BigInt(selected.amountDue), 6)} USDC
          </p>
          <p>
            Pay to workspace vault {selected.issuer.payoutAddress}. Issuing
            owner {selected.issuer.wallet}.
          </p>
          {selected.checkoutPath && selected.reconciliation !== 'REVIEW' && (
            <>
              <a href={selected.checkoutPath} target="_blank" rel="noreferrer">
                Open external checkout
              </a>
              <button
                onClick={() =>
                  void run(() =>
                    navigator.clipboard.writeText(
                      new URL(
                        selected.checkoutPath!,
                        window.location.origin,
                      ).toString(),
                    ),
                  )
                }
              >
                Copy checkout link
              </button>
            </>
          )}
          {owner && selected.status === 'DRAFT' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed the exact invoice terms and workspace payout address.
              </label>
              <button
                disabled={busy || !reviewed}
                onClick={() => void run(sign)}
              >
                Sign and issue invoice
              </button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
