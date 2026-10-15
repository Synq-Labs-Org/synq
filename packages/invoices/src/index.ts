import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseEventLogs,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import type { AssetRef } from '@synq/domain';
import type { JournalEntry } from '@synq/ledger';

/**
 * Invoices and receivables on Arc.
 *
 * - A model or user may draft; only the issuer's wallet signature over the
 *   exact terms (EIP-712, Arc chain id) issues an invoice.
 * - Each issued version has a unique 32-byte payment reference. The payer pays
 *   through Arc's Memo contract: one transaction that runs USDC.transfer(issuer,
 *   amount) as the payer and emits Memo(sender, target, callDataHash, memoId).
 *   A payment applies only when memoId is this version's reference, the memo's
 *   call is exactly that transfer, and the matching ERC-20 Transfer log is in
 *   the same transaction. Amount/time similarity never settles an invoice.
 * - Payments apply once per (chain, tx, log) key; overpayment is a refund
 *   liability; credits are separate documents; revisions mint a new reference
 *   so old pay links and payments to them cannot settle the new terms.
 */

export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERPAID',
  'VOID',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type LineItem = Readonly<{
  description: string;
  quantity: number;
  unitPrice: bigint;
}>;

export type InvoicePayment = Readonly<{
  key: string;
  txHash: Hex;
  logIndex: number;
  payer: Address;
  amount: bigint;
  at: number;
}>;

export type Invoice = Readonly<{
  invoiceId: string;
  number: string;
  workspaceId: string;
  version: number;
  status: InvoiceStatus;
  issuer: Readonly<{
    principalId: string;
    name: string;
    wallet: Address;
    payoutAddress: Address;
  }>;
  payer: Readonly<{ name: string; contact: string | null }>;
  asset: AssetRef;
  lineItems: readonly LineItem[];
  taxLabel: string | null;
  taxRateBps: number;
  subtotal: bigint;
  tax: bigint;
  total: bigint;
  dueDate: string;
  memo: string;
  /** keccak256 of the issued terms; null while drafting. */
  termsHash: Hex | null;
  paymentRef: Hex | null;
  issuerSignature: Hex | null;
  issuedAt: number | null;
  payments: readonly InvoicePayment[];
  paid: bigint;
  credited: bigint;
  creditNoteIds: readonly string[];
  history: readonly Readonly<{
    version: number;
    termsHash: Hex | null;
    paymentRef: Hex | null;
    at: number;
    note: string;
  }>[];
  draftedBy: string;
}>;

export type CreditNote = Readonly<{
  creditNoteId: string;
  invoiceId: string;
  invoiceVersion: number;
  amount: bigint;
  reason: string;
  at: number;
}>;

export class InvoiceError extends Error {
  constructor(
    readonly code:
      | 'BAD_TERMS'
      | 'NOT_ISSUER'
      | 'WRONG_STATE'
      | 'BAD_PAY_LINK'
      | 'REFERENCE_MISMATCH'
      | 'WRONG_RECIPIENT'
      | 'WRONG_ASSET'
      | 'CREDIT_TOO_LARGE'
      | 'CONFLICT'
      | 'DUPLICATE_NUMBER'
      | 'NOT_FOUND',
    message: string = code,
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const lower = (a: string) => a.toLowerCase();

export function amountDue(i: Invoice): bigint {
  const owed = i.total - i.credited - i.paid;
  return owed > 0n ? owed : 0n;
}

export function overpaidBy(i: Invoice): bigint {
  const over = i.paid - (i.total - i.credited);
  return over > 0n ? over : 0n;
}

/** Tax in base units with half-up rounding on basis points. */
export function computeTotals(items: readonly LineItem[], taxRateBps: number) {
  if (!items.length)
    throw new InvoiceError('BAD_TERMS', 'at least one line item');
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000)
    throw new InvoiceError('BAD_TERMS', 'tax rate must be 0-10000 bps');
  let subtotal = 0n;
  for (const it of items) {
    if (
      !Number.isInteger(it.quantity) ||
      it.quantity < 1 ||
      it.quantity > 1_000_000
    )
      throw new InvoiceError('BAD_TERMS', `quantity ${it.quantity}`);
    if (typeof it.unitPrice !== 'bigint' || it.unitPrice <= 0n)
      throw new InvoiceError(
        'BAD_TERMS',
        'unit price must be positive base units',
      );
    const d = it.description.replace(/\s+/g, ' ').trim();
    if (!d || d.length > 200)
      throw new InvoiceError('BAD_TERMS', 'line description');
    subtotal += it.unitPrice * BigInt(it.quantity);
  }
  const tax = (subtotal * BigInt(taxRateBps) + 5_000n) / 10_000n;
  return { subtotal, tax, total: subtotal + tax };
}

export function draftInvoice(input: {
  workspaceId: string;
  number: string;
  issuer: Invoice['issuer'];
  payer: Invoice['payer'];
  asset: AssetRef;
  lineItems: readonly LineItem[];
  taxLabel?: string | null;
  taxRateBps?: number;
  dueDate: string;
  memo?: string;
  draftedBy: string;
  now: number;
}): Invoice {
  if (!DAY.test(input.dueDate)) throw new InvoiceError('BAD_TERMS', 'due date');
  if (lower(input.issuer.payoutAddress) === lower(input.asset.address))
    throw new InvoiceError(
      'BAD_TERMS',
      'payout address cannot be the token contract',
    );
  const taxRateBps = input.taxRateBps ?? 0;
  const { subtotal, tax, total } = computeTotals(input.lineItems, taxRateBps);
  return Object.freeze({
    invoiceId: `inv_${randomBytes(10).toString('hex')}`,
    number: input.number,
    workspaceId: input.workspaceId,
    version: 1,
    status: 'DRAFT',
    issuer: input.issuer,
    payer: input.payer,
    asset: input.asset,
    lineItems: input.lineItems,
    taxLabel: input.taxLabel ?? null,
    taxRateBps,
    subtotal,
    tax,
    total,
    dueDate: input.dueDate,
    memo: input.memo ?? '',
    termsHash: null,
    paymentRef: null,
    issuerSignature: null,
    issuedAt: null,
    payments: [],
    paid: 0n,
    credited: 0n,
    creditNoteIds: [],
    history: [
      {
        version: 1,
        termsHash: null,
        paymentRef: null,
        at: input.now,
        note: `drafted by ${input.draftedBy}`,
      },
    ],
    draftedBy: input.draftedBy,
  });
}

export function termsHash(i: Invoice): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'string[]' },
        { type: 'uint256[]' },
        { type: 'uint256[]' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'string' },
      ],
      [
        i.invoiceId,
        BigInt(i.version),
        i.issuer.payoutAddress,
        BigInt(i.asset.chainId),
        i.asset.address,
        i.lineItems.map((l) => l.description),
        i.lineItems.map((l) => BigInt(l.quantity)),
        i.lineItems.map((l) => l.unitPrice),
        BigInt(i.taxRateBps),
        i.total,
        i.dueDate,
      ],
    ),
  );
}

/** What the issuer signs to send the invoice. */
export function issueTypedData(i: Invoice) {
  return {
    domain: { name: 'Synq Invoice', version: '1', chainId: i.asset.chainId },
    types: {
      IssueInvoice: [
        { name: 'invoiceId', type: 'string' },
        { name: 'number', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'payoutAddress', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'total', type: 'uint256' },
        { name: 'dueDate', type: 'string' },
        { name: 'termsHash', type: 'bytes32' },
      ],
    },
    primaryType: 'IssueInvoice' as const,
    message: {
      invoiceId: i.invoiceId,
      number: i.number,
      version: BigInt(i.version),
      payoutAddress: i.issuer.payoutAddress,
      token: i.asset.address,
      total: i.total,
      dueDate: i.dueDate,
      termsHash: termsHash(i),
    },
  };
}

export function paymentReference(i: Invoice): Hex {
  return keccak256(
    stringToHex(`synq:invoice:${i.invoiceId}:v${i.version}:${termsHash(i)}`),
  );
}

/** Issuance requires the issuer wallet's signature over the exact terms. */
export async function issueInvoice(
  i: Invoice,
  signature: Hex,
  now: number,
): Promise<{
  invoice: Invoice;
  entry: JournalEntry;
}> {
  if (i.status !== 'DRAFT') throw new InvoiceError('WRONG_STATE', i.status);
  const signer = await recoverTypedDataAddress({
    ...issueTypedData(i),
    signature,
  }).catch(() => null);
  if (!signer || lower(signer) !== lower(i.issuer.wallet))
    throw new InvoiceError('NOT_ISSUER', `signed by ${signer ?? 'nobody'}`);
  const th = termsHash(i);
  const ref = paymentReference(i);
  const invoice: Invoice = Object.freeze({
    ...i,
    status: 'ISSUED',
    termsHash: th,
    paymentRef: ref,
    issuerSignature: signature,
    issuedAt: now,
    history: [
      ...i.history,
      {
        version: i.version,
        termsHash: th,
        paymentRef: ref,
        at: now,
        note: 'issued by issuer signature',
      },
    ],
  });
  return {
    invoice,
    entry: {
      entryId: `je_${i.invoiceId}_v${i.version}_issue`,
      workspaceId: i.workspaceId,
      occurredAt: now,
      memo: `Invoice ${i.number} issued to ${i.payer.name}`,
      source: { kind: 'INVOICE', ref: `${i.invoiceId}:v${i.version}` },
      evidence: null,
      idempotencyKey: `invoice:${i.invoiceId}:v${i.version}:issue`,
      postings: [
        {
          account: 'ACCOUNTS_RECEIVABLE',
          assetId: i.asset.assetId,
          amount: i.total,
          counterpartyId: `payer:${i.payer.name}`,
          documentRef: i.invoiceId,
        },
        {
          account: 'REVENUE',
          assetId: i.asset.assetId,
          amount: -i.total,
          documentRef: i.invoiceId,
        },
      ],
      reversalOf: null,
    },
  };
}

/**
 * Changing terms creates a new version: back to DRAFT, new reference after
 * re-issue. Payments already received stay attached to the invoice.
 */
export function reviseInvoice(
  i: Invoice,
  change: {
    lineItems?: readonly LineItem[];
    dueDate?: string;
    taxRateBps?: number;
  },
  now: number,
  note: string,
): Invoice {
  if (i.status === 'VOID' || i.status === 'PAID' || i.status === 'OVERPAID')
    throw new InvoiceError('WRONG_STATE', i.status);
  const lineItems = change.lineItems ?? i.lineItems;
  const taxRateBps = change.taxRateBps ?? i.taxRateBps;
  const dueDate = change.dueDate ?? i.dueDate;
  if (!DAY.test(dueDate)) throw new InvoiceError('BAD_TERMS', 'due date');
  const totals = computeTotals(lineItems, taxRateBps);
  return Object.freeze({
    ...i,
    ...totals,
    lineItems,
    taxRateBps,
    dueDate,
    version: i.version + 1,
    status: 'DRAFT',
    termsHash: null,
    paymentRef: null,
    issuerSignature: null,
    history: [
      ...i.history,
      {
        version: i.version + 1,
        termsHash: null,
        paymentRef: null,
        at: now,
        note,
      },
    ],
  });
}

// Pay links: navigation tokens bound to one version's reference, total and expiry.

export function payLinkToken(
  key: Uint8Array,
  i: Invoice,
  expiresAt: number,
): string {
  if (!i.paymentRef) throw new InvoiceError('WRONG_STATE', 'not issued');
  const body = `${i.invoiceId}.${i.version}.${expiresAt}`;
  const mac = createHmac('sha256', key)
    .update(
      `${body}|${i.paymentRef}|${i.total}|${i.issuer.payoutAddress.toLowerCase()}`,
    )
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPayLink(
  key: Uint8Array,
  token: string,
  i: Invoice,
  now: number,
): void {
  const parts = token.split('.');
  if (parts.length !== 4 || !i.paymentRef)
    throw new InvoiceError('BAD_PAY_LINK', 'malformed');
  const [id, version, exp, mac] = parts as [string, string, string, string];
  if (id !== i.invoiceId || Number(version) !== i.version)
    throw new InvoiceError(
      'BAD_PAY_LINK',
      'link is for another version of this invoice',
    );
  if (!/^\d+$/.test(exp) || Number(exp) <= now)
    throw new InvoiceError('BAD_PAY_LINK', 'expired');
  const expected = createHmac('sha256', key)
    .update(
      `${id}.${version}.${exp}|${i.paymentRef}|${i.total}|${i.issuer.payoutAddress.toLowerCase()}`,
    )
    .digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected))
    throw new InvoiceError('BAD_PAY_LINK', 'signature');
  if (i.status === 'DRAFT' || i.status === 'VOID')
    throw new InvoiceError('BAD_PAY_LINK', `invoice is ${i.status}`);
}

// Matching Arc Memo payments.

export const MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Memo',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** The exact call a payer makes: Memo.memo(USDC, transfer(payout, amount), ref, label). */
export function payCall(i: Invoice, amount: bigint) {
  if (!i.paymentRef) throw new InvoiceError('WRONG_STATE', 'not issued');
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [i.issuer.payoutAddress, amount],
  });
  return {
    target: i.asset.address,
    data,
    memoId: i.paymentRef,
    memoData: stringToHex(`synq:${i.number}`),
    calldata: encodeFunctionData({
      abi: MEMO_ABI,
      functionName: 'memo',
      args: [
        i.asset.address,
        data,
        i.paymentRef,
        stringToHex(`synq:${i.number}`),
      ],
    }),
  };
}

export type MemoPayment = Readonly<{
  chainId: number;
  txHash: Hex;
  /** Log index of the ERC-20 Transfer that moved the value. */
  logIndex: number;
  paymentRef: Hex;
  payer: Address;
  recipient: Address;
  amount: bigint;
}>;

/**
 * Pairs each Memo event with the one ERC-20 Transfer it caused. Only logs
 * from the registry token and Memo contract count (Arc also emits a native
 * 18-decimal mirror `Transfer` from 0xffff…fffe; it is ignored, never a
 * second credit). Transfers without a matching memo are returned as
 * `unreferenced`: unapplied receipts, never invoice settlement.
 */
export function extractMemoPayments(input: {
  chainId: number;
  txHash: Hex;
  logs: readonly Log[];
  token: Address;
  memoContract: Address;
}): {
  payments: MemoPayment[];
  unreferenced: {
    logIndex: number;
    from: Address;
    to: Address;
    amount: bigint;
  }[];
} {
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: input.logs as Log[],
  }).filter((l) => lower(l.address) === lower(input.token));
  const memos = parseEventLogs({
    abi: MEMO_ABI,
    eventName: 'Memo',
    logs: input.logs as Log[],
  }).filter(
    (l) =>
      lower(l.address) === lower(input.memoContract) &&
      lower(l.args.target) === lower(input.token),
  );
  const used = new Set<number>();
  const payments: MemoPayment[] = [];
  for (const m of memos) {
    const hit = transfers.find(
      (t) =>
        !used.has(t.logIndex!) &&
        lower(t.args.from) === lower(m.args.sender) &&
        keccak256(
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [t.args.to, t.args.value],
          }),
        ) === m.args.callDataHash,
    );
    if (!hit) continue;
    used.add(hit.logIndex!);
    payments.push({
      chainId: input.chainId,
      txHash: input.txHash,
      logIndex: hit.logIndex!,
      paymentRef: m.args.memoId,
      payer: m.args.sender,
      recipient: hit.args.to,
      amount: hit.args.value,
    });
  }
  const unreferenced = transfers
    .filter((t) => !used.has(t.logIndex!))
    .map((t) => ({
      logIndex: t.logIndex!,
      from: t.args.from,
      to: t.args.to,
      amount: t.args.value,
    }));
  return { payments, unreferenced };
}

/**
 * Applies one matched payment. Idempotent by (chain, tx, log): a replayed
 * event returns `applied: false` and no ledger entry. The reference must be
 * this version's, the recipient the issuer's payout address, the asset the
 * invoice asset. Excess over the amount due becomes a refund liability.
 */
export function applyPayment(
  i: Invoice,
  p: MemoPayment,
  now: number,
): {
  invoice: Invoice;
  entry: JournalEntry | null;
  applied: boolean;
} {
  const key = `chain:${p.chainId}:${p.txHash.toLowerCase()}:${p.logIndex}`;
  if (i.payments.some((x) => x.key === key))
    return { invoice: i, entry: null, applied: false };
  if (i.status === 'DRAFT' || i.status === 'VOID' || !i.paymentRef)
    throw new InvoiceError('WRONG_STATE', i.status);
  if (lower(p.paymentRef) !== lower(i.paymentRef))
    throw new InvoiceError(
      'REFERENCE_MISMATCH',
      'payment carries another reference',
    );
  if (p.chainId !== i.asset.chainId)
    throw new InvoiceError('WRONG_ASSET', `chain ${p.chainId}`);
  if (lower(p.recipient) !== lower(i.issuer.payoutAddress))
    throw new InvoiceError('WRONG_RECIPIENT', `paid ${p.recipient}`);
  const due = amountDue(i);
  const toAr = p.amount < due ? p.amount : due;
  const excess = p.amount - toAr;
  const paid = i.paid + p.amount;
  const remaining = i.total - i.credited - paid;
  const status: InvoiceStatus =
    remaining > 0n ? 'PARTIALLY_PAID' : remaining === 0n ? 'PAID' : 'OVERPAID';
  const invoice: Invoice = Object.freeze({
    ...i,
    status,
    paid,
    payments: [
      ...i.payments,
      {
        key,
        txHash: p.txHash,
        logIndex: p.logIndex,
        payer: p.payer,
        amount: p.amount,
        at: now,
      },
    ],
  });
  const asset = i.asset.assetId;
  const postings = [
    {
      account: 'CASH_ARC_USDC' as const,
      assetId: asset,
      amount: p.amount,
      documentRef: i.invoiceId,
    },
    ...(toAr > 0n
      ? [
          {
            account: 'ACCOUNTS_RECEIVABLE' as const,
            assetId: asset,
            amount: -toAr,
            counterpartyId: `payer:${i.payer.name}`,
            documentRef: i.invoiceId,
          },
        ]
      : []),
    ...(excess > 0n
      ? [
          {
            account: 'REFUND_LIABILITY' as const,
            assetId: asset,
            amount: -excess,
            counterpartyId: `payer:${p.payer.toLowerCase()}`,
            documentRef: i.invoiceId,
          },
        ]
      : []),
  ];
  return {
    invoice,
    applied: true,
    entry: {
      entryId: `je_${i.invoiceId}_${p.txHash.slice(2, 14)}_${p.logIndex}`,
      workspaceId: i.workspaceId,
      occurredAt: now,
      memo: `Payment for ${i.number}${excess > 0n ? ` (overpaid by ${excess} units: refund owed)` : ''}`,
      source: { kind: 'CHAIN_TX', ref: i.invoiceId },
      evidence: {
        chainId: p.chainId,
        txHash: p.txHash,
        logIndex: p.logIndex,
        recipient: p.recipient,
      },
      idempotencyKey: key,
      postings,
      reversalOf: null,
    },
  };
}

/** A credit note is its own document; the invoice terms stay untouched. */
export function creditInvoice(
  i: Invoice,
  amount: bigint,
  reason: string,
  now: number,
): {
  invoice: Invoice;
  note: CreditNote;
  entry: JournalEntry;
} {
  if (i.status === 'DRAFT' || i.status === 'VOID')
    throw new InvoiceError('WRONG_STATE', i.status);
  if (amount <= 0n || amount > amountDue(i))
    throw new InvoiceError('CREDIT_TOO_LARGE', String(amount));
  const note: CreditNote = Object.freeze({
    creditNoteId: `crn_${randomBytes(8).toString('hex')}`,
    invoiceId: i.invoiceId,
    invoiceVersion: i.version,
    amount,
    reason,
    at: now,
  });
  const credited = i.credited + amount;
  const remaining = i.total - credited - i.paid;
  return {
    note,
    invoice: Object.freeze({
      ...i,
      credited,
      creditNoteIds: [...i.creditNoteIds, note.creditNoteId],
      status:
        remaining > 0n
          ? i.paid > 0n
            ? 'PARTIALLY_PAID'
            : 'ISSUED'
          : remaining === 0n
            ? 'PAID'
            : 'OVERPAID',
    }),
    entry: {
      entryId: `je_${note.creditNoteId}`,
      workspaceId: i.workspaceId,
      occurredAt: now,
      memo: `Credit note for ${i.number}: ${reason}`,
      source: { kind: 'INVOICE', ref: note.creditNoteId },
      evidence: null,
      idempotencyKey: `credit:${note.creditNoteId}`,
      postings: [
        {
          account: 'REVENUE',
          assetId: i.asset.assetId,
          amount,
          documentRef: note.creditNoteId,
        },
        {
          account: 'ACCOUNTS_RECEIVABLE',
          assetId: i.asset.assetId,
          amount: -amount,
          counterpartyId: `payer:${i.payer.name}`,
          documentRef: i.invoiceId,
        },
      ],
      reversalOf: null,
    },
  };
}

export * from './service.js';
