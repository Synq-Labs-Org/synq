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
import { PayoutDataSchema, UnitsSchema } from './finance-contracts.js';
import { WorkspaceError } from './contracts.js';
import type { WorkspaceFinance } from './finance.js';
export const ProposeSafeActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.enum(['QUEUE_VENDOR', 'ALLOW_VENDOR', 'REMOVE_VENDOR']),
    vendorId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('PAY_VENDOR'),
    payoutId: z.uuid(),
  }),
  z
    .strictObject({
      kind: z.enum(['QUEUE_CAPS', 'SET_CAPS']),
      perPaymentCap: UnitsSchema,
      windowCap: UnitsSchema,
    })
    .refine(
      (v) => BigInt(v.perPaymentCap) <= BigInt(v.windowCap),
      'per-payment cap exceeds window cap',
    ),
]);
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
      const fields =
        b.kind === 'PAY_VENDOR'
          ? await (async () => {
              // An above-budget payout: every Safe owner signs one direct transfer for exactly its terms.
              const r = await sql.query(
                'SELECT data,state FROM synq_ws_payouts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
                [workspaceId, b.payoutId],
              );
              if (!r.rows[0]) throw new WorkspaceError('PAYOUT_NOT_FOUND', 404);
              const p = PayoutDataSchema.parse(r.rows[0].data);
              if (p.route !== 'SAFE_QUORUM')
                throw new WorkspaceError('PAYOUT_USES_VAULT_POLICY');
              if (r.rows[0].state !== 'REVIEW')
                throw new WorkspaceError('PAYOUT_NOT_REVIEWABLE');
              if (
                getAddress(p.vault) !== a.vault ||
                getAddress(p.token) !== a.token
              )
                throw new WorkspaceError('PAYOUT_VAULT_MISMATCH');
              const v = (
                await sql.query(
                  'SELECT address,change_hash,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
                  [workspaceId, p.vendorId],
                )
              ).rows[0];
              if (
                !v ||
                String(v.address).toLowerCase() !== p.recipient.toLowerCase() ||
                v.change_hash !== p.vendorChangeHash
              )
                throw new WorkspaceError('PAYOUT_ADDRESS_CHANGED');
              if (Number(v.eligible_at) > this.workspaces.now())
                throw new WorkspaceError('VENDOR_COOLING');
              return {
                kind: 'PAY_VENDOR' as const,
                payoutId: p.id,
                vendorId: p.vendorId,
                vendorAddress: p.recipient,
                vendorChangeHash: p.vendorChangeHash,
                amount: p.amount,
              };
            })()
          : 'vendorId' in b
            ? await (async () => {
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
                return {
                  kind: b.kind,
                  vendorId: b.vendorId,
                  vendorAddress: v.address,
                  vendorChangeHash: v.change_hash,
                };
              })()
            : b;
      const action = SafeActionSchema.parse({
        id: randomUUID(),
        workspaceId,
        chainId: 5042002,
        safe: a.vault,
        policy: a.policy,
        token: a.token,
        ...fields,
        nonce: String(a.nonce),
        expiresAt: this.workspaces.now() + 900,
      });
      const inserted = await sql.query(
        "INSERT INTO synq_ws_safe_actions(id,workspace_id,data,state) VALUES($1,$2,$3,'REVIEW') ON CONFLICT DO NOTHING RETURNING id",
        [action.id, workspaceId, action],
      );
      if (inserted.rows[0]) return action.id;
      const existing =
        action.kind === 'PAY_VENDOR'
          ? await sql.query(
              "SELECT id FROM synq_ws_safe_actions WHERE workspace_id=$1 AND data->>'kind'='PAY_VENDOR' AND data->>'payoutId'=$2 AND data->>'nonce'=$3 AND data->>'expiresAt'=$4",
              [
                workspaceId,
                action.payoutId,
                action.nonce,
                String(action.expiresAt),
              ],
            )
          : 'vendorChangeHash' in action
            ? await sql.query(
                "SELECT id FROM synq_ws_safe_actions WHERE workspace_id=$1 AND data->>'kind'=$2 AND data->>'vendorChangeHash'=$3 AND data->>'nonce'=$4 AND data->>'expiresAt'=$5",
                [
                  workspaceId,
                  action.kind,
                  action.vendorChangeHash,
                  action.nonce,
                  String(action.expiresAt),
                ],
              )
            : 'perPaymentCap' in action
              ? await sql.query(
                  "SELECT id FROM synq_ws_safe_actions WHERE workspace_id=$1 AND data->>'kind'=$2 AND data->>'perPaymentCap'=$3 AND data->>'windowCap'=$4 AND data->>'nonce'=$5 AND data->>'expiresAt'=$6",
                  [
                    workspaceId,
                    action.kind,
                    action.perPaymentCap,
                    action.windowCap,
                    action.nonce,
                    String(action.expiresAt),
                  ],
                )
              : { rows: [] };
      if (!existing.rows[0]) throw new WorkspaceError('ACTION_CONFLICT');
      return String(existing.rows[0].id);
    });
    return this.view(workspaceId, principalId, id);
  }
  /**
   * A treasury step for a treasury operation the caller already validated.
   * Not reachable from the raw proposal API: only WorkspaceTreasury builds it.
   */
  async proposeTreasury(
    workspaceId: string,
    principalId: string,
    fields:
      | {
          kind: 'TREASURY_APPROVE';
          treasuryOpId: string;
          spender: string;
          approveToken: string;
          amount: string;
        }
      | {
          kind: 'TREASURY_EXECUTE';
          treasuryOpId: string;
          target: string;
          data: string;
          tokenIn: string;
          amountIn: string;
          tokenOut: string;
          minOut: string;
        },
  ) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const a = await this.finance.authority(workspaceId);
    const action = SafeActionSchema.parse({
      id: randomUUID(),
      workspaceId,
      chainId: 5042002,
      safe: a.vault,
      policy: a.policy,
      token: a.token,
      ...fields,
      nonce: String(a.nonce),
      expiresAt: this.workspaces.now() + 900,
    });
    await this.workspaces.pool.query(
      "INSERT INTO synq_ws_safe_actions(id,workspace_id,data,state) VALUES($1,$2,$3,'REVIEW')",
      [action.id, workspaceId, action],
    );
    return this.view(workspaceId, principalId, action.id);
  }
  /** The vault action for one planned member refund (one at a time: Safe nonces are sequential). */
  async proposeRefund(
    workspaceId: string,
    principalId: string,
    refundId: string,
  ) {
    const m = await this.workspaces.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const a = await this.finance.authority(workspaceId);
    return this.workspaces.transaction(async (sql) => {
      const r = (
        await sql.query(
          'SELECT * FROM synq_ws_refunds WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [refundId, workspaceId],
        )
      ).rows[0];
      if (!r) throw new WorkspaceError('REFUND_NOT_FOUND', 404);
      if (r.state !== 'REVIEW') throw new WorkspaceError('REFUND_NOT_PENDING');
      if (r.action_id) {
        const prior = await this.record(String(r.action_id));
        if (
          prior &&
          (prior.state === 'READY' ||
            (prior.state === 'REVIEW' &&
              prior.action.expiresAt > this.workspaces.now()))
        )
          return this.view(workspaceId, principalId, prior.action.id);
      }
      const action = SafeActionSchema.parse({
        id: randomUUID(),
        workspaceId,
        chainId: 5042002,
        safe: a.vault,
        policy: a.policy,
        token: a.token,
        kind: 'REFUND_MEMBER',
        refundId,
        principalId: String(r.principal_id),
        recipient: getAddress(String(r.recipient)),
        amount: String(r.amount),
        nonce: String(a.nonce),
        expiresAt: this.workspaces.now() + 900,
      });
      await sql.query(
        "INSERT INTO synq_ws_safe_actions(id,workspace_id,data,state) VALUES($1,$2,$3,'REVIEW')",
        [action.id, workspaceId, action],
      );
      await sql.query('UPDATE synq_ws_refunds SET action_id=$2 WHERE id=$1', [
        refundId,
        action.id,
      ]);
      return {
        action,
        signedBy: [],
        state: 'REVIEW' as const,
        evidence: null,
        lastError: null,
      };
    });
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
