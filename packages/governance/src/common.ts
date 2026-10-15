import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';

/**
 * Every governance signature is EIP-712 under one domain per chain, so a vote,
 * delegation, council action or contributor assent can never be replayed as
 * another kind of statement or on another network.
 */
export const governanceDomain = (chainId: number) =>
  ({ name: 'Synq Governance', version: '1', chainId }) as const;

export const BPS = 10_000n;

/** Canonical checksummed form; every address comparison goes through it. */
export const addr = (a: string): Address => getAddress(a);
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Recovers the signer of typed data, or null for anything that is not a
 * 65-byte wallet signature (a chat message, a button tap, an empty string).
 */
export async function recoverSigner(
  typed: TypedDataDefinition,
  signature: unknown,
): Promise<Address | null> {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
  try {
    return getAddress(
      await recoverTypedDataAddress({ ...typed, signature: signature as Hex }),
    );
  } catch {
    return null;
  }
}

/**
 * Freezes the whole tree, including children of nodes the caller had already
 * shallow-frozen, so no governance record keeps a mutable branch.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) deepFreeze(v, seen);
    Object.freeze(value);
  }
  return value;
}

/** Stable JSON (sorted keys, bigint as decimal string) for hashing records. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint'
      ? v.toString()
      : v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : v,
  );
}

export const isSafeTime = (t: number) => Number.isSafeInteger(t) && t >= 0;
