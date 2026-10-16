import { randomUUID } from 'node:crypto';
import { recoverTypedDataAddress, getAddress, type Hex } from 'viem';
import {
  newApprovalTerms,
  verifyMandateSignature,
  intentApprovalTypedData,
} from '@synq/kernel/arc';
import { WorkspaceError } from './contracts.js';
import { WorkspaceFinance, type WorkspaceAuthority } from './finance.js';
import {
  BudgetEditSchema,
  PayoutRequestSchema,
  PayoutDataSchema,
  payoutIntent,
  payoutMandate,
  type PayoutData,
} from './finance-contracts.js';
export type PayoutRecord = {
  data: PayoutData;
  state:
    | 'REVIEW'
    | 'READY'
    | 'HOLD'
    | 'SIGNED'
    | 'PAID'
    | 'FAILED'
    | 'NEEDS_REVIEW'
    | 'CANCELLED';
  signatures: Record<string, Hex>;
  mandateSignature: Hex | null;
  reason: string | null;
  txHash: Hex | null;
};
const readRow = (r: Record<string, unknown>): PayoutRecord => ({
  data: PayoutDataSchema.parse(r.data),
  state: r.state as PayoutRecord['state'],
  signatures: r.signatures as Record<string, Hex>,
  mandateSignature: r.mandate_signature as Hex | null,
  reason: r.reason as string | null,
  txHash: r.tx_hash as Hex | null,
});

export class WorkspacePayouts {
  constructor(readonly finance: WorkspaceFinance) {}
  get workspaces() {
    return this.finance.workspaces;
  }
  async record(id: string) {
    const r = await this.workspaces.pool.query(
      'SELECT * FROM synq_ws_payouts WHERE id=$1',
      [id],
    );
    return r.rows[0] ? readRow(r.rows[0]) : null;
  }
  async view(workspaceId: string, principalId: string, id: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const p = await this.record(id);
    if (!p || p.data.workspaceId !== workspaceId)
      throw new WorkspaceError('PAYOUT_NOT_FOUND', 404);
    return {
      data: p.data,
      state: p.state,
      signedBy: Object.keys(p.signatures),
      mandateSigned: !!p.mandateSignature,
      reason: p.reason,
      txHash: p.txHash,
    };
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const r = await this.workspaces.pool.query(
      'SELECT id FROM synq_ws_payouts WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 100',
      [workspaceId],
    );
    return Promise.all(
      r.rows.map((v) => this.view(workspaceId, principalId, String(v.id))),
    );
  }
  async propose(workspaceId: string, principalId: string, raw: unknown) {
    const member = await this.workspaces.membership(workspaceId, principalId);
    if (member.role === 'VIEWER')
      throw new WorkspaceError('PROPOSER_REQUIRED', 403);
    const b = PayoutRequestSchema.parse(raw);
    const a = await this.finance.authority(workspaceId);
    const id = await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const same = await sql.query(
        'SELECT * FROM synq_ws_payouts WHERE workspace_id=$1 AND idempotency_key=$2',
        [workspaceId, b.idempotencyKey],
      );
      if (same.rows[0]) {
        const p = readRow(same.rows[0]);
        if (
          p.data.vendorId !== b.vendorId ||
          p.data.amount !== b.amount ||
          p.data.obligation !== b.obligation ||
          p.data.purpose !== b.purpose
        )
          throw new WorkspaceError('IDEMPOTENCY_CONFLICT');
        return p.data.id;
      }
      const vendor = await sql.query(
        'SELECT * FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
        [workspaceId, b.vendorId],
      );
      const v = vendor.rows[0];
      if (!v) throw new WorkspaceError('VENDOR_NOT_VERIFIED');
      if (Number(v.eligible_at) > this.workspaces.now())
        throw new WorkspaceError('VENDOR_COOLING');
      const budget = await sql.query(
        'SELECT data,change_hash FROM synq_ws_budgets WHERE workspace_id=$1',
        [workspaceId],
      );
      const current = budget.rows[0];
      if (!current) throw new WorkspaceError('SIGNED_BUDGET_REQUIRED');
      const limits = BudgetEditSchema.parse(current.data);
      if (BigInt(b.amount) > BigInt(limits.perPayment))
        throw new WorkspaceError('SAFE_MULTISIG_PROPOSAL_REQUIRED');
      // Prefer the proposing owner; otherwise use the workspace creator's current owner wallet.
      const creator = await sql.query(
        "SELECT m.wallet FROM synq_workspaces w JOIN synq_ws_members m ON m.workspace_id=w.id AND m.principal_id=w.created_by AND m.role='OWNER' WHERE w.id=$1",
        [workspaceId],
      );
      const primaryOwner = getAddress(
        member.role === 'OWNER'
          ? member.wallet
          : String(creator.rows[0]?.wallet),
      );
      const p = PayoutDataSchema.parse({
        id: randomUUID(),
        workspaceId,
        vendorId: b.vendorId,
        recipient: v.address,
        amount: b.amount,
        purpose: b.purpose,
        obligation: b.obligation,
        vendorChangeHash: v.change_hash,
        budgetChangeHash: current.change_hash,
        budget: limits,
        primaryOwner,
        token: a.token,
        vault: a.vault,
        proposedBy: principalId,
        approval: newApprovalTerms(this.workspaces.now()),
        createdAt: this.workspaces.now(),
      });
      const inserted = await sql.query(
        "INSERT INTO synq_ws_payouts(id,workspace_id,idempotency_key,obligation,data,state,created_at) VALUES($1,$2,$3,$4,$5,'REVIEW',$6) ON CONFLICT(workspace_id,obligation) WHERE state<>'CANCELLED' DO NOTHING RETURNING id",
        [p.id, workspaceId, b.idempotencyKey, b.obligation, p, p.createdAt],
      );
      if (!inserted.rowCount)
        throw new WorkspaceError('OBLIGATION_ALREADY_PROPOSED');
      return p.id;
    });
    return this.view(workspaceId, principalId, id);
  }
  async cancel(workspaceId: string, principalId: string, id: string) {
    const member = await this.workspaces.membership(workspaceId, principalId);
    if (member.role !== 'OWNER')
      throw new WorkspaceError('OWNER_REQUIRED', 403);
    await this.finance.authority(workspaceId);
    await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT state FROM synq_ws_payouts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      if (!r.rows[0]) throw new WorkspaceError('PAYOUT_NOT_FOUND', 404);
      if (!['REVIEW', 'READY', 'HOLD'].includes(String(r.rows[0].state)))
        throw new WorkspaceError('PAYOUT_NOT_CANCELLABLE');
      const signed = await sql.query(
        'SELECT 1 FROM synq_arc_payout_outbox WHERE key=$1',
        [`workspace-payout:${id}`],
      );
      if (signed.rowCount)
        throw new WorkspaceError('SIGNED_PAYOUT_REQUIRES_RECONCILIATION');
      await sql.query(
        "UPDATE synq_ws_payouts SET state='CANCELLED',reason='CANCELLED_BY_OWNER' WHERE id=$1",
        [id],
      );
    });
    return this.view(workspaceId, principalId, id);
  }
  async verifyQuorum(p: PayoutRecord, a: WorkspaceAuthority) {
    if (!p.mandateSignature)
      throw new WorkspaceError('SIGNED_MANDATE_REQUIRED');
    await verifyMandateSignature(payoutMandate(p.data), p.mandateSignature);
    const counted = new Set<string>();
    for (const [wallet, signature] of Object.entries(p.signatures)) {
      const recovered = await recoverTypedDataAddress({
        ...intentApprovalTypedData(payoutIntent(p.data), p.data.approval),
        signature,
      }).catch(() => null);
      if (
        recovered?.toLowerCase() === wallet &&
        a.owners.some((v) => v.toLowerCase() === wallet)
      )
        counted.add(wallet);
    }
    if (
      counted.size < a.threshold ||
      !counted.has(p.data.primaryOwner.toLowerCase())
    )
      throw new WorkspaceError('CURRENT_OWNER_QUORUM_REQUIRED');
  }
  async approve(
    workspaceId: string,
    principalId: string,
    id: string,
    input: { signature: Hex; mandateSignature?: Hex },
  ) {
    const member = await this.workspaces.membership(workspaceId, principalId);
    if (member.role !== 'OWNER')
      throw new WorkspaceError('OWNER_REQUIRED', 403);
    const a = await this.finance.authority(workspaceId);
    await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT * FROM synq_ws_payouts WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [id, workspaceId],
      );
      if (!r.rows[0]) throw new WorkspaceError('PAYOUT_NOT_FOUND', 404);
      const p = readRow(r.rows[0]);
      if (p.state !== 'REVIEW')
        throw new WorkspaceError('PAYOUT_NOT_REVIEWABLE');
      if (p.data.approval.deadline <= this.workspaces.now())
        throw new WorkspaceError('APPROVAL_EXPIRED');
      const signer = await recoverTypedDataAddress({
        ...intentApprovalTypedData(payoutIntent(p.data), p.data.approval),
        signature: input.signature,
      }).catch(() => null);
      if (
        !signer ||
        signer.toLowerCase() !== member.wallet.toLowerCase() ||
        !a.owners.some((v) => v.toLowerCase() === signer.toLowerCase())
      )
        throw new WorkspaceError('INVALID_OWNER_SIGNATURE', 403);
      p.signatures[signer.toLowerCase()] = input.signature;
      if (input.mandateSignature) {
        await verifyMandateSignature(
          payoutMandate(p.data),
          input.mandateSignature,
        );
        p.mandateSignature = input.mandateSignature;
      }
      let ready = false;
      try {
        await this.verifyQuorum(p, a);
        ready = true;
      } catch (error) {
        if (
          error instanceof WorkspaceError &&
          ['CURRENT_OWNER_QUORUM_REQUIRED', 'SIGNED_MANDATE_REQUIRED'].includes(
            error.code,
          )
        )
          ready = false;
        else throw error;
      }
      if (ready) {
        const budget = await sql.query(
          'SELECT change_hash FROM synq_ws_budgets WHERE workspace_id=$1',
          [workspaceId],
        );
        if (budget.rows[0]?.change_hash !== p.data.budgetChangeHash)
          throw new WorkspaceError('BUDGET_CHANGED');
        const sum = await sql.query(
          "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS spent FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED','PAID') AND (state<>'PAID' OR executed_at>$2)",
          [workspaceId, this.workspaces.now() - 86400],
        );
        if (
          BigInt(sum.rows[0].spent) + BigInt(p.data.amount) >
          BigInt(p.data.budget.daily)
        )
          throw new WorkspaceError('DAILY_BUDGET_EXHAUSTED');
      }
      await sql.query(
        'UPDATE synq_ws_payouts SET signatures=$2,mandate_signature=$3,state=$4 WHERE id=$1',
        [id, p.signatures, p.mandateSignature, ready ? 'READY' : 'REVIEW'],
      );
    });
    return this.view(workspaceId, principalId, id);
  }
}
