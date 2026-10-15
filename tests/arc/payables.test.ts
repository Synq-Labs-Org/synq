import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  apEntries,
  assessPayable,
  lateReport,
  paymentTiming,
  proposeAddress,
  vendorDirectory,
  verifiedAddress,
  verifyAddress,
  type Obligation,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';

const USDC = token('arc-testnet', 'USDC');
const walletA = `0x${'a1'.repeat(20)}` as Address;
const walletB = `0x${'b2'.repeat(20)}` as Address;
const sarah: Vendor = {
  vendorId: 'sarah',
  workspaceId: 'wsp',
  name: 'Sarah (designer)',
  kind: 'CONTRACTOR',
  addresses: [
    {
      chainId: USDC.chainId,
      address: walletA,
      status: 'VERIFIED',
      source: 'onboarding signed challenge',
      at: 1,
      verifiedBy: 'owner',
    },
  ],
};
const invoice = (over: Partial<VendorInvoice> = {}): VendorInvoice => ({
  vendorInvoiceId: 'vi_1',
  vendorId: 'sarah',
  number: 'INV-0042',
  payTo: walletA,
  chainId: USDC.chainId,
  amount: 100_000_000n,
  issuedOn: '2026-10-10',
  dueOn: '2026-10-30',
  reference: 'milestone:design-2',
  documentText:
    'Invoice INV-0042 Sarah design services milestone two homepage and pricing page mockups total 100 USDC',
  earlyPayDiscountBps: 200,
  earlyPayByDays: 10,
  ...over,
});
const accepted: Obligation = {
  reference: 'milestone:design-2',
  vendorId: 'sarah',
  approvedAmount: 100_000_000n,
  status: 'ACCEPTED',
};
const ctx = {
  vendor: sarah,
  history: [] as VendorInvoice[],
  obligation: accepted,
  availableCash: 1_000_000_000n,
  today: '2026-10-16',
};
const hard = (flags: { severity: string; code: string }[]) =>
  flags.filter((f) => f.severity === 'HARD').map((f) => f.code);

describe('payables and contractor fraud controls (P12)', () => {
  it('a verified contractor with an accepted milestone has no hard flags', () => {
    const r = assessPayable({ ...ctx, invoice: invoice() });
    expect(hard(r.flags)).toEqual([]);
    expect(r.payTo).toBe(walletA);
  });

  it('P12-01 a new address in an invoice or chat is pending until independently verified', () => {
    const r = assessPayable({ ...ctx, invoice: invoice({ payTo: walletB }) });
    expect(hard(r.flags)).toEqual(['PAYOUT_ADDRESS_CHANGED']);
    expect(r.flags[0]!.detail).toContain(walletA);
    const pending = proposeAddress(
      sarah,
      USDC.chainId,
      walletB,
      'telegram message in project group',
      2,
    );
    expect(verifiedAddress(pending, USDC.chainId)).toBe(walletA);
    expect(
      hard(
        assessPayable({
          ...ctx,
          vendor: pending,
          invoice: invoice({ payTo: walletB }),
        }).flags,
      ),
    ).toEqual(['PAYOUT_ADDRESS_CHANGED']);
    const verified = verifyAddress(
      pending,
      USDC.chainId,
      walletB,
      'signed challenge from previously verified wallet',
      3,
    );
    expect(verifiedAddress(verified, USDC.chainId)).toBe(walletB);
    expect(verified.addresses.find((a) => a.address === walletA)!.status).toBe(
      'RETIRED',
    );
    expect(
      hard(
        assessPayable({
          ...ctx,
          vendor: verified,
          invoice: invoice({ payTo: walletB }),
        }).flags,
      ),
    ).toEqual([]);
  });

  it('P12-02 a reformatted duplicate invoice is flagged', () => {
    const paid = invoice({ vendorInvoiceId: 'vi_0' });
    const reformatted = invoice({
      vendorInvoiceId: 'vi_9',
      number: 'inv #42',
      documentText:
        'INVOICE inv #42 — Sarah design services milestone two homepage and pricing page mockups total 100 USDC',
    });
    expect(
      hard(
        assessPayable({ ...ctx, history: [paid], invoice: reformatted }).flags,
      ),
    ).toContain('DUPLICATE_INVOICE');
    const sameText = invoice({
      vendorInvoiceId: 'vi_8',
      number: 'INV-0099',
      amount: 100_000_000n,
    });
    expect(
      hard(assessPayable({ ...ctx, history: [paid], invoice: sameText }).flags),
    ).toContain('DUPLICATE_INVOICE');
    const different = invoice({
      vendorInvoiceId: 'vi_7',
      number: 'INV-0043',
      amount: 40_000_000n,
      documentText: 'Invoice INV-0043 logo refresh',
    });
    expect(
      hard(
        assessPayable({ ...ctx, history: [paid], invoice: different }).flags,
      ),
    ).toEqual([]);
  });

  it('P12-03 an invoice that does not match an accepted milestone/PO is held', () => {
    expect(
      hard(
        assessPayable({ ...ctx, obligation: null, invoice: invoice() }).flags,
      ),
    ).toEqual(['NO_MATCHING_OBLIGATION']);
    expect(
      hard(
        assessPayable({
          ...ctx,
          obligation: { ...accepted, status: 'DELIVERED' },
          invoice: invoice(),
        }).flags,
      ),
    ).toEqual(['DELIVERY_NOT_ACCEPTED']);
    expect(
      hard(
        assessPayable({
          ...ctx,
          obligation: { ...accepted, status: 'DISPUTED' },
          invoice: invoice(),
        }).flags,
      ),
    ).toEqual(['MILESTONE_DISPUTED']);
    expect(
      hard(
        assessPayable({ ...ctx, invoice: invoice({ amount: 120_000_000n }) })
          .flags,
      ),
    ).toEqual(['AMOUNT_EXCEEDS_OBLIGATION']);
    expect(
      hard(
        assessPayable({
          ...ctx,
          availableCash: 99_999_999n,
          invoice: invoice(),
        }).flags,
      ),
    ).toEqual(['INSUFFICIENT_FREE_CASH']);
  });

  it('P12-04 early payment only when the discount window is open and the reserve floor holds', () => {
    expect(
      paymentTiming({
        invoice: invoice(),
        today: '2026-10-16',
        freeCash: 500_000_000n,
        reserveFloor: 300_000_000n,
      }),
    ).toMatchObject({ action: 'PAY_EARLY', saving: 2_000_000n });
    expect(
      paymentTiming({
        invoice: invoice(),
        today: '2026-10-16',
        freeCash: 350_000_000n,
        reserveFloor: 300_000_000n,
      }),
    ).toMatchObject({
      action: 'PAY_ON_DUE_DATE',
      reason: 'early discount would breach the reserve floor',
    });
    expect(
      paymentTiming({
        invoice: invoice(),
        today: '2026-10-25',
        freeCash: 500_000_000n,
        reserveFloor: 0n,
      }),
    ).toMatchObject({ action: 'PAY_ON_DUE_DATE' });
    expect(
      paymentTiming({
        invoice: invoice(),
        today: '2026-10-16',
        freeCash: 50_000_000n,
        reserveFloor: 0n,
      }).action,
    ).toBe('HOLD');
  });

  it('P12-06 late report uses verified due and paid dates', () => {
    const a = invoice({ vendorInvoiceId: 'a', dueOn: '2026-10-01' });
    const b = invoice({ vendorInvoiceId: 'b', dueOn: '2026-10-20' });
    const c = invoice({ vendorInvoiceId: 'c', dueOn: '2026-10-05' });
    expect(lateReport([a, b, c], { a: '2026-10-04' }, '2026-10-16')).toEqual([
      {
        vendorInvoiceId: 'a',
        number: 'INV-0042',
        dueOn: '2026-10-01',
        paidOn: '2026-10-04',
        daysLate: 3,
      },
      {
        vendorInvoiceId: 'c',
        number: 'INV-0042',
        dueOn: '2026-10-05',
        paidOn: null,
        daysLate: 11,
      },
    ]);
  });

  it('P12-05 AP postings settle only to the verified wallet (counterparty check)', async () => {
    const ledger = new Ledger(
      new MemoryLedgerStore(),
      vendorDirectory([sarah]),
    );
    const ok = apEntries({
      workspaceId: 'wsp',
      vendor: sarah,
      invoice: invoice(),
      assetId: USDC.assetId,
      settlement: {
        txHash: `0x${'ab'.repeat(32)}`,
        logIndex: 4,
        recipient: walletA,
        feeBaseUnits: 1_223n,
      },
      at: 5,
    });
    for (const e of ok) await ledger.post(e);
    const b = await ledger.balances('wsp', USDC.assetId);
    expect([
      b.ACCOUNTS_PAYABLE,
      b.CONTRACTOR_EXPENSE,
      b.NETWORK_FEES,
      b.CASH_ARC_USDC,
    ]).toEqual([0n, 100_000_000n, 1_223n, -100_001_223n]);
    const wrong = apEntries({
      workspaceId: 'wsp',
      vendor: sarah,
      invoice: invoice({ vendorInvoiceId: 'vi_2' }),
      assetId: USDC.assetId,
      settlement: {
        txHash: `0x${'cd'.repeat(32)}`,
        logIndex: 1,
        recipient: walletB,
        feeBaseUnits: 0n,
      },
      at: 6,
    });
    await ledger.post(wrong[0]!);
    await expect(ledger.post(wrong[1]!)).rejects.toMatchObject({
      code: 'WRONG_VENDOR',
    });
  });
});
