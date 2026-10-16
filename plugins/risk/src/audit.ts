import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
    actor: cleanText(input.actor).slice(0, 80),
    kind: cleanText(input.kind).slice(0, 80),
    payload: redact(input.payload).value,
    citations: (input.citations ?? []).map(
      (c) => redact(c).value as unknown as Citation,
    ),
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

/** Key names are compared without case, `-` or `_` ("x-api-key" = "xapikey"). */
const SENSITIVE_KEY =
  /^(passport.*|mrz.*|documentnumber|nationalid|priv(ate)?key.*|.*secret.*|mnemonic|seedphrase|recoveryphrase|password|passphrase|.*apikey|accesstoken|refreshtoken|bottoken|token|auth|authorization|bearer|credentials?|cvv|cvc|cardnumber|pan|mac|grantkey|key|sk|pk)$/;
const normKey = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');
const ADDRESS_ONLY = /^0x[0-9a-fA-F]{40}$/;

const VALUE_PATTERNS: readonly [string, RegExp][] = [
  [
    'PEM_KEY',
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
  [
    'SECRET',
    /\b(priv(?:ate)?[_ -]?key|secret[_ -]?key|seed phrase|mnemonic|entity[_ -]?secret|api[_ -]?key|password|aws[_ -]?secret[_ -]?access[_ -]?key)\b\s*(?:is|:|=)?\s*["']?(0x[0-9a-fA-F]{64}|[A-Za-z0-9_\-./+=]{12,}(\s+[a-z]{3,8}){0,23})/gi,
  ],
  ['LABELLED_KEY', /\bkey\b\s*(?:is|:|=)?\s*0x[0-9a-fA-F]{64}\b/gi],
  [
    'RECOVERY_WORDS',
    /\b(seed phrase|mnemonic|recovery phrase)\b\s*(is|:|=)?\s*["']?[a-z]{3,8}(\s+[a-z]{3,8}){11,23}/gi,
  ],
  ['API_KEY', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  [
    'API_KEY',
    /\b(?:sk|pk|rk|ck)_(?:live|test|staging|production|prod)_[A-Za-z0-9_-]{8,}\b/g,
  ],
  ['API_KEY', /\bduffel_(?:test|live)_[A-Za-z0-9_-]{8,}\b/g],
  ['API_KEY', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['API_KEY', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['BOT_TOKEN', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ['PASSPORT', /\bP<[A-Z]{3}[A-Z<]{5,}[A-Z0-9<]*/g],
  // MRZ line 2: number, check digit, nationality, birth date, sex, expiry.
  ['PASSPORT', /\b[A-Z0-9<]{9}\d[A-Z]{3}\d{6}\d[MF<]\d{6}[A-Z0-9<]*/g],
  [
    'PASSPORT',
    /\bpassport\s*(?:no\.?|number|num|#|id)?\s*(?:is|:|=|-)?\s*[A-Z]{0,3}\s?\d{6,9}\b/gi,
  ],
  // Grouped card numbers; ungrouped runs only when Luhn-valid (see below).
  ['CARD', /\b\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}\b/g],
];

/** Luhn check, so long base-unit / wei amounts are not mistaken for cards. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
/** Card-like runs: 13-19 digits starting 2-6, Luhn-valid, not inside a hex string. */
const CARD_RUN = /(?<![0-9a-fA-Fx])[2-6]\d{12,18}(?![0-9a-fA-F])/g;

/** NUL and lone surrogates cannot be stored (jsonb) or hashed portably. */
export function cleanText(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '�',
    );
}

export type Redaction = Readonly<{ value: JsonValue; redactions: string[] }>;

function redactText(raw: string, hits: string[]): string {
  let out = cleanText(raw);
  for (const [label, re] of VALUE_PATTERNS)
    out = out.replace(re, () => {
      hits.push(label);
      return `[REDACTED:${label}]`;
    });
  out = out.replace(CARD_RUN, (m) => {
    if (!luhn(m)) return m;
    hits.push('CARD');
    return '[REDACTED:CARD]';
  });
  return out;
}

/**
 * Removes passports, credentials and keys from any value: sensitive keys are
 * replaced whole (an address value stays: addresses are public), free text is
 * scanned for key, token, passport and card patterns. Addresses and
 * transaction hashes stay (they are public evidence). Bigints become decimal
 * strings; NUL bytes and lone surrogates are removed.
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
      for (const [rawKey, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined || typeof x === 'function') continue;
        const k = cleanText(rawKey);
        if (
          SENSITIVE_KEY.test(normKey(k)) &&
          !(typeof x === 'string' && ADDRESS_ONLY.test(x))
        ) {
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

/** True when a known secret pattern or a sensitive key survives in the value. */
export function containsSecrets(value: unknown): boolean {
  let keyHit = false;
  const text = JSON.stringify(value, (k, v: unknown) => {
    if (
      k &&
      SENSITIVE_KEY.test(normKey(k)) &&
      v !== '[REDACTED]' &&
      !(typeof v === 'string' && ADDRESS_ONLY.test(v)) &&
      (typeof v === 'string' || typeof v === 'number')
    )
      keyHit = true;
    return typeof v === 'bigint' ? String(v) : v;
  });
  if (keyHit) return true;
  if (
    VALUE_PATTERNS.some(([, re]) =>
      new RegExp(re.source, re.flags.replace('g', '')).test(text),
    )
  )
    return true;
  return [...text.matchAll(CARD_RUN)].some((m) => luhn(m[0]));
}

// ---------------------------------------------------------------- head anchor

/**
 * A head anchor commits to (workspace, seq, head hash) with a MAC under a key
 * the Kernel holds (never the audit store). Verifying a trail against its
 * independently retained latest anchor detects tail truncation and a wholesale rehash.
 * A checkpoint stored in the same database cannot detect rollback of both trail and checkpoint.
 */
export type AuditAnchor = Readonly<{
  workspaceId: string;
  seq: number;
  head: `0x${string}`;
  anchoredAt: number;
  mac: `0x${string}`;
}>;

const anchorBody = (a: Omit<AuditAnchor, 'mac'>) =>
  `synq-audit-anchor/1:${a.workspaceId}:${a.seq}:${a.head}:${a.anchoredAt}`;

export function anchorAudit(
  key: Uint8Array,
  record: AuditRecord,
  anchoredAt: number,
): AuditAnchor {
  const body = {
    workspaceId: record.workspaceId,
    seq: record.seq,
    head: record.hash,
    anchoredAt,
  };
  return {
    ...body,
    mac: `0x${createHmac('sha256', key).update(anchorBody(body)).digest('hex')}`,
  };
}

export type AnchoredCheck =
  | ChainCheck
  | {
      ok: false;
      seq: number;
      reason: 'TRUNCATED' | 'ANCHOR_MISMATCH' | 'ANCHOR_FORGED';
    };

/** Chain check plus the anchor: the anchored record must still be there, unchanged. */
export function verifyAnchoredChain(
  records: readonly AuditRecord[],
  anchor: AuditAnchor | null,
  key: Uint8Array | null,
): AnchoredCheck {
  const chain = verifyAuditChain(records);
  if (!chain.ok || !anchor) return chain;
  if (key) {
    const { mac, ...body } = anchor;
    const expected = `0x${createHmac('sha256', key).update(anchorBody(body)).digest('hex')}`;
    const a = Buffer.from(mac.slice(2), 'hex');
    const b = Buffer.from(expected.slice(2), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return { ok: false, seq: anchor.seq, reason: 'ANCHOR_FORGED' };
  }
  const at = records.find((r) => r.seq === anchor.seq);
  if (!at) return { ok: false, seq: anchor.seq, reason: 'TRUNCATED' };
  if (at.hash !== anchor.head)
    return { ok: false, seq: anchor.seq, reason: 'ANCHOR_MISMATCH' };
  return chain;
}
