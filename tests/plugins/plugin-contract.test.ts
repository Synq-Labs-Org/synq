import { describe, expect, it } from 'vitest';
import {
  MAX_PLUGIN_GRANT_TTL_SECONDS,
  MUTATING_CAPABILITIES,
  NON_DELEGABLE_CAPABILITIES,
  PluginError,
  PluginManifestSchema,
  ValidationError,
  networkProfileForChain,
  type PluginManifestInput,
} from '@synq/domain';
import { PluginRegistry, type SynqPlugin } from '@synq/plugin-sdk';

const testnet = networkProfileForChain(10143);
const mainnet = networkProfileForChain(143);
const readOnly: PluginManifestInput = {
  id: 'reader',
  version: '1.0.0',
  capabilities: ['READ_MARKET', 'QUOTE'],
  chains: [10143],
  riskClass: 'READ_ONLY',
  requiresSimulation: false,
  maxGrantTtlSeconds: 60,
  dependencies: { viem: '2.57.4' },
  sourceDocs: ['https://docs.monad.xyz/'],
  sourceIds: ['S003'],
  health: { maxStalenessSeconds: 30, checks: ['RPC'] },
};
const financial: PluginManifestInput = {
  ...readOnly,
  id: 'mutator',
  capabilities: ['QUOTE', 'SPOT_TRADE'],
  riskClass: 'FINANCIAL_EXECUTION',
  requiresSimulation: true,
};
function plugin(
  manifest: PluginManifestInput,
  health: SynqPlugin['health'] = async (ctx) => ({
    available: true,
    checkedAt: ctx.now,
  }),
): SynqPlugin {
  return { manifest, health };
}
const unsupported = async () => {
  throw new Error('not exercised');
};
const fullMutator = (manifest: PluginManifestInput): SynqPlugin => ({
  ...plugin(manifest),
  prepare: unsupported,
  simulate: unsupported,
  execute: unsupported,
  reconcile: unsupported,
});

describe('plugin contract', () => {
  it('PLG-005 manifests reject unknown fields, non-delegable powers and unbounded TTLs', () => {
    expect(PluginManifestSchema.safeParse(readOnly).success).toBe(true);
    for (const patch of [
      { secret: 'x' },
      { capabilities: ['SIGN'] },
      { capabilities: ['QUOTE', 'QUOTE'] },
      { maxGrantTtlSeconds: MAX_PLUGIN_GRANT_TTL_SECONDS + 1 },
      { maxGrantTtlSeconds: 0 },
      { version: 'latest' },
      { dependencies: { viem: '^2.0.0' } },
      { sourceDocs: ['http://insecure.example'] },
      { environments: ['proof/monad-mainnet'] },
    ])
      expect(
        PluginManifestSchema.safeParse({ ...readOnly, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    for (const capability of NON_DELEGABLE_CAPABILITIES)
      expect(
        PluginManifestSchema.safeParse({
          ...financial,
          capabilities: ['SPOT_TRADE', capability],
        }).success,
      ).toBe(false);
  });
  it('READ_ONLY risk class cannot carry any mutating capability', () => {
    for (const capability of MUTATING_CAPABILITIES)
      expect(
        PluginManifestSchema.safeParse({
          ...readOnly,
          capabilities: ['QUOTE', capability],
        }).success,
        capability,
      ).toBe(false);
    expect(() =>
      new PluginRegistry().register(
        plugin({ ...readOnly, capabilities: ['TRANSFER'] }),
      ),
    ).toThrow(ValidationError);
    expect(
      PluginManifestSchema.safeParse({
        ...financial,
        capabilities: ['QUOTE'],
      }).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse({
        ...financial,
        requiresSimulation: false,
      }).success,
    ).toBe(false);
  });
  it('PLG-008 financial plugins without the full mutation lifecycle are rejected', () => {
    const registry = new PluginRegistry();
    expect(() => registry.register(plugin(financial))).toThrow(
      'PLUGIN_MUTATOR_INCOMPLETE',
    );
    const { reconcile: _omit, ...withoutReconcile } = fullMutator(financial);
    expect(() => registry.register(withoutReconcile)).toThrow(PluginError);
    expect(registry.register(fullMutator(financial)).id).toBe('mutator');
  });
  it('plugin conflicts are rejected and registered manifests are immutable', () => {
    const registry = new PluginRegistry();
    const manifest = registry.register(plugin(readOnly));
    expect(() => registry.register(plugin(readOnly))).toThrow(
      'PLUGIN_CONFLICT',
    );
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.capabilities)).toBe(true);
    expect(() => {
      (manifest.capabilities as string[]).push('SPOT_TRADE');
    }).toThrow();
  });
  it('PLG-001 unhealthy, unchecked or stale plugins are unavailable', async () => {
    let available = true;
    const registry = new PluginRegistry();
    registry.register(
      plugin(readOnly, async (ctx) => ({ available, checkedAt: ctx.now })),
    );
    expect(() => registry.get('reader', testnet, 1000)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
    expect(
      await registry.refreshHealth('reader', { network: testnet, now: 1000 }),
    ).toBe(true);
    expect(registry.get('reader', testnet, 1010).manifest.id).toBe('reader');
    expect(() => registry.get('reader', testnet, 1031)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
    expect(() => registry.get('reader', testnet, 999)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
    available = false;
    await registry.refreshHealth('reader', { network: testnet, now: 1040 });
    expect(() => registry.get('reader', testnet, 1040)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
  });
  it('PLG-007 a throwing or lying health check fails closed', async () => {
    const registry = new PluginRegistry();
    registry.register(
      plugin(readOnly, async () => {
        throw new Error('provider down');
      }),
    );
    expect(
      await registry.refreshHealth('reader', { network: testnet, now: 5 }),
    ).toBe(false);
    expect(() => registry.get('reader', testnet, 5)).toThrow(
      'PLUGIN_UNHEALTHY',
    );
    const future = new PluginRegistry();
    future.register(
      plugin(readOnly, async () => ({ available: true, checkedAt: 10_000 })),
    );
    expect(
      await future.refreshHealth('reader', { network: testnet, now: 5 }),
    ).toBe(false);
    const malformed = new PluginRegistry();
    malformed.register(
      plugin(readOnly, async () => ({
        available: true,
        checkedAt: 5,
        token: 'leak',
      })),
    );
    expect(
      await malformed.refreshHealth('reader', { network: testnet, now: 5 }),
    ).toBe(false);
  });
  it('PLG-006 plugins are unavailable outside declared chains and environments', async () => {
    const registry = new PluginRegistry();
    registry.register(plugin(readOnly));
    await registry.refreshHealth('reader', { network: testnet, now: 1 });
    expect(() => registry.get('reader', mainnet, 1)).toThrow(
      'PLUGIN_UNAVAILABLE',
    );
    await expect(
      registry.refreshHealth('reader', { network: mainnet, now: 1 }),
    ).rejects.toThrow('PLUGIN_UNAVAILABLE');
    expect(() => registry.get('missing', testnet, 1)).toThrow(
      'PLUGIN_UNAVAILABLE',
    );
  });
});
