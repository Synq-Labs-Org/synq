import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { PostgresSplitStore } from '@synq/allocations';
import { chainProfile } from '@synq/chain-registry/arc';
import { WorkspaceError, type Role } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * What agents did, as typed records rather than chat. A run groups the steps
 * of one piece of agent work; each step is an append-only event with a
 * per-workspace sequence, the actor that produced it (model, deterministic
 * rule, person, chain, provider), its status and its proof level. Events are
 * recorded once per semantic key, so a retried worker or a re-run projection
 * never duplicates a row. FINALIZED and RECONCILED come only from chain or
 * ledger evidence. The stream table feeds the live event stream and
 * notifications; it says only what changed, never the content.
 */

export const AGENT_EVENT_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_agent_runs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), title text NOT NULL, trigger text NOT NULL, status text NOT NULL, amount_units text, proof_level text NOT NULL, source_key text NOT NULL, started_at bigint NOT NULL, updated_at bigint NOT NULL, UNIQUE(workspace_id, source_key));
CREATE INDEX synq_agent_runs_ws ON synq_agent_runs(workspace_id, updated_at DESC, id DESC);
CREATE TABLE synq_agent_seq (workspace_id uuid PRIMARY KEY, last bigint NOT NULL);
CREATE TABLE synq_agent_events (event_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES synq_agent_runs(id), sequence bigint NOT NULL, semantic_key text NOT NULL, data jsonb NOT NULL, observed_at bigint NOT NULL, UNIQUE(workspace_id, sequence), UNIQUE(workspace_id, semantic_key));
CREATE INDEX synq_agent_events_run ON synq_agent_events(run_id, sequence);
CREATE FUNCTION synq_agent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'agent events are append only'; END $$;
CREATE TRIGGER synq_agent_events_immutable BEFORE UPDATE OR DELETE ON synq_agent_events FOR EACH ROW EXECUTE FUNCTION synq_agent_append_only();
CREATE TABLE synq_stream_events (cursor bigserial PRIMARY KEY, event_id uuid NOT NULL UNIQUE, workspace_id uuid, principal_id text, type text NOT NULL, entity_id text, observed_at bigint NOT NULL);
CREATE INDEX synq_stream_ws ON synq_stream_events(workspace_id, cursor);
CREATE INDEX synq_stream_principal ON synq_stream_events(principal_id, cursor);
`,
    down: `DROP TABLE synq_stream_events, synq_agent_events, synq_agent_seq, synq_agent_runs; DROP FUNCTION synq_agent_append_only();`,
  },
] as const;

const RunStatus = z.enum([
  'PENDING',
  'REQUIRES_OWNER',
  'AUTHORIZED',
  'BROADCAST',
  'FINALIZED',
  'RECONCILED',
  'BLOCKED',
  'REJECTED',
  'TIMED_OUT',
  'REORG_PENDING',
  'REVOKED',
  'QUARANTINED',
]);
export type RunStatus = z.output<typeof RunStatus>;
const ProofLevel = z.enum([
  'LIVE_ARC_TESTNET',
  'LIVE_ARC_MAINNET',
  'PROVIDER_SANDBOX',
  'LOCAL_FIXTURE',
  'NOT_VERIFIED',
  'BLOCKED',
]);
export type ProofLevel = z.output<typeof ProofLevel>;
const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const AgentEventInputSchema = z.strictObject({
  semanticKey: z.string().min(1).max(200),
  kind: z.enum([
    'DECISION',
    'INTENT',
    'GRANT',
    'BROADCAST',
    'FINALIZED',
    'REJECTED',
    'RECONCILED',
    'ESCALATED',
  ]),
  actor: z.enum(['MODEL', 'DETERMINISTIC', 'HUMAN', 'CHAIN', 'PROVIDER']),
  status: RunStatus,
  summary: z.string().min(1).max(400),
  sourceKind: z.string().min(1).max(40),
  proofLevel: ProofLevel,
  correlationId: z.string().min(1).max(80),
  causationId: z.string().max(80).nullable().default(null),
  effectiveAt: z.number().int().positive().nullable().default(null),
  evidenceHash: Hash.nullable().default(null),
  amountUnits: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .nullable()
    .default(null),
  recipientHint: z.string().max(16).nullable().default(null),
  txHash: Hash.nullable().default(null),
  chainId: z.number().int().nullable().default(null),
});
export type AgentEventInput = z.input<typeof AgentEventInputSchema>;
export type StreamType =
  | 'LEAD_UPDATED'
  | 'LEAD_MESSAGE'
  | 'OFFER_UPDATED'
  | 'AGENT_EVENT'
  | 'APPROVAL_CHANGED'
  | 'BALANCE_CHANGED'
  | 'NOTIFICATION'
  | 'CONTEXT_REVOKED';

const iso = (s: number) => new Date(s * 1000).toISOString();
const READERS: Role[] = ['OWNER', 'ADMIN', 'MEMBER'];
const FINAL: RunStatus[] = ['FINALIZED', 'RECONCILED'];
const ARC_TESTNET = chainProfile('arc-testnet').chainId;

export class AgentEvents {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: { explorerTxUrl?: string } = {},
  ) {}

  private now() {
    return this.store.now();
  }

  async migrate(target: number = AGENT_EVENT_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_agent_events_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_agent_events_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_agent_events_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...AGENT_EVENT_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_agent_events_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of AGENT_EVENT_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_agent_events_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  /** Opens (or finds) the run for one piece of agent work, keyed by its source. */
  async run(
    workspaceId: string,
    sourceKey: string,
    init: {
      title: string;
      trigger:
        | 'INVOICE_SETTLED'
        | 'DEPOSIT_FINALIZED'
        | 'SCHEDULE'
        | 'OWNER_REQUEST'
        | 'LEAD_MESSAGE'
        | 'OTHER';
      amountUnits?: string | null;
      proofLevel?: ProofLevel;
    },
  ) {
    const now = this.now();
    const r = await this.store.pool.query(
      `INSERT INTO synq_agent_runs(id,workspace_id,title,trigger,status,amount_units,proof_level,source_key,started_at,updated_at)
       VALUES($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$8)
       ON CONFLICT(workspace_id,source_key) DO UPDATE SET title=synq_agent_runs.title RETURNING id`,
      [
        randomUUID(),
        workspaceId,
        init.title.slice(0, 140),
        init.trigger,
        init.amountUnits ?? null,
        init.proofLevel ?? 'NOT_VERIFIED',
        sourceKey,
        now,
      ],
    );
    return String(r.rows[0].id);
  }

  private async stream(
    sql: PoolClient,
    type: StreamType,
    workspaceId: string | null,
    principalId: string | null,
    entityId: string | null,
  ) {
    await sql.query(
      'INSERT INTO synq_stream_events(event_id,workspace_id,principal_id,type,entity_id,observed_at) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), workspaceId, principalId, type, entityId, this.now()],
    );
  }

  /** Publishes a change marker for the live stream (no content, only ids). */
  async publish(
    type: StreamType,
    target: { workspaceId?: string | null; principalId?: string | null },
    entityId: string | null,
  ) {
    await this.store.transaction((sql) =>
      this.stream(
        sql,
        type,
        target.workspaceId ?? null,
        target.principalId ?? null,
        entityId,
      ),
    );
  }

  /**
   * Appends one event to a run, once per semantic key. The run's status and
   * proof level follow its latest event; a stream marker is written in the
   * same transaction.
   */
  async record(runId: string, raw: AgentEventInput) {
    const e = AgentEventInputSchema.parse(raw);
    return this.store.transaction(async (sql) => {
      const run = await sql.query(
        'SELECT workspace_id FROM synq_agent_runs WHERE id=$1 FOR UPDATE',
        [runId],
      );
      if (!run.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      const workspaceId = String(run.rows[0].workspace_id);
      const seen = await sql.query(
        'SELECT event_id FROM synq_agent_events WHERE workspace_id=$1 AND semantic_key=$2',
        [workspaceId, e.semanticKey],
      );
      if (seen.rows[0])
        return { eventId: String(seen.rows[0].event_id), duplicate: true };
      const seq = await sql.query(
        `INSERT INTO synq_agent_seq(workspace_id,last) VALUES($1,1)
         ON CONFLICT(workspace_id) DO UPDATE SET last=synq_agent_seq.last+1 RETURNING last`,
        [workspaceId],
      );
      const eventId = randomUUID();
      const now = this.now();
      await sql.query(
        'INSERT INTO synq_agent_events(event_id,workspace_id,run_id,sequence,semantic_key,data,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          eventId,
          workspaceId,
          runId,
          String(seq.rows[0].last),
          e.semanticKey,
          e,
          now,
        ],
      );
      await sql.query(
        'UPDATE synq_agent_runs SET status=$2, proof_level=$3, updated_at=$4, amount_units=COALESCE(amount_units,$5) WHERE id=$1',
        [runId, e.status, e.proofLevel, now, e.amountUnits],
      );
      await this.stream(sql, 'AGENT_EVENT', workspaceId, null, runId);
      return { eventId, duplicate: false };
    });
  }

  private async reader(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (!READERS.includes(m.role)) throw new WorkspaceError('NOT_FOUND', 404);
  }

  private summary(r: Record<string, unknown>) {
    return {
      runId: String(r.id),
      workspaceId: String(r.workspace_id),
      title: String(r.title),
      trigger: String(r.trigger) as
        | 'INVOICE_SETTLED'
        | 'DEPOSIT_FINALIZED'
        | 'SCHEDULE'
        | 'OWNER_REQUEST'
        | 'LEAD_MESSAGE'
        | 'OTHER',
      status: String(r.status) as RunStatus,
      amount:
        r.amount_units === null
          ? null
          : {
              assetId: 'arc-testnet:USDC',
              symbol: 'USDC',
              chainId: 5042002,
              decimals: 6,
              units: String(r.amount_units),
            },
      proofLevel: String(r.proof_level) as ProofLevel,
      startedAt: iso(Number(r.started_at)),
      updatedAt: iso(Number(r.updated_at)),
    };
  }

  async runs(
    workspaceId: string,
    principalId: string,
    query: { cursor?: string; limit?: number } = {},
  ) {
    await this.reader(workspaceId, principalId);
    const limit = query.limit ?? 20;
    let after: { at: number; id: string } | null = null;
    if (query.cursor) {
      const parsed = z
        .tuple([z.coerce.number().int(), z.uuid()])
        .safeParse(
          Buffer.from(query.cursor, 'base64url').toString().split('|'),
        );
      if (!parsed.success) throw new WorkspaceError('INVALID_CURSOR', 400);
      after = { at: parsed.data[0], id: parsed.data[1] };
    }
    const r = await this.store.pool.query(
      `SELECT * FROM synq_agent_runs WHERE workspace_id=$1
        AND ($2::bigint IS NULL OR (updated_at, id) < ($2::bigint, $3::uuid))
       ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [workspaceId, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    return {
      items: page.map((x) => this.summary(x)),
      nextCursor:
        r.rows.length > limit
          ? Buffer.from(
              `${page.at(-1)!.updated_at}|${page.at(-1)!.id}`,
            ).toString('base64url')
          : null,
    };
  }

  async highlights(workspaceId: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_agent_runs WHERE workspace_id=$1 ORDER BY updated_at DESC, id DESC LIMIT 5',
      [workspaceId],
    );
    return r.rows.map((x) => this.summary(x));
  }

  async detail(workspaceId: string, principalId: string, runId: string) {
    await this.reader(workspaceId, principalId);
    const r = await this.store.pool.query(
      'SELECT * FROM synq_agent_runs WHERE id=$1 AND workspace_id=$2',
      [runId, workspaceId],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    const ev = await this.store.pool.query(
      'SELECT * FROM synq_agent_events WHERE run_id=$1 ORDER BY sequence',
      [runId],
    );
    const events = ev.rows.map((x) => {
      const d = AgentEventInputSchema.parse(x.data);
      return {
        eventId: String(x.event_id),
        workspaceId,
        runId,
        sequence: String(x.sequence),
        correlationId: d.correlationId,
        causationId: d.causationId,
        kind: d.kind,
        actor: d.actor,
        status: d.status,
        summary: d.summary,
        sourceKind: d.sourceKind,
        observedAt: iso(Number(x.observed_at)),
        effectiveAt: d.effectiveAt === null ? null : iso(d.effectiveAt),
        evidenceHash: d.evidenceHash,
        proofLevel: d.proofLevel,
        amount:
          d.amountUnits === null
            ? null
            : {
                assetId: 'arc-testnet:USDC',
                symbol: 'USDC',
                chainId: 5042002,
                decimals: 6,
                units: d.amountUnits,
              },
        recipientHint: d.recipientHint,
        txHash: d.txHash,
        chainId: d.chainId,
      };
    });
    // One receipt per transaction: final only when a final event cites it.
    const receipts = new Map<
      string,
      {
        chainId: number;
        txHash: string;
        blockNumber: string | null;
        finality: 'PENDING' | 'FINALIZED' | 'REORGED';
        explorerUrl: string | null;
        ledgerEntryId: string | null;
      }
    >();
    for (const e of events) {
      if (!e.txHash || e.chainId === null) continue;
      const prev = receipts.get(e.txHash);
      const finality = FINAL.includes(e.status)
        ? 'FINALIZED'
        : e.status === 'REORG_PENDING'
          ? 'REORGED'
          : 'PENDING';
      receipts.set(e.txHash, {
        chainId: e.chainId,
        txHash: e.txHash,
        blockNumber: null,
        finality:
          prev?.finality === 'FINALIZED' && finality === 'PENDING'
            ? 'FINALIZED'
            : finality,
        explorerUrl:
          this.options.explorerTxUrl && e.chainId === ARC_TESTNET
            ? `${this.options.explorerTxUrl}${e.txHash}`
            : null,
        ledgerEntryId:
          e.status === 'RECONCILED' ? `${runId}:${e.txHash}` : null,
      });
    }
    return {
      run: this.summary(r.rows[0]),
      events,
      receipts: [...receipts.values()],
    };
  }

  /**
   * Stream markers after `cursor` that this principal may see: their own, or
   * for workspaces they belong to right now (a removed member stops seeing
   * new ones immediately).
   */
  async since(principalId: string, cursor: string | undefined, limit = 100) {
    const after = cursor === undefined ? null : z.coerce.bigint().parse(cursor);
    const r = await this.store.pool.query(
      `SELECT s.* FROM synq_stream_events s
        WHERE ($2::bigint IS NULL OR s.cursor > $2::bigint)
          AND (s.principal_id = $1 OR s.workspace_id IN (SELECT workspace_id FROM synq_ws_members WHERE principal_id=$1))
        ORDER BY s.cursor LIMIT $3`,
      [principalId, after === null ? null : String(after), limit + 1],
    );
    const page = r.rows.slice(0, limit);
    return {
      items: page.map((x) => ({
        cursor: String(x.cursor),
        eventId: String(x.event_id),
        type: x.type as StreamType,
        workspaceId: x.workspace_id === null ? null : String(x.workspace_id),
        entityId: x.entity_id === null ? null : String(x.entity_id),
        observedAt: iso(Number(x.observed_at)),
      })),
      nextCursor: page.length ? String(page.at(-1)!.cursor) : (cursor ?? null),
      more: r.rows.length > limit,
    };
  }

  /** The newest cursor, for a client that wants only future events. */
  async head() {
    const r = await this.store.pool.query(
      'SELECT coalesce(max(cursor),0)::text AS c FROM synq_stream_events',
    );
    return String(r.rows[0].c);
  }

  /**
   * Projects automatic revenue splits into runs: the settled invoice receipt,
   * the policy decision, and each transfer leg as it is submitted, confirmed
   * and reconciled. Safe to run repeatedly.
   */
  async projectSplits(workspaceId?: string) {
    const exists = await this.store.pool.query(
      "SELECT to_regclass('synq_alloc_splits') AS t",
    );
    if (!exists.rows[0].t) return 0;
    const splits = await this.store.pool.query(
      `SELECT s.split_id, s.workspace_id FROM synq_alloc_splits s
        WHERE ($1::text IS NULL OR s.workspace_id::text=$1) ORDER BY s.created_at DESC LIMIT 200`,
      [workspaceId ?? null],
    );
    const store = new PostgresSplitStore(this.store.pool);
    let recorded = 0;
    for (const row of splits.rows) {
      const split = await store.get(String(row.split_id));
      if (!split) continue;
      const ws = String(row.workspace_id);
      const runId = await this.run(ws, `split:${split.splitId}`, {
        title: `Split invoice payment of ${Number(split.receipt.amount) / 1e6} USDC`,
        trigger: 'INVOICE_SETTLED',
        amountUnits: String(split.receipt.amount),
      });
      const corr = `split:${split.splitId}`;
      const add = async (e: AgentEventInput) => {
        const r = await this.record(runId, e);
        if (!r.duplicate) recorded++;
      };
      await add({
        semanticKey: `${corr}:receipt`,
        kind: 'FINALIZED',
        actor: 'CHAIN',
        status: 'FINALIZED',
        summary: `Invoice payment of ${Number(split.receipt.amount) / 1e6} USDC settled on Arc testnet.`,
        sourceKind: 'INVOICE_RECEIPT',
        proofLevel: 'LIVE_ARC_TESTNET',
        correlationId: corr,
        txHash: split.receipt.txHash,
        chainId: 5042002,
        amountUnits: String(split.receipt.amount),
      });
      if (
        [
          'POLICY_VALIDATED',
          'SPLIT_AUTHORIZED',
          'EXECUTING',
          'EACH_LEG_RECONCILED',
          'COMPLETED',
        ].includes(split.state)
      )
        await add({
          semanticKey: `${corr}:policy`,
          kind: 'DECISION',
          actor: 'DETERMINISTIC',
          status: 'AUTHORIZED',
          summary: `Split under revenue policy version ${split.policyVersion}, signed by the owner quorum.`,
          sourceKind: 'REVENUE_POLICY',
          proofLevel: 'LIVE_ARC_TESTNET',
          correlationId: corr,
        });
      if (split.state === 'NEEDS_REVIEW')
        await add({
          semanticKey: `${corr}:review`,
          kind: 'ESCALATED',
          actor: 'DETERMINISTIC',
          status: 'REQUIRES_OWNER',
          summary: 'The split stopped and needs an owner to review it.',
          sourceKind: 'REVENUE_POLICY',
          proofLevel: 'NOT_VERIFIED',
          correlationId: corr,
        });
      for (const [i, leg] of (await store.legs(split.splitId)).entries()) {
        if (leg.kind !== 'TRANSFER' || !leg.txHash) continue;
        const hint = leg.payTo
          ? `${leg.payTo.slice(0, 6)}…${leg.payTo.slice(-4)}`
          : null;
        const base = {
          correlationId: corr,
          sourceKind: 'SPLIT_LEG',
          proofLevel: 'LIVE_ARC_TESTNET' as const,
          txHash: leg.txHash,
          chainId: 5042002,
          amountUnits: String(leg.amount),
          recipientHint: hint,
        };
        await add({
          ...base,
          semanticKey: `${corr}:leg:${i}:broadcast`,
          kind: 'BROADCAST',
          actor: 'DETERMINISTIC',
          status: 'BROADCAST',
          summary: `Sent ${Number(leg.amount) / 1e6} USDC for ${leg.purpose}.`,
        });
        if (leg.state === 'CONFIRMED' || leg.state === 'RECONCILED')
          await add({
            ...base,
            semanticKey: `${corr}:leg:${i}:final`,
            kind: 'FINALIZED',
            actor: 'CHAIN',
            status: 'FINALIZED',
            summary: `Transfer for ${leg.purpose} confirmed on chain.`,
          });
        if (leg.state === 'RECONCILED')
          await add({
            ...base,
            semanticKey: `${corr}:leg:${i}:reconciled`,
            kind: 'RECONCILED',
            actor: 'DETERMINISTIC',
            status: 'RECONCILED',
            summary: `Booked in the ledger and reconciled.`,
          });
      }
    }
    return recorded;
  }
}
