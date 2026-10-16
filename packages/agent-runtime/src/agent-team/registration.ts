import { createHash } from 'node:crypto';
import { TEAM_MANIFESTS, type TeamRole } from './manifests.js';

/** Stable manifest commitment; bigint limits are decimal strings in public metadata. */
export function canonicalManifest(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalManifest).join(',')}]`;
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalManifest((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  throw new Error('manifest contains unsupported data');
}
export const capabilityManifestHash = (value: unknown) =>
  `0x${createHash('sha256').update(canonicalManifest(value)).digest('hex')}` as const;

export function agentRegistration(role: TeamRole) {
  const manifest = TEAM_MANIFESTS[role];
  const manifestHash = capabilityManifestHash(manifest);
  const card = Object.freeze({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: `Synq ${manifest.title}`,
    description:
      'Testnet capability identity. All financial execution requires independent Kernel authority.',
    role,
    active: true,
    services: [],
    manifestHash,
    // This field commits to the capability manifest, not the metadata envelope.
    cardHash: manifestHash,
    authority: 'NONE' as const,
    canSign: false as const,
  });
  return Object.freeze({
    manifest,
    manifestHash,
    card,
    compactUri: `data:application/json,${JSON.stringify({ role, sha256: Buffer.from(manifestHash.slice(2), 'hex').toString('base64url') })}`,
    uri: `data:application/json;base64,${Buffer.from(canonicalManifest(card)).toString('base64')}`,
  });
}
