import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@synq/plugin-sdk';
import { PluginManifestSchema, networkProfileForChain } from '@synq/schemas';
import {
  CapabilityGraph,
  capabilityFacts,
  credentialPresence,
  mainnetBroadcastAllowed,
} from '@synq/world-model';

const mainnet = networkProfileForChain(143);
const testnet = networkProfileForChain(10143);
const manifestFor = (id: string) =>
  JSON.parse(readFileSync(`sources/plugin-manifests/${id}.json`, 'utf8'));
const NOW = 1_000;
function installed(ids: string[], healthy = true) {
  const registry = new PluginRegistry();
  for (const id of ids) {
    const manifest = manifestFor(id);
    const stub = async (): Promise<never> => {
      throw new Error('plugin behaviour arrives in its own phase');
    };
    registry.register({
      manifest,
      health: async () => ({
        available: healthy,
        checkedAt: NOW,
        ...(healthy ? {} : { reason: 'probe failed' }),
      }),
      ...(manifest.riskClass === 'FINANCIAL_EXECUTION'
        ? { prepare: stub, simulate: stub, execute: stub, reconcile: stub }
        : {}),
    });
  }
  return registry;
}
async function graph(
  network = mainnet,
  ids: string[] = [],
  options: { healthy?: boolean; broadcast?: boolean; keys?: boolean } = {},
) {
  const plugins = installed(ids, options.healthy ?? true);
  for (const id of ids)
    if (
      PluginManifestSchema.parse(manifestFor(id)).chains.includes(
        network.chainId,
      )
    )
      await plugins.refreshHealth(id, { network, now: NOW });
  return CapabilityGraph.build({
    network,
    now: NOW,
    plugins,
    modelProviders: {
      QWEN: { installed: true, credentialsPresent: options.keys ?? false },
      KIMI: { installed: true, credentialsPresent: options.keys ?? false },
    },
    mainnetBroadcastAllowed: options.broadcast ?? false,
  });
}

describe('runtime Capability Graph', () => {
  it('plugin manifests parse and every fact-backed plugin has a registry entry', () => {
    const registry = JSON.parse(
      readFileSync('sources/plugin_registry.json', 'utf8'),
    );
    const ids = new Set(registry.plugins.map((p: { id: string }) => p.id));
    for (const file of readdirSync('sources/plugin-manifests')) {
      const manifest = PluginManifestSchema.parse(
        JSON.parse(readFileSync(`sources/plugin-manifests/${file}`, 'utf8')),
      );
      expect(ids.has(manifest.id), manifest.id).toBe(true);
    }
    for (const p of capabilityFacts.providers)
      if (p.pluginId) expect(ids.has(p.pluginId), p.pluginId).toBe(true);
    expect(
      registry.plugins.filter((p: { id: string }) =>
        ['qwen', 'kimi'].includes(p.id),
      ),
    ).toEqual([
      expect.objectContaining({ status: 'CREDENTIAL_BLOCKED' }),
      expect.objectContaining({ status: 'CREDENTIAL_BLOCKED' }),
    ]);
  });

  it('Qwen and Kimi surface BLOCKED_NO_CREDENTIALS until keys exist', async () => {
    const g = await graph();
    expect(g.node('QWEN')?.status).toBe('BLOCKED_NO_CREDENTIALS');
    expect(g.node('KIMI')?.status).toBe('BLOCKED_NO_CREDENTIALS');
    expect(
      g.canPerform('STRUCTURED_REASONING', 'proof/monad-mainnet', 'QWEN'),
    ).toMatchObject({
      availability: 'UNHEALTHY',
      reason: expect.stringMatching(/^BLOCKED_NO_CREDENTIALS/),
    });
    const ready = await graph(mainnet, [], { keys: true });
    expect(
      ready.canPerform('WEB_RESEARCH', 'proof/monad-mainnet', 'KIMI')
        .availability,
    ).toBe('AVAILABLE');
  });

  it('credential presence reads only presence, never values', () => {
    const presence = credentialPresence(capabilityFacts, {
      DASHSCOPE_API_KEY: 'sk-not-a-real-key',
      KIMI_API_KEY: '   ',
    });
    expect(presence).toEqual({ QWEN: true, KIMI: false });
    expect(JSON.stringify(presence)).not.toContain('sk-');
    expect(
      mainnetBroadcastAllowed({ SYNQ_ALLOW_MAINNET_BROADCAST: 'false' }),
    ).toBe(false);
    expect(mainnetBroadcastAllowed({})).toBe(false);
  });

  it('Kuru Flow: mainnet quote/prepare only, broadcast disabled, no testnet', async () => {
    const off = await graph(mainnet);
    expect(
      off.canPerform('QUOTE', 'proof/monad-mainnet', 'KURU_FLOW').availability,
    ).toBe('NOT_INSTALLED');
    const g = await graph(mainnet, ['kuru-flow']);
    expect(
      g.canPerform('QUOTE', 'proof/monad-mainnet', 'KURU_FLOW').availability,
    ).toBe('AVAILABLE');
    expect(
      g.canPerform('PREPARE', 'proof/monad-mainnet', 'KURU_FLOW').availability,
    ).toBe('AVAILABLE');
    expect(
      g.canPerform('BROADCAST', 'proof/monad-mainnet', 'KURU_FLOW'),
    ).toMatchObject({
      availability: 'READ_ONLY',
      reason: 'SYNQ_ALLOW_MAINNET_BROADCAST=false in this run',
    });
    expect(
      g.canPerform('TRADE', 'proof/monad-mainnet', 'KURU_FLOW').availability,
    ).toBe('READ_ONLY');
    expect(
      g.canPerform('QUOTE', 'sandbox/monad-testnet', 'KURU_FLOW').availability,
    ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    const allowed = await graph(mainnet, ['kuru-flow'], { broadcast: true });
    expect(
      allowed.canPerform('TRADE', 'proof/monad-mainnet', 'KURU_FLOW')
        .availability,
    ).toBe('REQUIRES_HUMAN');
  });

  it('Kuru skill is mainnet USDC-settled prepare only', async () => {
    const g = await graph(mainnet, ['kuru-skill']);
    expect(
      g.canPerform('PREPARE', 'proof/monad-mainnet', 'KURU_SKILL').availability,
    ).toBe('AVAILABLE');
    expect(g.node('KURU_SKILL')?.facts[0]?.note).toMatch(/USDC-settled/);
    expect(
      g.canPerform('QUOTE', 'proof/monad-mainnet', 'KURU_SKILL').availability,
    ).toBe('NOT_INSTALLED');
  });

  it('Perpl reads, trades and cancels on testnet and mainnet within the run limits', async () => {
    const t = await graph(testnet, ['perpl']);
    expect(
      t.canPerform('READ', 'sandbox/monad-testnet', 'PERPL').availability,
    ).toBe('AVAILABLE');
    expect(
      t.canPerform('TRADE', 'sandbox/monad-testnet', 'PERPL').availability,
    ).toBe('REQUIRES_HUMAN');
    expect(
      t.canPerform('CANCEL', 'sandbox/monad-testnet', 'PERPL').availability,
    ).toBe('AVAILABLE');
    const m = await graph(mainnet, ['perpl']);
    expect(
      m.canPerform('TRADE', 'proof/monad-mainnet', 'PERPL').availability,
    ).toBe('READ_ONLY');
    const sick = await graph(testnet, ['perpl'], { healthy: false });
    expect(
      sick.canPerform('READ', 'sandbox/monad-testnet', 'PERPL').availability,
    ).toBe('UNHEALTHY');
  });

  it('Aurora Intents has no testnet route and CRE separates simulation from production writes', async () => {
    const t = await graph(testnet, ['chainlink-cre', 'aurora-intents']);
    expect(
      t.canPerform('QUOTE', 'sandbox/monad-testnet', 'AURORA_INTENTS')
        .availability,
    ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    expect(
      t.canPerform('SIMULATE', 'sandbox/monad-testnet', 'CHAINLINK_CRE')
        .availability,
    ).toBe('AVAILABLE');
    expect(
      t.canPerform('PRODUCTION_WRITE', 'sandbox/monad-testnet', 'CHAINLINK_CRE')
        .availability,
    ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    const m = await graph(mainnet, ['chainlink-cre', 'aurora-intents']);
    expect(
      m.canPerform('SIMULATE', 'proof/monad-mainnet', 'CHAINLINK_CRE')
        .availability,
    ).toBe('AVAILABLE');
    expect(
      m.canPerform('PRODUCTION_WRITE', 'proof/monad-mainnet', 'CHAINLINK_CRE')
        .availability,
    ).toBe('READ_ONLY');
    expect(
      m.canPerform('QUOTE', 'proof/monad-mainnet', 'AURORA_INTENTS')
        .availability,
    ).toBe('AVAILABLE');
    expect(
      m.canPerform('FUND', 'proof/monad-mainnet', 'AURORA_INTENTS')
        .availability,
    ).toBe('READ_ONLY');
  });

  it('canPerform without a provider picks the best available route and round-trips through JSON', async () => {
    const g = await graph(testnet, ['perpl', 'kuru-clob']);
    expect(g.canPerform('READ', 'sandbox/monad-testnet').availability).toBe(
      'AVAILABLE',
    );
    expect(g.canPerform('HEDGE', 'sandbox/monad-testnet')).toMatchObject({
      providerId: 'NONE',
      availability: 'NOT_INSTALLED',
    });
    const copy = CapabilityGraph.fromView(
      JSON.parse(JSON.stringify(g.toJSON())),
    );
    expect(copy.canPerform('TRADE', 'sandbox/monad-testnet', 'PERPL')).toEqual(
      g.canPerform('TRADE', 'sandbox/monad-testnet', 'PERPL'),
    );
  });
});
