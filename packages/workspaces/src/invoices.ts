import { getAddress, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  amountDue,
  draftInvoice,
  InvoiceError,
  type Invoice,
  type InvoiceService,
} from '@synq/invoices';
import { WorkspaceError } from './contracts.js';
import type { WorkspaceFinance } from './finance.js';

import { DraftWorkspaceInvoiceSchema } from './invoice-contracts.js';
export { DraftWorkspaceInvoiceSchema } from './invoice-contracts.js';

export class WorkspaceInvoices {
  constructor(
    readonly finance: WorkspaceFinance,
    readonly service: InvoiceService,
    private readonly payPath: (invoice: Invoice) => string | null,
  ) {}
  get workspaces() {
    return this.finance.workspaces;
  }
  /** Used by every issuing entry point, including old navigation links. */
  async authorizeIssue(invoice: Invoice) {
    const a = await this.finance.authority(invoice.workspaceId);
    if (
      getAddress(invoice.issuer.payoutAddress) !== a.vault ||
      invoice.asset.chainId !== token('arc-testnet', 'USDC').chainId ||
      getAddress(invoice.asset.address) !== a.token ||
      !a.owners.some(
        (v) => v.toLowerCase() === invoice.issuer.wallet.toLowerCase(),
      )
    )
      throw new WorkspaceError('INVOICE_ISSUER_AUTHORITY_CHANGED', 403);
  }
  private async view(i: Invoice) {
    const receipts = await this.workspaces.pool.query(
      'SELECT state FROM synq_ws_receipts WHERE workspace_id=$1 AND invoice_id=$2',
      [i.workspaceId, i.invoiceId],
    );
    const reconciliation = receipts.rows.some((r) => r.state === 'REVIEW')
      ? 'REVIEW'
      : i.paid === 0n
        ? 'NOT_PAID'
        : receipts.rows.length === i.payments.length &&
            receipts.rows.every((r) => r.state === 'PENDING_POLICY')
          ? 'FINALIZED'
          : 'PENDING';
    return {
      invoiceId: i.invoiceId,
      workspaceId: i.workspaceId,
      number: i.number,
      version: i.version,
      status: i.status,
      reconciliation,
      issuer: i.issuer,
      payer: { name: i.payer.name },
      asset: i.asset,
      lineItems: i.lineItems.map((l) => ({
        ...l,
        unitPrice: String(l.unitPrice),
      })),
      taxLabel: i.taxLabel,
      taxRateBps: i.taxRateBps,
      total: String(i.total),
      subtotal: String(i.subtotal),
      tax: String(i.tax),
      paid: String(i.paid),
      amountDue: String(amountDue(i)),
      dueDate: i.dueDate,
      memo: i.memo,
      termsHash: i.termsHash,
      paymentRef: i.paymentRef,
      checkoutPath: this.payPath(i),
    };
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    return Promise.all(
      (await this.service.store.list(workspaceId)).map((r) =>
        this.view(r.invoice),
      ),
    );
  }
  async get(workspaceId: string, principalId: string, id: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const r = await this.service.store.get(id);
    if (!r || r.invoice.workspaceId !== workspaceId)
      throw new WorkspaceError('INVOICE_NOT_FOUND', 404);
    return this.view(r.invoice);
  }
  async create(workspaceId: string, principalId: string, raw: unknown) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const body = DraftWorkspaceInvoiceSchema.parse(raw),
      a = await this.finance.authority(workspaceId);
    const workspace = await this.workspaces.get(workspaceId, principalId);
    const invoice = draftInvoice({
      workspaceId,
      number: body.number,
      issuer: {
        principalId,
        name: workspace.workspace.displayName,
        wallet: getAddress(m.wallet),
        payoutAddress: a.vault,
      },
      payer: { name: body.payerName, contact: null },
      asset: token('arc-testnet', 'USDC'),
      lineItems: body.lineItems.map((l) => ({
        ...l,
        unitPrice: BigInt(l.unitPrice),
      })),
      taxLabel: body.taxLabel,
      taxRateBps: body.taxRateBps,
      dueDate: body.dueDate,
      memo: body.memo,
      draftedBy: principalId,
      now: this.workspaces.now(),
    });
    if (invoice.total >= 2n ** 256n)
      throw new WorkspaceError('INVOICE_AMOUNT_OVERFLOW', 400);
    try {
      await this.service.create(invoice);
    } catch (e) {
      if (e instanceof InvoiceError)
        throw new WorkspaceError(`INVOICE_${e.code}`);
      throw e;
    }
    return this.view(invoice);
  }
  async issue(
    workspaceId: string,
    principalId: string,
    id: string,
    signature: Hex,
  ) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const stored = await this.service.store.get(id);
    if (!stored || stored.invoice.workspaceId !== workspaceId)
      throw new WorkspaceError('INVOICE_NOT_FOUND', 404);
    await this.authorizeIssue(stored.invoice);
    if (stored.invoice.issuer.wallet.toLowerCase() !== m.wallet.toLowerCase())
      throw new WorkspaceError('INVOICE_ISSUER_SIGNATURE_REQUIRED', 403);
    try {
      return this.view((await this.service.issue(id, signature)).invoice);
    } catch (e) {
      if (e instanceof InvoiceError)
        throw new WorkspaceError(
          `INVOICE_${e.code}`,
          e.code === 'NOT_ISSUER' ? 403 : 409,
        );
      throw e;
    }
  }
}
