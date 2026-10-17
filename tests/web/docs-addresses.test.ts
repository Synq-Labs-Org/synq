import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

it('the contracts page lists exactly the Arc testnet addresses in the chain registry', () => {
  const registry = JSON.parse(read('sources/arc_registry.json')) as {
    contracts: { chain: string; kind: string; address: string }[];
  };
  const byKind = new Map(
    registry.contracts
      .filter((d) => d.chain === 'arc-testnet')
      .map((d) => [d.kind, d.address]),
  );
  const page = read('apps/web/content/docs/contracts/00-index.md');
  const rows = [
    ...page.matchAll(/\|\s*`([A-Z0-9_]+)`\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|/g),
  ];
  expect(rows.length).toBeGreaterThan(0);
  for (const [, kind, address] of rows)
    expect(address, kind).toBe(byKind.get(kind!));
  // Every address on the page is in a checked row.
  expect(page.match(/0x[0-9a-fA-F]{40}/g)?.length).toBe(rows.length);
});
