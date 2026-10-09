import { z } from 'zod';
import { HashSchema } from '@synq/schemas';
import { artifactHash, type Hash } from './canonical.js';
import { parseAs, requireRule } from './errors.js';

export const AUDIT_KINDS = [
  'AUTHORIZATION',
  'CLAIM',
  'PREPARE',
  'RECONCILE',
  'RELEASE',
  'GOVERNANCE',
] as const;
export const GENESIS_HASH = `0x${'0'.repeat(64)}` as const;
export const AuditRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  previousHash: HashSchema,
  recordedAt: z.number().int().nonnegative(),
  kind: z.enum(AUDIT_KINDS),
  payload: z.json(),
  hash: HashSchema,
});
export type AuditRecord = z.output<typeof AuditRecordSchema>;
export type AuditKind = (typeof AUDIT_KINDS)[number];

function recordHash(record: Omit<AuditRecord, 'hash'>): Hash {
  return artifactHash(record);
}

export interface AuditSink {
  append(record: AuditRecord): void;
}

export class AuditRecorder {
  private readonly log: AuditRecord[] = [];
  constructor(private readonly sink?: AuditSink) {}
  append(kind: AuditKind, payload: unknown, recordedAt: number): AuditRecord {
    const body = {
      schemaVersion: 1 as const,
      sequence: this.log.length,
      previousHash: this.log.at(-1)?.hash ?? GENESIS_HASH,
      recordedAt,
      kind,
      payload: JSON.parse(JSON.stringify(payload)) as z.core.util.JSONType,
    };
    const record = { ...body, hash: recordHash(body) };
    this.sink?.append(structuredClone(record));
    this.log.push(record);
    return structuredClone(record);
  }
  records(): AuditRecord[] {
    return structuredClone(this.log);
  }
  head(): Hash {
    return this.log.at(-1)?.hash ?? GENESIS_HASH;
  }
  static verify(records: readonly unknown[]): AuditRecord[] {
    const parsed = records.map((r) =>
      parseAs(AuditRecordSchema, r, 'AUDIT_CHAIN_BROKEN'),
    );
    parsed.forEach((record, i) => {
      const { hash, ...body } = record;
      requireRule(
        record.sequence === i &&
          record.previousHash === (parsed[i - 1]?.hash ?? GENESIS_HASH) &&
          recordHash(body) === hash &&
          (i === 0 || record.recordedAt >= parsed[i - 1]!.recordedAt),
        'AUDIT_CHAIN_BROKEN',
      );
    });
    return parsed;
  }
  static restore(records: readonly unknown[], sink?: AuditSink): AuditRecorder {
    const recorder = new AuditRecorder(sink);
    recorder.log.push(...AuditRecorder.verify(records));
    return recorder;
  }
}
