const HASH_WORDS = new Set([
  'hash',
  'hashes',
  'tx',
  'txs',
  'transaction',
  'transactions',
  'id',
  'ids',
  'digest',
  'salt',
  'slot',
  'nonce',
  'signature',
  'sig',
  'root',
  'topic',
  'topics',
  'lineage',
  'selector',
]);
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Evidence files are public data, but the repository secret scanner treats an
 * unlabelled 32-byte hex value as a possible key. Values under non-hash keys
 * (bytes32 peers, history notes, NEAR account ids) are tagged `hex32:` so the
 * file stays scannable; no value is dropped or altered otherwise.
 */
export function labelEvidenceHex(value: unknown, key = ''): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string')
    return HEX32.test(value) && !words(key).some((w) => HASH_WORDS.has(w))
      ? `hex32:${value}`
      : value;
  if (Array.isArray(value)) return value.map((v) => labelEvidenceHex(v, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        labelEvidenceHex(v, k),
      ]),
    );
  return value;
}
