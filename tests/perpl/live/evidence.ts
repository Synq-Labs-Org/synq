import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { labelEvidenceHex } from '@synq/funding';

export const LIVE = process.env.SYNQ_P10_LIVE === '1';
export const EVIDENCE_DIR = 'reports/evidence/perpl';

const SECRET_KEYS =
  /^(api_?key|private_?key|secret|signature|pop_signature|token|mac)$/i;

// Evidence never carries secrets. Public keys are recorded as SHA-256
// fingerprints and venue `txid` fields as 0x-prefixed `txHash`, so the
// repository secret scanner can tell them from key material.
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]): [string, unknown] => {
        if (SECRET_KEYS.test(k) && typeof v === 'string')
          return [k, '[redacted]'];
        if (/public_?key$/i.test(k) && typeof v === 'string')
          return [
            `${k}Hash`,
            `0x${createHash('sha256')
              .update(Buffer.from(v.replace(/^0x/, ''), 'hex'))
              .digest('hex')}`,
          ];
        if (k === 'txid' && typeof v === 'string') return ['txHash', `0x${v}`];
        return [k, redact(v)];
      }),
    );
  return value;
}

export function recordEvidence(
  name: string,
  mode: 'REAL_TESTNET' | 'MAINNET_READ_ONLY',
  body: Record<string, unknown>,
): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.json`);
  const doc = {
    executionMode: mode,
    recordedAt: new Date().toISOString(),
    ...(labelEvidenceHex(redact(body)) as Record<string, unknown>),
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}

export function readEvidence(name: string): Record<string, unknown> | null {
  const path = join(EVIDENCE_DIR, `${name}.json`);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
}
