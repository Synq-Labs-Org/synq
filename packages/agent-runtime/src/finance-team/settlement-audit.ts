import type { JournalEntry } from '@synq/ledger';
import { amountDue, type Invoice } from '@synq/invoices';
import { usdcDisplay, type ArcWorldSnapshot } from '@synq/world-model';
import type { FinanceDesk } from './desk.js';
import type { AuditExplanation } from './specialists.js';
import type { FinanceAgent, FinanceTeam } from './team.js';

/**
 * How an invoice payment reached the issuer: the route record written by the
 * settlement worker after it reconciled the destination receipt. Public data
 * only (chains, hashes, addresses, amounts in base units).
 */
export type SettlementEvidence = Readonly<{
  invoiceId: string;
  route: 'CCTP_V2' | 'ARC_DIRECT';
  sourceChain: string;
  sourceTx: `0x${string}` | null;
  sourceExplorer: string | null;
  /** CCTP message nonce attested by Iris (null for a direct Arc payment). */
  attestationNonce: `0x${string}` | null;
  destinationChain: string;
  destinationTx: `0x${string}`;
  destinationExplorer: string;
  payer: string;
  recipient: string;
  grossBaseUnits: string;
  feeBaseUnits: string;
  creditedBaseUnits: string;
}>;

export type SettlementAudit = AuditExplanation &
  Readonly<{
    subject: 'INVOICE_PAYMENT';
    invoice: Readonly<{
      invoiceId: string;
      number: string;
      payer: string;
      status: string;
      total: string;
      paid: string;
      amountDue: string;
    }> | null;
    route: SettlementEvidence;
    currentState: string;
  }>;

const lower = (a: string) => a.toLowerCase();
const usdc = (b: string | bigint) => `${usdcDisplay(b)} USDC`;

/** The settlement whose source or destination transaction is `txHash`. */
export function findSettlement(
  desk: FinanceDesk,
  txHash: string | null,
): SettlementEvidence | null {
  if (!txHash || !desk.settlements?.length) return null;
  return (
    desk.settlements.find(
      (s) =>
        lower(s.destinationTx) === lower(txHash) ||
        (s.sourceTx !== null && lower(s.sourceTx) === lower(txHash)),
    ) ?? null
  );
}

function ledgerLines(entries: readonly JournalEntry[], invoiceId: string) {
  const out: Record<string, bigint> = {};
  for (const e of entries)
    for (const p of e.postings)
      if (p.documentRef === invoiceId)
        out[p.account] = (out[p.account] ?? 0n) + p.amount;
  return out;
}

function stateLine(s: ArcWorldSnapshot): string {
  const balances = s.treasury.balances.value
    .map((b) => `${b.chain} ${b.account.slice(0, 6)}… ${usdc(b.baseUnits)}`)
    .join('; ');
  const open = s.obligations.receivables.value.filter(
    (r) => r.status !== 'PAID' && r.status !== 'VOID',
  );
  const payables = s.obligations.payables.value.filter(
    (p) => p.status !== 'PAID',
  );
  const free = s.treasury.availableToSpend.value;
  return [
    `Balances: ${balances || 'none read'}.`,
    `Free to spend on Arc: ${free === null ? 'unknown' : usdc(free)}.`,
    `Open receivables: ${open.length ? open.map((r) => `${r.number} ${usdc(r.amountDue)}`).join(', ') : 'none'}.`,
    `Open payables: ${payables.length ? payables.map((p) => `${p.number} ${usdc(p.amount)}`).join(', ') : 'none'}.`,
    `Snapshot ${s.decision.decisionGrade ? 'is decision-grade' : `is NOT decision-grade (${s.decision.staleCritical.join(', ')})`}.`,
  ].join(' ');
}

/**
 * Audit Agent, invoice side: explains which invoice a payment settled, the
 * route it took (source burn, attestation, destination mint), what was
 * credited to whom, the ledger lines, an independent receipt check and the
 * workspace's current financial state. Read-only.
 */
export async function auditSettlementExplain(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  route: SettlementEvidence,
): Promise<SettlementAudit> {
  const s = team.tool(agent, 'world.snapshot', () => snapshot);
  const invoice: Invoice | null = team.tool(
    agent,
    'invoices.list',
    () => desk.invoices.find((i) => i.invoiceId === route.invoiceId) ?? null,
  );
  const lines = team.tool(agent, 'ledger.entries', () =>
    ledgerLines(desk.ledgerEntries ?? [], route.invoiceId),
  );
  const ledger = Object.fromEntries(
    Object.entries(lines).map(([k, v]) => [k, usdcDisplay(v)]),
  );
  const values = Object.values(lines);
  const ledgerBalanced = values.length
    ? values.reduce((a, v) => a + v, 0n) === 0n
    : null;
  let chainCheck: AuditExplanation['chainCheck'] = 'NOT_CHECKED';
  let chainDetail: string | null = null;
  if (desk.receipts) {
    const r = await desk.receipts(route.destinationTx);
    const credited = BigInt(route.creditedBaseUnits);
    const hit = r?.transfers.find(
      (t) => lower(t.to) === lower(route.recipient) && t.baseUnits === credited,
    );
    chainCheck = r && r.status === 'success' && hit ? 'VERIFIED' : 'MISMATCH';
    chainDetail = !r
      ? 'destination transaction not found on chain'
      : r.status !== 'success'
        ? 'destination transaction reverted'
        : hit
          ? `block ${r.blockNumber}: USDC ${usdcDisplay(credited)} to ${route.recipient}`
          : 'no USDC transfer of the credited amount to the payout address in the receipt';
  }
  const routeText =
    route.route === 'CCTP_V2'
      ? `Route: Circle CCTP V2 ${route.sourceChain} -> ${route.destinationChain}. ${route.payer} burned ${usdc(route.grossBaseUnits)} on ${route.sourceChain} (tx ${route.sourceTx}) with the invoice payment reference as hookData; Iris attested message nonce ${route.attestationNonce}; the mint on ${route.destinationChain} (tx ${route.destinationTx}) credited ${usdc(route.creditedBaseUnits)} to the payout address ${route.recipient} after a ${usdc(route.feeBaseUnits)} CCTP fee.`
      : `Route: direct ${route.destinationChain} payment from ${route.payer} (tx ${route.destinationTx}) crediting ${usdc(route.creditedBaseUnits)} to ${route.recipient}.`;
  const currentState = stateLine(s);
  const head = invoice
    ? `Invoice ${invoice.number} to ${invoice.payer.name} for ${usdc(invoice.total)} from ${invoice.issuer.name} is ${invoice.status}: paid ${usdc(invoice.paid)}, ${usdc(amountDue(invoice))} due.`
    : `The payment references invoice ${route.invoiceId}, which I cannot find in the books.`;
  const explanation = [
    head,
    routeText,
    `Ledger for this invoice: ${
      Object.entries(ledger)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'no lines'
    }${ledgerBalanced === null ? '' : ledgerBalanced ? ' (balanced)' : ' (does NOT balance)'}.`,
    chainCheck === 'NOT_CHECKED'
      ? 'I have not re-read the destination receipt in this run.'
      : `Chain check: ${chainCheck} (${chainDetail}).`,
    `Now: ${currentState}`,
    route.sourceExplorer ? `Source: ${route.sourceExplorer}` : '',
    `Destination: ${route.destinationExplorer}`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    status: 'EXPLAINED',
    subject: 'INVOICE_PAYMENT',
    txHash: route.destinationTx,
    environment: route.destinationChain,
    explorer: route.destinationExplorer,
    amount: usdcDisplay(route.creditedBaseUnits),
    recipient: route.recipient,
    kernelDecision: null,
    kernelReasons: [],
    grantId: null,
    ledger,
    ledgerBalanced,
    chainCheck,
    chainDetail,
    relatedRefusals: [],
    explanation,
    sources: [
      `invoice:${route.invoiceId}`,
      ...(route.sourceExplorer ? [route.sourceExplorer] : []),
      route.destinationExplorer,
      ...(chainCheck === 'NOT_CHECKED'
        ? []
        : [`chain:receipt:${route.destinationTx}`]),
    ],
    invoice: invoice
      ? {
          invoiceId: invoice.invoiceId,
          number: invoice.number,
          payer: invoice.payer.name,
          status: invoice.status,
          total: usdcDisplay(invoice.total),
          paid: usdcDisplay(invoice.paid),
          amountDue: usdcDisplay(amountDue(invoice)),
        }
      : null,
    route,
    currentState,
  };
}
