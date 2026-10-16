import { describe, expect, it } from 'vitest';
import type { MemoPayment } from '@synq/invoices';
import {
  TesterManifestSchema,
  tallyTesterPayments,
  type TesterManifest,
} from '../../scripts/lib/tester-traction.js';
const addr = (n: string) => `0x${n.repeat(40)}` as const;
const hash = (n: string) => `0x${n.repeat(64)}` as const;
const manifest: TesterManifest = {
  version: 1,
  chainId: 5042002,
  token: addr('3'),
  memoContract: addr('4'),
  controlledWallets: [addr('1'), addr('2'), addr('5'), addr('6')],
  invoices: [
    {
      testerId: 'outside-1',
      invoiceId: 'inv_1',
      paymentRef: hash('a'),
      recipient: addr('1'),
      totalBaseUnits: '1000',
      fromBlock: '1',
      issuedAt: 1,
      expiresAt: 100,
      checkoutUrl: 'http://localhost:3000/pay/test',
    },
  ],
};
const payment = (over: Partial<MemoPayment> = {}): MemoPayment => ({
  chainId: 5042002,
  txHash: hash('b'),
  logIndex: 2,
  paymentRef: hash('a'),
  payer: addr('7'),
  recipient: addr('1'),
  amount: 1000n,
  ...over,
});
describe('external tester chain tally', () => {
  it('deduplicates receipts and treats multiple payments from one wallet as one external wallet', () => {
    const p = payment();
    const r = tallyTesterPayments(
      manifest,
      [p, p, payment({ txHash: hash('c') })],
      [],
    );
    expect(r.distinctExternalPayerWallets).toBe(1);
    expect(r.externalPaymentTransactions).toBe(2);
    expect(r.grossExternalBaseUnits).toBe('2000');
    expect(r.invoiceVolumeBaseUnits).toBe('1000');
  });
  it('excludes role wallets from the manifest and a fresh address inventory', () => {
    const r = tallyTesterPayments(
      manifest,
      [
        payment({ payer: addr('2') }),
        payment({ payer: addr('8'), txHash: hash('c') }),
      ],
      [addr('8')],
    );
    expect(r.distinctExternalPayerWallets).toBe(0);
    expect(r.controlledPaymentsExcluded).toBe(2);
    expect(r.grossExternalBaseUnits).toBe('0');
  });
  it('ignores unrelated references, wrong recipients and chains, and nonpositive transfers', () => {
    const r = tallyTesterPayments(
      manifest,
      [
        payment({ paymentRef: hash('d') }),
        payment({ recipient: addr('2') }),
        payment({ chainId: 1 }),
        payment({ amount: 0n }),
        payment({ amount: -1n }),
      ],
      [],
    );
    expect(r.external).toEqual([]);
  });
  it('partial amounts accumulate but overpayment never increases invoice revenue beyond the total', () => {
    const r = tallyTesterPayments(
      manifest,
      [
        payment({ amount: 400n }),
        payment({ amount: 800n, txHash: hash('c'), payer: addr('8') }),
      ],
      [],
    );
    expect(r.grossExternalBaseUnits).toBe('1200');
    expect(r.invoiceVolumeBaseUnits).toBe('1000');
    expect(r.distinctExternalPayerWallets).toBe(2);
  });
  it('normalizes wallet and transaction case', () => {
    const a = addr('a');
    const mixed = `0x${a.slice(2).toUpperCase()}` as typeof a;
    const r = tallyTesterPayments(
      { ...manifest, controlledWallets: [...manifest.controlledWallets, a] },
      [payment({ payer: mixed })],
      [],
    );
    expect(r.external).toEqual([]);
  });
  it('refuses ambiguous duplicate invoice references', () => {
    expect(() =>
      tallyTesterPayments(
        {
          ...manifest,
          invoices: [
            ...manifest.invoices,
            { ...manifest.invoices[0]!, invoiceId: 'other' },
          ],
        },
        [],
        [],
      ),
    ).toThrow('duplicate tester payment reference');
  });
  it('mainnet manifests cannot be used for testnet traction', () => {
    expect(
      TesterManifestSchema.safeParse({ ...manifest, chainId: 1 }).success,
    ).toBe(false);
  });
  it('an empty issued-invoice set yields zero, never seeded traction', () => {
    expect(
      tallyTesterPayments({ ...manifest, invoices: [] }, [payment()], [])
        .distinctExternalPayerWallets,
    ).toBe(0);
  });
});
