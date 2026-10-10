import { describe, expect, it } from 'vitest';
import {
  ChainRegistrySchema,
  ausdDeployment,
  ausdOftNetwork,
  monadMainnetProfile,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import {
  FundingError,
  ausdForMutation,
  requireOfficialAusd,
} from '@synq/funding';
import raw from '../../sources/chain_registry.json' with { type: 'json' };

const TESTNET = monadTestnetProfile.network.chainId;
const MAINNET = monadMainnetProfile.network.chainId;
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof FundingError ? e.code : String(e);
  }
  return 'NO_ERROR';
};

describe('AUSD registry identity (B08.1)', () => {
  it('AUSD-002 official testnet AUSD resolves to the registry identity (chainId, address, decimals, canonicalAssetId)', () => {
    const d = ausdDeployment(TESTNET)!;
    expect(d.asset).toEqual(officialAssets.testnetAUSD);
    expect(d.asset.decimals).toBe(6);
    expect(d.asset.canonicalAssetId).toBe(
      `eip155:${TESTNET}/erc20:${officialAssets.testnetAUSD.address}`,
    );
    expect(d.faucetAddress).toBe(monadTestnetProfile.faucetAddress);
    expect(d.implementation).toBe(ausdDeployment(MAINNET)!.implementation);
    expect(requireOfficialAusd(officialAssets.testnetAUSD, TESTNET)).toEqual(
      officialAssets.testnetAUSD,
    );
    expect(ausdForMutation(TESTNET)).toEqual(officialAssets.testnetAUSD);
  });

  it('AUSD-001 mainnet AUSD address on the testnet profile is a profile mismatch', () => {
    expect(
      code(() =>
        requireOfficialAusd(
          { chainId: TESTNET, address: officialAssets.mainnetAUSD.address },
          TESTNET,
        ),
      ),
    ).toBe('PROFILE_MISMATCH');
    expect(
      code(() => requireOfficialAusd(officialAssets.mainnetAUSD, TESTNET)),
    ).toBe('PROFILE_MISMATCH');
    expect(code(() => ausdForMutation(MAINNET))).toBe('MAINNET_DISABLED');
  });

  it('AUSD-003 same symbol at another contract is a spoof; a different token is rejected', () => {
    expect(
      code(() =>
        requireOfficialAusd(
          {
            chainId: TESTNET,
            address: `0x${'ab'.repeat(20)}`,
            symbol: 'AUSD',
            decimals: 6,
          },
          TESTNET,
        ),
      ),
    ).toBe('SYMBOL_SPOOF');
    expect(
      code(() => requireOfficialAusd(officialAssets.testnetUSDC, TESTNET)),
    ).toBe('WRONG_TOKEN');
    expect(
      code(() =>
        requireOfficialAusd(
          { ...officialAssets.testnetAUSD, decimals: 18 },
          TESTNET,
        ),
      ),
    ).toBe('DECIMALS_MISMATCH');
  });

  it('wrong chain: AUSD on an OFT source chain or an unknown chain is not the Monad AUSD', () => {
    expect(
      code(() => requireOfficialAusd(officialAssets.ethereumAUSD, TESTNET)),
    ).toBe('WRONG_CHAIN');
    expect(
      code(() =>
        requireOfficialAusd(
          { chainId: 999, address: officialAssets.testnetAUSD.address },
          TESTNET,
        ),
      ),
    ).toBe('WRONG_CHAIN');
  });

  it('OFT configuration: mainnet bridge with peers; Monad testnet EID 40442 has no AUSD OFT', () => {
    const main = ausdOftNetwork(MAINNET)!;
    expect(main.status).toBe('CONFIGURED');
    if (main.status !== 'CONFIGURED') return;
    expect(main.eid).toBe(30390);
    expect(main.peers.map((p) => p.eid).sort()).toEqual([
      30101, 30106, 30184, 30375,
    ]);
    const test = ausdOftNetwork(TESTNET)!;
    expect(test.status).toBe('NO_AUSD_OFT');
    expect(test.eid).toBe(40442);
    expect(test.bridge).toBeNull();
  });

  it('registry schema refuses an AUSD OFT on Monad testnet and a non-AUSD deployment', () => {
    const forged = structuredClone(raw);
    const main = forged.ausd.oft[0]!;
    forged.ausd.oft[1] = {
      ...main,
      network: `eip155:${TESTNET}`,
      chainId: TESTNET,
      asset: 'testnetAUSD',
    } as never;
    expect(ChainRegistrySchema.safeParse(forged).success).toBe(false);
    const wrongAsset = structuredClone(raw);
    wrongAsset.ausd.deployments[0]!.asset = 'testnetUSDC';
    expect(ChainRegistrySchema.safeParse(wrongAsset).success).toBe(false);
    expect(ChainRegistrySchema.safeParse(raw).success).toBe(true);
  });
});
