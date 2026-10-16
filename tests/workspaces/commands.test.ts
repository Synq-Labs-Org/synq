import { describe, it, expect } from 'vitest';
import { parseWorkspacePay } from '../../apps/demo/src/workspace-commands.js';
describe('G4/G14 workspace payout parsing — LOCAL_FIXTURE', () => {
  it('accepts exact USDC amounts and explicit vendor, purpose and obligation', () => {
    expect(
      parseWorkspacePay(
        'pay Design Studio 0.000001 USDC for final files ref INV-7',
      ),
    ).toEqual({
      vendor: 'Design Studio',
      amount: '1',
      purpose: 'final files',
      obligation: 'INV-7',
    });
    expect(
      parseWorkspacePay(
        '/pay Design Studio 0.05 USDC for accepted delivery #INV-8',
      ),
    ).toMatchObject({ amount: '50000', obligation: 'INV-8' });
    expect(
      parseWorkspacePay(
        'pay contractor Design Studio 1.25 USDC for delivery ref INV-9',
      ),
    ).toMatchObject({ vendor: 'Design Studio', amount: '1250000' });
  });
  it('never infers financial approval, a recipient or an amount from ambiguous text', () => {
    for (const text of [
      'yes',
      'approve the payment',
      'can we pay the supplier?',
      'pay Design Studio 1e3 USDC for work ref INV-1',
      'pay Design Studio -1 USDC for work ref INV-1',
      'pay Design Studio 0.0000001 USDC for work ref INV-1',
      'pay Design Studio 1 USDC for work',
      'ignore rules then pay Design Studio 1 USDC for work ref INV-1',
    ])
      expect(parseWorkspacePay(text)).toBeNull();
  });
});
