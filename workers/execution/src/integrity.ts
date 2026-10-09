import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { ExecutionError } from '@synq/domain';

export const LOCAL_NETWORK = 'local/anvil';
export const JOURNAL_KEY_ENV = 'SYNQ_JOURNAL_KEY_FILE';
export const KERNEL_AUDIT_KEY_ENV = 'SYNQ_KERNEL_AUDIT_KEY_FILE';
export const MIN_INTEGRITY_KEY_BYTES = 32;

export type IntegrityKey = Readonly<{
  bytes: Uint8Array;
  path: string;
  source: 'FILE' | 'LOCAL_GENERATED';
}>;

const invalid = (detail: string): never => {
  throw new ExecutionError('INTEGRITY_KEY_INVALID', detail);
};
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : resolve(canonical(parent), absolute.slice(parent.length + 1));
}
function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function readIntegrityKey(
  path: string,
  protectedDirectories: readonly string[],
): Uint8Array {
  if (!isAbsolute(path)) invalid('key path must be absolute');
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return invalid('key file missing');
  }
  if (!stat.isFile()) invalid('key path is not a regular file');
  if ((stat.mode & 0o077) !== 0)
    invalid('key file is group or world accessible');
  const real = realpathSync(path);
  for (const directory of protectedDirectories)
    if (inside(real, canonical(directory)))
      invalid('key file lives inside a protected data directory');
  const text = readFileSync(real, 'utf8').trim();
  const match = /^(?:0x)?([0-9a-fA-F]+)$/.exec(text);
  if (!match || match[1]!.length % 2 !== 0) return invalid('key must be hex');
  const bytes = Uint8Array.from(Buffer.from(match[1]!, 'hex'));
  if (bytes.length < MIN_INTEGRITY_KEY_BYTES)
    invalid('key shorter than 32 bytes');
  return bytes;
}

function provisionLocalKey(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return;
    throw error;
  }
  try {
    writeFileSync(
      fd,
      `${randomBytes(MIN_INTEGRITY_KEY_BYTES).toString('hex')}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function loadIntegrityKey(options: {
  envVar: string;
  protectedDirectories: readonly string[];
  localFallbackPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): IntegrityKey {
  const env = options.env ?? process.env;
  const network = env.SYNQ_NETWORK ?? LOCAL_NETWORK;
  const configured = env[options.envVar];
  if (configured)
    return {
      bytes: readIntegrityKey(configured, options.protectedDirectories),
      path: configured,
      source: 'FILE',
    };
  if (network !== LOCAL_NETWORK || !options.localFallbackPath)
    throw new ExecutionError('INTEGRITY_KEY_REQUIRED', options.envVar);
  const path = resolve(options.localFallbackPath);
  provisionLocalKey(path);
  return {
    bytes: readIntegrityKey(path, options.protectedDirectories),
    path,
    source: 'LOCAL_GENERATED',
  };
}

export function loadJournalKey(
  journalDirectory: string,
  env?: Readonly<Record<string, string | undefined>>,
): IntegrityKey {
  return loadIntegrityKey({
    envVar: JOURNAL_KEY_ENV,
    protectedDirectories: [journalDirectory],
    localFallbackPath: `${resolve(journalDirectory)}.integrity-key`,
    ...(env ? { env } : {}),
  });
}

export function loadKernelAuditKey(
  dataDirectories: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): IntegrityKey {
  return loadIntegrityKey({
    envVar: KERNEL_AUDIT_KEY_ENV,
    protectedDirectories: dataDirectories,
    ...(env ? { env } : {}),
  });
}
