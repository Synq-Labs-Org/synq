import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PerplRequestSigner, PerplScope } from '@synq/plugin-perpl';

const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export class PerplKeyError extends Error {
  constructor(
    readonly code:
      | 'KEY_FILE_MISSING'
      | 'KEY_FILE_PERMISSIONS'
      | 'KEY_FILE_INVALID'
      | 'KEY_SCOPE'
      | 'KEY_NETWORK',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PerplKeyError';
  }
}

export function ed25519FromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32)
    throw new PerplKeyError('KEY_FILE_INVALID', 'seed must be 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function rawPublicKey(key: KeyObject): Uint8Array {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

export function ed25519Sign(key: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, key));
}

export function generateEd25519(): {
  key: KeyObject;
  seed: Uint8Array;
  publicKey: Uint8Array;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = new Uint8Array(der.subarray(der.length - 32));
  return { key: privateKey, seed, publicKey: rawPublicKey(privateKey) };
}

// Key file: JSON written by enrollment (or by a human from the Perpl UI),
// mode 0600, never committed and never passed to a model.
export const PerplKeyFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  apiKey: z.string().min(8),
  privateKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
  publicKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  scope: z.enum(['read', 'trade']),
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  label: z.string().min(1),
  origin: z.string().optional(),
  createdAt: z.string().optional(),
});
export type PerplKeyFile = z.output<typeof PerplKeyFileSchema>;

export const PERPL_KEY_ENV: Readonly<Record<PerplScope, string>> =
  Object.freeze({
    read: 'SYNQ_PERPL_READ_KEY_FILE',
    trade: 'SYNQ_PERPL_TRADE_KEY_FILE',
  });

export function defaultKeyPath(
  scope: PerplScope,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env[PERPL_KEY_ENV[scope]] ??
    env.SYNQ_PERPL_API_KEY_FILE ??
    join(homedir(), '.synq', 'perpl', `${scope}.key`)
  );
}

function assertPrivate(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new PerplKeyError('KEY_FILE_MISSING', path);
  }
  if ((mode & 0o077) !== 0)
    throw new PerplKeyError('KEY_FILE_PERMISSIONS', `${path} must be mode 600`);
}

export type LoadedPerplKey = Readonly<{
  signer: PerplRequestSigner;
  scope: PerplScope;
  chainId: number;
  address: `0x${string}`;
  label: string;
  publicKey: `0x${string}`;
}>;

export function loadPerplKey(
  path: string,
  expected: { scope: PerplScope; chainId: number },
): LoadedPerplKey {
  assertPrivate(path);
  let parsed: PerplKeyFile;
  try {
    parsed = PerplKeyFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new PerplKeyError(
      'KEY_FILE_INVALID',
      error instanceof Error ? error.message.slice(0, 120) : path,
    );
  }
  if (parsed.scope !== expected.scope)
    throw new PerplKeyError('KEY_SCOPE', `${path} holds a ${parsed.scope} key`);
  if (parsed.chainId !== expected.chainId)
    throw new PerplKeyError(
      'KEY_NETWORK',
      `${path} is for chain ${parsed.chainId}`,
    );
  const key = ed25519FromSeed(
    Buffer.from(parsed.privateKey.replace(/^0x/, ''), 'hex'),
  );
  const publicKey =
    `0x${Buffer.from(rawPublicKey(key)).toString('hex')}` as const;
  if (parsed.publicKey && parsed.publicKey.toLowerCase() !== publicKey)
    throw new PerplKeyError(
      'KEY_FILE_INVALID',
      'public key does not match private key',
    );
  const apiKey = parsed.apiKey;
  const scope = parsed.scope;
  const signer: PerplRequestSigner = Object.freeze({
    apiKey,
    scope,
    sign: async (message: Uint8Array) => ed25519Sign(key, message),
  });
  return Object.freeze({
    signer,
    scope,
    chainId: parsed.chainId,
    address: parsed.address.toLowerCase() as `0x${string}`,
    label: parsed.label,
    publicKey,
  });
}

export function writePerplKey(path: string, file: PerplKeyFile): void {
  const content = JSON.stringify(PerplKeyFileSchema.parse(file), null, 2);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${content}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

export function keyFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
