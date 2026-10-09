import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { HashSchema } from '@synq/schemas';
import { artifactHash, canonicalJson, type Hash } from './canonical.js';
import { KernelError, parseAs, requireRule } from './errors.js';

export const AUDIT_KINDS = [
  'AUTHORIZATION',
  'CLAIM',
  'PREPARE',
  'RECONCILE',
  'RELEASE',
  'GOVERNANCE',
  'SNAPSHOT',
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

export const MIN_AUDIT_KEY_BYTES = 32;
function recordHash(
  record: Omit<AuditRecord, 'hash'>,
  key: Uint8Array | undefined,
): Hash {
  if (!key) return artifactHash(record);
  return `0x${createHmac('sha256', key).update(canonicalJson(record)).digest('hex')}`;
}
export function assertAuditKey(key: Uint8Array | undefined): void {
  requireRule(
    key === undefined ||
      (key instanceof Uint8Array && key.length >= MIN_AUDIT_KEY_BYTES),
    'AUDIT_UNAVAILABLE',
  );
}

export interface AuditSink {
  append(record: AuditRecord): void;
  head?(): Hash | null;
}

export class AuditRecorder {
  private readonly log: AuditRecord[] = [];
  constructor(
    private readonly sink?: AuditSink,
    private readonly key?: Uint8Array,
  ) {
    assertAuditKey(key);
  }
  append(kind: AuditKind, payload: unknown, recordedAt: number): AuditRecord {
    const body = {
      schemaVersion: 1 as const,
      sequence: this.log.length,
      previousHash: this.log.at(-1)?.hash ?? GENESIS_HASH,
      recordedAt,
      kind,
      payload: JSON.parse(JSON.stringify(payload)) as z.core.util.JSONType,
    };
    const record = { ...body, hash: recordHash(body, this.key) };
    try {
      this.sink?.append(structuredClone(record));
    } catch {
      throw new KernelError('AUDIT_UNAVAILABLE');
    }
    this.log.push(record);
    return structuredClone(record);
  }
  records(): AuditRecord[] {
    return structuredClone(this.log);
  }
  head(): Hash {
    return this.log.at(-1)?.hash ?? GENESIS_HASH;
  }
  static verify(records: readonly unknown[], key?: Uint8Array): AuditRecord[] {
    const parsed = records.map((r) =>
      parseAs(AuditRecordSchema, r, 'AUDIT_CHAIN_BROKEN'),
    );
    parsed.forEach((record, i) => {
      const { hash, ...body } = record;
      requireRule(
        record.sequence === i &&
          record.previousHash === (parsed[i - 1]?.hash ?? GENESIS_HASH) &&
          recordHash(body, key) === hash &&
          (i === 0 || record.recordedAt >= parsed[i - 1]!.recordedAt),
        'AUDIT_CHAIN_BROKEN',
      );
    });
    return parsed;
  }
  static restore(
    records: readonly unknown[],
    sink?: AuditSink,
    key?: Uint8Array,
  ): AuditRecorder {
    requireRule(
      key !== undefined || sink?.head !== undefined,
      'AUDIT_CHAIN_BROKEN',
    );
    const recorder = new AuditRecorder(sink, key);
    recorder.log.push(...AuditRecorder.verify(records, key));
    if (sink) {
      let anchored: Hash | null;
      try {
        anchored = sink.head ? sink.head() : null;
      } catch {
        throw new KernelError('AUDIT_UNAVAILABLE');
      }
      requireRule(
        sink.head === undefined || anchored === recorder.head(),
        'AUDIT_CHAIN_BROKEN',
      );
    }
    return recorder;
  }
}
