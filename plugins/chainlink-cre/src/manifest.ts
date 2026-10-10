import { parseAbi, type PublicClient } from 'viem';
import { chainRegistry, contractForPair } from '@synq/chain-registry';
import type { PluginManifestInput } from '@synq/domain';
import type { PluginContext, SynqPlugin } from '@synq/plugin-sdk';
import { riskAttestationDeployment } from './deployment.js';
import { riskAttestationRegistryAbi } from './reader.js';

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);

export const chainlinkCreManifest: PluginManifestInput = {
  id: 'chainlink-cre-ausd-risk',
  version: '0.1.0',
  capabilities: ['READ_MARKET'],
  chains: [
    chainRegistry.profiles['sandbox/monad-testnet'].network.chainId,
    chainRegistry.profiles['proof/monad-mainnet'].network.chainId,
  ],
  riskClass: 'READ_ONLY',
  requiresSimulation: false,
  maxGrantTtlSeconds: 60,
  dependencies: { viem: '2.57.4', '@chainlink/cre-sdk': '1.23.0' },
  sourceDocs: [
    'https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory',
    'https://docs.chain.link/data-feeds/price-feeds/addresses?network=monad',
  ],
  sourceIds: ['S031', 'SYNQ-093', 'SYNQ-094'],
  health: { maxStalenessSeconds: 120, checks: ['RPC', 'QUOTE_SOURCE'] },
};

type HealthClient = Pick<PublicClient, 'readContract' | 'getChainId'>;

/**
 * Read-only plugin view of the AUSD risk pipeline. Testnet health reads the deployed registry's forwarder; mainnet
 * health reads the Chainlink AUSD/USD feed (no registry is deployed on mainnet).
 */
export function chainlinkCrePlugin(
  clientFor: (context: PluginContext) => HealthClient,
): SynqPlugin {
  return {
    manifest: chainlinkCreManifest,
    async health(context) {
      const client = clientFor(context);
      const fail = (reason: string) => ({
        available: false,
        checkedAt: context.now,
        reason,
      });
      try {
        if ((await client.getChainId()) !== context.network.chainId)
          return fail('rpc chain mismatch');
        if (context.network.profile === 'sandbox/monad-testnet') {
          const deployment = riskAttestationDeployment(context.network.profile);
          const forwarder = await client.readContract({
            address: deployment.RiskAttestationRegistry,
            abi: riskAttestationRegistryAbi,
            functionName: 'forwarder',
          });
          return forwarder.toLowerCase() === deployment.forwarder
            ? { available: true, checkedAt: context.now }
            : fail('registry forwarder drift');
        }
        const feed = contractForPair(
          context.network.chainId,
          'CHAINLINK_PRICE_FEED',
          'AUSD/USD',
        );
        if (!feed) return fail('no AUSD/USD feed on this network');
        const round = await client.readContract({
          address: feed.address,
          abi: feedAbi,
          functionName: 'latestRoundData',
        });
        return round[1] > 0n
          ? { available: true, checkedAt: context.now }
          : fail('feed answer is not positive');
      } catch {
        return fail('health read failed');
      }
    },
  };
}
