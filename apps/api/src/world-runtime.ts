import type { PublicClient } from 'viem';
import {
  PluginRegistry,
  type SynqPlugin,
  type PluginContext,
} from '@synq/plugin-sdk';
import {
  KuruFlowClient,
  KuruClobAdapter,
  kuruFlowPlugin,
  kuruSkillPlugin,
  kuruClobPlugin,
} from '@synq/plugin-kuru';
import { chainlinkCrePlugin } from '@synq/plugin-chainlink-cre';
import type { NetworkProfile } from '@synq/schemas';
import { monadTestnetProfile } from '@synq/chain-registry';
import { erc20TransferPlugin } from './transfer-plugin.js';

/** Uses the same bounded transfer adapter as Send; health is observed, never inferred from installation. */
export function productionWorldPlugins(options: {
  client: PublicClient;
  network: NetworkProfile;
  executionModule: `0x${string}`;
  sendEnabled: boolean;
  now: () => number;
  refreshIntervalSeconds?: number;
  healthTimeoutMs?: number;
}) {
  const registry = new PluginRegistry();
  const deps = {
    clientFor: () => options.client,
    clob: new KuruClobAdapter(() => options.client),
    flow: new KuruFlowClient({
      fetch: (url, init) => fetch(url, init),
      clock: { now: Date.now },
    }),
    probeAddress: options.executionModule,
  };
  const plugins: SynqPlugin[] = [
    kuruFlowPlugin(deps),
    kuruSkillPlugin(deps),
    kuruClobPlugin(deps),
    chainlinkCrePlugin(() => options.client),
  ];
  if (
    options.sendEnabled &&
    options.network.profile === 'sandbox/monad-testnet'
  )
    plugins.push(
      erc20TransferPlugin({
        id: 'ausd-transfer',
        chainId: monadTestnetProfile.network.chainId,
        environment: 'sandbox/monad-testnet',
        client: options.client,
        calldataFor: () => undefined,
      }),
    );
  for (const plugin of plugins) {
    registry.register({
      ...plugin,
      health: async (context: PluginContext) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            plugin.health(context),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('PLUGIN_HEALTH_TIMEOUT')),
                options.healthTimeoutMs ?? 5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    });
  }
  let refreshedAt: number | null = null;
  let pending: Promise<void> | null = null;
  const refresh = async () => {
    if (pending) return pending;
    const now = options.now();
    if (
      refreshedAt !== null &&
      now >= refreshedAt &&
      now - refreshedAt < (options.refreshIntervalSeconds ?? 15)
    )
      return;
    pending = (async () => {
      for (const manifest of registry.manifests()) {
        if (
          !manifest.chains.includes(options.network.chainId) ||
          !manifest.environments.includes(options.network.profile)
        )
          continue;
        await registry.refreshHealth(manifest.id, {
          network: options.network,
          now: options.now(),
        });
      }
      refreshedAt = options.now();
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  };
  return { registry, refresh };
}
