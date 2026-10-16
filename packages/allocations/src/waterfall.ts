import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import {
  assessPayable,
  verifiedAddress,
  type Obligation,
  type RiskFlag,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import { hashOf, type RevenuePolicy } from './policy.js';

/**
 * The cash model and the post-receipt waterfall.
 *
 * Money is integer base units of one registry asset. The treasury's position
 * keeps separate buckets: finalized on-chain cash, reservations already held,
 * committed outgoing payments (signed, not yet final), escrow liabilities and
 * refunds owed (restricted), invested balances (not liquid), and receivables
 * (expected, never spendable). Only `availableLiquidity` can fund anything.
 *
 * `computeWaterfall` turns one final receipt into an ordered plan of legs:
 * tax estimate reservation → contractor payables due → upcoming bills →
 * operating floor top-up → fixed distributions → percentage distributions of
 * the surplus → free cash. Every leg is integer; rounding dust goes to the
 * free-cash remainder so the legs always sum to the receipt exactly. The plan
 * is a proposal: nothing moves until each transfer leg is authorized by the
 * Kernel under the owner's signed mandate.
 */

export class AllocationError extends Error {
  constructor(
    readonly code:
      | 'RECEIPT_NOT_FINAL'
      | 'WRONG_ASSET'
      | 'WRONG_TREASURY'
      | 'STALE_BALANCE'
      | 'BALANCE_BEFORE_RECEIPT'
      | 'OVER_COMMITTED'
      | 'CONSERVATION'
      | 'DUPLICATE_RECEIPT'
      | 'WRONG_STATE'
      | 'CONFLICT'
      | 'NOT_FOUND'
      | 'LEG_NOT_PAYABLE',
    message: string = code,
  ) {
    super(message);
    this.name = 'AllocationError';
  }
}

/** One finalized incoming payment (Memo invoice payment or CCTP mint). */
export type FinalReceipt = Readonly<{
  /** `chain:<id>:<tx>:<log>`: the same key the ledger uses for the cash entry. */
  receiptId: string;
  chainId: number;
  token: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  amount: bigint;
  /** Account credited (must be the policy treasury). */
  recipient: Address;
  payer: Address;
  invoiceId: string;
  invoiceNumber: string;
  source: 'MEMO_INVOICE' | 'CCTP_MINT';
  /** FINAL only after the receipt was re-read at a finalized block. */
  finality: 'FINAL' | 'PENDING';
}>;

export const receiptKey = (chainId: number, txHash: Hex, logIndex: number) =>
  `chain:${chainId}:${txHash.toLowerCase()}:${logIndex}`;

/** The treasury's cash buckets at one observation. */
export type CashPosition = Readonly<{
  treasury: Address;
  /** Token balance of the treasury at a finalized block. */
  onChainFinalized: bigint;
  observedBlock: bigint;
  /** Unix seconds of the observation. */
  observedAt: number;
  source: string;
  /** Active cash reservations held before this receipt. */
  reservations: bigint;
  /** Signed or broadcast outgoing payments not yet final. */
  committedOutgoing: bigint;
  /** Deal escrow held in the treasury (restricted). */
  escrowLiabilities: bigint;
  /** Overpayment refunds owed (restricted). */
  refundLiabilities: bigint;
  /** Yield positions: valued separately, never liquid cash. */
  invested: bigint;
  /**
   * This workspace's own cash in the treasury, from its ledger (a cash
   * sub-ledger). When the treasury is shared, the workspace can never spend
   * more than its own booked cash minus its own holds, whatever is on chain.
   */
  workspaceCash?: bigint;
  /** Active holds of this workspace only (included in `reservations`). */
  workspaceReservations?: bigint;
}>;

/**
 * Cash that can fund anything: the lower of (finalized treasury cash minus
 * every hold on the treasury, any workspace) and (this workspace's booked
 * cash minus its own holds), each also minus in-flight payments, escrow and
 * refunds owed.
 */
export function availableLiquidity(p: CashPosition): bigint {
  const restricted =
    p.committedOutgoing + p.escrowLiabilities + p.refundLiabilities;
  const held = p.reservations + restricted;
  if (held > p.onChainFinalized)
    throw new AllocationError(
      'OVER_COMMITTED',
      `${held} held > ${p.onChainFinalized} finalized cash`,
    );
  const chainFree = p.onChainFinalized - held;
  if (p.workspaceCash === undefined) return chainFree;
  const own = (p.workspaceReservations ?? 0n) + restricted;
  if (own > p.workspaceCash)
    throw new AllocationError(
      'OVER_COMMITTED',
      `${own} held > ${p.workspaceCash} of this workspace's booked cash`,
    );
  const ownFree = p.workspaceCash - own;
  return ownFree < chainFree ? ownFree : chainFree;
}

/** An open receivable: expected money, never spendable until it is a final receipt. */
export type Receivable = Readonly<{
  invoiceId: string;
  number: string;
  payer: string;
  amountDue: bigint;
  dueOn: string;
  /** Days late on this payer's past invoices (empty when no history). */
  payerDaysLate: readonly number[];
}>;

export type RecurringBill = Readonly<{
  billId: string;
  label: string;
  kind: 'BILL' | 'PAYROLL' | 'RENT' | 'SUBSCRIPTION';
  amount: bigint;
  nextDueOn: string;
  cadenceDays: number;
}>;

export type LegKind = 'RESERVE' | 'TRANSFER' | 'FREE_CASH';
export type LegPurpose =
  | 'TAX_ESTIMATE'
  | 'CONTRACTOR_PAYABLE'
  | 'PAYABLE_HELD'
  | 'UPCOMING_BILL'
  | 'OPERATING_FLOOR'
  | 'DISTRIBUTION'
  | 'UNALLOCATED';

export type AllocationLeg = Readonly<{
  legIndex: number;
  /** `<receiptId>#<legIndex>`: the idempotency key of everything this leg does. */
  legKey: string;
  kind: LegKind;
  purpose: LegPurpose;
  amount: bigint;
  /** Vendor-master id of the payee (TRANSFER legs only). */
  beneficiaryId: string | null;
  payTo: Address | null;
  /** Vendor invoice / bill / distribution the leg settles or holds for. */
  documentRef: string | null;
  /** Kernel obligation ref: the same vendor invoice is never granted twice. */
  obligationRef: string | null;
  /** What the leg's hold is for (`bill:<id>@<date>`, `payable:<id>`, `tax:<receipt>`, `floor:<leg>`). */
  holdKey: string | null;
  dueOn: string | null;
  autonomy: 'AUTONOMOUS' | 'OWNER_APPROVAL_REQUIRED' | 'NOT_A_TRANSFER';
  basis: string;
  flags: readonly RiskFlag[];
}>;

export type Shortfall = Readonly<{
  purpose: LegPurpose;
  ref: string;
  needed: bigint;
  reason: string;
}>;

export type AllocationPlan = Readonly<{
  receiptId: string;
  invoiceId: string;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  asOf: number;
  receiptAmount: bigint;
  legs: readonly AllocationLeg[];
  /** Amount of the FREE_CASH leg (includes all rounding dust). */
  remainder: bigint;
  shortfalls: readonly Shortfall[];
  position: Readonly<{
    onChainFinalized: bigint;
    availableBefore: bigint;
    freeOutsideReceipt: bigint;
    reservations: bigint;
    committedOutgoing: bigint;
    escrowLiabilities: bigint;
    refundLiabilities: bigint;
    invested: bigint;
    observedBlock: bigint;
    observedAt: number;
    source: string;
  }>;
  /** Shown, never allocated. */
  excluded: Readonly<{
    receivablesNotSpendable: bigint;
    openReceivables: number;
    invested: bigint;
    escrowLiabilities: bigint;
  }>;
  planHash: Hex;
}>;

export const DAY_SECONDS = 86_400;
export const isoDay = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10);
export const dayNumber = (iso: string) =>
  Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export const daysBetween = (from: string, to: string) =>
  dayNumber(to) - dayNumber(from);

/** Every due date of `bill` within [today, today + horizon]. */
export function billOccurrences(
  bill: RecurringBill,
  today: string,
  horizonDays: number,
): string[] {
  if (bill.cadenceDays < 1) return [];
  const out: string[] = [];
  let d = dayNumber(bill.nextDueOn);
  const start = dayNumber(today);
  while (d < start) d += bill.cadenceDays;
  for (; d <= start + horizonDays; d += bill.cadenceDays)
    out.push(new Date(d * 86_400_000).toISOString().slice(0, 10));
  return out;
}

const mulBps = (amount: bigint, bps: number) =>
  (amount * BigInt(bps)) / 10_000n;

/** Fixed-point display for explanations: `1500000000n, 6` → `1500.00`. */
export function units(amount: bigint, decimals: number, min = 2): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  let frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < min) frac = frac.padEnd(min, '0');
  return `${neg ? '-' : ''}${a / base}${frac ? `.${frac}` : ''}`;
}

export type WaterfallInput = Readonly<{
  policy: RevenuePolicy;
  policyHash: Hex;
  receipt: FinalReceipt;
  position: CashPosition;
  /** Unix seconds. */
  asOf: number;
  vendors: readonly Vendor[];
  /** Open (unpaid, unscheduled) vendor invoices. */
  payables: readonly VendorInvoice[];
  /** All vendor invoices ever received, for duplicate checks. */
  payableHistory: readonly VendorInvoice[];
  obligations: readonly Obligation[];
  bills: readonly RecurringBill[];
  receivables: readonly Receivable[];
  /** Holds this workspace already has on the treasury: never planned twice. */
  held?: Readonly<{
    /** Bill occurrences already held or paid (`bill:<id>@<date>`). */
    billKeys: ReadonlySet<string>;
    /** Operating-floor holds already active. */
    floorReserved: bigint;
  }>;
}>;

/**
 * Deterministic: the same inputs give the same plan and `planHash`. Throws
 * when the receipt is not final, the asset or treasury differ from the
 * policy, or the balance is stale or predates the receipt.
 */
export function computeWaterfall(input: WaterfallInput): AllocationPlan {
  const { policy: p, receipt: r, position: pos } = input;
  if (r.finality !== 'FINAL')
    throw new AllocationError('RECEIPT_NOT_FINAL', r.receiptId);
  if (r.chainId !== p.chainId || getAddress(r.token) !== p.token)
    throw new AllocationError('WRONG_ASSET', `${r.chainId}/${r.token}`);
  if (
    getAddress(r.recipient) !== p.treasury ||
    getAddress(pos.treasury) !== p.treasury
  )
    throw new AllocationError(
      'WRONG_TREASURY',
      `receipt to ${r.recipient}, position of ${pos.treasury}, policy treasury ${p.treasury}`,
    );
  if (input.asOf - pos.observedAt > p.maxBalanceAgeSeconds)
    throw new AllocationError(
      'STALE_BALANCE',
      `balance observed ${input.asOf - pos.observedAt}s ago (max ${p.maxBalanceAgeSeconds}s)`,
    );
  if (pos.observedBlock < r.blockNumber)
    throw new AllocationError(
      'BALANCE_BEFORE_RECEIPT',
      `balance at block ${pos.observedBlock} predates receipt block ${r.blockNumber}`,
    );
  if (r.amount <= 0n)
    throw new AllocationError('CONSERVATION', 'empty receipt');
  const availableBefore = availableLiquidity(pos);
  if (availableBefore < r.amount)
    throw new AllocationError(
      'OVER_COMMITTED',
      `available ${availableBefore} < receipt ${r.amount}: the receipt is already spoken for`,
    );
  const freeOutsideReceipt = availableBefore - r.amount;
  const today = isoDay(input.asOf);
  const horizonEnd = dayNumber(today) + p.obligationHorizonDays;
  const d = p.decimals;
  const allowed = new Map(
    p.allowedBeneficiaries.map((b) => [b.beneficiaryId, b]),
  );

  type Draft = Omit<AllocationLeg, 'legIndex' | 'legKey'>;
  const drafts: Draft[] = [];
  const shortfalls: Shortfall[] = [];
  let remaining = r.amount;
  const take = (draft: Draft) => {
    if (draft.amount <= 0n) return;
    if (draft.amount > remaining)
      throw new AllocationError('CONSERVATION', `${draft.purpose} overdraws`);
    remaining -= draft.amount;
    drafts.push(draft);
  };
  const reserve = (
    purpose: LegPurpose,
    amount: bigint,
    basis: string,
    extra: Partial<Draft> = {},
  ): Draft => ({
    kind: 'RESERVE',
    purpose,
    amount,
    beneficiaryId: null,
    payTo: null,
    documentRef: null,
    obligationRef: null,
    dueOn: null,
    holdKey: null,
    autonomy: 'NOT_A_TRANSFER',
    basis,
    flags: [],
    ...extra,
  });

  // 1. Tax estimate: a reservation on our own cash, not a remittance.
  if (p.taxReserveBps > 0) {
    const tax = mulBps(r.amount, p.taxReserveBps);
    take(
      reserve(
        'TAX_ESTIMATE',
        tax,
        `${(p.taxReserveBps / 100).toFixed(2)}% of the ${units(r.amount, d)} gross receipt, held as an estimate (no transfer, not a tax payment)`,
        { holdKey: `tax:${r.receiptId}` },
      ),
    );
  }

  // 2. Contractor payables due within the horizon, earliest first.
  const due = [...input.payables]
    .filter((i) => i.chainId === p.chainId && dayNumber(i.dueOn) <= horizonEnd)
    .sort((a, b) =>
      a.dueOn === b.dueOn
        ? a.vendorInvoiceId.localeCompare(b.vendorInvoiceId)
        : a.dueOn.localeCompare(b.dueOn),
    );
  for (const inv of due) {
    const vendor = input.vendors.find((v) => v.vendorId === inv.vendorId);
    if (inv.amount > remaining) {
      shortfalls.push({
        purpose: 'CONTRACTOR_PAYABLE',
        ref: inv.vendorInvoiceId,
        needed: inv.amount,
        reason: `${units(inv.amount, d)} due ${inv.dueOn} exceeds the ${units(remaining, d)} left of this receipt`,
      });
      continue;
    }
    const obligation =
      input.obligations.find((o) => o.reference === inv.reference) ?? null;
    const assessed = vendor
      ? assessPayable({
          vendor,
          invoice: inv,
          history: input.payableHistory,
          obligation,
          availableCash: remaining,
          today,
        })
      : {
          flags: [
            {
              code: 'UNKNOWN_VENDOR',
              severity: 'HARD' as const,
              detail: `${inv.vendorId} is not in the vendor master`,
            },
          ],
          payTo: null,
        };
    const flags = [...assessed.flags];
    if (!inv.token)
      flags.push({
        code: 'ASSET_UNSPECIFIED',
        severity: 'HARD',
        detail: `${inv.number} does not name its token`,
      });
    else if (
      getAddress(inv.token) !== p.token ||
      (inv.decimals !== undefined && inv.decimals !== p.decimals)
    )
      flags.push({
        code: 'WRONG_ASSET',
        severity: 'HARD',
        detail: `${inv.number} is in ${inv.token}/${inv.decimals ?? '?'} decimals, the policy pays ${p.token}/${p.decimals}`,
      });
    const verified = vendor ? verifiedAddress(vendor, p.chainId) : null;
    const listed = allowed.get(inv.vendorId);
    if (!listed)
      flags.push({
        code: 'NOT_ALLOWED_BENEFICIARY',
        severity: 'HARD',
        detail: `${inv.vendorId} is not an allowed beneficiary of policy ${p.policyId} v${p.version}`,
      });
    else if (!verified || getAddress(verified) !== listed.address)
      flags.push({
        code: 'BENEFICIARY_UNVERIFIED',
        severity: 'HARD',
        detail: `policy pays ${listed.address}; vendor master verified ${verified ?? 'nothing'}`,
      });
    const hard = flags.some((f) => f.severity === 'HARD');
    const basis = `${vendor?.name ?? inv.vendorId} invoice ${inv.number}, due ${inv.dueOn}`;
    if (hard)
      take(
        reserve('PAYABLE_HELD', inv.amount, `${basis}: held, not paid`, {
          documentRef: inv.vendorInvoiceId,
          obligationRef: `payable:${inv.vendorInvoiceId}`,
          holdKey: `payable:${inv.vendorInvoiceId}`,
          dueOn: inv.dueOn,
          beneficiaryId: inv.vendorId,
          flags,
        }),
      );
    else
      take({
        kind: 'TRANSFER',
        purpose: 'CONTRACTOR_PAYABLE',
        amount: inv.amount,
        beneficiaryId: inv.vendorId,
        payTo: listed!.address,
        documentRef: inv.vendorInvoiceId,
        obligationRef: `payable:${inv.vendorInvoiceId}`,
        holdKey: `payable:${inv.vendorInvoiceId}`,
        dueOn: inv.dueOn,
        autonomy:
          inv.amount > p.limits.maxAutonomousPerLeg
            ? 'OWNER_APPROVAL_REQUIRED'
            : 'AUTONOMOUS',
        basis,
        flags,
      });
  }

  // 3. Bills and payroll falling due within the horizon, one hold per
  //    occurrence; an occurrence already held (or paid) is not held again.
  const heldBills = input.held?.billKeys ?? new Set<string>();
  for (const bill of [...input.bills].sort((a, b) =>
    a.billId.localeCompare(b.billId),
  ))
    for (const date of billOccurrences(bill, today, p.obligationHorizonDays)) {
      const holdKey = `bill:${bill.billId}@${date}`;
      if (heldBills.has(holdKey)) continue;
      const amount = bill.amount <= remaining ? bill.amount : remaining;
      if (amount < bill.amount)
        shortfalls.push({
          purpose: 'UPCOMING_BILL',
          ref: holdKey,
          needed: bill.amount - amount,
          reason: `${bill.label} due ${date}: ${units(bill.amount - amount, d)} not covered by this receipt`,
        });
      take(
        reserve(
          'UPCOMING_BILL',
          amount,
          `${bill.label} (${bill.kind.toLowerCase()}) ${units(bill.amount, d)} due ${date}`,
          { documentRef: bill.billId, dueOn: date, holdKey },
        ),
      );
    }

  // 4. Operating floor: top up only what free cash outside this receipt and
  //    the floor already held lack.
  const floorReserved = input.held?.floorReserved ?? 0n;
  const floorHave = freeOutsideReceipt + floorReserved;
  const floorNeed =
    p.operatingFloor > floorHave ? p.operatingFloor - floorHave : 0n;
  if (floorNeed > 0n) {
    const amount = floorNeed <= remaining ? floorNeed : remaining;
    if (amount < floorNeed)
      shortfalls.push({
        purpose: 'OPERATING_FLOOR',
        ref: 'operating-floor',
        needed: floorNeed - amount,
        reason: `floor ${units(p.operatingFloor, d)} not met: ${units(floorNeed - amount, d)} short`,
      });
    take(
      reserve(
        'OPERATING_FLOOR',
        amount,
        `operating floor ${units(p.operatingFloor, d)} minus ${units(freeOutsideReceipt, d)} free cash and ${units(floorReserved, d)} floor already held`,
      ),
    );
  }

  // 5-6. Distributions, only from surplus once obligations and the floor are covered.
  const floorShort = shortfalls.length > 0;
  const transferLeg = (
    dist: { label: string; beneficiaryId: string },
    amount: bigint,
    basis: string,
  ): Draft => {
    const b = allowed.get(dist.beneficiaryId)!;
    const vendor = input.vendors.find((v) => v.vendorId === b.beneficiaryId);
    const verified = vendor ? verifiedAddress(vendor, p.chainId) : null;
    const flags: RiskFlag[] =
      verified && getAddress(verified) === b.address
        ? []
        : [
            {
              code: 'BENEFICIARY_UNVERIFIED',
              severity: 'HARD',
              detail: `${b.beneficiaryId}: vendor master verified ${verified ?? 'nothing'}, policy pays ${b.address}`,
            },
          ];
    if (flags.length)
      return reserve('DISTRIBUTION', amount, `${basis}: held`, {
        beneficiaryId: b.beneficiaryId,
        documentRef: dist.label,
        flags,
      });
    return {
      kind: 'TRANSFER',
      purpose: 'DISTRIBUTION',
      amount,
      beneficiaryId: b.beneficiaryId,
      payTo: b.address,
      documentRef: dist.label,
      obligationRef: null,
      holdKey: null,
      dueOn: null,
      autonomy:
        amount > p.limits.maxAutonomousPerLeg
          ? 'OWNER_APPROVAL_REQUIRED'
          : 'AUTONOMOUS',
      basis,
      flags,
    };
  };
  if (!floorShort) {
    for (const dist of p.distributions)
      if (dist.kind === 'FIXED') {
        if (dist.amount > remaining) {
          shortfalls.push({
            purpose: 'DISTRIBUTION',
            ref: dist.label,
            needed: dist.amount,
            reason: `fixed ${units(dist.amount, d)} exceeds the ${units(remaining, d)} surplus`,
          });
          continue;
        }
        take(
          transferLeg(
            dist,
            dist.amount,
            `${dist.label}: fixed ${units(dist.amount, d)}`,
          ),
        );
      }
    const surplus = remaining;
    for (const dist of p.distributions)
      if (dist.kind === 'PERCENT_OF_SURPLUS')
        take(
          transferLeg(
            dist,
            mulBps(surplus, dist.bps),
            `${dist.label}: ${(dist.bps / 100).toFixed(2)}% of the ${units(surplus, d)} surplus (rounded down)`,
          ),
        );
  }

  // 7. Remainder: unallocated surplus and all rounding dust stay free cash.
  drafts.push({
    kind: 'FREE_CASH',
    purpose: 'UNALLOCATED',
    amount: remaining,
    beneficiaryId: null,
    payTo: null,
    documentRef: null,
    obligationRef: null,
    holdKey: null,
    dueOn: null,
    autonomy: 'NOT_A_TRANSFER',
    basis:
      'remainder after all rules, including rounding dust; stays in the treasury as free cash',
    flags: [],
  });

  const legs: AllocationLeg[] = drafts.map((x, i) => {
    const legKey = `${r.receiptId}#${i}`;
    return {
      ...x,
      legIndex: i,
      legKey,
      holdKey:
        x.holdKey ??
        (x.purpose === 'OPERATING_FLOOR'
          ? `floor:${legKey}`
          : x.kind === 'FREE_CASH'
            ? null
            : `leg:${legKey}`),
    };
  });
  const total = legs.reduce((a, l) => a + l.amount, 0n);
  if (total !== r.amount)
    throw new AllocationError('CONSERVATION', `${total} != ${r.amount}`);
  const receivablesNotSpendable = input.receivables.reduce(
    (a, x) => a + x.amountDue,
    0n,
  );
  const body = {
    receiptId: r.receiptId,
    invoiceId: r.invoiceId,
    policyId: p.policyId,
    policyVersion: p.version,
    policyHash: input.policyHash,
    asOf: input.asOf,
    receiptAmount: r.amount,
    legs,
    remainder: remaining,
    shortfalls,
    position: {
      onChainFinalized: pos.onChainFinalized,
      availableBefore,
      freeOutsideReceipt,
      reservations: pos.reservations,
      committedOutgoing: pos.committedOutgoing,
      escrowLiabilities: pos.escrowLiabilities,
      refundLiabilities: pos.refundLiabilities,
      invested: pos.invested,
      observedBlock: pos.observedBlock,
      observedAt: pos.observedAt,
      source: pos.source,
    },
    excluded: {
      receivablesNotSpendable,
      openReceivables: input.receivables.length,
      invested: pos.invested,
      escrowLiabilities: pos.escrowLiabilities,
    },
  };
  return Object.freeze({ ...body, planHash: hashOf(body) });
}

/** Sum of legs by kind/purpose, for summaries and tests. */
export function totals(plan: AllocationPlan) {
  const by = (f: (l: AllocationLeg) => boolean) =>
    plan.legs.filter(f).reduce((a, l) => a + l.amount, 0n);
  return {
    taxReserve: by((l) => l.purpose === 'TAX_ESTIMATE'),
    payables: by((l) => l.purpose === 'CONTRACTOR_PAYABLE'),
    payablesHeld: by((l) => l.purpose === 'PAYABLE_HELD'),
    bills: by((l) => l.purpose === 'UPCOMING_BILL'),
    operatingFloor: by((l) => l.purpose === 'OPERATING_FLOOR'),
    distributions: by((l) => l.purpose === 'DISTRIBUTION'),
    transfers: by((l) => l.kind === 'TRANSFER'),
    reserved: by((l) => l.kind === 'RESERVE'),
    freeCash: plan.remainder,
  };
}
