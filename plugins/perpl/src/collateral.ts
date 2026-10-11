import type { PublicClient } from 'viem';
import type { PerplNetworkConfig } from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import { PerplError } from './errors.js';
import { ExchangeReader, erc20Abi } from './exchange.js';
import type { PerplContext } from './schemas.js';

export type CollateralIdentity = Readonly<{
  chainId: number;
  address: `0x${string}`;
  decimals: number;
  canonicalAssetId: string;
  // Truthful display label derived from the registry, never from a symbol.
  label: string;
  minAccountOpen: bigint;
  minDeposit: bigint;
}>;

export type OnchainCollateralCheck = Readonly<{
  exchangeCollateral: `0x${string}`;
  exchangeDecimals: number;
  tokenSymbol: string;
  tokenDecimals: number;
  minAccountOpen: bigint;
}>;

function sameAsset(
  a: { chainId: number; address: string },
  b: { chainId: number; address: string },
) {
  return (
    a.chainId === b.chainId &&
    a.address.toLowerCase() === b.address.toLowerCase()
  );
}

// Collateral identity is (chainId, address) from the Perpl context, asserted
// equal to the chain registry entry for the same profile (finding
// P10-20261010T150000Z). The token symbol is never used for resolution.
export class PerplCollateralAdapter {
  constructor(readonly network: PerplNetworkConfig) {}

  label(): string {
    return this.network.label === 'TESTNET'
      ? 'AUSD (Agora Monad testnet token)'
      : 'AUSD (Agora, Monad mainnet)';
  }

  registryAsset(): Asset {
    return this.network.collateral;
  }

  resolve(context: PerplContext): CollateralIdentity {
    if (context.chain.chain_id !== this.network.chainId)
      throw new PerplError(
        'PROFILE_MISMATCH',
        `context chain ${context.chain.chain_id} on the ${this.network.label} profile`,
      );
    const instance = context.instances.find(
      (i) => i.address === this.network.exchange.toLowerCase(),
    );
    if (!instance)
      throw new PerplError(
        'COLLATERAL_MISMATCH',
        'context has no instance for the registry exchange',
      );
    const token = context.tokens.find(
      (t) => t.id === instance.collateral_token_id,
    );
    if (!token?.address)
      throw new PerplError('COLLATERAL_MISMATCH', 'collateral token missing');
    const observed = {
      chainId: context.chain.chain_id,
      address: token.address.toLowerCase(),
    };
    const expected = this.network.collateral;
    if (!sameAsset(observed, expected) || token.decimals !== expected.decimals)
      throw new PerplError(
        'COLLATERAL_MISMATCH',
        `context collateral ${observed.chainId}:${observed.address}/${token.decimals} != registry ${expected.chainId}:${expected.address}/${expected.decimals}`,
      );
    return Object.freeze({
      chainId: expected.chainId,
      address: expected.address,
      decimals: expected.decimals,
      canonicalAssetId: expected.canonicalAssetId,
      label: this.label(),
      minAccountOpen: BigInt(instance.min_account_open_amount),
      minDeposit: BigInt(instance.min_deposit_amount),
    });
  }

  assertCollateral(asset: {
    chainId: number;
    address: string;
    decimals: number;
  }) {
    const expected = this.network.collateral;
    if (!sameAsset(asset, expected) || asset.decimals !== expected.decimals)
      throw new PerplError(
        'COLLATERAL_MISMATCH',
        `${asset.chainId}:${asset.address} is not ${this.network.label} Perpl collateral`,
      );
    return expected;
  }

  async verifyOnchain(client: PublicClient): Promise<OnchainCollateralCheck> {
    const reader = new ExchangeReader(client, this.network);
    const info = await reader.info();
    const expected = this.network.collateral;
    if (
      info.collateralToken !== expected.address.toLowerCase() ||
      info.collateralDecimals !== expected.decimals
    )
      throw new PerplError(
        'COLLATERAL_MISMATCH',
        `exchange collateral ${info.collateralToken}/${info.collateralDecimals}`,
      );
    const [tokenSymbol, tokenDecimals] = await Promise.all([
      client.readContract({
        address: expected.address,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
      client.readContract({
        address: expected.address,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    ]);
    if (tokenDecimals !== expected.decimals)
      throw new PerplError('COLLATERAL_MISMATCH', 'token decimals differ');
    return Object.freeze({
      exchangeCollateral: info.collateralToken,
      exchangeDecimals: info.collateralDecimals,
      tokenSymbol,
      tokenDecimals,
      minAccountOpen: info.minAccountOpen,
    });
  }
}
