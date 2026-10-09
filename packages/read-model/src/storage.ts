import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ReadModelError, fail } from './errors.js';
import { parseChainEvent, type ChainEvent } from './events.js';
import type { LoadRequest, ScopeKey } from './projection.js';
import type {
  Checkpoint,
  MandateArtifact,
  ProjectionSession,
  ProjectionStore,
  ReconciliationReopened,
  Scope2,
  StoredEvent,
} from './store.js';
import {
  TABLES,
  TABLE_NAMES,
  Tables,
  type GroupRow,
  type Hex,
  type TableChanges,
  type TableName,
  type TableRows,
} from './tables.js';

export interface SqlConnection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface SqlPoolClient extends SqlConnection {
  release(error?: Error | boolean): void;
}
export interface SqlPool {
  connect(): Promise<SqlPoolClient>;
}
export type SqlTarget = { pool: SqlPool } | { client: SqlConnection };

const MIGRATIONS = ['001-projection.sql', '002-build-identity.sql'] as const;
const NULLABLE: { [T in TableName]?: readonly string[] } = {
  group: ['creator', 'salt', 'threshold', 'guard'],
  mandate_version: ['security_sensitive'],
  tracked_account: ['group_id'],
};
const BOOLEAN = new Set(['paused', 'enabled', 'allowed', 'security_sensitive']);
const SCOPE = /^(g:0x[0-9a-f]{64}|a:0x[0-9a-f]{40})$/;
const HEX_OR_ENUM = /^(0x[0-9a-f]*|[A-Z_]+)$/;
const DIGITS = /^(0|[1-9][0-9]{0,77})$/;

function safeInt(value: unknown, column: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    fail('INCONSISTENT_PROOF', `invalid integer in ${column}`);
  return n;
}

export function decodeRow<T extends TableName>(
  table: T,
  raw: Record<string, unknown>,
): TableRows[T] {
  const spec = TABLES[table];
  const nullable = new Set(NULLABLE[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const col of spec.columns as readonly string[]) {
    const v = raw[col];
    if (v === null || v === undefined) {
      if (!nullable.has(col))
        fail('INCONSISTENT_PROOF', `${table}.${col} is null`);
      out[col] = null;
    } else if ((spec.bigint as readonly string[]).includes(col))
      out[col] = safeInt(v, `${table}.${col}`);
    else if ((spec.numeric as readonly string[]).includes(col)) {
      if (typeof v !== 'string' || !DIGITS.test(v))
        fail('INCONSISTENT_PROOF', `invalid amount in ${table}.${col}`);
      out[col] = v;
    } else if ((spec.json as readonly string[]).includes(col)) {
      const parsed = z.array(z.string().regex(HEX_OR_ENUM)).safeParse(v);
      if (!parsed.success)
        fail('INCONSISTENT_PROOF', `invalid list in ${table}.${col}`);
      out[col] = parsed.data;
    } else if (BOOLEAN.has(col)) {
      if (typeof v !== 'boolean')
        fail('INCONSISTENT_PROOF', `invalid flag in ${table}.${col}`);
      out[col] = v;
    } else {
      if (typeof v !== 'string' || !HEX_OR_ENUM.test(v))
        fail('INCONSISTENT_PROOF', `invalid value in ${table}.${col}`);
      out[col] = v;
    }
  }
  return out as unknown as TableRows[T];
}

const SignalSchema = z.strictObject({
  id: z.string().min(1),
  chainId: z.number().int().positive(),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  orphanedBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  eventName: z.enum(['Transfer', 'GrantExecuted', 'SpendRecorded']),
  groupIds: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)),
  intentHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .nullable(),
  nonce: z.string().regex(DIGITS).nullable(),
  fingerprint: z.string().min(1),
  status: z.enum(['OPEN', 'RESOLVED']),
  resolution: z.enum(['REOBSERVED', 'DROPPED']).nullable(),
  reobservedBlock: z.number().int().nonnegative().nullable(),
  reobservedBlockHash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .nullable(),
  openedGeneration: z.number().int().nonnegative(),
  resolvedGeneration: z.number().int().nonnegative().nullable(),
  evidence: z.string().nullable(),
});

const tableName = (schema: string, t: TableName) => `"${schema}".rm_${t}`;

export class PostgresProjectionStore implements ProjectionStore {
  readonly namespace: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly target: SqlTarget,
    readonly chainId: number,
    readonly schema = 'synq_read_model',
  ) {
    this.namespace = `pg:${schema}`;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new ReadModelError('CONFIG_MISMATCH', 'invalid schema name');
    if (!Number.isSafeInteger(chainId) || chainId <= 0)
      throw new ReadModelError('CONFIG_MISMATCH', 'invalid chain id');
  }
  private async withConnection<T>(
    fn: (db: SqlConnection) => Promise<T>,
  ): Promise<T> {
    if ('pool' in this.target) {
      const client = await this.target.pool.connect();
      try {
        const result = await fn(client);
        client.release();
        return result;
      } catch (error) {
        client.release(error instanceof Error ? error : true);
        throw error;
      }
    }
    const client = this.target.client;
    const run = this.queue.then(() => fn(client));
    this.queue = run.catch(() => undefined);
    return run;
  }
  async migrate(): Promise<void> {
    await this.withConnection(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `synq-rm-migrate:${this.schema}`,
        ]);
        await db.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
        await db.query(
          `CREATE TABLE IF NOT EXISTS "${this.schema}".rm_schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const applied = new Set(
          (
            await db.query(
              `SELECT version FROM "${this.schema}".rm_schema_migration`,
            )
          ).rows.map((r) => String(r.version)),
        );
        for (const file of MIGRATIONS) {
          if (applied.has(file)) continue;
          const sql = await readFile(
            new URL(`../sql/${file}`, import.meta.url),
            'utf8',
          );
          await db.query(sql.replaceAll('__SCHEMA__', `"${this.schema}"`));
          await db.query(
            `INSERT INTO "${this.schema}".rm_schema_migration(version) VALUES ($1)`,
            [file],
          );
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
  }
  async dropSchema(): Promise<void> {
    await this.withConnection((db) =>
      db.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`),
    );
  }
  async resetProjection(): Promise<void> {
    await this.withConnection(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [
          `synq-rm:${this.schema}`,
          this.chainId,
        ]);
        for (const t of [...TABLE_NAMES, 'event', 'checkpoint'])
          await db.query(
            `DELETE FROM "${this.schema}".rm_${t} WHERE chain_id=$1`,
            [this.chainId],
          );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
  }
  transaction<T>(fn: (s: ProjectionSession) => Promise<T>): Promise<T> {
    return this.withConnection(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [
          `synq-rm:${this.schema}`,
          this.chainId,
        ]);
        const result = await fn(new PgSession(db, this.chainId, this.schema));
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
  }
  read<T>(fn: (s: ProjectionSession) => Promise<T>): Promise<T> {
    return this.withConnection(async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const result = await fn(new PgSession(db, this.chainId, this.schema));
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
  }
}

class PgSession implements ProjectionSession {
  constructor(
    private readonly db: SqlConnection,
    private readonly chainId: number,
    private readonly schema: string,
  ) {}
  private t(name: string) {
    return `"${this.schema}".rm_${name}`;
  }
  async checkpoint(): Promise<Checkpoint | null> {
    const { rows } = await this.db.query(
      `SELECT indexed_through_block, generation, config_hash, build_id FROM ${this.t('checkpoint')} WHERE chain_id=$1`,
      [this.chainId],
    );
    const row = rows[0];
    if (!row) return null;
    const configHash = z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .parse(row.config_hash) as Hex;
    const buildId = z
      .string()
      .regex(/^0x[0-9a-f]{32}$/)
      .parse(row.build_id) as Hex;
    return {
      chainId: this.chainId,
      indexedThroughBlock: safeInt(row.indexed_through_block, 'checkpoint'),
      generation: safeInt(row.generation, 'generation'),
      configHash,
      buildId,
    };
  }
  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t('checkpoint')}(chain_id,indexed_through_block,generation,config_hash,build_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (chain_id) DO UPDATE SET indexed_through_block=EXCLUDED.indexed_through_block, generation=EXCLUDED.generation, config_hash=EXCLUDED.config_hash, build_id=EXCLUDED.build_id, updated_at=now()`,
      [
        this.chainId,
        cp.indexedThroughBlock,
        cp.generation,
        cp.configHash,
        cp.buildId,
      ],
    );
  }
  private decodeEvents(rows: Record<string, unknown>[]): StoredEvent[] {
    return rows.map((r) => {
      const scope = z.array(z.string().regex(SCOPE)).parse(r.scope);
      const event = parseChainEvent(r.event);
      if (event.chainId !== this.chainId)
        fail('INCONSISTENT_PROOF', 'journal chain mismatch');
      return { event, scope: scope as ScopeKey[] };
    });
  }
  private readonly order = 'ORDER BY block_number, tx_index, log_index';
  async journalRange(fromExclusive: number, toInclusive: number) {
    const { rows } = await this.db.query(
      `SELECT scope, event FROM ${this.t('event')} WHERE chain_id=$1 AND block_number>$2 AND block_number<=$3 ${this.order}`,
      [this.chainId, fromExclusive, toInclusive],
    );
    return this.decodeEvents(rows);
  }
  async journalByScope(keys: readonly ScopeKey[], beforeBlock: number) {
    if (!keys.length) return [];
    const { rows } = await this.db.query(
      `SELECT scope, event FROM ${this.t('event')} WHERE chain_id=$1 AND block_number<$2 AND scope && $3::text[] ${this.order}`,
      [this.chainId, beforeBlock, keys],
    );
    return this.decodeEvents(rows);
  }
  async journalByTransactions(txHashes: readonly Hex[]) {
    if (!txHashes.length) return [];
    const { rows } = await this.db.query(
      `SELECT scope, event FROM ${this.t('event')} WHERE chain_id=$1 AND tx_hash = ANY($2::text[]) ${this.order}`,
      [this.chainId, txHashes],
    );
    return this.decodeEvents(rows);
  }
  private async select<T extends TableName>(
    table: T,
    where: string,
    values: unknown[],
    into: Tables,
  ): Promise<void> {
    const cols = TABLES[table].columns.join(',');
    const { rows } = await this.db.query(
      `SELECT ${cols} FROM ${tableName(this.schema, table)} WHERE chain_id=$1 AND ${where}`,
      [this.chainId, ...values],
    );
    into.load(
      table,
      rows.map((r) => decodeRow(table, r)),
    );
  }
  async load(request: LoadRequest, into: Tables): Promise<void> {
    await this.select(
      'tracked_account',
      'account = ANY($2::text[])',
      [request.accounts],
      into,
    );
    const groups = new Set<Hex>(request.groups);
    for (const r of into.rows('tracked_account'))
      if (r.group_id) groups.add(r.group_id);
    await this.loadGroups([...groups], into);
    await this.select(
      'balance',
      'account = ANY($2::text[])',
      [request.accounts],
      into,
    );
    const pairs = (list: [string, string][]) => [
      list.map(([a]) => a),
      list.map(([, b]) => b),
    ];
    if (request.grantNonces.length || request.grantIntents.length) {
      const [ng, nn] = pairs(request.grantNonces);
      const [ig, ii] = pairs(request.grantIntents);
      await this.select(
        'grant_executed',
        '((group_id, nonce) IN (SELECT g, n::numeric FROM unnest($2::text[], $3::text[]) AS x(g, n)) OR (group_id, intent_hash) IN (SELECT g, i FROM unnest($4::text[], $5::text[]) AS y(g, i)))',
        [ng, nn, ig, ii],
        into,
      );
    }
    if (request.cancelledNonces.length) {
      const [cg, cn] = pairs(request.cancelledNonces);
      await this.select(
        'cancelled_nonce',
        '(group_id, nonce) IN (SELECT g, n::numeric FROM unnest($2::text[], $3::text[]) AS x(g, n))',
        [cg, cn],
        into,
      );
    }
  }
  async loadGroups(
    groupIds: readonly Hex[],
    into: Tables,
    full = false,
  ): Promise<void> {
    if (!groupIds.length) return;
    const tables: TableName[] = [
      'group',
      'owner',
      'safe_module',
      'executor',
      'mandate',
      'mandate_version',
      ...(full
        ? (['grant_executed', 'cancelled_nonce', 'spend'] as const)
        : []),
    ];
    for (const t of tables)
      await this.select(t, 'group_id = ANY($2::text[])', [groupIds], into);
    const accounts = into
      .rows('group')
      .filter((g) => groupIds.includes(g.group_id))
      .map((g) => g.account);
    await this.select(
      'tracked_account',
      'account = ANY($2::text[])',
      [accounts],
      into,
    );
    await this.select('balance', 'account = ANY($2::text[])', [accounts], into);
  }
  async groupIndex(groupIds?: readonly Hex[]): Promise<GroupRow[]> {
    const t = new Tables();
    if (groupIds)
      await this.select('group', 'group_id = ANY($2::text[])', [groupIds], t);
    else await this.select('group', 'true', [], t);
    return t.rows('group');
  }
  async clearScope(scope: Scope2): Promise<void> {
    for (const t of TABLE_NAMES) {
      if (!TABLES[t].groupColumn || t === 'tracked_account') continue;
      await this.db.query(
        `DELETE FROM ${tableName(this.schema, t)} WHERE chain_id=$1 AND group_id = ANY($2::text[])`,
        [this.chainId, scope.groups],
      );
    }
    const { rows } = await this.db.query(
      `DELETE FROM ${this.t('tracked_account')} WHERE chain_id=$1 AND group_id = ANY($2::text[]) RETURNING account`,
      [this.chainId, scope.groups],
    );
    const owned = rows.map((r) => String(r.account));
    await this.db.query(
      `DELETE FROM ${this.t('balance')} WHERE chain_id=$1 AND account = ANY($2::text[])`,
      [this.chainId, owned],
    );
    await this.db.query(
      `UPDATE ${this.t('balance')} SET balance=baseline_balance, last_block=baseline_block WHERE chain_id=$1 AND account = ANY($2::text[])`,
      [this.chainId, scope.accounts.filter((a) => !owned.includes(a))],
    );
  }
  async write(changes: TableChanges): Promise<void> {
    for (const t of TABLE_NAMES) {
      const spec = TABLES[t];
      for (const row of changes.deletes[t] ?? []) {
        const values = row as unknown as Record<string, unknown>;
        await this.db.query(
          `DELETE FROM ${tableName(this.schema, t)} WHERE chain_id=$1 AND ${spec.pk
            .map((c, i) => `${c}=$${i + 2}`)
            .join(' AND ')}`,
          [this.chainId, ...spec.pk.map((c) => values[c])],
        );
      }
      const upserts = changes.upserts[t] ?? [];
      if (!upserts.length) continue;
      const cols = spec.columns as readonly string[];
      const json = new Set<string>(spec.json);
      const updates = cols.filter(
        (c) => !(spec.pk as readonly string[]).includes(c),
      );
      const sql = `INSERT INTO ${tableName(this.schema, t)} (chain_id,${cols.join(',')}) VALUES ($1,${cols
        .map((c, i) => `$${i + 2}${json.has(c) ? '::jsonb' : ''}`)
        .join(',')}) ON CONFLICT (chain_id,${spec.pk.join(',')}) DO ${
        updates.length
          ? `UPDATE SET ${updates.map((c) => `${c}=EXCLUDED.${c}`).join(',')}`
          : 'NOTHING'
      }`;
      for (const row of upserts) {
        const values = row as unknown as Record<string, unknown>;
        await this.db.query(sql, [
          this.chainId,
          ...cols.map((c) =>
            json.has(c) ? JSON.stringify(values[c]) : values[c],
          ),
        ]);
      }
    }
  }
  async insertEvents(events: readonly StoredEvent[], generation: number) {
    for (const { event: e, scope } of events)
      await this.db.query(
        `INSERT INTO ${this.t('event')}(chain_id,tx_hash,log_index,block_number,block_hash,tx_index,event_name,schema_version,scope,event,generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,$11)`,
        [
          this.chainId,
          e.transactionHash,
          e.logIndex,
          e.blockNumber,
          e.blockHash,
          e.transactionIndex,
          e.eventName,
          e.schemaVersion,
          scope,
          JSON.stringify(e),
          generation,
        ],
      );
  }
  async deleteEvents(events: readonly ChainEvent[]) {
    for (const e of events)
      await this.db.query(
        `DELETE FROM ${this.t('event')} WHERE chain_id=$1 AND tx_hash=$2 AND log_index=$3`,
        [this.chainId, e.transactionHash, e.logIndex],
      );
  }
  async signals(status?: 'OPEN'): Promise<ReconciliationReopened[]> {
    const { rows } = await this.db.query(
      `SELECT seq, signal FROM ${this.t('reconciliation_signal')} WHERE chain_id=$1 ${status ? "AND status='OPEN'" : ''} ORDER BY seq`,
      [this.chainId],
    );
    return rows.map((r) => ({
      ...(SignalSchema.parse(r.signal) as Omit<ReconciliationReopened, 'seq'>),
      seq: safeInt(r.seq, 'seq'),
    }));
  }
  async saveSignal(signal: Omit<ReconciliationReopened, 'seq'>) {
    const { seq: _seq, ...rest } = signal as ReconciliationReopened;
    void _seq;
    const body = SignalSchema.parse(rest);
    await this.db.query(
      `INSERT INTO ${this.t('reconciliation_signal')}(id,chain_id,status,signal) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, signal=EXCLUDED.signal`,
      [body.id, this.chainId, body.status, JSON.stringify(body)],
    );
  }
  async saveArtifact(a: MandateArtifact) {
    await this.db.query(
      `INSERT INTO ${this.t('mandate_artifact')}(chain_id,mandate_hash,artifact) VALUES ($1,$2,$3::jsonb) ON CONFLICT (chain_id,mandate_hash) DO NOTHING`,
      [this.chainId, a.mandateHash, JSON.stringify(a.artifact)],
    );
  }
  async artifactHashes() {
    const { rows } = await this.db.query(
      `SELECT mandate_hash FROM ${this.t('mandate_artifact')} WHERE chain_id=$1`,
      [this.chainId],
    );
    return new Set(rows.map((r) => z.string().parse(r.mandate_hash)));
  }
  async artifacts(): Promise<MandateArtifact[]> {
    const { rows } = await this.db.query(
      `SELECT mandate_hash, artifact FROM ${this.t('mandate_artifact')} WHERE chain_id=$1 ORDER BY mandate_hash`,
      [this.chainId],
    );
    return rows.map((r) => ({
      mandateHash: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .parse(r.mandate_hash) as Hex,
      artifact: r.artifact,
    }));
  }
  async allTables(): Promise<Tables> {
    const t = new Tables();
    for (const name of TABLE_NAMES) await this.select(name, 'true', [], t);
    return t;
  }
}
