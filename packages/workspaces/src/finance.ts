import { randomUUID } from 'node:crypto';
import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import type { PoolClient } from 'pg';
import { WorkspaceError } from './contracts.js';
import { PostgresWorkspaceStore } from './postgres.js';
import { FINANCE_MIGRATIONS } from './finance-migrations.js';
import {
  FinanceChangeSchema,
  FinanceEditSchema,
  financeChangeHash,
  financeChangeTypedData,
  type FinanceChange,
} from './finance-contracts.js';

export type WorkspaceAuthority = {
  vault: Address;
  policy: Address;
  token: Address;
  policyCodeHash: Hex;
  owners: readonly Address[];
  threshold: number;
  blockNumber: bigint;
  nonce: bigint;
};
export type WorkspaceAuthorityReader = (
  workspaceId: string,
) => Promise<WorkspaceAuthority>;
type ChangeRow = {
  data: FinanceChange;
  signatures: Record<string, Hex>;
  state: 'PENDING' | 'APPLIED';
};

/** No chat or SQL role can apply a finance edit without the current Safe quorum. */
export class WorkspaceFinance {
  constructor(
    readonly workspaces: PostgresWorkspaceStore,
    readonly readAuthority: WorkspaceAuthorityReader,
  ) {}
  async migrate(target: number = FINANCE_MIGRATIONS.length) {
    if (
      !Number.isInteger(target) ||
      target < 0 ||
      target > FINANCE_MIGRATIONS.length
    )
      throw new Error('invalid finance migration target');
    return this.workspaces.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_workspace_finance_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_workspace_finance_migrations(version int PRIMARY KEY)',
      );
      const r = await sql.query(
        'SELECT version FROM synq_workspace_finance_migrations',
      );
      const versions = new Set(r.rows.map((v) => Number(v.version)));
      for (const m of [...FINANCE_MIGRATIONS].reverse())
        if (versions.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_workspace_finance_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of FINANCE_MIGRATIONS)
        if (!versions.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_workspace_finance_migrations VALUES($1)',
            [m.version],
          );
        }
    });
  }
  async authority(workspaceId: string) {
    const a = await this.readAuthority(workspaceId);
    const members = await this.workspaces.pool.query(
      "SELECT wallet FROM synq_ws_members WHERE workspace_id=$1 AND role='OWNER'",
      [workspaceId],
    );
    const registered = members.rows
      .map((r) => String(r.wallet).toLowerCase())
      .sort();
    const live = a.owners.map((v) => v.toLowerCase()).sort();
    if (
      !a.owners.length ||
      a.threshold < 1 ||
      a.threshold > a.owners.length ||
      new Set(live).size !== live.length ||
      JSON.stringify(registered) !== JSON.stringify(live)
    )
      throw new WorkspaceError('ONCHAIN_AUTHORITY_CHANGED', 409);
    const stored = await this.workspaces.pool.query(
      "SELECT vault,policy,threshold FROM synq_workspaces WHERE id=$1 AND status='ACTIVE'",
      [workspaceId],
    );
    const w = stored.rows[0];
    if (
      !w ||
      w.vault.toLowerCase() !== a.vault.toLowerCase() ||
      w.policy.toLowerCase() !== a.policy.toLowerCase() ||
      Number(w.threshold) !== a.threshold
    )
      throw new WorkspaceError('VAULT_AUTHORITY_MISMATCH', 409);
    return a;
  }
  private async owner(workspaceId: string, principalId: string) {
    const member = await this.workspaces.membership(workspaceId, principalId);
    if (member.role !== 'OWNER')
      throw new WorkspaceError('OWNER_REQUIRED', 403);
    return member;
  }
  async propose(workspaceId: string, principalId: string, raw: unknown) {
    await this.owner(workspaceId, principalId);
    const edit = FinanceEditSchema.parse(raw);
    const a = await this.authority(workspaceId);
    const pool = this.workspaces.pool;
    if (edit.kind === 'PAYABLE' || edit.kind === 'OBLIGATION') {
      const v = await pool.query(
        'SELECT 1 FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
        [workspaceId, edit.vendorId],
      );
      if (!v.rowCount) throw new WorkspaceError('VENDOR_NOT_VERIFIED');
    }
    if (edit.kind === 'PAYABLE') {
      const used = await pool.query(
        'SELECT 1 FROM synq_ws_payables WHERE workspace_id=$1 AND id=$2',
        [workspaceId, edit.payableId],
      );
      if (used.rowCount) throw new WorkspaceError('PAYABLE_EXISTS');
    }
    if (edit.kind === 'CLOSE_PAYABLE') {
      const open = await pool.query(
        "SELECT 1 FROM synq_ws_payables WHERE workspace_id=$1 AND id=$2 AND status='OPEN'",
        [workspaceId, edit.payableId],
      );
      if (!open.rowCount) throw new WorkspaceError('PAYABLE_NOT_OPEN');
    }
    if (edit.kind === 'REMOVE_BILL') {
      const active = await pool.query(
        'SELECT 1 FROM synq_ws_bills WHERE workspace_id=$1 AND id=$2 AND active',
        [workspaceId, edit.billId],
      );
      if (!active.rowCount) throw new WorkspaceError('BILL_NOT_ACTIVE');
    }
    const revision = await this.workspaces.pool.query(
      'SELECT revision FROM synq_ws_finance_revision WHERE workspace_id=$1',
      [workspaceId],
    );
    const c = FinanceChangeSchema.parse({
      workspaceId,
      vault: a.vault,
      token: a.token,
      chainId: 5042002,
      revision: Number(revision.rows[0]?.revision ?? 0),
      nonce: randomUUID(),
      expiresAt: this.workspaces.now() + 900,
      edit,
    });
    const hash = financeChangeHash(c);
    await this.workspaces.pool.query(
      'INSERT INTO synq_ws_finance_changes(hash,workspace_id,data,signatures,state) VALUES($1,$2,$3,$4,$5)',
      [hash, workspaceId, c, {}, 'PENDING'],
    );
    return this.change(workspaceId, principalId, hash);
  }
  async change(workspaceId: string, principalId: string, hash: Hex) {
    await this.workspaces.membership(workspaceId, principalId);
    const r = await this.workspaces.pool.query(
      'SELECT data,signatures,state FROM synq_ws_finance_changes WHERE workspace_id=$1 AND hash=$2',
      [workspaceId, hash],
    );
    const row = r.rows[0] as ChangeRow | undefined;
    if (!row) throw new WorkspaceError('CHANGE_NOT_FOUND', 404);
    return {
      hash,
      change: row.data,
      signedBy: Object.keys(row.signatures),
      state: row.state,
      typedData: JSON.parse(
        JSON.stringify(financeChangeTypedData(row.data), (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ) as unknown,
    };
  }
  async approve(
    workspaceId: string,
    principalId: string,
    hash: Hex,
    signature: Hex,
  ) {
    const member = await this.owner(workspaceId, principalId);
    const a = await this.authority(workspaceId);
    await this.workspaces.transaction(async (sql) => {
      // Workspace lock serializes independent edits and payout checks.
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT data,signatures,state FROM synq_ws_finance_changes WHERE workspace_id=$1 AND hash=$2 FOR UPDATE',
        [workspaceId, hash],
      );
      const row = r.rows[0] as ChangeRow | undefined;
      if (!row) throw new WorkspaceError('CHANGE_NOT_FOUND', 404);
      const c = FinanceChangeSchema.parse(row.data);
      if (row.state === 'APPLIED') return;
      if (
        c.expiresAt <= this.workspaces.now() ||
        financeChangeHash(c) !== hash ||
        getAddress(c.vault) !== a.vault ||
        getAddress(c.token) !== a.token
      )
        throw new WorkspaceError('STALE_CHANGE');
      const signer = await recoverTypedDataAddress({
        ...financeChangeTypedData(c),
        signature,
      }).catch(() => null);
      if (
        !signer ||
        signer.toLowerCase() !== member.wallet.toLowerCase() ||
        !a.owners.some((v) => v.toLowerCase() === signer.toLowerCase())
      )
        throw new WorkspaceError('INVALID_OWNER_SIGNATURE', 403);
      const revision = await sql.query(
        'SELECT revision FROM synq_ws_finance_revision WHERE workspace_id=$1',
        [workspaceId],
      );
      if (Number(revision.rows[0]?.revision ?? 0) !== c.revision)
        throw new WorkspaceError('STALE_REVISION');
      const signatures = {
        ...row.signatures,
        [signer.toLowerCase()]: signature,
      };
      // Revalidate every saved signature at the point the quorum applies.
      const counted = new Set<string>();
      for (const [wallet, sig] of Object.entries(signatures)) {
        const recovered = await recoverTypedDataAddress({
          ...financeChangeTypedData(c),
          signature: sig,
        }).catch(() => null);
        if (
          recovered?.toLowerCase() === wallet &&
          a.owners.some((v) => v.toLowerCase() === wallet)
        )
          counted.add(wallet);
      }
      const apply = counted.size >= a.threshold;
      if (apply) {
        await this.apply(sql, c, hash);
        await sql.query(
          'INSERT INTO synq_ws_finance_revision(workspace_id,revision) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision',
          [workspaceId, c.revision + 1],
        );
      }
      await sql.query(
        'UPDATE synq_ws_finance_changes SET signatures=$3,state=$4 WHERE workspace_id=$1 AND hash=$2',
        [workspaceId, hash, signatures, apply ? 'APPLIED' : 'PENDING'],
      );
    });
    return this.change(workspaceId, principalId, hash);
  }
  private async apply(sql: PoolClient, c: FinanceChange, hash: Hex) {
    const e = c.edit;
    if (e.kind === 'REVOKE_BUDGET') {
      await sql.query('DELETE FROM synq_ws_budgets WHERE workspace_id=$1', [
        c.workspaceId,
      ]);
      return;
    }
    if (e.kind === 'BUDGET') {
      await sql.query(
        'INSERT INTO synq_ws_budgets(workspace_id,data,change_hash) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET data=EXCLUDED.data,change_hash=EXCLUDED.change_hash',
        [c.workspaceId, e, hash],
      );
      return;
    }
    if (e.kind === 'PAYABLE') {
      // The payable is owed at the vendor's verified address as of approval; a later
      // address change makes the waterfall refuse it rather than pay the new address.
      const v = (
        await sql.query(
          'SELECT address FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
          [c.workspaceId, e.vendorId],
        )
      ).rows[0];
      if (!v) throw new WorkspaceError('VENDOR_NOT_VERIFIED');
      const inserted = await sql.query(
        "INSERT INTO synq_ws_payables(workspace_id,id,data,pay_to,status,change_hash,created_at) VALUES($1,$2,$3,$4,'OPEN',$5,$6) ON CONFLICT DO NOTHING RETURNING id",
        [
          c.workspaceId,
          e.payableId,
          e,
          String(v.address).toLowerCase(),
          hash,
          this.workspaces.now(),
        ],
      );
      if (!inserted.rowCount) throw new WorkspaceError('PAYABLE_EXISTS');
      return;
    }
    if (e.kind === 'CLOSE_PAYABLE') {
      const closed = await sql.query(
        "UPDATE synq_ws_payables SET status=$3,closed_by=$4 WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING id",
        [c.workspaceId, e.payableId, e.status, hash],
      );
      if (!closed.rowCount) throw new WorkspaceError('PAYABLE_NOT_OPEN');
      return;
    }
    if (e.kind === 'OBLIGATION') {
      await sql.query(
        'INSERT INTO synq_ws_obligations(workspace_id,reference,data,change_hash) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,reference) DO UPDATE SET data=EXCLUDED.data,change_hash=EXCLUDED.change_hash',
        [c.workspaceId, e.reference, e, hash],
      );
      return;
    }
    if (e.kind === 'BILL') {
      await sql.query(
        'INSERT INTO synq_ws_bills(workspace_id,id,data,active,change_hash) VALUES($1,$2,$3,true,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET data=EXCLUDED.data,active=true,change_hash=EXCLUDED.change_hash',
        [c.workspaceId, e.billId, e, hash],
      );
      return;
    }
    if (e.kind === 'REMOVE_BILL') {
      const removed = await sql.query(
        'UPDATE synq_ws_bills SET active=false,change_hash=$3 WHERE workspace_id=$1 AND id=$2 AND active RETURNING id',
        [c.workspaceId, e.billId, hash],
      );
      if (!removed.rowCount) throw new WorkspaceError('BILL_NOT_ACTIVE');
      return;
    }
    const prior = await sql.query(
      'SELECT address,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
      [c.workspaceId, e.vendorId],
    );
    const old = prior.rows[0];
    // The immutable audit history also prevents changing away and back to reset cooling.
    const eligibleAt = old
      ? old.address.toLowerCase() === e.address.toLowerCase()
        ? Number(old.eligible_at)
        : this.workspaces.now() + 86400
      : this.workspaces.now();
    await sql.query(
      'INSERT INTO synq_ws_vendor_history(workspace_id,vendor_id,address,change_hash,verified_at,eligible_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        c.workspaceId,
        e.vendorId,
        e.address.toLowerCase(),
        hash,
        this.workspaces.now(),
        eligibleAt,
      ],
    );
    await sql.query(
      'INSERT INTO synq_ws_vendors(workspace_id,id,name,address,verified_at,eligible_at,change_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,verified_at=EXCLUDED.verified_at,eligible_at=EXCLUDED.eligible_at,change_hash=EXCLUDED.change_hash',
      [
        c.workspaceId,
        e.vendorId,
        e.name,
        e.address.toLowerCase(),
        this.workspaces.now(),
        eligibleAt,
        hash,
      ],
    );
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const [vendors, budget, pending] = await Promise.all([
      this.workspaces.pool.query(
        'SELECT id,name,address,verified_at,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 ORDER BY name,id',
        [workspaceId],
      ),
      this.workspaces.pool.query(
        'SELECT data,change_hash FROM synq_ws_budgets WHERE workspace_id=$1',
        [workspaceId],
      ),
      this.workspaces.pool.query(
        "SELECT hash,data FROM synq_ws_finance_changes WHERE workspace_id=$1 AND state='PENDING' ORDER BY hash",
        [workspaceId],
      ),
    ]);
    return {
      vendors: vendors.rows.map((v) => ({
        id: v.id,
        name: v.name,
        address: v.address,
        verifiedAt: Number(v.verified_at),
        eligibleAt: Number(v.eligible_at),
        status:
          Number(v.eligible_at) > this.workspaces.now()
            ? 'COOLING'
            : 'VERIFIED',
      })),
      budget: budget.rows[0]?.data ?? null,
      pending: pending.rows.map((v) => ({ hash: v.hash, change: v.data })),
    };
  }
}
