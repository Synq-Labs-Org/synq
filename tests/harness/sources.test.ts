import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chainRegistry } from '@synq/chain-registry';
import { parseCsv } from '../../scripts/csv.mjs';

const REQUIRED_COLUMNS = [
  'id',
  'url',
  'authority',
  'scope',
  'owner',
  'environment',
  'fallback',
  'last_verified',
  'recheck_phase',
];
const BIBLE_33_PLUGINS = [
  'alchemy',
  'aurora',
  'chainlink',
  'cleanverse',
  'dynamic',
  'envio',
  'immersve',
  'kimi',
  'kuru',
  'linq',
  'mera',
  'metamask',
  'nansen',
  'perpl',
  'prava',
  'privy',
  'qwen',
  'x402',
];
const registry = parseCsv(readFileSync('sources/source_registry.csv', 'utf8'));
const ids = new Set(registry.rows.map((r) => r.id));
function packRegistry(): string | null {
  for (let dir = resolve('.'); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(
      dir,
      '..',
      'Synq_Agent_Build_Pack_v1.2',
      'sources',
      'source_registry.csv',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const pack = packRegistry();

describe('source registry and research lock', () => {
  it('source_registry.csv carries the section 73 columns with complete rows', () => {
    expect(registry.header.slice(0, REQUIRED_COLUMNS.length)).toEqual(
      REQUIRED_COLUMNS,
    );
    expect(ids.size).toBe(registry.rows.length);
    for (const row of registry.rows) {
      expect(row.id).toMatch(/^(S\d{3}|SYNQ-\d{3})$/);
      expect(z.url().safeParse(row.url).success, row.id).toBe(true);
      for (const column of REQUIRED_COLUMNS)
        expect(row[column], `${row.id}.${column}`).not.toBe('');
      expect(row.last_verified, row.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it.runIf(pack !== null)(
    'every reference-pack source tagged P00-P05 is registered with the same URL',
    () => {
      const reference = parseCsv(readFileSync(pack!, 'utf8')).rows.filter((r) =>
        /P0[0-5]/.test(r.recheck_phase ?? ''),
      );
      expect(reference.length).toBeGreaterThanOrEqual(39);
      for (const row of reference) {
        const own = registry.rows.find((r) => r.id === row.id);
        expect(own?.url, row.id).toBe(row.url);
      }
    },
  );
  it('chain registry and plugin registry cite only registered sources', () => {
    for (const entry of [
      ...chainRegistry.chains,
      ...Object.values(chainRegistry.assets),
      ...Object.values(chainRegistry.contracts),
      ...Object.values(chainRegistry.nativeAssets),
    ])
      expect(ids.has(entry.source), entry.source).toBe(true);
  });
  // The snapshot is a local research note (git-ignored), so this runs only where it exists.
  it.skipIf(!existsSync('sources/bounty_snapshot.md'))(
    'P00-005 bounty snapshot is timestamped, sourced and names its blocker',
    () => {
      const snapshot = readFileSync('sources/bounty_snapshot.md', 'utf8');
      const captured = /^Captured: (\S+)$/m.exec(snapshot)?.[1];
      expect(captured).toBeDefined();
      expect(z.iso.datetime().safeParse(captured).success).toBe(true);
      expect(Date.parse(captured!)).toBeLessThanOrEqual(Date.now());
      expect(snapshot).toMatch(
        /^Source: https:\/\/monad\.xyz\/developers\/hackathons\/metropolis/m,
      );
      expect(snapshot).toMatch(/^Blocker: \S+/m);
    },
  );
  it('plugin_registry.json classifies every section 33 plugin with a reason', () => {
    const PluginRegistryFile = z.strictObject({
      schemaVersion: z.literal(2),
      verifiedAt: z.iso.datetime(),
      plugins: z.array(
        z.strictObject({
          id: z.string(),
          classification: z.enum(['TESTNET', 'MAINNET', 'SANDBOX', 'BLOCKED']),
          status: z.enum([
            'EXECUTED',
            'NOT_STARTED',
            'CREDENTIAL_BLOCKED',
            'BROWSER_EVIDENCE_BLOCKED',
            'PHASE_BLOCKED',
          ]),
          phase: z.string().regex(/^P\d{2}$/),
          owner: z.string().min(2),
          chains: z.array(z.number().int()),
          roles: z.array(z.string()).min(1),
          sourceIds: z.array(z.string()),
          reason: z.string().min(20),
          fallback: z.string().min(5),
        }),
      ),
    });
    const file = PluginRegistryFile.parse(
      JSON.parse(readFileSync('sources/plugin_registry.json', 'utf8')),
    );
    const pluginIds = file.plugins.map((p) => p.id);
    expect(new Set(pluginIds).size).toBe(pluginIds.length);
    for (const id of BIBLE_33_PLUGINS) expect(pluginIds, id).toContain(id);
    for (const plugin of file.plugins) {
      for (const source of plugin.sourceIds)
        expect(ids.has(source), `${plugin.id}:${source}`).toBe(true);
      if (plugin.classification === 'TESTNET')
        expect(plugin.chains.some((c) => c === 10143 || c === 31337)).toBe(
          true,
        );
      if (plugin.classification === 'MAINNET')
        expect(plugin.chains).toContain(143);
    }
  });
});
