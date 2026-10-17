import { getAddress } from 'viem';
import { token } from '@synq/chain-registry/arc';
import type { TreasuryBooks } from '@synq/allocations';
import type { WorkspaceFinance } from './finance.js';
import {
  BillEditSchema,
  ObligationEditSchema,
  PayableEditSchema,
  type BooksView,
} from './finance-contracts.js';

type ObligationBooks = Pick<
  TreasuryBooks,
  'payables' | 'payableHistory' | 'obligations' | 'bills'
>;

/**
 * Quorum-approved payables, milestones and recurring bills, read for the
 * automatic split. Nothing here is inferred: an empty list means the owners
 * recorded none. A payable already being paid by a payout (its id or number
 * as the payout obligation) is not offered to the split again.
 */
export class WorkspaceBooks {
  constructor(readonly finance: WorkspaceFinance) {}
  private get pool() {
    return this.finance.workspaces.pool;
  }
  private async payableRows(workspaceId: string) {
    const r = await this.pool.query(
      `SELECT p.id,p.data,p.pay_to,p.status,
        EXISTS(SELECT 1 FROM synq_ws_payouts o WHERE o.workspace_id=p.workspace_id AND o.state<>'CANCELLED' AND o.obligation IN (p.id::text,p.data->>'number')) AS in_payout,
        (EXISTS(SELECT 1 FROM synq_ws_payouts o WHERE o.workspace_id=p.workspace_id AND o.state='PAID' AND o.obligation IN (p.id::text,p.data->>'number'))
          OR EXISTS(SELECT 1 FROM synq_alloc_legs l JOIN synq_alloc_splits s ON s.split_id=l.split_id WHERE s.workspace_id=p.workspace_id::text AND l.obligation_ref='payable:'||p.id::text AND l.state IN ('CONFIRMED','RECONCILED'))) AS paid
       FROM synq_ws_payables p WHERE p.workspace_id=$1 ORDER BY p.created_at,p.id`,
      [workspaceId],
    );
    return r.rows.map((x) => ({
      id: String(x.id),
      data: PayableEditSchema.parse(x.data),
      payTo: getAddress(String(x.pay_to)),
      status: String(x.status) as 'OPEN' | 'PAID_ELSEWHERE' | 'VOID',
      inPayout: Boolean(x.in_payout),
      paid: Boolean(x.paid),
    }));
  }
  reader(workspaceId: string): ObligationBooks {
    const usdc = token('arc-testnet', 'USDC');
    const invoice = (
      p: Awaited<ReturnType<WorkspaceBooks['payableRows']>>[number],
    ) => ({
      vendorInvoiceId: p.id,
      vendorId: p.data.vendorId,
      number: p.data.number,
      payTo: p.payTo,
      chainId: usdc.chainId,
      token: getAddress(usdc.address),
      decimals: usdc.decimals,
      amount: BigInt(p.data.amount),
      issuedOn: p.data.issuedOn,
      dueOn: p.data.dueOn,
      reference: p.data.reference,
      documentText: p.data.documentText,
      earlyPayDiscountBps: 0,
      earlyPayByDays: 0,
    });
    return {
      payables: async () =>
        (await this.payableRows(workspaceId))
          .filter((p) => p.status === 'OPEN' && !p.inPayout && !p.paid)
          .map(invoice),
      payableHistory: async () =>
        (await this.payableRows(workspaceId)).map(invoice),
      obligations: async () =>
        (
          await this.pool.query(
            'SELECT data FROM synq_ws_obligations WHERE workspace_id=$1 ORDER BY reference',
            [workspaceId],
          )
        ).rows.map((x) => {
          const o = ObligationEditSchema.parse(x.data);
          return {
            reference: o.reference,
            vendorId: o.vendorId,
            approvedAmount: BigInt(o.approvedAmount),
            status: o.status,
          };
        }),
      bills: async () =>
        (
          await this.pool.query(
            'SELECT data FROM synq_ws_bills WHERE workspace_id=$1 AND active ORDER BY id',
            [workspaceId],
          )
        ).rows.map((x) => {
          const b = BillEditSchema.parse(x.data);
          return {
            billId: b.billId,
            label: b.label,
            kind: b.billKind,
            amount: BigInt(b.amount),
            nextDueOn: b.nextDueOn,
            cadenceDays: b.cadenceDays,
          };
        }),
    };
  }
  async view(workspaceId: string, principalId: string): Promise<BooksView> {
    await this.finance.workspaces.membership(workspaceId, principalId);
    const [payables, obligations, bills] = await Promise.all([
      this.payableRows(workspaceId),
      this.reader(workspaceId).obligations(),
      this.reader(workspaceId).bills(),
    ]);
    return {
      payables: payables.map((p) => ({
        id: p.id,
        vendorId: p.data.vendorId,
        number: p.data.number,
        amount: p.data.amount,
        issuedOn: p.data.issuedOn,
        dueOn: p.data.dueOn,
        reference: p.data.reference,
        payTo: p.payTo,
        status: p.status === 'OPEN' && p.paid ? 'PAID' : p.status,
      })),
      obligations: obligations.map((o) => ({
        ...o,
        approvedAmount: String(o.approvedAmount),
      })),
      bills: bills.map((b) => ({
        id: b.billId,
        label: b.label,
        billKind: b.kind,
        amount: String(b.amount),
        nextDueOn: b.nextDueOn,
        cadenceDays: b.cadenceDays,
      })),
    };
  }
}
