import { it, expect } from 'vitest';
import {
  officialAssets,
  verifiedAsset,
  profileFor,
  monadTestnetProfile,
} from '../../packages/chain-registry/src/index.js';
it('anchors treasury AUSD to official chain/address/decimals identity and rejects spoofed symbols', () => {
  expect(verifiedAsset(officialAssets.testnetAUSD)).toEqual(
    officialAssets.testnetAUSD,
  );
  expect(() =>
    verifiedAsset({ ...officialAssets.testnetUSDC, symbol: 'AUSD' }),
  ).toThrow('ASSET_REGISTRY_MISMATCH');
  expect(() =>
    verifiedAsset({
      ...officialAssets.testnetAUSD,
      address: officialAssets.testnetUSDC.address,
    }),
  ).toThrow();
  expect(() =>
    verifiedAsset({ ...officialAssets.testnetAUSD, decimals: 18 }),
  ).toThrow();
  expect(monadTestnetProfile.treasuryAsset?.symbol).toBe('AUSD');
  expect(monadTestnetProfile.edgeSettlementAsset?.symbol).toBe('USDC');
  expect(profileFor('local').treasuryAsset).toBeNull();
  expect(() => profileFor('mainnet')).toThrow('NETWORK_DISABLED');
});
