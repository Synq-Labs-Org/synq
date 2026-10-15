import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { JournalEntry, VendorDirectory } from '@synq/ledger';

/**
 * Accounts payable and the contractor network.
 *
 * The vendor master holds each vendor's *verified* payout address per chain,
 * with history. A new address arriving through chat, email or an invoice is a
 * pending change: it pays nothing until verified out of band (a signed
 * challenge from the previously verified wallet, or an owner confirmation
 * through a separate channel). `assessPayable` turns that and the other
 * controls (duplicate invoices, PO/milestone match, cash after reservations)
 * into deterministic risk flags the Kernel consumes; it never moves money.
 */

export type VendorAddress = Readonly<{
  chainId: number;
  address: Address;
  status: 'VERIFIED' | 'PENDING' | 'REJECTED' | 'RETIRED';
  source: string;
  at: number;
  verifiedBy: string | null;
}>;

export type Vendor = Readonly<{
  vendorId: string;
  workspaceId: string;
  name: string;
  kind: 'CONTRACTOR' | 'VENDOR';
  addresses: readonly VendorAddress[];
}>;

export type VendorInvoice = Readonly<{
  vendorInvoiceId: string;
  vendorId: string;
  number: string;
  /** Address the invoice asks to be paid at (may differ from the master). */
  payTo: Address;
  chainId: number;
  amount: bigint;
  issuedOn: string;
  dueOn: string;
  /** PO / milestone the work belongs to, if any. */
  reference: string | null;
  /** Normalised extracted text of the document, for near-duplicate checks. */
  documentText: string;
  earlyPayDiscountBps: number;
  earlyPayByDays: number;
}>;

export type Obligation = Readonly<{
  reference: string;
  vendorId: string;
  approvedAmount: bigint;
  status: 'APPROVED' | 'DELIVERED' | 'ACCEPTED' | 'DISPUTED' | 'PAID';
}>;

export type RiskFlag = Readonly<{
  code: string;
  severity: 'HARD' | 'SOFT';
  detail: string;
}>;

const lower = (a: string) => a.toLowerCase();

export function verifiedAddress(v: Vendor, chainId: number): Address | null {
  const hits = v.addresses.filter(
    (a) => a.chainId === chainId && a.status === 'VERIFIED',
  );
  return hits.length ? hits[hits.length - 1]!.address : null;
}

export function vendorDirectory(vendors: readonly Vendor[]): VendorDirectory {
  return {
    verifiedPayout: (counterpartyId, chainId) => {
      const v = vendors.find((x) => `vendor:${x.vendorId}` === counterpartyId);
      return v ? verifiedAddress(v, chainId) : null;
    },
  };
}

/** Any new payout address enters as PENDING; it is never auto-trusted. */
export function proposeAddress(
  v: Vendor,
  chainId: number,
  address: Address,
  source: string,
  at: number,
): Vendor {
  if (
    v.addresses.some(
      (a) => a.chainId === chainId && lower(a.address) === lower(address),
    )
  )
    return v;
  return {
    ...v,
    addresses: [
      ...v.addresses,
      { chainId, address, status: 'PENDING', source, at, verifiedBy: null },
    ],
  };
}

/**
 * Verification is an independent step: e.g. the vendor signs a challenge with
 * the *previously verified* wallet, or the owner confirms via a separate,
 * pre-registered channel. Verifying retires the old address.
 */
export function verifyAddress(
  v: Vendor,
  chainId: number,
  address: Address,
  verifiedBy: string,
  at: number,
): Vendor {
  const target = v.addresses.find(
    (a) =>
      a.chainId === chainId &&
      lower(a.address) === lower(address) &&
      a.status === 'PENDING',
  );
  if (!target) throw new Error('no pending address to verify');
  return {
    ...v,
    addresses: v.addresses.map((a) =>
      a === target
        ? { ...a, status: 'VERIFIED', verifiedBy, at }
        : a.chainId === chainId && a.status === 'VERIFIED'
          ? { ...a, status: 'RETIRED', at }
          : a,
    ),
  };
}

/** Number with formatting noise removed: "INV #0042", "inv-42" and "INV 42" collide. */
export const normalizeNumber = (n: string) =>
  n
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^(inv|invoice|bill)/, '')
    .replace(/^0+/, '');

const shingles = (t: string) => {
  const w = t
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++)
    s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return s;
};
function similarity(a: string, b: string) {
  const x = shingles(a),
    y = shingles(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const s of x) if (y.has(s)) inter++;
  return inter / (x.size + y.size - inter);
}

export const documentHash = (text: string): Hex =>
  `0x${createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex')}`;

/**
 * Deterministic AP controls for one vendor invoice. HARD flags block payment
 * (the Kernel denies); SOFT flags are disclosed and may require review.
 */
export function assessPayable(input: {
  vendor: Vendor;
  invoice: VendorInvoice;
  history: readonly VendorInvoice[];
  obligation: Obligation | null;
  availableCash: bigint;
  today: string;
}): { flags: RiskFlag[]; payTo: Address | null } {
  const { vendor: v, invoice: i } = input;
  const flags: RiskFlag[] = [];
  const verified = verifiedAddress(v, i.chainId);
  if (!verified)
    flags.push({
      code: 'NO_VERIFIED_PAYOUT',
      severity: 'HARD',
      detail: `${v.name} has no verified payout address on chain ${i.chainId}`,
    });
  else if (lower(verified) !== lower(i.payTo))
    flags.push({
      code: 'PAYOUT_ADDRESS_CHANGED',
      severity: 'HARD',
      detail: `invoice asks for ${i.payTo}; ${v.name}'s verified address is ${verified}. Verify the change independently before paying.`,
    });
  for (const h of input.history) {
    if (h.vendorInvoiceId === i.vendorInvoiceId || h.vendorId !== i.vendorId)
      continue;
    const sameNumber = normalizeNumber(h.number) === normalizeNumber(i.number);
    const sameAmount = h.amount === i.amount;
    const sameDoc =
      documentHash(h.documentText) === documentHash(i.documentText);
    const nearDoc = similarity(h.documentText, i.documentText) >= 0.8;
    if (sameDoc || (sameNumber && sameAmount))
      flags.push({
        code: 'DUPLICATE_INVOICE',
        severity: 'HARD',
        detail: `matches ${h.number} (${h.vendorInvoiceId})`,
      });
    else if (sameNumber || (sameAmount && nearDoc))
      flags.push({
        code: 'POSSIBLE_DUPLICATE',
        severity: 'HARD',
        detail: `resembles ${h.number} (${h.vendorInvoiceId}); confirm before paying`,
      });
  }
  if (i.reference) {
    const o = input.obligation;
    if (!o || o.reference !== i.reference || o.vendorId !== i.vendorId)
      flags.push({
        code: 'NO_MATCHING_OBLIGATION',
        severity: 'HARD',
        detail: `no approved PO/milestone ${i.reference} for ${v.name}`,
      });
    else if (o.status === 'DISPUTED')
      flags.push({
        code: 'MILESTONE_DISPUTED',
        severity: 'HARD',
        detail: `${o.reference} is disputed`,
      });
    else if (o.status !== 'ACCEPTED')
      flags.push({
        code: 'DELIVERY_NOT_ACCEPTED',
        severity: 'HARD',
        detail: `${o.reference} is ${o.status}, not accepted`,
      });
    else if (i.amount > o.approvedAmount)
      flags.push({
        code: 'AMOUNT_EXCEEDS_OBLIGATION',
        severity: 'HARD',
        detail: `${i.amount} > approved ${o.approvedAmount}`,
      });
  } else
    flags.push({
      code: 'NO_PO_REFERENCE',
      severity: 'SOFT',
      detail: 'invoice references no PO or milestone',
    });
  if (i.amount > input.availableCash)
    flags.push({
      code: 'INSUFFICIENT_FREE_CASH',
      severity: 'HARD',
      detail: `${i.amount} > free cash ${input.availableCash}`,
    });
  if (i.dueOn < input.today)
    flags.push({ code: 'OVERDUE', severity: 'SOFT', detail: `due ${i.dueOn}` });
  return { flags, payTo: verified };
}

/** Days between two ISO dates (UTC). */
const days = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );

/**
 * Timing advice the CFO agent can explain: pay early only for a discount when
 * free cash after the payment stays above the reserve floor; otherwise pay on
 * the due date. Deterministic, so the explanation is reproducible.
 */
export function paymentTiming(input: {
  invoice: VendorInvoice;
  today: string;
  freeCash: bigint;
  reserveFloor: bigint;
}): {
  action: 'PAY_EARLY' | 'PAY_ON_DUE_DATE' | 'HOLD';
  payOn: string;
  saving: bigint;
  reason: string;
} {
  const { invoice: i } = input;
  const discount = (i.amount * BigInt(i.earlyPayDiscountBps)) / 10_000n;
  const deadline = new Date(
    Date.parse(`${i.issuedOn}T00:00:00Z`) + i.earlyPayByDays * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const after = input.freeCash - (i.amount - discount);
  if (input.freeCash - i.amount < 0n)
    return {
      action: 'HOLD',
      payOn: i.dueOn,
      saving: 0n,
      reason: 'free cash does not cover this invoice',
    };
  if (discount > 0n && input.today <= deadline && after >= input.reserveFloor)
    return {
      action: 'PAY_EARLY',
      payOn: input.today,
      saving: discount,
      reason: `pay by ${deadline} for ${i.earlyPayDiscountBps / 100}% off; reserve floor still covered`,
    };
  return {
    action: 'PAY_ON_DUE_DATE',
    payOn: i.dueOn,
    saving: 0n,
    reason:
      discount > 0n && after < input.reserveFloor
        ? 'early discount would breach the reserve floor'
        : 'no early-payment benefit',
  };
}

/** Late-payment report from verified dates only. */
export function lateReport(
  invoices: readonly VendorInvoice[],
  paidOn: Readonly<Record<string, string>>,
  today: string,
) {
  return invoices
    .map((i) => {
      const paid = paidOn[i.vendorInvoiceId] ?? null;
      const end = paid ?? today;
      const late = days(i.dueOn, end);
      return {
        vendorInvoiceId: i.vendorInvoiceId,
        number: i.number,
        dueOn: i.dueOn,
        paidOn: paid,
        daysLate: late > 0 ? late : 0,
      };
    })
    .filter((r) => r.daysLate > 0);
}

/** AP ledger entries: approve (expense/AP) and settle (AP/cash with chain evidence). */
export function apEntries(input: {
  workspaceId: string;
  vendor: Vendor;
  invoice: VendorInvoice;
  assetId: string;
  settlement: {
    txHash: Hex;
    logIndex: number;
    recipient: Address;
    feeBaseUnits: bigint;
  } | null;
  at: number;
}): JournalEntry[] {
  const cp = `vendor:${input.vendor.vendorId}`;
  const i = input.invoice;
  const approve: JournalEntry = {
    entryId: `je_ap_${i.vendorInvoiceId}_approve`,
    workspaceId: input.workspaceId,
    occurredAt: input.at,
    memo: `${input.vendor.name} invoice ${i.number} approved`,
    source: { kind: 'PAYABLE', ref: i.vendorInvoiceId },
    evidence: null,
    idempotencyKey: `payable:${i.vendorInvoiceId}:approve`,
    postings: [
      {
        account: 'CONTRACTOR_EXPENSE',
        assetId: input.assetId,
        amount: i.amount,
        counterpartyId: cp,
        documentRef: i.vendorInvoiceId,
      },
      {
        account: 'ACCOUNTS_PAYABLE',
        assetId: input.assetId,
        amount: -i.amount,
        counterpartyId: cp,
        documentRef: i.vendorInvoiceId,
      },
    ],
    reversalOf: null,
  };
  if (!input.settlement) return [approve];
  const s = input.settlement;
  return [
    approve,
    {
      entryId: `je_ap_${i.vendorInvoiceId}_settle`,
      workspaceId: input.workspaceId,
      occurredAt: input.at,
      memo: `${input.vendor.name} paid for ${i.number}`,
      source: { kind: 'CHAIN_TX', ref: i.vendorInvoiceId },
      evidence: {
        chainId: i.chainId,
        txHash: s.txHash,
        logIndex: s.logIndex,
        recipient: s.recipient,
      },
      idempotencyKey: `chain:${i.chainId}:${s.txHash.toLowerCase()}:${s.logIndex}`,
      postings: [
        {
          account: 'ACCOUNTS_PAYABLE',
          assetId: input.assetId,
          amount: i.amount,
          counterpartyId: cp,
          documentRef: i.vendorInvoiceId,
        },
        ...(s.feeBaseUnits > 0n
          ? [
              {
                account: 'NETWORK_FEES' as const,
                assetId: input.assetId,
                amount: s.feeBaseUnits,
              },
            ]
          : []),
        {
          account: 'CASH_ARC_USDC',
          assetId: input.assetId,
          amount: -(i.amount + s.feeBaseUnits),
        },
      ],
      reversalOf: null,
    },
  ];
}

type Sql = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

/** Vendor master persistence with a revision counter: a stale write never overwrites a verification. */
export interface VendorStore {
  get(vendorId: string): Promise<{ vendor: Vendor; rev: number } | null>;
  save(vendor: Vendor, expectedRev: number | null): Promise<number>;
  list(workspaceId: string): Promise<Vendor[]>;
}

export class VendorConflictError extends Error {
  constructor(vendorId: string) {
    super(`${vendorId} changed concurrently; reload and retry`);
    this.name = 'VendorConflictError';
  }
}

export class MemoryVendorStore implements VendorStore {
  private rows = new Map<string, { vendor: Vendor; rev: number }>();
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async save(vendor: Vendor, expectedRev: number | null) {
    if ((this.rows.get(vendor.vendorId)?.rev ?? null) !== expectedRev)
      throw new VendorConflictError(vendor.vendorId);
    const rev = (expectedRev ?? 0) + 1;
    this.rows.set(vendor.vendorId, { vendor, rev });
    return rev;
  }
  async list(workspaceId: string) {
    return [...this.rows.values()]
      .map((r) => r.vendor)
      .filter((v) => v.workspaceId === workspaceId);
  }
}

/** Uses table `synq_vendors` from the finance migrations (`migrateFinance`). */
export class PostgresVendorStore implements VendorStore {
  constructor(readonly sql: Sql) {}
  async get(id: string) {
    const r = await this.sql.query(
      'SELECT data, rev FROM synq_vendors WHERE vendor_id=$1',
      [id],
    );
    const x = r.rows[0];
    return x
      ? {
          vendor: (typeof x.data === 'string'
            ? JSON.parse(x.data)
            : x.data) as Vendor,
          rev: Number(x.rev),
        }
      : null;
  }
  async save(vendor: Vendor, expectedRev: number | null) {
    const data = JSON.stringify(vendor);
    const r =
      expectedRev === null
        ? await this.sql.query(
            `INSERT INTO synq_vendors (vendor_id, workspace_id, rev, data) VALUES ($1,$2,1,$3)
             ON CONFLICT (vendor_id) DO NOTHING RETURNING rev`,
            [vendor.vendorId, vendor.workspaceId, data],
          )
        : await this.sql.query(
            `UPDATE synq_vendors SET rev=rev+1, data=$2 WHERE vendor_id=$1 AND rev=$3 RETURNING rev`,
            [vendor.vendorId, data, expectedRev],
          );
    if (!r.rows[0]) throw new VendorConflictError(vendor.vendorId);
    return Number(r.rows[0].rev);
  }
  async list(workspaceId: string) {
    const r = await this.sql.query(
      'SELECT data FROM synq_vendors WHERE workspace_id=$1 ORDER BY vendor_id',
      [workspaceId],
    );
    return r.rows.map(
      (x) =>
        (typeof x.data === 'string' ? JSON.parse(x.data) : x.data) as Vendor,
    );
  }
}
