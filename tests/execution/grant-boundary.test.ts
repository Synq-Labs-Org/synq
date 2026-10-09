import { keccak256 } from 'viem';
import { expect, it } from 'vitest';
import { Kernel, artifactHash } from '@synq/kernel';
import { officialAssets } from '@synq/chain-registry';
import { chainGrant } from '@synq/execution-worker';
import {
  address,
  asset,
  evidence,
  intent,
  mandate,
  network,
  now,
} from '../kernel/fixtures.js';

it('execution boundary re-verifies the grant asset against the official registry', async () => {
  const data = '0xa9059cbb' as const;
  const input = {
    ...evidence(
      intent({ maxInputAmount: '10', calldataHash: keccak256(data) }),
    ),
    approvals: [],
    now,
  };
  const kernel = new Kernel({
    network,
    mandates: [mandate()],
    balances: [{ account: address(20), asset, balance: '1000' }],
    trustedEvidence: {
      riskPacketHashes: [artifactHash(input.risk)],
      simulationHashes: [artifactHash(input.simulation)],
    },
  });
  const decision = await kernel.authorize(input);
  if (decision.status !== 'AUTHORIZED') throw new Error(decision.code);
  expect(() => chainGrant(decision.grant)).toThrow('ASSET_REGISTRY_MISMATCH');
  expect(chainGrant(decision.grant, [asset]).inputToken).toBe(asset.address);
  expect(() =>
    chainGrant(
      { ...decision.grant, inputAsset: { ...asset, symbol: 'AUSD' } },
      [asset],
    ),
  ).toThrow('ASSET_REGISTRY_MISMATCH');
  const spoofed = {
    ...officialAssets.testnetAUSD,
    decimals: 18,
  };
  expect(() =>
    chainGrant({ ...decision.grant, chainId: 10143, inputAsset: spoofed }),
  ).toThrow('ASSET_REGISTRY_MISMATCH');
});
