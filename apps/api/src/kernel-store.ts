import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AuditRecordSchema,
  KernelError,
  canonicalJson,
  type AuditRecord,
  type AuditSink,
  type KernelSnapshot,
} from '@synq/kernel';

export type PersistedKernel = {
  state: KernelSnapshot;
  records: AuditRecord[];
  head: string;
  sequence: number;
  mac: string;
};

export interface KernelStateStore {
  load(): Promise<PersistedKernel | null>;
  save(input: {
    state: KernelSnapshot;
    records: readonly AuditRecord[];
    fromSequence: number;
    head: string;
    sequence: number;
    mac: string;
  }): Promise<void>;
}

export function kernelStateMac(
  key: Uint8Array,
  input: { state: KernelSnapshot; head: string; sequence: number },
): string {
  return createHmac('sha256', key)
    .update(
      canonicalJson({
        state: { ...input.state, audit: [] },
        head: input.head,
        sequence: input.sequence,
      }),
    )
    .digest('hex');
}

export function verifyPersistedKernel(
  persisted: PersistedKernel,
  key: Uint8Array,
): KernelSnapshot {
  const expected = Buffer.from(
    kernelStateMac(key, {
      state: persisted.state,
      head: persisted.head,
      sequence: persisted.sequence,
    }),
    'hex',
  );
  const presented = Buffer.from(persisted.mac, 'hex');
  const last = persisted.records.at(-1);
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected) ||
    persisted.records.length !== persisted.sequence ||
    !last ||
    last.hash !== persisted.head ||
    persisted.records.some((r, i) => r.sequence !== i)
  )
    throw new KernelError('SNAPSHOT_INVALID');
  return { ...persisted.state, audit: persisted.records };
}

export function anchoredSink(head: () => string | null): AuditSink {
  return {
    append() {},
    head: () => head() as `0x${string}` | null,
  };
}

export class MemoryKernelStateStore implements KernelStateStore {
  persisted: PersistedKernel | null = null;
  async load() {
    return this.persisted ? structuredClone(this.persisted) : null;
  }
  async save(input: Parameters<KernelStateStore['save']>[0]) {
    const records = this.persisted?.records ?? [];
    if (records.length !== input.fromSequence)
      throw new KernelError('AUDIT_UNAVAILABLE');
    this.persisted = structuredClone({
      state: input.state,
      records: [...records, ...input.records],
      head: input.head,
      sequence: input.sequence,
      mac: input.mac,
    });
  }
}

export interface SqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface SqlPool {
  connect(): Promise<SqlClient>;
}

const MIGRATION = `
CREATE SCHEMA IF NOT EXISTS synq_kernel;
CREATE TABLE IF NOT EXISTS synq_kernel.audit_record (
  instance text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  hash text NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (instance, sequence)
);
CREATE TABLE IF NOT EXISTS synq_kernel.state (
  instance text PRIMARY KEY,
  state jsonb NOT NULL,
  head text NOT NULL,
  sequence integer NOT NULL,
  mac text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION synq_kernel.audit_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kernel audit records are append-only';
END $$;
DROP TRIGGER IF EXISTS audit_append_only ON synq_kernel.audit_record;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON synq_kernel.audit_record
  FOR EACH ROW EXECUTE FUNCTION synq_kernel.audit_append_only();
DROP TRIGGER IF EXISTS audit_no_truncate ON synq_kernel.audit_record;
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON synq_kernel.audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION synq_kernel.audit_append_only();
`;

export class PostgresKernelStateStore implements KernelStateStore {
  constructor(
    private readonly pool: SqlPool,
    readonly instance: string,
  ) {
    if (!/^[a-z0-9:/_.-]{1,128}$/i.test(instance))
      throw new KernelError('INVALID_REQUEST');
  }
  private async tx<T>(fn: (db: SqlClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `synq-kernel:${this.instance}`,
      ]);
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
  async migrate(): Promise<void> {
    await this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'synq-kernel-migrate',
      ]);
      await db.query(MIGRATION);
    });
  }
  async load(): Promise<PersistedKernel | null> {
    return this.tx(async (db) => {
      const { rows } = await db.query(
        'SELECT state, head, sequence, mac FROM synq_kernel.state WHERE instance=$1',
        [this.instance],
      );
      const row = rows[0];
      if (!row) return null;
      const records = (
        await db.query(
          'SELECT sequence, hash, record FROM synq_kernel.audit_record WHERE instance=$1 ORDER BY sequence',
          [this.instance],
        )
      ).rows.map((r) => {
        const record = AuditRecordSchema.parse(r.record);
        if (record.sequence !== r.sequence || record.hash !== r.hash)
          throw new KernelError('AUDIT_CHAIN_BROKEN');
        return record;
      });
      return {
        state: row.state as KernelSnapshot,
        records,
        head: z.string().parse(row.head),
        sequence: z.number().int().nonnegative().parse(row.sequence),
        mac: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .parse(row.mac),
      };
    });
  }
  async save(input: Parameters<KernelStateStore['save']>[0]): Promise<void> {
    await this.tx(async (db) => {
      const { rows } = await db.query(
        'SELECT count(*)::int AS n FROM synq_kernel.audit_record WHERE instance=$1',
        [this.instance],
      );
      if (rows[0]?.n !== input.fromSequence)
        throw new KernelError('AUDIT_UNAVAILABLE');
      for (const record of input.records)
        await db.query(
          'INSERT INTO synq_kernel.audit_record(instance,sequence,hash,record) VALUES ($1,$2,$3,$4::jsonb)',
          [this.instance, record.sequence, record.hash, JSON.stringify(record)],
        );
      await db.query(
        `INSERT INTO synq_kernel.state(instance,state,head,sequence,mac) VALUES ($1,$2::jsonb,$3,$4,$5)
         ON CONFLICT (instance) DO UPDATE SET state=EXCLUDED.state, head=EXCLUDED.head, sequence=EXCLUDED.sequence, mac=EXCLUDED.mac, updated_at=now()`,
        [
          this.instance,
          JSON.stringify(input.state),
          input.head,
          input.sequence,
          input.mac,
        ],
      );
    });
  }
}
