import {
  DealRoomError,
  TermsSchema,
  toJson,
  type Attestation,
  type Deal,
  type DealSignature,
  type DealVersion,
  type Transition,
} from './schema.js';
import type { Commit, CommitOutcome, DealRoomStore } from './store.js';

type Rows = { rows: Record<string, unknown>[] };
export type Sql = { query(text: string, values?: unknown[]): Promise<Rows> };
/** A pg.Pool-like source of dedicated connections for transactions. */
export type PgPool = Sql & {
  connect(): Promise<Sql & { release(): void }>;
};

/**
 * Versioned, reversible migrations for the Deal Room tables, tracked in their
 * own `synq_dealroom_migrations` table. Versions, signatures, attestations
 * and transitions are append-only: a trigger rejects UPDATE and DELETE.
 * `down` is for development dry runs only.
 */
export const DEALROOM_MIGRATIONS: readonly {
  version: number;
  up: string;
  down: string;
}[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_dealroom_deals (
      deal_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      status text NOT NULL,
      current_version int NOT NULL,
      rev int NOT NULL,
      escrow_deal_id text,
      data jsonb NOT NULL,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL);
    CREATE INDEX IF NOT EXISTS synq_dealroom_deals_ws ON synq_dealroom_deals (workspace_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS synq_dealroom_one_escrow_deal ON synq_dealroom_deals (escrow_deal_id) WHERE escrow_deal_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS synq_dealroom_versions (
      deal_id text NOT NULL REFERENCES synq_dealroom_deals(deal_id),
      version int NOT NULL,
      terms_hash text NOT NULL UNIQUE,
      parent_terms_hash text,
      proposed_by text NOT NULL,
      data jsonb NOT NULL,
      created_at bigint NOT NULL,
      PRIMARY KEY (deal_id, version));
    CREATE TABLE IF NOT EXISTS synq_dealroom_signatures (
      deal_id text NOT NULL REFERENCES synq_dealroom_deals(deal_id),
      version int NOT NULL,
      terms_hash text NOT NULL,
      role text NOT NULL,
      decision text NOT NULL,
      signer text NOT NULL,
      data jsonb NOT NULL,
      signed_at bigint NOT NULL,
      PRIMARY KEY (deal_id, version, role, decision),
      FOREIGN KEY (deal_id, version) REFERENCES synq_dealroom_versions(deal_id, version));
    CREATE TABLE IF NOT EXISTS synq_dealroom_attestations (
      attestation_id text PRIMARY KEY,
      deal_id text NOT NULL REFERENCES synq_dealroom_deals(deal_id),
      milestone int NOT NULL,
      kind text NOT NULL,
      nonce text NOT NULL UNIQUE,
      signer text NOT NULL,
      data jsonb NOT NULL,
      at bigint NOT NULL,
      UNIQUE (deal_id, milestone, kind));
    CREATE TABLE IF NOT EXISTS synq_dealroom_transitions (
      seq bigserial PRIMARY KEY,
      deal_id text NOT NULL REFERENCES synq_dealroom_deals(deal_id),
      idempotency_key text NOT NULL,
      kind text NOT NULL,
      from_status text,
      to_status text NOT NULL,
      actor text NOT NULL,
      payload jsonb NOT NULL,
      at bigint NOT NULL,
      UNIQUE (deal_id, idempotency_key));
    CREATE OR REPLACE FUNCTION synq_dealroom_append_only() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synq_dealroom: % is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS synq_dealroom_versions_ro ON synq_dealroom_versions;
    CREATE TRIGGER synq_dealroom_versions_ro BEFORE UPDATE OR DELETE ON synq_dealroom_versions
      FOR EACH ROW EXECUTE FUNCTION synq_dealroom_append_only();
    DROP TRIGGER IF EXISTS synq_dealroom_signatures_ro ON synq_dealroom_signatures;
    CREATE TRIGGER synq_dealroom_signatures_ro BEFORE UPDATE OR DELETE ON synq_dealroom_signatures
      FOR EACH ROW EXECUTE FUNCTION synq_dealroom_append_only();
    DROP TRIGGER IF EXISTS synq_dealroom_attestations_ro ON synq_dealroom_attestations;
    CREATE TRIGGER synq_dealroom_attestations_ro BEFORE UPDATE OR DELETE ON synq_dealroom_attestations
      FOR EACH ROW EXECUTE FUNCTION synq_dealroom_append_only();
    DROP TRIGGER IF EXISTS synq_dealroom_transitions_ro ON synq_dealroom_transitions;
    CREATE TRIGGER synq_dealroom_transitions_ro BEFORE UPDATE OR DELETE ON synq_dealroom_transitions
      FOR EACH ROW EXECUTE FUNCTION synq_dealroom_append_only();`,
    down: `DROP TABLE IF EXISTS synq_dealroom_transitions;
    DROP TABLE IF EXISTS synq_dealroom_attestations;
    DROP TABLE IF EXISTS synq_dealroom_signatures;
    DROP TABLE IF EXISTS synq_dealroom_versions;
    DROP TABLE IF EXISTS synq_dealroom_deals;
    DROP FUNCTION IF EXISTS synq_dealroom_append_only();`,
  },
];

export async function migrateDealRoom(
  sql: Sql,
  target = DEALROOM_MIGRATIONS.at(-1)!.version,
): Promise<number> {
  await sql.query(
    'CREATE TABLE IF NOT EXISTS synq_dealroom_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const r = await sql.query(
    'SELECT coalesce(max(version), 0) AS v FROM synq_dealroom_migrations',
  );
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of DEALROOM_MIGRATIONS)
    if (m.version > current && m.version <= target) {
      await sql.query(m.up);
      await sql.query(
        'INSERT INTO synq_dealroom_migrations (version) VALUES ($1)',
        [m.version],
      );
      current = m.version;
    }
  for (const m of [...DEALROOM_MIGRATIONS].reverse())
    if (m.version <= current && m.version > target) {
      await sql.query(m.down);
      await sql.query('DELETE FROM synq_dealroom_migrations WHERE version=$1', [
        m.version,
      ]);
      current = m.version - 1;
    }
  return current;
}

const json = (raw: unknown) =>
  (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
const decodeVersion = (raw: unknown): DealVersion => {
  const v = json(raw) as unknown as DealVersion;
  return { ...v, terms: TermsSchema.parse(v.terms) };
};
const unique = (e: unknown) => (e as { code?: string }).code === '23505';

/** Postgres store: one transaction per commit, the head row locked FOR UPDATE. */
export class PostgresDealRoomStore implements DealRoomStore {
  constructor(readonly pool: PgPool) {}

  async migrate() {
    await migrateDealRoom(this.pool);
  }

  private async tx<T>(fn: (c: Sql) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async insertTransition(c: Sql, t: Transition) {
    await c.query(
      `INSERT INTO synq_dealroom_transitions (deal_id, idempotency_key, kind, from_status, to_status, actor, payload, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        t.dealId,
        t.idempotencyKey,
        t.kind,
        t.from,
        t.to,
        t.actor,
        toJson(t.payload ?? null),
        t.at,
      ],
    );
  }

  private async insertVersion(c: Sql, v: DealVersion) {
    await c.query(
      `INSERT INTO synq_dealroom_versions (deal_id, version, terms_hash, parent_terms_hash, proposed_by, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        v.dealId,
        v.version,
        v.termsHash,
        v.parentTermsHash,
        v.proposedBy,
        toJson(v),
        v.createdAt,
      ],
    );
  }

  async create(input: {
    deal: Deal;
    version: DealVersion;
    transition: Transition;
  }): Promise<CommitOutcome> {
    const d = input.deal;
    try {
      return await this.tx(async (c) => {
        const r = await c.query(
          `INSERT INTO synq_dealroom_deals (deal_id, workspace_id, status, current_version, rev, escrow_deal_id, data, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8) ON CONFLICT (deal_id) DO NOTHING RETURNING deal_id`,
          [
            d.dealId,
            d.workspaceId,
            d.status,
            d.currentVersion,
            d.rev,
            toJson(d),
            d.createdAt,
            d.updatedAt,
          ],
        );
        if (!r.rows.length) {
          const cur = await this.get(d.dealId);
          return { outcome: 'DUPLICATE' as const, deal: cur! };
        }
        await this.insertVersion(c, input.version);
        await this.insertTransition(c, input.transition);
        return { outcome: 'APPLIED' as const, deal: d };
      });
    } catch (e) {
      if (unique(e)) throw new DealRoomError('CONFLICT', (e as Error).message);
      throw e;
    }
  }

  async commit(cm: Commit): Promise<CommitOutcome> {
    try {
      return await this.tx(async (c) => {
        const head = await c.query(
          'SELECT rev, data FROM synq_dealroom_deals WHERE deal_id=$1 FOR UPDATE',
          [cm.dealId],
        );
        if (!head.rows.length) throw new DealRoomError('NOT_FOUND', cm.dealId);
        const cur = json(head.rows[0]!.data) as unknown as Deal;
        const seen = await c.query(
          'SELECT 1 FROM synq_dealroom_transitions WHERE deal_id=$1 AND idempotency_key=$2',
          [cm.dealId, cm.transition.idempotencyKey],
        );
        if (seen.rows.length)
          return { outcome: 'DUPLICATE' as const, deal: cur };
        if (
          Number(head.rows[0]!.rev) !== cm.expectedRev ||
          cm.deal.rev !== cm.expectedRev + 1
        )
          throw new DealRoomError(
            'CONFLICT',
            `deal ${cm.dealId} is at rev ${String(head.rows[0]!.rev)}, expected ${cm.expectedRev}`,
          );
        if (cm.version) await this.insertVersion(c, cm.version);
        if (cm.signature) {
          const s = cm.signature;
          await c.query(
            `INSERT INTO synq_dealroom_signatures (deal_id, version, terms_hash, role, decision, signer, data, signed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              s.dealId,
              s.version,
              s.termsHash,
              s.role,
              s.decision,
              s.signer.toLowerCase(),
              toJson(s),
              s.signedAt,
            ],
          );
        }
        if (cm.attestation) {
          const a = cm.attestation;
          await c.query(
            `INSERT INTO synq_dealroom_attestations (attestation_id, deal_id, milestone, kind, nonce, signer, data, at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              a.attestationId,
              a.dealId,
              a.milestone,
              a.kind,
              a.nonce.toLowerCase(),
              a.signer.toLowerCase(),
              toJson(a),
              a.at,
            ],
          );
        }
        const d = cm.deal;
        await c.query(
          `UPDATE synq_dealroom_deals SET status=$2, current_version=$3, rev=$4, escrow_deal_id=$5, data=$6, updated_at=$7
           WHERE deal_id=$1 AND rev=$8`,
          [
            d.dealId,
            d.status,
            d.currentVersion,
            d.rev,
            d.escrow?.escrowDealId ?? null,
            toJson(d),
            d.updatedAt,
            cm.expectedRev,
          ],
        );
        await this.insertTransition(c, cm.transition);
        return { outcome: 'APPLIED' as const, deal: d };
      });
    } catch (e) {
      if (unique(e))
        throw new DealRoomError(
          'REPLAYED',
          `already recorded: ${(e as { detail?: string }).detail ?? ''}`,
        );
      throw e;
    }
  }

  async get(dealId: string): Promise<Deal | null> {
    const r = await this.pool.query(
      'SELECT data FROM synq_dealroom_deals WHERE deal_id=$1',
      [dealId],
    );
    return r.rows.length ? (json(r.rows[0]!.data) as unknown as Deal) : null;
  }
  async versions(dealId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_dealroom_versions WHERE deal_id=$1 ORDER BY version',
      [dealId],
    );
    return r.rows.map((x) => decodeVersion(x.data));
  }
  async signatures(dealId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_dealroom_signatures WHERE deal_id=$1 ORDER BY signed_at, version',
      [dealId],
    );
    return r.rows.map((x) => json(x.data) as unknown as DealSignature);
  }
  async attestations(dealId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_dealroom_attestations WHERE deal_id=$1 ORDER BY at, milestone',
      [dealId],
    );
    return r.rows.map((x) => json(x.data) as unknown as Attestation);
  }
  async transitions(dealId: string) {
    const r = await this.pool.query(
      `SELECT deal_id, idempotency_key, kind, from_status, to_status, actor, payload, at
       FROM synq_dealroom_transitions WHERE deal_id=$1 ORDER BY seq`,
      [dealId],
    );
    return r.rows.map(
      (x): Transition => ({
        dealId: String(x.deal_id),
        idempotencyKey: String(x.idempotency_key),
        kind: String(x.kind),
        from: (x.from_status as Transition['from']) ?? null,
        to: x.to_status as Transition['to'],
        actor: String(x.actor),
        payload: x.payload,
        at: Number(x.at),
      }),
    );
  }
  async list(workspaceId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_dealroom_deals WHERE workspace_id=$1 ORDER BY created_at',
      [workspaceId],
    );
    return r.rows.map((x) => json(x.data) as unknown as Deal);
  }
}
