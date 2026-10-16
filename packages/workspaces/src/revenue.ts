import { randomUUID } from 'node:crypto';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import {
  parsePolicy,
  policyTypedData,
  mandateFromPolicy,
  type RevenuePolicy,
} from '@synq/allocations/policy-data';
import {
  verifySignedPolicy,
  PostgresSplitStore,
  type SignedRevenuePolicy,
} from '@synq/allocations';
import { mandateTypedData } from '@synq/kernel/arc-payment-data';
import { WorkspaceError } from './contracts.js';
import type { WorkspaceFinance } from './finance.js';
import {
  DraftRevenuePolicySchema,
  RevenuePolicyWireSchema,
  revenueWire,
  revenueRevocationTypedData,
} from './revenue-contracts.js';

type SignaturePair = { policy: Hex; mandate: Hex };
type Row = {
  id: string;
  workspace_id: string;
  data: unknown;
  signatures: Record<string, SignaturePair>;
  revocations: Record<string, Hex>;
  state: 'REVIEW' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
};
export class WorkspaceRevenue {
  constructor(readonly finance: WorkspaceFinance) {}
  get workspaces() {
    return this.finance.workspaces;
  }
  private async owner(workspaceId: string, principalId: string) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    return m;
  }
  private view(row: Row) {
    return {
      id: row.id,
      policy: revenueWire(RevenuePolicyWireSchema.parse(row.data)),
      state: row.state,
      signedBy: Object.keys(row.signatures),
      revokedBy: Object.keys(row.revocations),
    };
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    return (
      await this.workspaces.pool.query(
        'SELECT * FROM synq_ws_revenue_policies WHERE workspace_id=$1 ORDER BY version DESC LIMIT 50',
        [workspaceId],
      )
    ).rows.map((r) => this.view(r));
  }
  async allocations(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const rows = await this.workspaces.pool.query(
      'SELECT s.split_id,r.state AS receipt_state FROM synq_alloc_splits s JOIN synq_ws_receipts r ON r.key=s.receipt_id WHERE s.workspace_id=$1 ORDER BY s.created_at DESC LIMIT 50',
      [workspaceId],
    );
    const store = new PostgresSplitStore(this.workspaces.pool);
    return Promise.all(
      rows.rows.map(async (row) => {
        const split = (await store.get(row.split_id))!;
        return {
          id: split.splitId,
          invoiceId: split.invoiceId,
          state: split.state,
          receiptReview: row.receipt_state === 'REVIEW',
          received: String(split.receipt.amount),
          receiptTx: split.receipt.txHash,
          policyVersion: split.policyVersion,
          legs: (await store.legs(split.splitId)).map((l) => ({
            kind: l.kind,
            purpose: l.purpose,
            amount: String(l.amount),
            state: l.state,
            recipient: l.payTo,
            txHash: l.txHash,
          })),
        };
      }),
    );
  }
  async propose(workspaceId: string, principalId: string, raw: unknown) {
    const m = await this.owner(workspaceId, principalId),
      input = DraftRevenuePolicySchema.parse(raw);
    const a = await this.finance.authority(workspaceId);
    return this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const vendors = await sql.query(
        'SELECT id,name,address,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
        [workspaceId, input.vendorIds],
      );
      if (
        vendors.rows.length !== input.vendorIds.length ||
        vendors.rows.some((v) => Number(v.eligible_at) > this.workspaces.now())
      )
        throw new WorkspaceError('VERIFIED_VENDOR_REQUIRED');
      const prior = await sql.query(
        'SELECT COALESCE(max(version),0) AS version FROM synq_ws_revenue_policies WHERE workspace_id=$1',
        [workspaceId],
      );
      const policy = parsePolicy({
        policyId: `workspace:${workspaceId.replaceAll('-', '')}`,
        version: Number(prior.rows[0].version) + 1,
        workspaceId,
        owner: getAddress(m.wallet),
        treasury: a.vault,
        chainId: 5042002,
        token: a.token,
        decimals: 6,
        validFrom: this.workspaces.now(),
        validUntil: this.workspaces.now() + input.validForSeconds,
        taxReserveBps: input.taxReserveBps,
        operatingFloor: input.operatingFloor,
        obligationHorizonDays: input.obligationHorizonDays,
        allowedBeneficiaries: vendors.rows.map((v) => ({
          beneficiaryId: v.id,
          address: getAddress(v.address),
          label: v.name,
        })),
        distributions: input.distributions,
        limits: input.limits,
        maxBalanceAgeSeconds: 60,
        remainder: 'FREE_CASH',
        cancellation: 'BEFORE_EXECUTION',
        recovery: 'RECONCILE_THEN_REVIEW',
      });
      await this.assertTerms(policy);
      const id = randomUUID();
      const r = await sql.query(
        "INSERT INTO synq_ws_revenue_policies(id,workspace_id,version,data,state,created_at) VALUES($1,$2,$3,$4,'REVIEW',$5) RETURNING *",
        [
          id,
          workspaceId,
          policy.version,
          revenueWire(policy),
          this.workspaces.now(),
        ],
      );
      return this.view(r.rows[0]);
    });
  }
  private async assertTerms(p: RevenuePolicy) {
    const a = await this.finance.authority(p.workspaceId);
    if (
      getAddress(p.treasury) !== a.vault ||
      getAddress(p.token) !== a.token ||
      !a.owners.includes(p.owner)
    )
      throw new WorkspaceError('REVENUE_AUTHORITY_CHANGED');
    if (
      this.workspaces.now() < p.validFrom ||
      this.workspaces.now() >= p.validUntil
    )
      throw new WorkspaceError('REVENUE_POLICY_EXPIRED');
    const budget = (
      await this.workspaces.pool.query(
        'SELECT data FROM synq_ws_budgets WHERE workspace_id=$1',
        [p.workspaceId],
      )
    ).rows[0]?.data;
    if (
      !budget ||
      p.limits.maxAutonomousPerLeg > BigInt(budget.perPayment) ||
      p.limits.maxAutonomousPerWindow > BigInt(budget.aiDaily) ||
      p.limits.windowSeconds !== 86400 ||
      p.operatingFloor < BigInt(budget.reserve)
    )
      throw new WorkspaceError('REVENUE_OUTSIDE_WORKSPACE_BUDGET');
    const vendors = await this.workspaces.pool.query(
      'SELECT id,address,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1',
      [p.workspaceId],
    );
    for (const b of p.allowedBeneficiaries) {
      const v = vendors.rows.find((v) => v.id === b.beneficiaryId);
      if (
        !v ||
        getAddress(v.address) !== b.address ||
        Number(v.eligible_at) > this.workspaces.now()
      )
        throw new WorkspaceError('REVENUE_VENDOR_CHANGED');
    }
    return a;
  }
  private async signatures(
    p: RevenuePolicy,
    signatures: Record<string, SignaturePair>,
  ) {
    const a = await this.assertTerms(p),
      valid = new Set<string>();
    for (const [wallet, pair] of Object.entries(signatures)) {
      const [policy, mandate] = await Promise.all([
        recoverTypedDataAddress({
          ...policyTypedData(p),
          signature: pair.policy,
        }),
        recoverTypedDataAddress({
          ...mandateTypedData(mandateFromPolicy(p)),
          signature: pair.mandate,
        }),
      ]);
      if (
        policy.toLowerCase() === wallet &&
        mandate === policy &&
        a.owners.includes(policy)
      )
        valid.add(wallet);
    }
    return { a, valid };
  }
  async approve(
    workspaceId: string,
    principalId: string,
    id: string,
    pair: SignaturePair,
  ) {
    const member = await this.owner(workspaceId, principalId);
    return this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const row = (
        await sql.query(
          'SELECT * FROM synq_ws_revenue_policies WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, id],
        )
      ).rows[0] as Row | undefined;
      if (!row) throw new WorkspaceError('REVENUE_POLICY_NOT_FOUND', 404);
      if (row.state !== 'REVIEW') return this.view(row);
      const p = RevenuePolicyWireSchema.parse(row.data),
        signatures = { ...row.signatures, [member.wallet.toLowerCase()]: pair };
      const { a, valid } = await this.signatures(p, signatures);
      if (!valid.has(member.wallet.toLowerCase()))
        throw new WorkspaceError('INVALID_REVENUE_SIGNATURE', 403);
      const activate =
        valid.size >= a.threshold && valid.has(p.owner.toLowerCase());
      if (activate) {
        const primary = signatures[p.owner.toLowerCase()]!;
        await verifySignedPolicy(
          {
            policy: p,
            policySignature: primary.policy,
            mandate: mandateFromPolicy(p),
            mandateSignature: primary.mandate,
          },
          this.workspaces.now(),
        );
        const newer = await sql.query(
          "SELECT id FROM synq_ws_revenue_policies WHERE workspace_id=$1 AND version>$2 AND state IN ('ACTIVE','REVOKED','SUPERSEDED')",
          [workspaceId, p.version],
        );
        if (newer.rowCount)
          throw new WorkspaceError('REVENUE_POLICY_SUPERSEDED');
        await sql.query(
          "UPDATE synq_ws_revenue_policies SET state='SUPERSEDED' WHERE workspace_id=$1 AND state='ACTIVE'",
          [workspaceId],
        );
      }
      const r = await sql.query(
        'UPDATE synq_ws_revenue_policies SET signatures=$2,state=$3 WHERE id=$1 RETURNING *',
        [id, signatures, activate ? 'ACTIVE' : 'REVIEW'],
      );
      return this.view(r.rows[0]);
    });
  }
  async revoke(
    workspaceId: string,
    principalId: string,
    id: string,
    signature: Hex,
  ) {
    const member = await this.owner(workspaceId, principalId);
    return this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const row = (
        await sql.query(
          'SELECT * FROM synq_ws_revenue_policies WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [workspaceId, id],
        )
      ).rows[0] as Row | undefined;
      if (!row) throw new WorkspaceError('REVENUE_POLICY_NOT_FOUND', 404);
      if (row.state !== 'ACTIVE')
        throw new WorkspaceError('REVENUE_POLICY_NOT_ACTIVE');
      const p = RevenuePolicyWireSchema.parse(row.data),
        a = await this.finance.authority(workspaceId);
      const signer = await recoverTypedDataAddress({
        ...revenueRevocationTypedData(p),
        signature,
      });
      if (
        signer.toLowerCase() !== member.wallet.toLowerCase() ||
        !a.owners.includes(signer)
      )
        throw new WorkspaceError('INVALID_REVENUE_SIGNATURE', 403);
      const revocations = {
          ...row.revocations,
          [signer.toLowerCase()]: signature,
        },
        valid = new Set<string>();
      for (const sig of Object.values(revocations)) {
        const recovered = await recoverTypedDataAddress({
          ...revenueRevocationTypedData(p),
          signature: sig,
        });
        if (a.owners.includes(recovered)) valid.add(recovered.toLowerCase());
      }
      const r = await sql.query(
        'UPDATE synq_ws_revenue_policies SET revocations=$2,state=$3 WHERE id=$1 RETURNING *',
        [id, revocations, valid.size >= a.threshold ? 'REVOKED' : 'ACTIVE'],
      );
      return this.view(r.rows[0]);
    });
  }
  /** Revalidated by the runner and again immediately before any new signature. */
  async active(
    workspaceId: string,
  ): Promise<{ id: string; signed: SignedRevenuePolicy } | null> {
    const row = (
      await this.workspaces.pool.query(
        "SELECT * FROM synq_ws_revenue_policies WHERE workspace_id=$1 AND state='ACTIVE' ORDER BY version DESC LIMIT 1",
        [workspaceId],
      )
    ).rows[0] as Row | undefined;
    if (!row) return null;
    const policy = RevenuePolicyWireSchema.parse(row.data),
      { a, valid } = await this.signatures(policy, row.signatures);
    if (valid.size < a.threshold || !valid.has(policy.owner.toLowerCase()))
      throw new WorkspaceError('REVENUE_QUORUM_CHANGED');
    const primary = row.signatures[policy.owner.toLowerCase()]!;
    const signed = {
      policy,
      policySignature: primary.policy,
      mandate: mandateFromPolicy(policy),
      mandateSignature: primary.mandate,
    };
    await verifySignedPolicy(signed, this.workspaces.now());
    return { id: row.id, signed };
  }
}
