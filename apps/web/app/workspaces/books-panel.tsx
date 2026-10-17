'use client';

import { useEffect, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { z } from 'zod';
import {
  BooksViewSchema,
  FinanceChangeViewSchema,
  FinanceViewSchema,
} from '@synq/workspaces/finance-contracts';
import { api, describeError } from '../../lib/api';

type Books = z.output<typeof BooksViewSchema>;
type Vendors = z.output<typeof FinanceViewSchema>['vendors'];
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Payables, milestones and recurring bills. Each entry is a finance change the
 * current Safe quorum signs under "Vendors and signed budgets"; automatic
 * splits read only what the owners approved here.
 */
export function BooksPanel({
  workspaceId,
  owner,
}: {
  workspaceId: string;
  owner: boolean;
}) {
  const [books, setBooks] = useState<Books | null>(null),
    [vendors, setVendors] = useState<Vendors>([]);
  const [vendor, setVendor] = useState(''),
    [number, setNumber] = useState(''),
    [amount, setAmount] = useState(''),
    [issuedOn, setIssuedOn] = useState(''),
    [dueOn, setDueOn] = useState(''),
    [reference, setReference] = useState(''),
    [documentText, setDocumentText] = useState('');
  const [milestone, setMilestone] = useState(''),
    [approved, setApproved] = useState(''),
    [status, setStatus] = useState<
      'APPROVED' | 'DELIVERED' | 'ACCEPTED' | 'DISPUTED'
    >('APPROVED');
  const [label, setLabel] = useState(''),
    [billKind, setBillKind] = useState<
      'BILL' | 'PAYROLL' | 'RENT' | 'SUBSCRIPTION'
    >('BILL'),
    [billAmount, setBillAmount] = useState(''),
    [nextDueOn, setNextDueOn] = useState(''),
    [cadence, setCadence] = useState('30');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const ws = `/v2/workspaces/${encodeURIComponent(workspaceId)}`;
  async function refresh() {
    const [b, f] = await Promise.all([
      api.get(`${ws}/books`, BooksViewSchema),
      api.get(`${ws}/finance`, FinanceViewSchema),
    ]);
    setBooks(b);
    setVendors(f.vendors);
  }
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get(`${ws}/books`, BooksViewSchema),
      api.get(`${ws}/finance`, FinanceViewSchema),
    ])
      .then(([b, f]) => {
        if (!active) return;
        setBooks(b);
        setVendors(f.vendors);
      })
      .catch((e: unknown) => {
        if (active) setError(describeError(e));
      });
    return () => {
      active = false;
    };
  }, [ws]);
  function units(v: string) {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(v))
      throw new Error('Use exact USDC amounts with at most six decimals.');
    const n = parseUnits(v, 6);
    if (n <= 0n) throw new Error('Amounts must be positive.');
    return String(n);
  }
  function date(v: string, what: string) {
    if (!isoDate.test(v)) throw new Error(`Enter the ${what} as YYYY-MM-DD.`);
    return v;
  }
  async function propose(edit: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const c = await api.post(
        `${ws}/finance/changes`,
        FinanceChangeViewSchema,
        edit,
      );
      setNotice(
        `Proposed ${c.change.edit.kind.toLowerCase().replace('_', ' ')}. Owners sign it under Vendors and signed budgets before it counts.`,
      );
      await refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const vendorName = (id: string) =>
    vendors.find((v) => v.id === id)?.name ?? 'Unknown vendor';
  return (
    <section>
      <h2>Bills and payables</h2>
      <p>
        What the business owes. Automatic splits hold or pay these before any
        distribution, and only after the Safe owner quorum signs each entry. An
        empty list means no bills were recorded, not that none exist.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Working…</p>}
      {!books ? (
        <p>Loading…</p>
      ) : (
        <>
          <h3>Vendor bills</h3>
          {books.payables.length === 0 && <p>No vendor bills recorded.</p>}
          {books.payables.map((p) => (
            <p key={p.id}>
              {p.number} · {vendorName(p.vendorId)} ·{' '}
              {formatUnits(BigInt(p.amount), 6)} USDC · due {p.dueOn}
              {p.reference ? ` · ${p.reference}` : ''} · {p.status}
              {owner && p.status === 'OPEN' && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void propose({
                      kind: 'CLOSE_PAYABLE',
                      payableId: p.id,
                      status: 'VOID',
                      reason: 'Voided by an owner',
                    })
                  }
                >
                  Propose void
                </button>
              )}
            </p>
          ))}
          <h3>Milestones</h3>
          {books.obligations.length === 0 && <p>No milestones recorded.</p>}
          {books.obligations.map((o) => (
            <p key={o.reference}>
              {o.reference} · {vendorName(o.vendorId)} · up to{' '}
              {formatUnits(BigInt(o.approvedAmount), 6)} USDC · {o.status}
            </p>
          ))}
          <h3>Recurring bills</h3>
          {books.bills.length === 0 && <p>No recurring bills recorded.</p>}
          {books.bills.map((b) => (
            <p key={b.id}>
              {b.label} · {b.billKind} · {formatUnits(BigInt(b.amount), 6)} USDC
              every {b.cadenceDays} days from {b.nextDueOn}
              {owner && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void propose({
                      kind: 'REMOVE_BILL',
                      billId: b.id,
                      reason: 'Stopped by an owner',
                    })
                  }
                >
                  Propose stop
                </button>
              )}
            </p>
          ))}
        </>
      )}
      {owner && (
        <>
          <h3>Record a vendor bill</h3>
          <label>
            Vendor
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="">Select a vendor</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bill number
            <input
              value={number}
              maxLength={40}
              onChange={(e) => setNumber(e.target.value)}
            />
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
            Issued on
            <input
              value={issuedOn}
              placeholder="YYYY-MM-DD"
              onChange={(e) => setIssuedOn(e.target.value)}
            />
          </label>
          <label>
            Due on
            <input
              value={dueOn}
              placeholder="YYYY-MM-DD"
              onChange={(e) => setDueOn(e.target.value)}
            />
          </label>
          <label>
            PO or milestone reference (optional)
            <input
              value={reference}
              maxLength={80}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label>
            Bill text, as written on the document
            <textarea
              value={documentText}
              maxLength={2000}
              onChange={(e) => setDocumentText(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !vendor || !number.trim() || !documentText.trim()}
            onClick={() =>
              void (async () => {
                try {
                  await propose({
                    kind: 'PAYABLE',
                    payableId: crypto.randomUUID(),
                    vendorId: vendor,
                    number: number.trim(),
                    amount: units(amount),
                    issuedOn: date(issuedOn, 'issue date'),
                    dueOn: date(dueOn, 'due date'),
                    reference: reference.trim() || null,
                    documentText: documentText.trim(),
                  });
                } catch (e) {
                  setError(describeError(e));
                }
              })()
            }
          >
            Propose vendor bill
          </button>
          <h3>Record a milestone</h3>
          <label>
            Reference
            <input
              value={milestone}
              maxLength={80}
              onChange={(e) => setMilestone(e.target.value)}
            />
          </label>
          <label>
            Approved amount in USDC
            <input
              value={approved}
              inputMode="decimal"
              onChange={(e) => setApproved(e.target.value)}
            />
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="APPROVED">Approved</option>
              <option value="DELIVERED">Delivered</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="DISPUTED">Disputed</option>
            </select>
          </label>
          <button
            disabled={busy || !vendor || !milestone.trim()}
            onClick={() =>
              void (async () => {
                try {
                  await propose({
                    kind: 'OBLIGATION',
                    reference: milestone.trim(),
                    vendorId: vendor,
                    approvedAmount: units(approved),
                    status,
                  });
                } catch (e) {
                  setError(describeError(e));
                }
              })()
            }
          >
            Propose milestone for the selected vendor
          </button>
          <h3>Record a recurring bill</h3>
          <label>
            Label
            <input
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label>
            Kind
            <select
              value={billKind}
              onChange={(e) => setBillKind(e.target.value as typeof billKind)}
            >
              <option value="BILL">Bill</option>
              <option value="PAYROLL">Payroll</option>
              <option value="RENT">Rent</option>
              <option value="SUBSCRIPTION">Subscription</option>
            </select>
          </label>
          <label>
            Amount in USDC
            <input
              value={billAmount}
              inputMode="decimal"
              onChange={(e) => setBillAmount(e.target.value)}
            />
          </label>
          <label>
            Next due on
            <input
              value={nextDueOn}
              placeholder="YYYY-MM-DD"
              onChange={(e) => setNextDueOn(e.target.value)}
            />
          </label>
          <label>
            Every how many days
            <input
              value={cadence}
              inputMode="numeric"
              onChange={(e) => setCadence(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !label.trim()}
            onClick={() =>
              void (async () => {
                try {
                  const days = Number(cadence);
                  if (!Number.isInteger(days) || days < 1 || days > 366)
                    throw new Error('Repeat every 1 to 366 days.');
                  await propose({
                    kind: 'BILL',
                    billId: crypto.randomUUID(),
                    label: label.trim(),
                    billKind,
                    amount: units(billAmount),
                    nextDueOn: date(nextDueOn, 'next due date'),
                    cadenceDays: days,
                  });
                } catch (e) {
                  setError(describeError(e));
                }
              })()
            }
          >
            Propose recurring bill
          </button>
        </>
      )}
    </section>
  );
}
