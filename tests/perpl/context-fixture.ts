import { readFileSync } from 'node:fs';
import { chainRegistry } from '@synq/chain-registry';
import { ContextSchema, type PerplContext } from '@synq/plugin-perpl';

// Snapshots of GET /v1/pub/context keep addresses as `$registry:<key>` so the
// only place real addresses live is sources/chain_registry.json.
export function registryAddress(key: string): `0x${string}` {
  const entry =
    chainRegistry.assets[key] ?? chainRegistry.contracts[key] ?? null;
  if (!entry) throw new Error(`unknown registry key ${key}`);
  return entry.address.toLowerCase() as `0x${string}`;
}

export function contextFixture(network: 'testnet' | 'mainnet'): PerplContext {
  const raw = readFileSync(
    `tests/perpl/fixtures/context-${network}.json`,
    'utf8',
  ).replace(/\$registry:([A-Za-z0-9]+)/g, (_m, key: string) =>
    registryAddress(key),
  );
  return ContextSchema.parse(JSON.parse(raw));
}
