import { getAddress } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  extractMemoPayments,
  InvoiceError,
  type InvoiceService,
} from '@synq/invoices';
import {
  walletTag,
  type IndexedEvent,
  type IndexerChain,
  type Ledger,
} from '@synq/ledger';
import type { WorkspaceFinance } from './finance.js';

/** Called only for finalized events from the code-pinned persistent indexer. */
export class WorkspaceReceipts {
  constructor(
    readonly finance: WorkspaceFinance,
    readonly invoices: InvoiceService,
    readonly ledger: Ledger,
  ) {}
  async apply(workspaceId: string, chain: IndexerChain, event: IndexedEvent) {
    const usdc = token('arc-testnet', 'USDC');
    if (event.chainId !== usdc.chainId) throw new Error('WRONG_CHAIN');
    if (event.kind !== 'TRANSFER') return 'MEMO_HANDLED_WITH_TRANSFER';
    if (getAddress(event.emitter) !== getAddress(usdc.address))
      throw new Error('WRONG_TOKEN');
    const key = `chain:${event.chainId}:${event.txHash.toLowerCase()}:${event.logIndex}`;
    const pool = this.finance.workspaces.pool;
    if (event.removed) {
      await this.finance.workspaces.transaction(async (sql) => {
        await sql.query(
          'SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE',
          [workspaceId],
        );
        await sql.query(
          "UPDATE synq_ws_receipts SET state='REVIEW',reason='REORGED_RECEIPT' WHERE key=$1 AND workspace_id=$2",
          [key, workspaceId],
        );
      });
      return 'REVIEW_REORGED_RECEIPT';
    }
    const w = await pool.query(
      "SELECT vault FROM synq_workspaces WHERE id=$1 AND status='ACTIVE'",
      [workspaceId],
    );
    const vault = w.rows[0]?.vault;
    if (!vault) throw new Error('ACTIVE_VAULT_REQUIRED');
    if (event.data.to?.toLowerCase() !== vault.toLowerCase()) return 'OUTGOING';
    const receipt = await chain.receiptLogs(event.txHash);
    if (receipt.status !== 'success') throw new Error('RECEIPT_NOT_SUCCESS');
    // Transfer effects run before Memo effects. Pair from the whole receipt first.
    const parsed = extractMemoPayments({
      chainId: usdc.chainId,
      txHash: event.txHash,
      logs: receipt.logs,
      token: usdc.address,
      memoContract: contract('arc-testnet', 'MEMO').address,
    });
    const payment = parsed.payments.find((p) => p.logIndex === event.logIndex);
    const transfer = payment
      ? { from: payment.payer, to: payment.recipient, amount: payment.amount }
      : parsed.unreferenced.find((p) => p.logIndex === event.logIndex);
    const log = receipt.logs.find(
      (l) =>
        l.logIndex === event.logIndex &&
        l.address.toLowerCase() === usdc.address.toLowerCase(),
    );
    if (
      !transfer ||
      !log ||
      log.removed ||
      log.transactionHash?.toLowerCase() !== event.txHash.toLowerCase() ||
      log.blockHash?.toLowerCase() !== event.blockHash.toLowerCase() ||
      log.blockNumber !== event.blockNumber ||
      transfer.to.toLowerCase() !== vault.toLowerCase() ||
      transfer.from.toLowerCase() !== event.data.from?.toLowerCase() ||
      String(transfer.amount) !== event.data.value
    )
      throw new Error('RECEIPT_PROVENANCE_MISMATCH');
    if (transfer.amount === 0n) return 'ZERO_TRANSFER';
    const data = {
      chainId: usdc.chainId,
      token: usdc.address,
      vault,
      txHash: event.txHash.toLowerCase(),
      logIndex: event.logIndex,
      blockNumber: String(event.blockNumber),
      blockHash: event.blockHash,
      from: transfer.from,
      amount: String(transfer.amount),
      paymentRef: payment?.paymentRef ?? null,
    };
    await pool.query(
      "INSERT INTO synq_ws_receipts(key,workspace_id,data,state,created_at) VALUES($1,$2,$3,'BOOKING',$4) ON CONFLICT DO NOTHING",
      [key, workspaceId, data, this.finance.workspaces.now()],
    );
    const saved = (
      await pool.query('SELECT * FROM synq_ws_receipts WHERE key=$1', [key])
    ).rows[0];
    if (
      saved.workspace_id !== workspaceId ||
      saved.data.blockHash !== data.blockHash
    ) {
      await pool.query(
        "UPDATE synq_ws_receipts SET state='REVIEW',reason='CONFLICTING_PROVENANCE' WHERE key=$1",
        [key],
      );
      throw new Error('RECEIPT_CONFLICT');
    }
    if (saved.state === 'REVIEW') return 'REVIEW';
    if (saved.state === 'PENDING_POLICY') return 'DUPLICATE';
    let invoiceId: string | null = null;
    if (payment) {
      const known = await this.invoices.store.byPaymentRef(payment.paymentRef);
      if (known && known.invoice.workspaceId !== workspaceId)
        throw new Error('INVOICE_WORKSPACE_MISMATCH');
      try {
        const result = await this.invoices.settle(payment);
        if (result.outcome !== 'UNMATCHED')
          invoiceId = result.invoice.invoiceId;
      } catch (e) {
        if (!(e instanceof InvoiceError)) throw e;
        await pool.query(
          "UPDATE synq_ws_receipts SET state='REVIEW',reason=$2 WHERE key=$1",
          [key, `INVOICE_${e.code}`],
        );
        return `REVIEW:INVOICE_${e.code}`;
      }
    }
    if (!invoiceId)
      await this.ledger.post({
        entryId: `receipt:${key}`,
        workspaceId,
        occurredAt: Number(saved.created_at),
        memo: 'Unapplied Arc USDC receipt',
        source: { kind: 'CHAIN_TX', ref: key },
        evidence: {
          chainId: usdc.chainId,
          txHash: event.txHash,
          logIndex: event.logIndex,
          recipient: getAddress(vault),
        },
        idempotencyKey: key,
        reversalOf: null,
        postings: [
          {
            account: 'CASH_ARC_USDC',
            assetId: usdc.assetId,
            amount: transfer.amount,
            counterpartyId: walletTag(getAddress(vault)),
          },
          {
            account: 'UNAPPLIED_RECEIPTS',
            assetId: usdc.assetId,
            amount: -transfer.amount,
          },
        ],
      });
    // Crash before this update replays the same invoice/ledger key, never a new credit.
    await pool.query(
      "UPDATE synq_ws_receipts SET state='PENDING_POLICY',invoice_id=$2 WHERE key=$1 AND state='BOOKING'",
      [key, invoiceId],
    );
    return invoiceId ? `INVOICE:${invoiceId}` : 'UNAPPLIED';
  }
}
