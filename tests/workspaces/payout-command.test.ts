import { describe, expect, it } from 'vitest';
import { parseWorkspacePay } from '@synq/workspaces/payout-command';

describe('G10/G14 deterministic payout requests from chat', () => {
  it('reads every field from the message in both supported forms', () => {
    expect(
      parseWorkspacePay('pay Acme Studio 10 USDC for logo design ref INV-1'),
    ).toEqual({
      vendor: 'Acme Studio',
      amount: '10000000',
      purpose: 'logo design',
      obligation: 'INV-1',
    });
    expect(
      parseWorkspacePay(
        'send 0.25 USDC to Acme Studio for the logo, invoice INV-1.',
      ),
    ).toEqual({
      vendor: 'Acme Studio',
      amount: '250000',
      purpose: 'the logo',
      obligation: 'INV-1',
    });
    expect(
      parseWorkspacePay('Pay 3 USDC to Bo for hosting bill 2026-10')
        ?.obligation,
    ).toBe('2026-10');
  });
  it('refuses requests without an exact amount, a vendor, a purpose or a reference', () => {
    for (const t of [
      'send some USDC to Acme for the logo, invoice INV-1',
      'send 10 USDC to Acme, invoice INV-1',
      'send 10 USDC to Acme for the logo',
      'send 10.1234567 USDC to Acme for logo invoice INV-1',
      'please send 10 USDC to Acme for logo invoice INV-1',
    ])
      expect(parseWorkspacePay(t)).toBeNull();
  });
});
