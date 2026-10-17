import { randomUUID } from 'node:crypto';
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { contract, token } from '@synq/chain-registry/arc';
import { MEMO_ABI, type MemoPayment } from '@synq/invoices';
import { Ledger, PostgresLedgerStore, walletTag } from '@synq/ledger';
import { WorkspaceError } from './contracts.js';
import type { WorkspaceFinance } from './finance.js';
import { UnitsSchema } from './finance-contracts.js';

export const ContributionRequestSchema = z.strictObject({
  amount: UnitsSchema.refine((v) => BigInt(v) > 0n, 'must be positive'),
  note: z.string().trim().max(120).default(''),
});
/** Group funds hold members' money: a contribution is that member's equity, never revenue. */
export const memberTag = (principalId: string) => `member:${principalId}`;
type Sql = {
  query(
    q: string,
    v?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

/**
 * Group-fund contributions on Arc. A member asks to contribute; the server
 * returns a Memo payment from that member's own wallet to the workspace
 * vault, tagged with a one-time reference. The persistent indexer credits it
 * only when the reference, the exact amount and the paying wallet all match;
 * it is booked as the member's equity. Spending uses the vault's normal
 * owner-quorum payouts; refunds return each member's equity by quorum.
 */
export class WorkspaceContributions {
  constructor(readonly finance: WorkspaceFinance) {}
  private get pool() {
    return this.finance.workspaces.pool;
  }
  async request(workspaceId: string, principalId: string, raw: unknown) {
    const m = await this.finance.workspaces.membership(
      workspaceId,
      principalId,
    );
    if (m.role === 'VIEWER')
      throw new WorkspaceError('CONTRIBUTOR_ROLE_REQUIRED', 403);
    const b = ContributionRequestSchema.parse(raw);
    const a = await this.finance.authority(workspaceId);
    const id = randomUUID(),
      paymentRef = keccak256(toHex(`synq-contribution:${id}`)),
      now = this.finance.workspaces.now();
    await this.pool.query(
      "INSERT INTO synq_ws_contributions(id,workspace_id,principal_id,wallet,amount,payment_ref,note,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,$9)",
      [
        id,
        workspaceId,
        principalId,
        m.wallet.toLowerCase(),
        b.amount,
        paymentRef,
        b.note,
        now,
        now + 7 * 86400,
      ],
    );
    return this.payment(id, a.vault, BigInt(b.amount), paymentRef);
  }
  private payment(id: string, vault: Address, amount: bigint, ref: Hex) {
    const usdc = token('arc-testnet', 'USDC');
    const inner = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [vault, amount],
    });
    const memoData = stringToHex(`synq:contribution:${id.slice(0, 8)}`);
    return {
      id,
      paymentRef: ref,
      amount: String(amount),
      vault,
      transaction: {
        to: contract('arc-testnet', 'MEMO').address,
        data: encodeFunctionData({
          abi: MEMO_ABI,
          functionName: 'memo',
          args: [usdc.address, inner, ref, memoData],
        }),
        value: '0',
      },
    };
  }
  /**
   * Indexer hook: credits a finalized Memo payment to its contribution.
   * Returns null when the reference is not a contribution.
   */
  async match(
    sql: Sql,
    workspaceId: string,
    payment: MemoPayment,
    receiptKey: string,
    vault: Address,
    at: number,
  ): Promise<'CONTRIBUTION' | 'REVIEW' | null> {
    const r = (
      await sql.query(
        'SELECT * FROM synq_ws_contributions WHERE payment_ref=$1 FOR UPDATE',
        [payment.paymentRef.toLowerCase()],
      )
    ).rows[0];
    if (!r) return null;
    if (
      r.workspace_id !== workspaceId ||
      String(r.wallet) !== payment.payer.toLowerCase() ||
      BigInt(String(r.amount)) !== payment.amount ||
      getAddress(payment.recipient) !== getAddress(vault)
    ) {
      await sql.query(
        "UPDATE synq_ws_contributions SET state='REVIEW',receipt_key=$2 WHERE id=$1 AND state='OPEN'",
        [r.id, receiptKey],
      );
      return 'REVIEW';
    }
    if (r.state === 'PAID') return 'CONTRIBUTION';
    const usdc = token('arc-testnet', 'USDC');
    const id = `contribution:${String(r.id)}`;
    await new Ledger(new PostgresLedgerStore(sql)).post({
      entryId: id,
      workspaceId,
      occurredAt: at,
      memo: 'Member contribution to the group fund',
      source: { kind: 'CHAIN_TX', ref: receiptKey },
      evidence: {
        chainId: usdc.chainId,
        txHash: payment.txHash,
        logIndex: payment.logIndex,
        recipient: getAddress(vault),
      },
      idempotencyKey: id,
      reversalOf: null,
      postings: [
        {
          account: 'CASH_ARC_USDC',
          assetId: usdc.assetId,
          amount: payment.amount,
          counterpartyId: walletTag(getAddress(vault)),
        },
        {
          account: 'OWNER_EQUITY',
          assetId: usdc.assetId,
          amount: -payment.amount,
          counterpartyId: memberTag(String(r.principal_id)),
        },
      ],
    });
    await sql.query(
      "UPDATE synq_ws_contributions SET state='PAID',receipt_key=$2,paid_at=$3 WHERE id=$1",
      [r.id, receiptKey, at],
    );
    return 'CONTRIBUTION';
  }
  /** Each member's money in the fund: contributions less refunds, from the ledger. */
  async equity(workspaceId: string) {
    const usdc = token('arc-testnet', 'USDC');
    const entries = await new Ledger(
      new PostgresLedgerStore(this.pool),
    ).store.entries(workspaceId);
    const out = new Map<string, bigint>();
    for (const e of entries)
      for (const p of e.postings)
        if (
          p.account === 'OWNER_EQUITY' &&
          p.assetId === usdc.assetId &&
          p.counterpartyId?.startsWith('member:')
        )
          out.set(
            p.counterpartyId.slice(7),
            (out.get(p.counterpartyId.slice(7)) ?? 0n) - p.amount,
          );
    return out;
  }
  async view(workspaceId: string, principalId: string) {
    await this.finance.workspaces.membership(workspaceId, principalId);
    const [rows, equity, members] = await Promise.all([
      this.pool.query(
        'SELECT id,principal_id,amount,state,note,created_at,paid_at FROM synq_ws_contributions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',
        [workspaceId],
      ),
      this.equity(workspaceId),
      this.pool.query(
        'SELECT principal_id,wallet FROM synq_ws_members WHERE workspace_id=$1',
        [workspaceId],
      ),
    ]);
    const hint = new Map(
      members.rows.map((m) => [
        String(m.principal_id),
        `${String(m.wallet).slice(0, 6)}…${String(m.wallet).slice(-4)}`,
      ]),
    );
    return {
      contributions: rows.rows.map((r) => ({
        id: String(r.id),
        mine: r.principal_id === principalId,
        member: hint.get(String(r.principal_id)) ?? 'former member',
        amount: String(r.amount),
        state: String(r.state),
        note: String(r.note),
        createdAt: Number(r.created_at),
        paidAt: r.paid_at === null ? null : Number(r.paid_at),
      })),
      balances: [...equity.entries()].map(([pid, amount]) => ({
        member: hint.get(pid) ?? 'former member',
        mine: pid === principalId,
        amount: String(amount),
      })),
    };
  }
  /**
   * Refund plan when the group winds down: every member gets back their
   * equity, scaled down pro rata (rounded down) when the vault holds less.
   */
  async refundPlan(workspaceId: string, available: bigint) {
    const equity = [...(await this.equity(workspaceId)).entries()].filter(
      ([, v]) => v > 0n,
    );
    const total = equity.reduce((n, [, v]) => n + v, 0n);
    const members = await this.pool.query(
      'SELECT principal_id,wallet FROM synq_ws_members WHERE workspace_id=$1',
      [workspaceId],
    );
    const wallet = new Map(
      members.rows.map((m) => [String(m.principal_id), String(m.wallet)]),
    );
    return equity.map(([principalId, owed]) => ({
      principalId,
      recipient: getAddress(
        wallet.get(principalId) ?? '0x0000000000000000000000000000000000000000',
      ),
      owed,
      amount: total <= available ? owed : (owed * available) / total,
      member: wallet.has(principalId),
    }));
  }
  /**
   * Owners start a wind-down: one refund row per member with equity, each
   * later signed as its own vault transfer. `available` is the vault's spendable
   * USDC after payouts in flight and money owed to others.
   */
  async proposeRefunds(
    workspaceId: string,
    principalId: string,
    available: bigint,
  ) {
    const m = await this.finance.workspaces.membership(
      workspaceId,
      principalId,
    );
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const open = await this.pool.query(
      "SELECT 1 FROM synq_ws_refunds WHERE workspace_id=$1 AND state IN ('REVIEW','SIGNED')",
      [workspaceId],
    );
    if (open.rowCount) throw new WorkspaceError('REFUNDS_IN_PROGRESS');
    const plan = (await this.refundPlan(workspaceId, available)).filter(
      (p) => p.member && p.amount > 0n,
    );
    if (!plan.length) throw new WorkspaceError('NOTHING_TO_REFUND');
    const now = this.finance.workspaces.now();
    for (const p of plan)
      await this.pool.query(
        "INSERT INTO synq_ws_refunds(id,workspace_id,principal_id,recipient,amount,state,created_at) VALUES($1,$2,$3,$4,$5,'REVIEW',$6)",
        [
          randomUUID(),
          workspaceId,
          p.principalId,
          p.recipient.toLowerCase(),
          String(p.amount),
          now,
        ],
      );
    return this.refunds(workspaceId, principalId);
  }
  async refunds(workspaceId: string, principalId: string) {
    await this.finance.workspaces.membership(workspaceId, principalId);
    return (
      await this.pool.query(
        'SELECT id,principal_id,recipient,amount,state,action_id,tx_hash FROM synq_ws_refunds WHERE workspace_id=$1 ORDER BY created_at,id',
        [workspaceId],
      )
    ).rows.map((r) => ({
      id: String(r.id),
      mine: r.principal_id === principalId,
      recipient: getAddress(String(r.recipient)),
      amount: String(r.amount),
      state: String(r.state),
      actionId: r.action_id === null ? null : String(r.action_id),
      txHash: r.tx_hash === null ? null : String(r.tx_hash),
    }));
  }
}
