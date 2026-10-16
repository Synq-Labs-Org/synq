import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AllocationError,
  PolicyError,
  SCENARIOS,
  availableLiquidity,
  canDeployToYield,
  computeWaterfall,
  forecastCash,
  parsePolicy,
  policyHash,
  totals,
  verifySignedPolicy,
  type AllocationPlan,
  type WaterfallInput,
} from '@synq/allocations';
import {
  DEV,
  SAVINGS,
  STRANGER,
  T0,
  bills1500,
  day,
  devInvoice,
  intruder,
  policy1500,
  position,
  receipt1500,
  receivables1500,
  signPolicy,
  usd,
  vendors,
} from './harness.js';

const input1500 = (over: Partial<WaterfallInput> = {}): WaterfallInput => {
  const policy = over.policy ?? policy1500();
  return {
    policy,
    policyHash: policyHash(policy),
    receipt: receipt1500(),
    position: position(usd('1500')),
    asOf: T0,
    vendors: vendors(),
    payables: [devInvoice(usd('300'), 5)],
    payableHistory: [devInvoice(usd('300'), 5)],
    obligations: [],
    bills: bills1500(),
    receivables: receivables1500(),
    ...over,
  };
};
const sum = (p: AllocationPlan) => p.legs.reduce((a, l) => a + l.amount, 0n);

describe('Revenue waterfall: the $1,500 example', () => {
  it('reserves tax, pays the contractor, reserves bills, keeps the floor, distributes surplus', () => {
    const plan = computeWaterfall(input1500());
    const t = totals(plan);
    expect(t.taxReserve).toBe(usd('225'));
    expect(t.payables).toBe(usd('300'));
    expect(t.bills).toBe(usd('295'));
    expect(t.operatingFloor).toBe(usd('500'));
    expect(t.distributions).toBe(usd('18'));
    expect(t.freeCash).toBe(usd('162'));
    expect(sum(plan)).toBe(usd('1500'));
    expect(plan.excluded.receivablesNotSpendable).toBe(usd('2000'));
    expect(plan.legs.map((l) => [l.purpose, l.kind, l.autonomy])).toEqual([
      ['TAX_ESTIMATE', 'RESERVE', 'NOT_A_TRANSFER'],
      ['CONTRACTOR_PAYABLE', 'TRANSFER', 'AUTONOMOUS'],
      ['UPCOMING_BILL', 'RESERVE', 'NOT_A_TRANSFER'],
      ['UPCOMING_BILL', 'RESERVE', 'NOT_A_TRANSFER'],
      ['OPERATING_FLOOR', 'RESERVE', 'NOT_A_TRANSFER'],
      ['DISTRIBUTION', 'TRANSFER', 'AUTONOMOUS'],
      ['UNALLOCATED', 'FREE_CASH', 'NOT_A_TRANSFER'],
    ]);
    expect(plan.legs[1]!.payTo).toBe(DEV);
    expect(plan.legs[5]!.payTo).toBe(SAVINGS);
    // Deterministic.
    expect(computeWaterfall(input1500()).planHash).toBe(plan.planHash);
  });

  it('P14-01 the tax reserve is a reservation, never a transfer or a remittance', () => {
    const plan = computeWaterfall(input1500());
    const tax = plan.legs.filter((l) => l.purpose === 'TAX_ESTIMATE');
    expect(tax).toHaveLength(1);
    expect(tax[0]).toMatchObject({
      kind: 'RESERVE',
      payTo: null,
      beneficiaryId: null,
      autonomy: 'NOT_A_TRANSFER',
    });
    expect(tax[0]!.basis).toMatch(/not a tax payment/);
    // The policy has no field for a tax authority address at all.
    expect(() =>
      parsePolicy({ ...policy1500(), taxAuthority: STRANGER }),
    ).toThrow(PolicyError);
  });

  it('pre-existing free cash covers the floor before the receipt does', () => {
    const plan = computeWaterfall(
      input1500({ position: position(usd('1800')) }),
    );
    // 300 free outside the receipt: the receipt tops up only 200.
    expect(totals(plan).operatingFloor).toBe(usd('200'));
    expect(sum(plan)).toBe(usd('1500'));
  });

  it('a payee that is not verified is held, never planned as a transfer', () => {
    const inv = {
      ...devInvoice(usd('100'), 3, 'vin_new'),
      vendorId: 'vnd_new',
      payTo: STRANGER,
    };
    const policy = policy1500({
      allowedBeneficiaries: [
        ...policy1500().allowedBeneficiaries,
        { beneficiaryId: 'vnd_new', address: STRANGER, label: 'new' },
      ],
    });
    const plan = computeWaterfall(
      input1500({ policy, payables: [inv], payableHistory: [inv] }),
    );
    const held = plan.legs.find((l) => l.documentRef === 'vin_new')!;
    expect(held.kind).toBe('RESERVE');
    expect(held.purpose).toBe('PAYABLE_HELD');
    expect(held.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(['NO_VERIFIED_PAYOUT', 'BENEFICIARY_UNVERIFIED']),
    );
    expect(
      plan.legs.some((l) => l.kind === 'TRANSFER' && l.payTo === STRANGER),
    ).toBe(false);
  });

  it('a payee outside the policy allowlist is held, not paid', () => {
    const policy = policy1500({
      allowedBeneficiaries: [policy1500().allowedBeneficiaries[1]!],
      distributions: [],
    });
    const plan = computeWaterfall(input1500({ policy }));
    const leg = plan.legs.find((l) => l.documentRef === 'vin_dev_1')!;
    expect(leg.purpose).toBe('PAYABLE_HELD');
    expect(leg.flags.map((f) => f.code)).toContain('NOT_ALLOWED_BENEFICIARY');
  });

  it('a distribution to a beneficiary that is not allowed is an invalid policy', () => {
    expect(() =>
      policy1500({
        distributions: [
          { kind: 'FIXED', label: 'x', beneficiaryId: 'vnd_new', amount: 1n },
        ],
      }),
    ).toThrow(/not an allowed beneficiary/);
  });

  it('a payable above the per-leg autonomy limit needs the owner', () => {
    const plan = computeWaterfall(
      input1500({ payables: [devInvoice(usd('450'), 5)] }),
    );
    expect(plan.legs[1]).toMatchObject({
      purpose: 'CONTRACTOR_PAYABLE',
      autonomy: 'OWNER_APPROVAL_REQUIRED',
    });
  });

  it('obligations that do not fit block every distribution', () => {
    const plan = computeWaterfall(
      input1500({
        payables: [devInvoice(usd('1400'), 5)],
        policy: policy1500({
          limits: { ...policy1500().limits, maxAutonomousPerLeg: usd('1000') },
        }),
      }),
    );
    expect(plan.shortfalls.map((s) => s.purpose)).toContain(
      'CONTRACTOR_PAYABLE',
    );
    expect(totals(plan).distributions).toBe(0n);
    expect(sum(plan)).toBe(usd('1500'));
  });

  it('refuses a receipt that is not final', () => {
    expect(() =>
      computeWaterfall(
        input1500({
          receipt: receipt1500(usd('1500'), { finality: 'PENDING' }),
        }),
      ),
    ).toThrow(AllocationError);
  });

  it('refuses a stale balance and a balance read before the receipt block', () => {
    expect(() =>
      computeWaterfall(
        input1500({
          position: position(usd('1500'), { observedAt: T0 - 301 }),
        }),
      ),
    ).toThrow(/STALE_BALANCE|observed/);
    expect(() =>
      computeWaterfall(
        input1500({ position: position(usd('1500'), { observedBlock: 999n }) }),
      ),
    ).toThrow(/predates/);
  });

  it('refuses when the receipt is already spoken for (cash below reservations + receipt)', () => {
    expect(() =>
      computeWaterfall(
        input1500({
          position: position(usd('1500'), { escrowLiabilities: usd('100') }),
        }),
      ),
    ).toThrow(/OVER_COMMITTED|spoken for/);
    expect(() =>
      availableLiquidity(position(usd('10'), { reservations: usd('11') })),
    ).toThrow(AllocationError);
  });

  it('refuses a receipt into another account than the policy treasury', () => {
    expect(() =>
      computeWaterfall(
        input1500({ receipt: receipt1500(usd('1500'), { recipient: DEV }) }),
      ),
    ).toThrow(/WRONG_TREASURY|policy treasury/);
  });
});

describe('P14-07 integer rounding conserves funds', () => {
  it('rounding dust goes to free cash, the legs sum to the receipt exactly', () => {
    const policy = policy1500({
      taxReserveBps: 1_333,
      operatingFloor: 0n,
      distributions: [
        {
          kind: 'PERCENT_OF_SURPLUS',
          label: 'a',
          beneficiaryId: 'vnd_savings',
          bps: 3_333,
        },
        {
          kind: 'PERCENT_OF_SURPLUS',
          label: 'b',
          beneficiaryId: 'vnd_dev',
          bps: 3_333,
        },
      ],
    });
    const plan = computeWaterfall(
      input1500({
        policy,
        receipt: receipt1500(7n),
        position: position(7n),
        payables: [],
        bills: [],
      }),
    );
    expect(plan.legs.map((l) => l.amount)).toEqual([2n, 2n, 3n]);
    expect(sum(plan)).toBe(7n);
    const one = computeWaterfall(
      input1500({
        policy,
        receipt: receipt1500(1n),
        position: position(1n),
        payables: [],
        bills: [],
      }),
    );
    expect(one.legs).toHaveLength(1);
    expect(one.remainder).toBe(1n);
  });

  it('property: for any receipt, policy and obligations, legs + remainder == receipt', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 3 }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { maxLength: 3 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        (amount, taxBps, floor, pcts, aps, preFree) => {
          let left = 10_000;
          const dists = pcts
            .map((bps, i) => {
              const b = Math.min(bps, left);
              left -= b;
              return {
                kind: 'PERCENT_OF_SURPLUS' as const,
                label: `d${i}`,
                beneficiaryId: 'vnd_savings',
                bps: b,
              };
            })
            .filter((d) => d.bps > 0);
          const policy = policy1500({
            taxReserveBps: taxBps,
            operatingFloor: floor,
            distributions: dists,
            limits: {
              ...policy1500().limits,
              maxAutonomousPerLeg: 10n ** 13n,
              maxAutonomousPerWindow: 10n ** 14n,
            },
          });
          const payables = aps.map((a, i) => devInvoice(a, i + 1, `vin_p${i}`));
          const plan = computeWaterfall(
            input1500({
              policy,
              receipt: receipt1500(amount),
              position: position(amount + preFree),
              payables,
              payableHistory: payables,
            }),
          );
          expect(sum(plan)).toBe(amount);
          expect(plan.remainder).toBe(plan.legs.at(-1)!.amount);
          for (const l of plan.legs) {
            expect(typeof l.amount).toBe('bigint');
            expect(l.amount >= 0n).toBe(true);
          }
        },
      ),
      { numRuns: 300, seed: 1416 },
    );
  });
});

describe('Cash forecast and yield gate', () => {
  const base = {
    asOf: T0,
    position: position(usd('1500')),
    heldForTax: usd('225'),
    payables: [devInvoice(usd('300'), 5)],
    bills: [
      {
        billId: 'payroll',
        label: 'Payroll',
        kind: 'PAYROLL' as const,
        amount: usd('1200'),
        nextDueOn: day(40),
        cadenceDays: 30,
      },
    ],
    receivables: [
      {
        invoiceId: 'inv_globex',
        number: 'INV-2002',
        payer: 'Globex',
        amountDue: usd('2000'),
        dueOn: day(10),
        payerDaysLate: [],
      },
    ],
  };

  it('P14-02 the forecast subtracts AP and never counts uncollected AR as cash', () => {
    const f = forecastCash({ ...base, scenario: 'BASE' });
    const noAr = forecastCash({ ...base, receivables: [], scenario: 'BASE' });
    expect(f.startCash).toBe(usd('1275'));
    expect(f.startCash).toBe(noAr.startCash);
    const d30 = f.points.find((p) => p.days === 30)!;
    expect(d30.outflows).toBe(usd('300'));
    expect(d30.committedCash).toBe(usd('975'));
    expect(noAr.points.find((p) => p.days === 30)!.committedCash).toBe(
      usd('975'),
    );
    expect(d30.expectedInflows).toBe(usd('2000'));
    expect(d30.expectedCash).toBe(usd('2975'));
    const d60 = f.points.find((p) => p.days === 60)!;
    expect(d60.committedCash).toBe(usd('975') - usd('1200'));
    expect(f.receivablesExcluded).toBe(usd('2000'));
    // Adding a payable lowers committed cash by exactly its amount.
    const more = forecastCash({
      ...base,
      payables: [...base.payables, devInvoice(usd('50'), 20, 'vin_x')],
      scenario: 'BASE',
    });
    expect(more.points[0]!.committedCash).toBe(d30.committedCash - usd('50'));
  });

  it('overdue and habitually late receivables are AT_RISK and never counted', () => {
    const f = forecastCash({
      ...base,
      receivables: [{ ...base.receivables[0]!, dueOn: day(-40) }],
      scenario: 'BASE',
    });
    expect(f.atRisk).toHaveLength(1);
    expect(f.points.every((p) => p.expectedInflows === 0n)).toBe(true);
  });

  it('P14-03 a late receivable scenario blocks a yield deposit the base case allows', () => {
    const forecasts = SCENARIOS.map((scenario) =>
      forecastCash({ ...base, scenario }),
    );
    const gate = (fs = forecasts) =>
      canDeployToYield({
        amount: usd('300'),
        lockDays: 60,
        operatingFloor: usd('500'),
        stressBuffer: 0n,
        forecasts: fs,
        obligationsImported: true,
        forecastBuiltAt: T0,
        now: T0 + 10,
        maxForecastAgeSeconds: 600,
        activeDisputes: 0,
        productEligible: true,
      });
    const baseOnly = gate(
      forecasts.map((f) =>
        f.scenario === 'BASE'
          ? f
          : { ...f, ...forecasts[0]!, scenario: f.scenario },
      ),
    );
    expect(baseOnly.allowed).toBe(true);
    const r = gate();
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/LATE_RECEIVABLES: low point/);
  });

  it('a yield deposit is refused without imported obligations, with a stale forecast or an open dispute', () => {
    const forecasts = SCENARIOS.map((scenario) =>
      forecastCash({
        ...base,
        receivables: [],
        payables: [],
        bills: [],
        scenario,
      }),
    );
    const r = canDeployToYield({
      amount: usd('100'),
      lockDays: 7,
      operatingFloor: usd('500'),
      stressBuffer: 0n,
      forecasts,
      obligationsImported: false,
      forecastBuiltAt: T0,
      now: T0 + 3_600,
      maxForecastAgeSeconds: 600,
      activeDisputes: 1,
      productEligible: false,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join('|')).toMatch(/not been imported/);
    expect(r.reasons.join('|')).toMatch(/old/);
    expect(r.reasons.join('|')).toMatch(/dispute/);
    expect(r.reasons.join('|')).toMatch(/not eligible/);
  });
});

describe('Policy signatures', () => {
  it('a policy signed by someone other than the owner is rejected', async () => {
    const policy = policy1500();
    const forged = await signPolicy(policy, intruder);
    await expect(verifySignedPolicy(forged, T0)).rejects.toMatchObject({
      code: 'NOT_SIGNED_BY_OWNER',
    });
    const good = await signPolicy(policy);
    await expect(verifySignedPolicy(good, T0)).resolves.toMatchObject({
      policyHash: policyHash(policy),
    });
  });

  it('changing any amount after signing breaks the signature', async () => {
    const good = await signPolicy(policy1500());
    const tampered = { ...good, policy: { ...good.policy, taxReserveBps: 0 } };
    await expect(verifySignedPolicy(tampered, T0)).rejects.toMatchObject({
      code: 'NOT_SIGNED_BY_OWNER',
    });
  });

  it('a mandate wider than the policy implies is rejected', async () => {
    const good = await signPolicy(policy1500());
    const wide = {
      ...good,
      mandate: { ...good.mandate, perActionCap: usd('900') },
    };
    await expect(verifySignedPolicy(wide, T0)).rejects.toMatchObject({
      code: 'MANDATE_MISMATCH',
    });
  });
});
