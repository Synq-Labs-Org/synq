import { createHash } from 'node:crypto';
import { canonicalJsonOf } from '@synq/schemas';
import type { Citation } from './citations.js';

/**
 * Forensic audit trail: an append-only, per-workspace hash chain. Each record
 * commits to its predecessor's hash, so editing, deleting or reordering any
 * record is detected by `verifyAuditChain`. Payloads are redacted before
 * they are hashed or stored: passports, credentials and keys never enter the
 * trail.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type AuditRecord = Readonly<{
  workspaceId: string;
  seq: number;
  at: number;
  /** Agent role, principal or service that produced the record. */
  actor: string;
  kind: string;
  payload: JsonValue;
  citations: readonly Citation[];
  prevHash: `0x${string}`;
  hash: `0x${string}`;
}>;

export const GENESIS_HASH = `0x${'00'.repeat(32)}` as const;

export function auditHash(r: Omit<AuditRecord, 'hash'>): `0x${string}` {
  const body = canonicalJsonOf({
    workspaceId: r.workspaceId,
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    kind: r.kind,
    payload: r.payload,
    citations: r.citations,
    prevHash: r.prevHash,
  });
  return `0x${createHash('sha256').update(`synq-audit/1:${body}`).digest('hex')}`;
}

export function nextAuditRecord(
  prev: AuditRecord | null,
  input: {
    workspaceId: string;
    at: number;
    actor: string;
    kind: string;
    payload: unknown;
    citations?: readonly Citation[];
  },
): AuditRecord {
  const body = {
    workspaceId: input.workspaceId,
    seq: prev ? prev.seq + 1 : 1,
    at: input.at,
    actor: input.actor.slice(0, 80),
    kind: input.kind.slice(0, 80),
    payload: redact(input.payload).value,
    citations: [...(input.citations ?? [])],
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return Object.freeze({ ...body, hash: auditHash(body) });
}

export type ChainCheck =
  | { ok: true; records: number; head: `0x${string}` }
  | {
      ok: false;
      seq: number;
      reason: 'HASH_MISMATCH' | 'BROKEN_LINK' | 'SEQUENCE_GAP' | 'WORKSPACE';
    };

/** Recomputes every hash and link; the first tampered record is reported. */
export function verifyAuditChain(records: readonly AuditRecord[]): ChainCheck {
  let prev: AuditRecord | null = null;
  for (const r of records) {
    if (prev && r.workspaceId !== prev.workspaceId)
      return { ok: false, seq: r.seq, reason: 'WORKSPACE' };
    if (r.seq !== (prev ? prev.seq + 1 : 1))
      return { ok: false, seq: r.seq, reason: 'SEQUENCE_GAP' };
    if (r.prevHash !== (prev ? prev.hash : GENESIS_HASH))
      return { ok: false, seq: r.seq, reason: 'BROKEN_LINK' };
    const { hash, ...body } = r;
    if (auditHash(body) !== hash)
      return { ok: false, seq: r.seq, reason: 'HASH_MISMATCH' };
    prev = r;
  }
  return {
    ok: true,
    records: records.length,
    head: prev?.hash ?? GENESIS_HASH,
  };
}

// ---------------------------------------------------------------- redaction

const SENSITIVE_KEY =
  /passport|mrz|document_?number|national_?id|private_?key|secret|mnemonic|seed_?phrase|password|passphrase|api_?key|access_?token|refresh_?token|bot_?token|bearer|authori[sz]ation|credential|cvv|cvc|card_?number|^pan$|^mac$|grant_?key|entity_?secret|^key$/i;

const VALUE_PATTERNS: readonly [string, RegExp][] = [
  [
    'PEM_KEY',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
  [
    'SECRET',
    /\b(private key|secret key|seed phrase|mnemonic|entity secret|api key|password)\b\s*(is|:|=)?\s*["']?(0x[0-9a-fA-F]{64}|[A-Za-z0-9_\-./+]{12,}(\s+[a-z]{3,8}){0,23})/gi,
  ],
  [
    'RECOVERY_WORDS',
    /\b(seed phrase|mnemonic|recovery phrase)\b\s*(is|:|=)?\s*["']?[a-z]{3,8}(\s+[a-z]{3,8}){11,23}/gi,
  ],
  ['API_KEY', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['BOT_TOKEN', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ['PASSPORT', /\bP<[A-Z]{3}[A-Z<]{5,}[A-Z0-9<]*/g],
  ['PASSPORT', /\bpassport\s*(no\.?|number|#)?\s*[:=]?\s*[A-Z0-9]{6,9}\b/gi],
  // Grouped card numbers only: bare digit runs are amounts (wei, base units).
  ['CARD', /\b\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}\b/g],
];

export type Redaction = Readonly<{ value: JsonValue; redactions: string[] }>;

function redactText(text: string, hits: string[]): string {
  let out = text;
  for (const [label, re] of VALUE_PATTERNS)
    out = out.replace(re, () => {
      hits.push(label);
      return `[REDACTED:${label}]`;
    });
  return out;
}

/**
 * Removes passports, credentials and keys from any value: sensitive keys are
 * replaced whole, free text is scanned for key, token, passport and card
 * patterns. Addresses and transaction hashes stay (they are public evidence).
 * Bigints become decimal strings.
 */
export function redact(value: unknown): Redaction {
  const hits: string[] = [];
  const walk = (v: unknown, depth: number): JsonValue => {
    if (depth > 12) return '[TRUNCATED]';
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return redactText(v, hits);
    if (v instanceof Uint8Array) {
      hits.push('BYTES');
      return '[REDACTED:BYTES]';
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined || typeof x === 'function') continue;
        if (SENSITIVE_KEY.test(k)) {
          hits.push(`KEY:${k}`);
          out[k] = '[REDACTED]';
        } else out[k] = walk(x, depth + 1);
      }
      return out;
    }
    return String(v);
  };
  return { value: walk(value, 0), redactions: hits };
}

/** True when no known secret pattern survives in the serialised value. */
export function containsSecrets(value: unknown): boolean {
  const text = JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? String(v) : v,
  );
  return VALUE_PATTERNS.some(([, re]) =>
    new RegExp(re.source, re.flags.replace('g', '')).test(text),
  );
}
