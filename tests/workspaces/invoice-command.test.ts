import { describe, expect, it } from 'vitest';
import { parseWorkspaceInvoice } from '@synq/workspaces/invoice-command';

describe('G14 chat invoice drafts', () => {
  it('parses payer, exact amount, due date and work', () => {
    expect(
      parseWorkspaceInvoice(
        'invoice Acme Studio 1.25 USDC due 2026-11-01 for logo design',
      ),
    ).toEqual({
      payerName: 'Acme Studio',
      amount: '1250000',
      dueDate: '2026-11-01',
      description: 'logo design',
    });
    expect(
      parseWorkspaceInvoice(
        '/invoice@synqbot Bo 0.5 usdc due 2026-12-31 for fixes',
      )?.amount,
    ).toBe('500000');
  });
  it('refuses vague, zero or over-precise amounts and missing dates', () => {
    for (const t of [
      'invoice Acme 1.2345678 USDC due 2026-11-01 for work',
      'invoice Acme 0 USDC due 2026-11-01 for work',
      'invoice Acme 10 USDC for work',
      'invoice Acme ten USDC due 2026-11-01 for work',
      'please invoice Acme 10 USDC due 2026-11-01 for work',
    ])
      expect(parseWorkspaceInvoice(t)).toBeNull();
  });
});
