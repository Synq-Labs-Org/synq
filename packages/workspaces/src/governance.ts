import { randomUUID } from 'node:crypto';
import { recoverTypedDataAddress, getAddress, type Hex } from 'viem';
import { z } from 'zod';
import {
  SafeActionSchema,
  safeActionApprovalTypedData,
  safeActionTypedData,
  type SafeAction,
  type SafeActionSignature,
} from '@synq/kernel/arc-safe-action';
import { WorkspaceError } from './contracts.js';
import type { WorkspaceFinance } from './finance.js';
export const ProposeSafeActionSchema = z.strictObject({
  kind: z.enum(['QUEUE_VENDOR', 'ALLOW_VENDOR', 'REMOVE_VENDOR']),
  vendorId: z.string().uuid(),
});
export type SafeActionRecord = {
  action: SafeAction;
  signatures: SafeActionSignature[];
  state: 'REVIEW' | 'READY' | 'CONFIRMED' | 'FAILED' | 'NEEDS_REVIEW';
  evidence: Record<string, unknown> | null;
  lastError: string | null;
};
const row = (r: Record<string, unknown>): SafeActionRecord => ({
  action: SafeActionSchema.parse(r.data),
  signatures: Object.values(
    r.signatures as Record<string, SafeActionSignature>,
  ),
  state: r.state as SafeActionRecord['state'],
  evidence: r.evidence as Record<string, unknown> | null,
  lastError: r.last_error as string | null,
});
export class WorkspaceGovernance {
  constructor(readonly finance: WorkspaceFinance) {}
  get workspaces() {
    return this.finance.workspaces;
  }
  async record(id: string) {
    const r = await this.workspaces.pool.query(
      'SELECT * FROM synq_ws_safe_actions WHERE id=$1',
      [id],
    );
    return r.rows[0] ? row(r.rows[0]) : null;
  }
  async view(workspaceId: string, principalId: string, id: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const r = await this.record(id);
    if (!r || r.action.workspaceId !== workspaceId)
      throw new WorkspaceError('ACTION_NOT_FOUND', 404);
    return {
      action: r.action,
      signedBy: r.signatures.map((v) => v.owner),
      state: r.state,
      evidence: r.evidence,
      lastError: r.lastError,
    };
  }
  async list(workspaceId: string, principalId: string) {
    await this.workspaces.membership(workspaceId, principalId);
    const r = await this.workspaces.pool.query(
      'SELECT id FROM synq_ws_safe_actions WHERE workspace_id=$1 ORDER BY id LIMIT 100',
      [workspaceId],
    );
    return Promise.all(
      r.rows.map((v) => this.view(workspaceId, principalId, String(v.id))),
    );
  }
  async propose(workspaceId: string, principalId: string, raw: unknown) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const b = ProposeSafeActionSchema.parse(raw),
      a = await this.finance.authority(workspaceId);
    const id = await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const vendor = await sql.query(
        'SELECT address,change_hash,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
        [workspaceId, b.vendorId],
      );
      const v = vendor.rows[0];
      if (!v) throw new WorkspaceError('VENDOR_NOT_VERIFIED');
      if (
        b.kind !== 'REMOVE_VENDOR' &&
        Number(v.eligible_at) > this.workspaces.now()
      )
        throw new WorkspaceError('VENDOR_COOLING');
      const action = SafeActionSchema.parse({
        id: randomUUID(),
        workspaceId,
        chainId: 5042002,
        safe: a.vault,
        policy: a.policy,
        token: a.token,
        kind: b.kind,
        vendorId: b.vendorId,
        vendorAddress: v.address,
        vendorChangeHash: v.change_hash,
        nonce: String(a.nonce),
        expiresAt: this.workspaces.now() + 900,
      });
      const inserted = await sql.query(
        "INSERT INTO synq_ws_safe_actions(id,workspace_id,data,state) VALUES($1,$2,$3,'REVIEW') ON CONFLICT DO NOTHING RETURNING id",
        [action.id, workspaceId, action],
      );
      if (inserted.rows[0]) return action.id;
      const existing = await sql.query(
        "SELECT id FROM synq_ws_safe_actions WHERE workspace_id=$1 AND data->>'kind'=$2 AND data->>'vendorChangeHash'=$3 AND data->>'nonce'=$4 AND data->>'expiresAt'=$5",
        [
          workspaceId,
          b.kind,
          v.change_hash,
          String(a.nonce),
          String(action.expiresAt),
        ],
      );
      if (!existing.rows[0]) throw new WorkspaceError('ACTION_CONFLICT');
      return String(existing.rows[0].id);
    });
    return this.view(workspaceId, principalId, id);
  }
  async approve(
    workspaceId: string,
    principalId: string,
    id: string,
    signatures: { approvalSignature: Hex; safeSignature: Hex },
  ) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const a = await this.finance.authority(workspaceId);
    await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT * FROM synq_ws_safe_actions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      if (!r.rows[0]) throw new WorkspaceError('ACTION_NOT_FOUND', 404);
      const p = row(r.rows[0]);
      if (p.state !== 'REVIEW')
        throw new WorkspaceError('ACTION_NOT_REVIEWABLE');
      if (
        p.action.expiresAt <= this.workspaces.now() ||
        BigInt(p.action.nonce) !== a.nonce ||
        getAddress(p.action.safe) !== a.vault ||
        getAddress(p.action.policy) !== a.policy
      )
        throw new WorkspaceError('ACTION_STALE');
      const [approval, safe] = await Promise.all([
        recoverTypedDataAddress({
          ...safeActionApprovalTypedData(p.action),
          signature: signatures.approvalSignature,
        }).catch(() => null),
        recoverTypedDataAddress({
          ...safeActionTypedData(p.action),
          signature: signatures.safeSignature,
        }).catch(() => null),
      ]);
      if (
        !approval ||
        !safe ||
        approval.toLowerCase() !== m.wallet.toLowerCase() ||
        safe.toLowerCase() !== m.wallet.toLowerCase() ||
        !a.owners.some((v) => v.toLowerCase() === m.wallet.toLowerCase())
      )
        throw new WorkspaceError('INVALID_OWNER_SIGNATURE', 403);
      const map = Object.fromEntries(
        p.signatures.map((v) => [v.owner.toLowerCase(), v]),
      );
      map[m.wallet.toLowerCase()] = {
        owner: getAddress(m.wallet),
        ...signatures,
      };
      await sql.query(
        'UPDATE synq_ws_safe_actions SET signatures=$2,state=$3 WHERE id=$1',
        [id, map, Object.keys(map).length >= a.threshold ? 'READY' : 'REVIEW'],
      );
    });
    return this.view(workspaceId, principalId, id);
  }
}
