import type { VendorInvoice } from '@synq/payables';
import {
  availableLiquidity,
  billOccurrences,
  dayNumber,
  isoDay,
  type CashPosition,
  type Receivable,
  type RecurringBill,
} from './waterfall.js';

/**
 * 30/60/90-day cash projection from actual obligations.
 *
 * Outflows are real documents: open vendor invoices (AP) on their due dates
 * and each occurrence of a recurring bill or payroll run. Receivables are
 * never cash: `committedCash` excludes them entirely; `expectedCash` adds
 * only receivables in the EXPECTED band on their expected collection date;
 * AT_RISK receivables are listed and never counted. Three deterministic
 * scenarios: BASE, LATE_RECEIVABLES (every receivable slips) and
 * EXPENSE_SHOCK (outflows up by a fixed percentage). A yield deposit is
 * allowed only when every scenario keeps the floor through the lock period.
 */

export type Scenario = 'BASE' | 'LATE_RECEIVABLES' | 'EXPENSE_SHOCK';
export const SCENARIOS: readonly Scenario[] = [
  'BASE',
  'LATE_RECEIVABLES',
  'EXPENSE_SHOCK',
];

export type ScenarioParams = Readonly<{
  /** Days every receivable slips in LATE_RECEIVABLES. */
  lateShiftDays: number;
  /** Outflow increase in EXPENSE_SHOCK, basis points. */
  expenseShockBps: number;
}>;
export const DEFAULT_SCENARIO_PARAMS: ScenarioParams = {
  lateShiftDays: 45,
  expenseShockBps: 2_500,
};

export type CollectionBand = 'EXPECTED' | 'AT_RISK';

/**
 * Collection band of one receivable from its due date and the payer's
 * verified history. Probability is disclosed, never used to count cash.
 */
export function classifyReceivable(
  r: Receivable,
  today: string,
): {
  band: CollectionBand;
  expectedOn: string;
  probabilityBps: number;
  reason: string;
} {
  const hist = r.payerDaysLate;
  const avgLate = hist.length
    ? Math.ceil(hist.reduce((a, x) => a + x, 0) / hist.length)
    : 0;
  const overdue = dayNumber(today) - dayNumber(r.dueOn);
  const expected = Math.max(dayNumber(r.dueOn) + avgLate, dayNumber(today));
  const expectedOn = new Date(expected * 86_400_000).toISOString().slice(0, 10);
  if (overdue > 30)
    return {
      band: 'AT_RISK',
      expectedOn,
      probabilityBps: 3_000,
      reason: `${overdue} days overdue`,
    };
  if (avgLate > 30)
    return {
      band: 'AT_RISK',
      expectedOn,
      probabilityBps: 4_000,
      reason: `payer averages ${avgLate} days late`,
    };
  if (overdue > 0 && !hist.length)
    return {
      band: 'AT_RISK',
      expectedOn,
      probabilityBps: 5_000,
      reason: `overdue ${overdue} days, no payment history`,
    };
  return {
    band: 'EXPECTED',
    expectedOn,
    probabilityBps: avgLate > 0 ? 7_500 : 9_000,
    reason:
      avgLate > 0 ? `payer averages ${avgLate} days late` : 'on-time payer',
  };
}

export type CashEvent = Readonly<{
  day: string;
  kind: 'AP' | 'BILL' | 'AR_EXPECTED';
  ref: string;
  /** Signed base units: outflows negative. */
  amount: bigint;
}>;

export type HorizonPoint = Readonly<{
  days: number;
  through: string;
  outflows: bigint;
  /** Start cash minus every outflow through the horizon; receivables excluded. */
  committedCash: bigint;
  expectedInflows: bigint;
  /** committedCash + EXPECTED receivables collected by then (not spendable). */
  expectedCash: bigint;
  /** Lowest running expected balance on any day through the horizon. */
  lowPoint: bigint;
  atRiskInflows: bigint;
}>;

export type CashForecast = Readonly<{
  scenario: Scenario;
  asOf: string;
  /** Liquid cash today: finalized cash minus restricted buckets and held tax estimates. */
  startCash: bigint;
  /** Never added to startCash. */
  receivablesExcluded: bigint;
  points: readonly HorizonPoint[];
  events: readonly CashEvent[];
  atRisk: readonly { ref: string; amount: bigint; reason: string }[];
}>;

export function forecastCash(input: {
  asOf: number;
  position: CashPosition;
  /** Tax estimates already held: owed later, so not cash for planning. */
  heldForTax: bigint;
  payables: readonly VendorInvoice[];
  bills: readonly RecurringBill[];
  receivables: readonly Receivable[];
  scenario: Scenario;
  horizons?: readonly number[];
  params?: ScenarioParams;
}): CashForecast {
  const params = input.params ?? DEFAULT_SCENARIO_PARAMS;
  const horizons = input.horizons ?? [30, 60, 90];
  const max = Math.max(...horizons);
  const today = isoDay(input.asOf);
  const t0 = dayNumber(today);
  const pos = input.position;
  // Reservations are not subtracted here: the obligations they hold for are
  // projected as outflows below. Only restricted and in-flight money is.
  const startCash =
    availableLiquidity({
      ...pos,
      reservations: 0n,
      ...(pos.workspaceCash === undefined ? {} : { workspaceReservations: 0n }),
    }) - input.heldForTax;
  const shock = (a: bigint) =>
    input.scenario === 'EXPENSE_SHOCK'
      ? a + (a * BigInt(params.expenseShockBps)) / 10_000n
      : a;
  const events: CashEvent[] = [];
  for (const inv of input.payables) {
    const day = Math.max(dayNumber(inv.dueOn), t0);
    if (day - t0 <= max)
      events.push({
        day: isoDay(day * 86_400),
        kind: 'AP',
        ref: inv.vendorInvoiceId,
        amount: -shock(inv.amount),
      });
  }
  for (const b of input.bills)
    for (const day of billOccurrences(b, today, max))
      events.push({
        day,
        kind: 'BILL',
        ref: `${b.billId}@${day}`,
        amount: -shock(b.amount),
      });
  const atRisk: { ref: string; amount: bigint; reason: string }[] = [];
  for (const r of input.receivables) {
    const c = classifyReceivable(r, today);
    if (c.band === 'AT_RISK') {
      atRisk.push({ ref: r.invoiceId, amount: r.amountDue, reason: c.reason });
      continue;
    }
    const shift =
      input.scenario === 'LATE_RECEIVABLES' ? params.lateShiftDays : 0;
    const day = dayNumber(c.expectedOn) + shift;
    if (day - t0 <= max)
      events.push({
        day: isoDay(day * 86_400),
        kind: 'AR_EXPECTED',
        ref: r.invoiceId,
        amount: r.amountDue,
      });
  }
  // Same day: outflows first, so the low point is the conservative one.
  events.sort((a, b) =>
    a.day !== b.day
      ? a.day.localeCompare(b.day)
      : a.amount < b.amount
        ? -1
        : a.amount > b.amount
          ? 1
          : a.ref.localeCompare(b.ref),
  );
  const atRiskTotal = atRisk.reduce((a, x) => a + x.amount, 0n);
  const points = [...horizons]
    .sort((a, b) => a - b)
    .map((h): HorizonPoint => {
      const within = events.filter((e) => dayNumber(e.day) - t0 <= h);
      let running = startCash;
      let low = startCash;
      let outflows = 0n;
      let inflows = 0n;
      for (const e of within) {
        running += e.amount;
        if (running < low) low = running;
        if (e.amount < 0n) outflows -= e.amount;
        else inflows += e.amount;
      }
      return {
        days: h,
        through: isoDay((t0 + h) * 86_400),
        outflows,
        committedCash: startCash - outflows,
        expectedInflows: inflows,
        expectedCash: startCash - outflows + inflows,
        lowPoint: low,
        atRiskInflows: atRiskTotal,
      };
    });
  return {
    scenario: input.scenario,
    asOf: today,
    startCash,
    receivablesExcluded: input.receivables.reduce(
      (a, r) => a + r.amountDue,
      0n,
    ),
    points,
    events,
    atRisk,
  };
}

export type YieldGateInput = Readonly<{
  amount: bigint;
  /** Days until the deposit can be redeemed (lock + redemption lag). */
  lockDays: number;
  operatingFloor: bigint;
  /** Extra cushion over the floor, base units. */
  stressBuffer: bigint;
  /** One forecast per scenario, all built from the same position. */
  forecasts: readonly CashForecast[];
  /** False until AP, bills and payroll were imported from real records. */
  obligationsImported: boolean;
  forecastBuiltAt: number;
  now: number;
  maxForecastAgeSeconds: number;
  /** Any open escrow dispute or lock on the treasury. */
  activeDisputes: number;
  /** The product is on the venue allowlist and the account is eligible. */
  productEligible: boolean;
}>;

/**
 * Whether surplus may go to a yield product. Deterministic; an agent may
 * propose a deposit but only this check (plus the Kernel) can let one through.
 * The deposit must keep the operating floor plus buffer at the lowest point
 * of every scenario through the lock period (at least 30 days).
 */
export function canDeployToYield(input: YieldGateInput): {
  allowed: boolean;
  reasons: string[];
  checks: { scenario: Scenario; horizon: number; lowAfterDeposit: bigint }[];
} {
  const reasons: string[] = [];
  if (input.amount <= 0n) reasons.push('deposit amount must be positive');
  if (!input.obligationsImported)
    reasons.push('cash obligations have not been imported: forecast untrusted');
  if (input.now - input.forecastBuiltAt > input.maxForecastAgeSeconds)
    reasons.push(
      `forecast is ${input.now - input.forecastBuiltAt}s old (max ${input.maxForecastAgeSeconds}s)`,
    );
  if (input.activeDisputes > 0)
    reasons.push(`${input.activeDisputes} active escrow dispute(s)`);
  if (!input.productEligible) reasons.push('product or account not eligible');
  const missing = SCENARIOS.filter(
    (s) => !input.forecasts.some((f) => f.scenario === s),
  );
  if (missing.length) reasons.push(`missing scenarios: ${missing.join(', ')}`);
  const need = input.operatingFloor + input.stressBuffer;
  const span = Math.max(input.lockDays, 30);
  const checks: {
    scenario: Scenario;
    horizon: number;
    lowAfterDeposit: bigint;
  }[] = [];
  for (const f of input.forecasts) {
    if (f.startCash - input.amount < need)
      reasons.push(
        `${f.scenario}: deposit leaves ${f.startCash - input.amount} today, below floor+buffer ${need}`,
      );
    // Every horizon point up to and including the first one covering the lock.
    const cover = f.points.find((p) => p.days >= span);
    if (!cover) {
      reasons.push(
        `${f.scenario}: forecast does not reach the ${span}-day lock period`,
      );
      continue;
    }
    for (const p of f.points.filter((x) => x.days <= cover.days)) {
      const low = p.lowPoint - input.amount;
      checks.push({
        scenario: f.scenario,
        horizon: p.days,
        lowAfterDeposit: low,
      });
      if (low < need)
        reasons.push(
          `${f.scenario}: low point within ${p.days} days would be ${low}, below floor+buffer ${need}`,
        );
    }
  }
  return { allowed: reasons.length === 0, reasons, checks };
}
