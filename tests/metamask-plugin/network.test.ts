import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assetForRole,
  officialAsset,
  profileConfiguration,
} from '@synq/chain-registry';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const network = read('packages/metamask-synq-plugin/src/core/network.json');

describe('MetaMask Agent Wallet plugin network pin', () => {
  it('matches the Synq chain registry and deployments', () => {
    const profile = profileConfiguration('sandbox/monad-testnet');
    const ausd = officialAsset('testnetAUSD');
    const deployments = read('contracts/deployments/10143.json');
    expect(network.profile).toBe('sandbox/monad-testnet');
    expect(network.chainId).toBe(profile.network.chainId);
    expect(network.caip2).toBe(`eip155:${profile.network.chainId}`);
    expect(network.explorerUrl).toBe(profile.explorerUrl);
    expect(network.confirmationDepth).toBe(profile.confirmationDepth);
    expect(network.ausd.address.toLowerCase()).toBe(ausd.address.toLowerCase());
    expect(network.ausd.decimals).toBe(ausd.decimals);
    expect(assetForRole(profile, 'treasuryAsset').address.toLowerCase()).toBe(
      ausd.address.toLowerCase(),
    );
    expect(network.mandateRegistry).toBe(deployments.MandateRegistry);
    expect(deployments.chainId).toBe(network.chainId);
    expect(BigInt(network.maxContributionBaseUnits)).toBeLessThanOrEqual(
      5n * 10n ** BigInt(ausd.decimals),
    );
  });
});
