import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { token } from '@synq/chain-registry/arc';
import {
  FinanceChangeSchema,
  describeFinanceEdit,
  financeChangeHash,
  type FinanceEdit,
} from '@synq/workspaces/finance-contracts';

const base = {
  workspaceId: randomUUID(),
  vault: '0x1111111111111111111111111111111111111111',
  chainId: 5042002,
  token: token('arc-testnet', 'USDC').address,
  revision: 3,
  nonce: randomUUID(),
  expiresAt: 2_000_000_900,
} as const;
const edits: FinanceEdit[] = [
  {
    kind: 'PAYABLE',
    payableId: randomUUID(),
    vendorId: randomUUID(),
    number: 'INV-9',
    amount: '1250000',
    issuedOn: '2033-05-01',
    dueOn: '2033-05-31',
    reference: 'PO-9',
    documentText: 'Invoice INV-9',
  },
  {
    kind: 'CLOSE_PAYABLE',
    payableId: randomUUID(),
    status: 'VOID',
    reason: 'duplicate',
  },
  {
    kind: 'OBLIGATION',
    reference: 'PO-9',
    vendorId: randomUUID(),
    approvedAmount: '1250000',
    status: 'ACCEPTED',
  },
  {
    kind: 'BILL',
    billId: randomUUID(),
    label: 'Rent',
    billKind: 'RENT',
    amount: '3000000',
    nextDueOn: '2033-06-01',
    cadenceDays: 30,
  },
  { kind: 'REMOVE_BILL', billId: randomUUID(), reason: 'lease ended' },
];
const changeOf = (edit: FinanceEdit) =>
  FinanceChangeSchema.parse({ ...base, edit });

describe('G6 books edits are fully bound by the owner signature', () => {
  it('changes the signed hash when any single field of any books edit changes', () => {
    for (const edit of edits) {
      const signed = financeChangeHash(changeOf(edit));
      for (const [key, value] of Object.entries(edit)) {
        if (key === 'kind') continue;
        const altered =
          typeof value === 'number'
            ? value + 1
            : value === null
              ? 'PO-NEW'
              : key === 'amount' || key === 'approvedAmount'
                ? `${value}1`
                : key.endsWith('Id')
                  ? randomUUID()
                  : key === 'issuedOn'
                    ? '2033-04-15'
                    : key.endsWith('On')
                      ? '2033-07-15'
                      : key === 'status'
                        ? edit.kind === 'CLOSE_PAYABLE'
                          ? 'PAID_ELSEWHERE'
                          : 'DISPUTED'
                        : key === 'billKind'
                          ? 'PAYROLL'
                          : `${String(value)}x`;
        const other = { ...edit, [key]: altered } as FinanceEdit;
        expect(
          financeChangeHash(changeOf(other)),
          `${edit.kind}.${key}`,
        ).not.toBe(signed);
      }
    }
  });
  it('describes each books edit in exact USDC for the owner review', () => {
    expect(describeFinanceEdit(edits[0]!)).toContain('1.25 USDC');
    expect(describeFinanceEdit(edits[0]!)).toContain('PO-9');
    expect(describeFinanceEdit(edits[3]!)).toContain('3 USDC every 30 days');
    for (const e of edits)
      expect(describeFinanceEdit(e).length).toBeGreaterThan(10);
  });
});
