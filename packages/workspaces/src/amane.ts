import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { z } from 'zod';
import { WorkspaceError } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * Amane-enforced agent payments for a workspace. An owner sets up an Amane
 * account (one recipient, one token, owner-signed root policy) and signs an
 * agent lease to Synq's agent key; Synq only records what the chain already
 * enforces, after reading it back from the contract. A job says "pay this
 * contractor this amount when this trigger happens"; the execution worker
 * then pays inside the lease with no new human signature, and the contract
 * refuses anything outside it regardless of what Synq does.
 */

export const AMANE_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_amane_accounts (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), chain_id int NOT NULL, account text NOT NULL UNIQUE, code_hash text NOT NULL, token text NOT NULL, recipient text NOT NULL, adapter_id text NOT NULL, root jsonb NOT NULL, root_hash text NOT NULL, vendor_id uuid, state text NOT NULL CHECK(state IN ('ACTIVE','RETIRED')), created_by text NOT NULL, created_at bigint NOT NULL, UNIQUE(workspace_id, account));
CREATE TABLE synq_amane_leases (lease_id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES synq_amane_accounts(id), workspace_id uuid NOT NULL, agent text NOT NULL, lease jsonb NOT NULL, state text NOT NULL CHECK(state IN ('ACTIVE','REVOKED','EXPIRED')), created_at bigint NOT NULL, revoked_at bigint);
CREATE TABLE synq_amane_jobs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), account_id uuid NOT NULL REFERENCES synq_amane_accounts(id), lease_id text NOT NULL REFERENCES synq_amane_leases(lease_id), trigger_kind text NOT NULL CHECK(trigger_kind IN ('INVOICE_PAID','OWNER_REQUEST')), trigger_ref text NOT NULL, amount numeric(78,0) NOT NULL CHECK(amount>0), purpose text NOT NULL, state text NOT NULL CHECK(state IN ('WAITING','READY','SENT','PAID','REFUSED','NEEDS_REVIEW')), nonce numeric(78,0), intent jsonb, intent_hash text, agent_signature text, tx_hash text, reason text, created_by text NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL, UNIQUE(workspace_id, trigger_kind, trigger_ref, lease_id));
CREATE UNIQUE INDEX synq_amane_job_nonce ON synq_amane_jobs(lease_id, nonce) WHERE nonce IS NOT NULL;
`,
    down: `DROP TABLE synq_amane_jobs, synq_amane_leases, synq_amane_accounts;`,
  },
] as const;

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a));
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Units = z.string().regex(/^[1-9][0-9]{0,30}$/);
const iso = (s: number) => new Date(s * 1000).toISOString();
const hint = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What the contract reports, read by the caller from chain (see @synq/plugin-amane). */
export type ChainAccountView = {
  chainId: number;
  account: string;
  codeHash: string;
  rootHash: string;
  root: {
    version: bigint;
    token: string;
    recipient: string;
    adapterId: string;
    recovery: string;
    perAction: bigint;
    perPeriod: bigint;
    total: bigint;
    periodSeconds: bigint;
    maxLeaseLifetime: bigint;
  };
};
export type ChainLeaseView = {
  leaseId: string;
  rootHash: string;
  agent: string;
  validAfter: bigint;
  expiresAt: bigint;
  perAction: bigint;
  perPeriod: bigint;
  total: bigint;
  live: boolean;
  revoked: boolean;
  /** Remaining room under the lease and policy caps right now. */
  available: bigint;
};

const strings = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'bigint' ? String(v) : v,
    ]),
  );

export type AmaneJob = {
  id: string;
  workspaceId: string;
  accountId: string;
  leaseId: string;
  triggerKind: 'INVOICE_PAID' | 'OWNER_REQUEST';
  triggerRef: string;
  amount: bigint;
  purpose: string;
  state: 'WAITING' | 'READY' | 'SENT' | 'PAID' | 'REFUSED' | 'NEEDS_REVIEW';
  nonce: bigint | null;
  txHash: string | null;
  reason: string | null;
};
const job = (r: Record<string, unknown>): AmaneJob => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  accountId: String(r.account_id),
  leaseId: String(r.lease_id),
  triggerKind: r.trigger_kind as AmaneJob['triggerKind'],
  triggerRef: String(r.trigger_ref),
  amount: BigInt(String(r.amount)),
  purpose: String(r.purpose),
  state: r.state as AmaneJob['state'],
  nonce: r.nonce === null ? null : BigInt(String(r.nonce)),
  txHash: r.tx_hash === null ? null : String(r.tx_hash),
  reason: r.reason === null ? null : String(r.reason),
});

export class WorkspaceAmane {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: {
      /** Synq's agent address; leases to any other agent are refused. */
      agent: string | null;
      /** Code hash of the pinned Amane account release. */
      accountCodeHash: string | null;
      /** Reads an account's live policy from chain. */
      readAccount: (account: string) => Promise<ChainAccountView>;
      /** Reads one lease's live state from chain. */
      readLease: (account: string, leaseId: string) => Promise<ChainLeaseView>;
      /** Whether a wallet is a controller (owner) of the account on chain. */
      isController: (account: string, wallet: string) => Promise<boolean>;
    },
  ) {}

  private now() {
    return this.store.now();
  }

  async migrate(target: number = AMANE_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_amane_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_amane_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_amane_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...AMANE_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_amane_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of AMANE_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_amane_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  private async owner(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    return m;
  }

  /**
   * Records an Amane account the owner already set up, after reading its code
   * and root policy from chain. Nothing here can widen what the contract allows.
   */
  async registerAccount(
    workspaceId: string,
    principalId: string,
    raw: unknown,
  ) {
    const body = z
      .strictObject({
        account: Address,
        vendorId: z.uuid().nullable().default(null),
      })
      .parse(raw);
    const m = await this.owner(workspaceId, principalId);
    if (!this.options.accountCodeHash)
      throw new WorkspaceError('AMANE_NOT_CONFIGURED', 503);
    // Only an on-chain controller of the account can attach it, to one workspace.
    if (!(await this.options.isController(body.account, m.wallet)))
      throw new WorkspaceError('AMANE_NOT_CONTROLLER', 403);
    const taken = await this.store.pool.query(
      'SELECT 1 FROM synq_amane_accounts WHERE lower(account)=lower($1)',
      [body.account],
    );
    if (taken.rowCount)
      throw new WorkspaceError('AMANE_ACCOUNT_REGISTERED', 409);
    const view = await this.options.readAccount(body.account);
    if (
      view.codeHash.toLowerCase() !== this.options.accountCodeHash.toLowerCase()
    )
      throw new WorkspaceError('AMANE_CODE_MISMATCH', 422);
    const id = randomUUID();
    await this.store.pool.query(
      `INSERT INTO synq_amane_accounts(id,workspace_id,chain_id,account,code_hash,token,recipient,adapter_id,root,root_hash,vendor_id,state,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12,$13)`,
      [
        id,
        workspaceId,
        view.chainId,
        getAddress(view.account),
        view.codeHash,
        getAddress(view.root.token),
        getAddress(view.root.recipient),
        view.root.adapterId,
        strings(view.root),
        view.rootHash,
        body.vendorId,
        principalId,
        this.now(),
      ],
    );
    return this.account(workspaceId, id);
  }

  async account(workspaceId: string, id: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_amane_accounts WHERE id=$1 AND workspace_id=$2',
      [id, workspaceId],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    const a = r.rows[0];
    return {
      id: String(a.id),
      workspaceId,
      chainId: Number(a.chain_id),
      account: String(a.account),
      codeHash: String(a.code_hash),
      token: String(a.token),
      recipient: String(a.recipient),
      adapterId: String(a.adapter_id),
      rootHash: String(a.root_hash),
      root: a.root as Record<string, string>,
    };
  }

  /** Records a lease the owner activated on chain, if it is live and names Synq's agent. */
  async registerLease(workspaceId: string, principalId: string, raw: unknown) {
    const body = z
      .strictObject({ accountId: z.uuid(), leaseId: Bytes32 })
      .parse(raw);
    await this.owner(workspaceId, principalId);
    const a = await this.account(workspaceId, body.accountId);
    const lease = await this.options.readLease(a.account, body.leaseId);
    if (
      !this.options.agent ||
      lease.agent.toLowerCase() !== this.options.agent.toLowerCase()
    )
      throw new WorkspaceError('LEASE_AGENT_MISMATCH', 422);
    if (
      !lease.live ||
      lease.rootHash.toLowerCase() !== a.rootHash.toLowerCase()
    )
      throw new WorkspaceError('LEASE_NOT_LIVE', 422);
    const inserted = await this.store.pool.query(
      `INSERT INTO synq_amane_leases(lease_id,account_id,workspace_id,agent,lease,state,created_at) VALUES($1,$2,$3,$4,$5,'ACTIVE',$6)
       ON CONFLICT(lease_id) DO UPDATE SET lease_id=EXCLUDED.lease_id WHERE synq_amane_leases.account_id=EXCLUDED.account_id
       RETURNING lease_id`,
      [
        body.leaseId,
        a.id,
        workspaceId,
        getAddress(lease.agent),
        strings(lease as unknown as Record<string, unknown>),
        this.now(),
      ],
    );
    if (!inserted.rowCount)
      throw new WorkspaceError('LEASE_REGISTERED_ELSEWHERE', 409);
    return { leaseId: body.leaseId, accountId: a.id };
  }

  /**
   * A contractor payment the agent may make inside a lease once its trigger
   * happens (an invoice paid in full, or an explicit owner request).
   */
  async createJob(workspaceId: string, principalId: string, raw: unknown) {
    const body = z
      .strictObject({
        leaseId: Bytes32,
        triggerKind: z.enum(['INVOICE_PAID', 'OWNER_REQUEST']),
        triggerRef: z.string().min(1).max(80),
        amount: Units,
        purpose: z.string().trim().min(1).max(160),
      })
      .parse(raw);
    await this.owner(workspaceId, principalId);
    const l = await this.store.pool.query(
      "SELECT l.*, a.workspace_id AS ws FROM synq_amane_leases l JOIN synq_amane_accounts a ON a.id=l.account_id WHERE l.lease_id=$1 AND l.state='ACTIVE'",
      [body.leaseId],
    );
    if (!l.rows[0] || String(l.rows[0].ws) !== workspaceId)
      throw new WorkspaceError('NOT_FOUND', 404);
    if (BigInt(body.amount) > BigInt(String(l.rows[0].lease.perAction)))
      throw new WorkspaceError('ABOVE_LEASE_PER_ACTION', 422);
    const id = randomUUID();
    const now = this.now();
    const r = await this.store.pool.query(
      `INSERT INTO synq_amane_jobs(id,workspace_id,account_id,lease_id,trigger_kind,trigger_ref,amount,purpose,state,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) ON CONFLICT(workspace_id,trigger_kind,trigger_ref,lease_id) DO NOTHING RETURNING id`,
      [
        id,
        workspaceId,
        l.rows[0].account_id,
        body.leaseId,
        body.triggerKind,
        body.triggerRef,
        body.amount,
        body.purpose,
        body.triggerKind === 'OWNER_REQUEST' ? 'READY' : 'WAITING',
        principalId,
        now,
      ],
    );
    if (!r.rows[0]) throw new WorkspaceError('JOB_EXISTS', 409);
    return this.job(id);
  }

  async job(id: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_amane_jobs WHERE id=$1',
      [id],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    return job(r.rows[0]);
  }

  /** The invoice was paid in full: its waiting jobs may now run. Idempotent. */
  async triggerInvoicePaid(workspaceId: string, invoiceId: string) {
    const r = await this.store.pool.query(
      "UPDATE synq_amane_jobs SET state='READY', updated_at=$3 WHERE workspace_id=$1 AND trigger_kind='INVOICE_PAID' AND trigger_ref=$2 AND state='WAITING' RETURNING id",
      [workspaceId, invoiceId, this.now()],
    );
    return r.rows.map((x) => String(x.id));
  }

  /** Invoices that waiting jobs depend on. */
  async waitingInvoices() {
    const r = await this.store.pool.query(
      "SELECT DISTINCT workspace_id, trigger_ref FROM synq_amane_jobs WHERE state='WAITING' AND trigger_kind='INVOICE_PAID' LIMIT 100",
    );
    return r.rows.map((x) => ({
      workspaceId: String(x.workspace_id),
      invoiceId: String(x.trigger_ref),
    }));
  }

  async jobs(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (m.role !== 'OWNER' && m.role !== 'ADMIN')
      throw new WorkspaceError('NOT_FOUND', 404);
    const r = await this.store.pool.query(
      'SELECT * FROM synq_amane_jobs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',
      [workspaceId],
    );
    return r.rows.map(job).map((j) => ({
      ...j,
      amount: String(j.amount),
      nonce: j.nonce === null ? null : String(j.nonce),
    }));
  }

  async ready() {
    const r = await this.store.pool.query(
      "SELECT id FROM synq_amane_jobs WHERE state IN ('READY','SENT') ORDER BY created_at LIMIT 20",
    );
    return r.rows.map((x) => String(x.id));
  }

  /** Mandates view: each lease with the limits the contract reports now. */
  async mandates(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (m.role !== 'OWNER' && m.role !== 'ADMIN')
      throw new WorkspaceError('NOT_FOUND', 404);
    const r = await this.store.pool.query(
      'SELECT l.*, a.account, a.chain_id, a.root_hash, a.recipient, a.token FROM synq_amane_leases l JOIN synq_amane_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 ORDER BY l.created_at DESC',
      [workspaceId],
    );
    const leases = [];
    for (const row of r.rows) {
      let live: ChainLeaseView | null = null;
      try {
        live = await this.options.readLease(
          String(row.account),
          String(row.lease_id),
        );
      } catch {
        live = null;
      }
      const stored = row.lease as Record<string, string>;
      leases.push({
        leaseId: String(row.lease_id),
        policyHash: String(row.root_hash),
        agentId: hint(String(row.agent)),
        actions: ['PAY'],
        recipients: [hint(String(row.recipient))],
        assetIds: ['arc-testnet:USDC'],
        perActionUnits: stored.perAction!,
        availableUnits: live ? String(live.available) : '0',
        expiresAt: iso(Number(stored.expiresAt)),
        revokedAt: live?.revoked
          ? iso(this.now())
          : row.revoked_at === null
            ? null
            : iso(Number(row.revoked_at)),
        enforcingContract: String(row.account),
        chainId: Number(row.chain_id),
        proofLevel:
          live === null
            ? 'NOT_VERIFIED'
            : live.live
              ? 'LIVE_ARC_TESTNET'
              : 'BLOCKED',
      });
    }
    return leases;
  }

  async recordNonce(id: string, nonce: bigint) {
    await this.store.pool.query(
      'UPDATE synq_amane_jobs SET nonce=$2 WHERE id=$1 AND nonce IS NULL',
      [id, String(nonce)],
    );
  }

  async nextNonce(leaseId: string) {
    const r = await this.store.pool.query(
      'SELECT coalesce(max(nonce),0)::text AS n FROM synq_amane_jobs WHERE lease_id=$1',
      [leaseId],
    );
    return BigInt(r.rows[0].n) + 1n;
  }

  async mark(
    id: string,
    state: AmaneJob['state'],
    fields: {
      txHash?: string;
      reason?: string;
      intent?: unknown;
      intentHash?: string;
      agentSignature?: string;
    } = {},
  ) {
    await this.store.pool.query(
      `UPDATE synq_amane_jobs SET state=$2, tx_hash=COALESCE($3,tx_hash), reason=COALESCE($4,reason),
         intent=COALESCE($5,intent), intent_hash=COALESCE($6,intent_hash), agent_signature=COALESCE($7,agent_signature), updated_at=$8 WHERE id=$1`,
      [
        id,
        state,
        fields.txHash ?? null,
        fields.reason ?? null,
        fields.intent === undefined
          ? null
          : JSON.stringify(fields.intent, (_k, v: unknown) =>
              typeof v === 'bigint' ? String(v) : v,
            ),
        fields.intentHash ?? null,
        fields.agentSignature ?? null,
        this.now(),
      ],
    );
  }
}
