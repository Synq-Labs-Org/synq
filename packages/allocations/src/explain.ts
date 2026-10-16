import type { JournalEntry } from '@synq/ledger';
import type { Invoice } from '@synq/invoices';
import type { VendorInvoice } from '@synq/payables';
import type { LegRecord, Reservation, SplitRecord } from './split.js';
import {
  dayNumber,
  totals,
  units,
  type AllocationPlan,
  type Receivable,
} from './waterfall.js';

/**
 * CFO-facing explanation of one split, built only from stored facts: the
 * plan, each leg's state and chain evidence, and the reservations. The same
 * split always gives the same text. Every transfer cites its transaction and
 * on-chain reference; reservations say plainly that no money moved.
 */
export function explainAllocation(input: {
  split: SplitRecord;
  legs: readonly LegRecord[];
  reservations: readonly Reservation[];
  decimals: number;
  symbol: string;
  explorer: string;
}): {
  headline: string;
  lines: string[];
  citations: { label: string; ref: string; url: string | null }[];
  summary: Record<string, string>;
} {
  const { split: s, decimals: d, symbol } = input;
  const plan = s.plan as AllocationPlan | null;
  const fmt = (x: bigint) => `${units(x, d)} ${symbol}`;
  const r = s.receipt;
  const citations: { label: string; ref: string; url: string | null }[] = [
    {
      label: `receipt for invoice ${r.invoiceNumber}`,
      ref: r.receiptId,
      url: `${input.explorer}/tx/${r.txHash}`,
    },
  ];
  if (!plan)
    return {
      headline: `Receipt ${fmt(r.amount)} for ${r.invoiceNumber}: not yet allocated (${s.state})`,
      lines: [s.note ?? ''],
      citations,
      summary: { state: s.state },
    };
  const t = totals(plan);
  const lines: string[] = [
    `Received ${fmt(r.amount)} for invoice ${r.invoiceNumber} in tx ${r.txHash} (block ${r.blockNumber}), final on chain.`,
    `Before allocating: treasury held ${fmt(plan.position.onChainFinalized)} at block ${plan.position.observedBlock}; ${fmt(plan.position.reservations)} already reserved, ${fmt(plan.position.escrowLiabilities)} escrow, ${fmt(plan.position.refundLiabilities)} refunds owed, ${fmt(plan.position.committedOutgoing)} in flight; ${fmt(plan.position.freeOutsideReceipt)} free outside this receipt.`,
    `Not counted as cash: ${fmt(plan.excluded.receivablesNotSpendable)} across ${plan.excluded.openReceivables} open receivable(s) and ${fmt(plan.excluded.invested)} invested.`,
  ];
  for (const leg of input.legs) {
    const res = input.reservations.find((x) => x.reservationId === leg.legKey);
    if (leg.kind === 'TRANSFER') {
      const ev = leg.evidence;
      lines.push(
        `Leg ${leg.legIndex} ${leg.purpose}: ${fmt(leg.amount)} to ${leg.beneficiaryId} (${leg.payTo}) for ${leg.basis}. ${
          ev
            ? `Paid in tx ${ev.txHash}, block ${ev.blockNumber}, on-chain ref ${ev.ref}; state ${leg.state}.`
            : `State ${leg.state}${leg.reasons.length ? `: ${leg.reasons.join('; ')}` : ''}.`
        }`,
      );
      if (ev)
        citations.push({
          label: `leg ${leg.legIndex} ${leg.purpose}`,
          ref: leg.legKey,
          url: ev.explorer,
        });
    } else if (leg.kind === 'RESERVE')
      lines.push(
        `Leg ${leg.legIndex} ${leg.purpose}: ${fmt(leg.amount)} reserved (${res?.status ?? 'not yet held'}; no transfer${
          leg.purpose === 'TAX_ESTIMATE' ? ', not a tax payment' : ''
        }). ${leg.basis}.${leg.flags.length ? ` Flags: ${leg.flags.map((f) => f.code).join(', ')}.` : ''}`,
      );
    else
      lines.push(
        `Leg ${leg.legIndex} free cash: ${fmt(leg.amount)} stays in the treasury (${leg.basis}).`,
      );
  }
  for (const sf of plan.shortfalls)
    lines.push(
      `Shortfall ${sf.purpose} ${sf.ref}: ${fmt(sf.needed)}; ${sf.reason}.`,
    );
  lines.push(
    `Conservation: legs sum to ${fmt(plan.legs.reduce((a, l) => a + l.amount, 0n))} = receipt ${fmt(r.amount)}. Plan ${plan.planHash}; policy ${plan.policyId} v${plan.policyVersion} (${plan.policyHash}).`,
  );
  return {
    headline: `${fmt(r.amount)} received: ${fmt(t.taxReserve)} tax estimate reserved, ${fmt(t.payables)} contractor payables, ${fmt(t.bills)} bills reserved, ${fmt(t.operatingFloor)} operating floor, ${fmt(t.distributions)} distributed, ${fmt(t.freeCash)} free cash (${s.state}).`,
    lines,
    citations,
    summary: {
      state: s.state,
      gross: units(r.amount, d),
      taxReserve: units(t.taxReserve, d),
      payables: units(t.payables, d),
      payablesHeld: units(t.payablesHeld, d),
      bills: units(t.bills, d),
      operatingFloor: units(t.operatingFloor, d),
      distributions: units(t.distributions, d),
      freeCash: units(t.freeCash, d),
      receivablesNotSpendable: units(plan.excluded.receivablesNotSpendable, d),
    },
  };
}

/** Vendor invoices with no settlement in the ledger (by source ref). */
export function openPayables(
  invoices: readonly VendorInvoice[],
  entries: readonly JournalEntry[],
): VendorInvoice[] {
  const settled = new Set(
    entries
      .filter((e) => e.source.kind === 'CHAIN_TX')
      .map((e) => e.source.ref),
  );
  return invoices.filter((i) => !settled.has(i.vendorInvoiceId));
}

/**
 * Open receivables from issued invoices, with each payer's lateness taken
 * from the payment times of its earlier invoices.
 */
export function receivablesFromInvoices(
  invoices: readonly Invoice[],
): Receivable[] {
  const lateByPayer = new Map<string, number[]>();
  for (const i of invoices) {
    if (i.status !== 'PAID' && i.status !== 'OVERPAID') continue;
    const last = i.payments.at(-1);
    if (!last) continue;
    const paidOn = new Date(last.at * 1000).toISOString().slice(0, 10);
    const late = Math.max(0, dayNumber(paidOn) - dayNumber(i.dueDate));
    lateByPayer.set(i.payer.name, [
      ...(lateByPayer.get(i.payer.name) ?? []),
      late,
    ]);
  }
  return invoices
    .filter((i) => i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID')
    .map((i) => {
      const due = i.total - i.credited - i.paid;
      return {
        invoiceId: i.invoiceId,
        number: i.number,
        payer: i.payer.name,
        amountDue: due > 0n ? due : 0n,
        dueOn: i.dueDate,
        payerDaysLate: lateByPayer.get(i.payer.name) ?? [],
      };
    });
}
