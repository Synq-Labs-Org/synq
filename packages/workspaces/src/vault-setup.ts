import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getAddress, type Hex } from 'viem';
import { z } from 'zod';
import {
  VaultSetupSchema,
  vaultSetupHash,
  vaultSetupTypedData,
  verifySetupSignature,
  type VaultSetup,
  type SetupSignature,
} from '@synq/kernel/arc-vault-setup';
import { defaultThreshold, WorkspaceError } from './contracts.js';
import { PostgresWorkspaceStore } from './postgres.js';

const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
export const ProposeVaultSchema = z.strictObject({
  threshold: z.number().int().min(1).max(20).optional(),
  perPaymentCap: uint.default('5000000'),
  windowCap: uint.default('20000000'),
  delay: z.number().int().min(3600).max(2592000).default(86400),
});
export type VaultSetupDefaults = Pick<
  VaultSetup,
  'factory' | 'token' | 'sponsor' | 'operator' | 'guardian' | 'maxGasNativeWei'
>;
export type SetupRecord = {
  setup: VaultSetup;
  setupHash: Hex;
  state:
    | 'AWAITING_SIGNATURES'
    | 'READY'
    | 'ACTIVE'
    | 'REVERTED'
    | 'NEEDS_REVIEW';
  signatures: SetupSignature[];
  evidence: Record<string, unknown> | null;
  lastError: string | null;
};

export class WorkspaceVaultSetups {
  constructor(
    readonly workspaces: PostgresWorkspaceStore,
    readonly defaults: VaultSetupDefaults,
  ) {}
  private async owner(workspaceId: string, principalId: string) {
    const r = await this.workspaces.pool.query(
      "SELECT wallet FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2 AND role='OWNER'",
      [workspaceId, principalId],
    );
    if (!r.rows[0]) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
    return getAddress(r.rows[0].wallet);
  }
  async record(workspaceId: string): Promise<SetupRecord | null> {
    const r = await this.workspaces.pool.query(
      'SELECT * FROM synq_ws_vault_setups WHERE workspace_id=$1',
      [workspaceId],
    );
    if (!r.rows[0]) return null;
    const sigs = await this.workspaces.pool.query(
      'SELECT owner,signature FROM synq_ws_setup_signatures WHERE workspace_id=$1 ORDER BY owner',
      [workspaceId],
    );
    return {
      setup: VaultSetupSchema.parse(r.rows[0].data),
      setupHash: r.rows[0].setup_hash,
      state: r.rows[0].state,
      signatures: sigs.rows.map((s) => ({
        owner: getAddress(s.owner),
        signature: String(s.signature),
      })),
      evidence: r.rows[0].evidence,
      lastError: r.rows[0].last_error,
    };
  }
  async view(workspaceId: string, principalId: string) {
    await this.owner(workspaceId, principalId);
    const r = await this.record(workspaceId);
    return r
      ? {
          setup: r.setup,
          setupHash: r.setupHash,
          state: r.state,
          signedOwners: r.signatures.map((s) => s.owner),
          typedData: JSON.parse(
            JSON.stringify(vaultSetupTypedData(r.setup), (_key, value) =>
              typeof value === 'bigint' ? String(value) : value,
            ),
          ) as Record<string, unknown>,
          evidence: r.evidence,
          lastError: r.lastError,
        }
      : null;
  }
  async propose(workspaceId: string, principalId: string, raw: unknown) {
    const body = ProposeVaultSchema.parse(raw);
    await this.owner(workspaceId, principalId);
    await this.workspaces.transaction(async (sql) => {
      const w = await sql.query(
        'SELECT status FROM synq_workspaces WHERE id=$1 FOR UPDATE',
        [workspaceId],
      );
      const exists = await sql.query(
        'SELECT 1 FROM synq_ws_vault_setups WHERE workspace_id=$1',
        [workspaceId],
      );
      if (exists.rowCount) return;
      if (w.rows[0]?.status !== 'FORMING')
        throw new WorkspaceError('WORKSPACE_NOT_FORMING');
      const members = await sql.query(
        "SELECT wallet FROM synq_ws_members WHERE workspace_id=$1 AND role='OWNER' ORDER BY wallet",
        [workspaceId],
      );
      const setup = VaultSetupSchema.parse({
        ...this.defaults,
        ...body,
        workspaceId,
        chainId: 5042002,
        owners: members.rows.map((m) => getAddress(m.wallet)),
        threshold: body.threshold ?? defaultThreshold(members.rows.length),
        salt: `0x${randomBytes(32).toString('hex')}`,
        expiresAt: this.workspaces.now() + 3600,
      });
      await sql.query(
        "INSERT INTO synq_ws_vault_setups(workspace_id,setup_hash,data,state,created_at) VALUES($1,$2,$3,'AWAITING_SIGNATURES',$4)",
        [workspaceId, vaultSetupHash(setup), setup, this.workspaces.now()],
      );
      await sql.query(
        "UPDATE synq_workspaces SET status='LAUNCHING' WHERE id=$1",
        [workspaceId],
      );
    });
    return this.view(workspaceId, principalId);
  }
  async approve(workspaceId: string, principalId: string, signature: Hex) {
    const owner = await this.owner(workspaceId, principalId);
    await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT * FROM synq_ws_vault_setups WHERE workspace_id=$1 FOR UPDATE',
        [workspaceId],
      );
      if (
        !r.rows[0] ||
        !['AWAITING_SIGNATURES', 'READY'].includes(r.rows[0].state)
      )
        throw new WorkspaceError('SETUP_NOT_SIGNABLE');
      const setup = VaultSetupSchema.parse(r.rows[0].data);
      if (this.workspaces.now() >= setup.expiresAt)
        throw new WorkspaceError('SETUP_EXPIRED');
      try {
        await verifySetupSignature(setup, { owner, signature });
      } catch {
        throw new WorkspaceError('INVALID_SETUP_SIGNATURE', 403);
      }
      await sql.query(
        'INSERT INTO synq_ws_setup_signatures(workspace_id,owner,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [workspaceId, owner.toLowerCase(), signature],
      );
      const count = await sql.query(
        'SELECT count(*) AS n FROM synq_ws_setup_signatures WHERE workspace_id=$1',
        [workspaceId],
      );
      if (Number(count.rows[0].n) === setup.owners.length)
        await sql.query(
          "UPDATE synq_ws_vault_setups SET state='READY' WHERE workspace_id=$1",
          [workspaceId],
        );
    });
    return this.view(workspaceId, principalId);
  }
  async reserveGas(
    workspaceId: string,
    dayLimitWei: bigint,
    principalDailyLimit = 3,
  ) {
    if (
      dayLimitWei <= 0n ||
      !Number.isInteger(principalDailyLimit) ||
      principalDailyLimit < 1
    )
      throw new Error('INVALID_SPONSOR_LIMIT');
    return this.workspaces.transaction(async (sql) => {
      const w = await sql.query(
        'SELECT created_by FROM synq_workspaces WHERE id=$1 FOR UPDATE',
        [workspaceId],
      );
      if (!w.rows[0]) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
      const r = await sql.query(
        'SELECT setup_hash,data,state FROM synq_ws_vault_setups WHERE workspace_id=$1 FOR UPDATE',
        [workspaceId],
      );
      if (!r.rows[0] || !['READY', 'ACTIVE'].includes(r.rows[0].state))
        throw new WorkspaceError('SETUP_NOT_READY');
      const s = VaultSetupSchema.parse(r.rows[0].data);
      const day = await this.rollSponsorDay(sql, dayLimitWei);
      const existing = await sql.query(
        'SELECT setup_hash,reserved_wei FROM synq_ws_sponsor_reservations WHERE workspace_id=$1',
        [workspaceId],
      );
      if (existing.rows[0])
        return {
          setupHash: existing.rows[0].setup_hash as Hex,
          maxGasNativeWei: String(existing.rows[0].reserved_wei),
        };
      if (s.expiresAt <= this.workspaces.now())
        throw new WorkspaceError('SETUP_EXPIRED');
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `vault-sponsor-principal:${w.rows[0].created_by}`,
      ]);
      const count = await sql.query(
        'SELECT count(*) AS n FROM synq_ws_sponsor_reservations r JOIN synq_workspaces w ON w.id=r.workspace_id WHERE w.created_by=$1 AND r.day=$2',
        [w.rows[0].created_by, day],
      );
      if (Number(count.rows[0].n) >= principalDailyLimit)
        throw new WorkspaceError('VAULT_CREATION_RATE_LIMIT', 429);
      await sql.query(
        'INSERT INTO synq_ws_sponsor_days(day,limit_wei,used_wei) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
        [day, String(dayLimitWei)],
      );
      const reserved = await sql.query(
        'UPDATE synq_ws_sponsor_days SET used_wei=used_wei+$2 WHERE day=$1 AND used_wei+$2<=LEAST(limit_wei,$3) RETURNING day',
        [day, s.maxGasNativeWei, String(dayLimitWei)],
      );
      if (!reserved.rowCount)
        throw new WorkspaceError('SPONSOR_BUDGET_EXHAUSTED', 429);
      await sql.query(
        "INSERT INTO synq_ws_sponsor_reservations(workspace_id,setup_hash,day,reserved_wei,state) VALUES($1,$2,$3,$4,'RESERVED')",
        [workspaceId, r.rows[0].setup_hash, day, s.maxGasNativeWei],
      );
      return {
        setupHash: r.rows[0].setup_hash as Hex,
        maxGasNativeWei: s.maxGasNativeWei,
      };
    });
  }
  async settleGas(
    workspaceId: string,
    setupHash: Hex,
    txHash: Hex,
    actualWei: bigint,
  ) {
    await this.workspaces.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_ws_sponsor_budget'))",
      );
      const r = await sql.query(
        'SELECT * FROM synq_ws_sponsor_reservations WHERE workspace_id=$1 FOR UPDATE',
        [workspaceId],
      );
      const reserved = r.rows[0];
      if (
        !reserved ||
        reserved.setup_hash !== setupHash ||
        actualWei < 0n ||
        actualWei > BigInt(reserved.reserved_wei)
      )
        throw new WorkspaceError('SPONSOR_RECONCILIATION_MISMATCH');
      if (reserved.state === 'SETTLED') {
        if (
          reserved.tx_hash !== txHash ||
          BigInt(reserved.actual_wei) !== actualWei
        )
          throw new WorkspaceError('SPONSOR_RECONCILIATION_MISMATCH');
        return;
      }
      await sql.query(
        'UPDATE synq_ws_sponsor_days SET used_wei=used_wei-$2 WHERE day=$1',
        [reserved.day, String(BigInt(reserved.reserved_wei) - actualWei)],
      );
      await sql.query(
        "UPDATE synq_ws_sponsor_reservations SET state='SETTLED',actual_wei=$2,tx_hash=$3 WHERE workspace_id=$1",
        [workspaceId, String(actualWei), txHash],
      );
    });
  }
  private async rollSponsorDay(sql: PoolClient, limit: bigint) {
    await sql.query(
      "SELECT pg_advisory_xact_lock(hashtext('synq_ws_sponsor_budget'))",
    );
    const day = Math.floor(this.workspaces.now() / 86400);
    await sql.query(
      'INSERT INTO synq_ws_sponsor_days(day,limit_wei,used_wei) VALUES($1,$2,0) ON CONFLICT DO NOTHING',
      [day, String(limit)],
    );
    const pending = await sql.query(
      "SELECT day,sum(reserved_wei)::text AS amount FROM synq_ws_sponsor_reservations WHERE state='RESERVED' AND day<>$1 GROUP BY day",
      [day],
    );
    const carry = pending.rows.reduce((n, r) => n + BigInt(r.amount), 0n);
    if (carry > 0n) {
      const moved = await sql.query(
        'UPDATE synq_ws_sponsor_days SET used_wei=used_wei+$2 WHERE day=$1 AND used_wei+$2<=LEAST(limit_wei,$3) RETURNING day',
        [day, String(carry), String(limit)],
      );
      if (!moved.rowCount)
        throw new WorkspaceError('SPONSOR_BUDGET_EXHAUSTED', 429);
      for (const prior of pending.rows)
        await sql.query(
          'UPDATE synq_ws_sponsor_days SET used_wei=used_wei-$2 WHERE day=$1',
          [prior.day, prior.amount],
        );
      await sql.query(
        "UPDATE synq_ws_sponsor_reservations SET day=$1 WHERE state='RESERVED' AND day<>$1",
        [day],
      );
    }
    return day;
  }
  async activate(
    workspaceId: string,
    evidence: {
      setupHash: Hex;
      hash: Hex;
      safe: string;
      policy: string;
      owners: readonly string[];
      threshold: number;
      blockNumber: string;
      policyCodeHash: Hex;
      custody: string;
    },
  ) {
    await this.workspaces.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT * FROM synq_ws_vault_setups WHERE workspace_id=$1 FOR UPDATE',
        [workspaceId],
      );
      if (
        !r.rows[0] ||
        r.rows[0].setup_hash !== evidence.setupHash ||
        !['READY', 'ACTIVE'].includes(r.rows[0].state)
      )
        throw new WorkspaceError('SETUP_RECONCILIATION_MISMATCH');
      const s = VaultSetupSchema.parse(r.rows[0].data);
      if (
        s.threshold !== evidence.threshold ||
        [...s.owners].sort().join() !==
          evidence.owners
            .map((a) => getAddress(a))
            .sort()
            .join()
      )
        throw new WorkspaceError('CUSTODY_MISMATCH');
      if (r.rows[0].state === 'ACTIVE') {
        if (JSON.stringify(r.rows[0].evidence) !== JSON.stringify(evidence)) {
          const prior = r.rows[0].evidence;
          if (
            prior.hash !== evidence.hash ||
            prior.safe !== evidence.safe ||
            prior.policy !== evidence.policy
          )
            throw new WorkspaceError('SETUP_RECONCILIATION_MISMATCH');
        }
        return;
      }
      await sql.query(
        "UPDATE synq_workspaces SET status='ACTIVE',vault=$2,policy=$3,threshold=$4,vault_tx_hash=$5 WHERE id=$1 AND status='LAUNCHING'",
        [
          workspaceId,
          getAddress(evidence.safe),
          getAddress(evidence.policy),
          evidence.threshold,
          evidence.hash,
        ],
      );
      await sql.query(
        "UPDATE synq_ws_vault_setups SET state='ACTIVE',evidence=$2,last_error=NULL WHERE workspace_id=$1",
        [workspaceId, evidence],
      );
    });
  }
}
