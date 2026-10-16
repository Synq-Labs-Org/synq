import {
  InteractiveCardSchema,
  arcCardBase,
  cardDecimal,
  cardLine,
  cardRef,
  type ArcCardContext,
  type CardOf,
} from '@synq/schemas';
import {
  amountDue,
  overpaidBy,
  type Invoice,
  type InvoiceStatus,
} from './index.js';

/*
 * Invoice → INVOICE card. Pure: amounts are the invoice's integer base
 * units at the asset's decimals; due and overpaid come from the same
 * functions the ledger uses. The card shows the Memo payment reference that
 * binds a payment to this version; paying happens on the authenticated page.
 */

const STATUS: Record<InvoiceStatus, CardOf<'INVOICE'>['status']> = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PARTIALLY_PAID: 'PARTIAL',
  PAID: 'PAID',
  OVERPAID: 'OVERPAID',
  VOID: 'VOID',
};

export function invoiceCard(
  invoice: Invoice,
  ctx: ArcCardContext,
): CardOf<'INVOICE'> {
  const last = [...invoice.payments].sort((x, y) => x.at - y.at).at(-1);
  const observed = Math.max(
    invoice.issuedAt ?? 0,
    last?.at ?? 0,
    ...invoice.history.map((h) => h.at),
  );
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      observed,
      'invoice',
      invoice.invoiceId,
      invoice.version,
      invoice.status,
      invoice.paid,
      invoice.payments.length,
    ),
    ...invoiceCardContent(invoice),
  }) as CardOf<'INVOICE'>;
}

/** Immutable notification snapshot; no issuer signature, private contact or keys. */
export function invoiceCardContent(invoice: Invoice) {
  const a = invoice.asset;
  const money = (units: bigint) => ({
    amount: cardDecimal(units, a.decimals),
    symbol: a.symbol,
  });
  const last = [...invoice.payments].sort((x, y) => x.at - y.at).at(-1);
  return {
    type: 'INVOICE',
    chainId: a.chainId,
    invoiceId: cardRef(invoice.invoiceId),
    number: cardLine(invoice.number, 40),
    version: invoice.version,
    status: STATUS[invoice.status],
    issuer: {
      label: cardLine(invoice.issuer.name, 120),
      address: invoice.issuer.payoutAddress,
    },
    payer: cardLine(invoice.payer.name, 120),
    total: money(invoice.total),
    paid: money(invoice.paid),
    due: money(amountDue(invoice)),
    overpaid: money(overpaidBy(invoice)),
    dueDate: invoice.dueDate,
    paymentRef: invoice.paymentRef,
    termsHash: invoice.termsHash,
    paymentCount: invoice.payments.length,
    lastPaymentTx: last?.txHash ?? null,
  };
}
