import { parseAbi, type Address, type PublicClient } from 'viem';
import {
  AUSD_PAUSE_READERS,
  ausdAssets,
  ausdDeployment,
  ausdRegistry,
  isMutationEnabledChain,
  profileForChainId,
} from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import { FundingError } from './errors.js';

export const ausdAbi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function isTransferPaused() view returns (bool)',
  'function isMintPaused() view returns (bool)',
  'function isBurnFromPaused() view returns (bool)',
  'function isBridgingPaused() view returns (bool)',
  'function isFreezingPaused() view returns (bool)',
  'function isAccountFrozen(address account) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export type AssetCandidate = {
  chainId: number;
  address: string;
  decimals?: number;
  symbol?: string;
  canonicalAssetId?: string;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Resolves a claimed AUSD asset against the registry identity
 * (chainId, address, decimals, canonicalAssetId) for the expected chain.
 * Symbols are never trusted: a contract calling itself "AUSD" at another
 * address is a spoof.
 */
export function requireOfficialAusd(
  candidate: AssetCandidate,
  expectedChainId: number,
): Asset {
  const expected = ausdDeployment(expectedChainId);
  if (!expected)
    throw new FundingError('NOT_AUSD', `no AUSD on chain ${expectedChainId}`);
  const known = ausdAssets();
  if (candidate.chainId !== expectedChainId) {
    const profile = profileForChainId(candidate.chainId);
    throw new FundingError(
      profile ? 'PROFILE_MISMATCH' : 'WRONG_CHAIN',
      `asset chain ${candidate.chainId} on profile chain ${expectedChainId}`,
    );
  }
  if (!same(candidate.address, expected.asset.address)) {
    const otherProfile = known.find(
      (a) =>
        same(a.address, candidate.address) && a.chainId !== expectedChainId,
    );
    if (otherProfile)
      throw new FundingError(
        'PROFILE_MISMATCH',
        `${candidate.address} is AUSD on chain ${otherProfile.chainId}, not ${expectedChainId}`,
      );
    throw new FundingError(
      candidate.symbol === ausdRegistry.canonicalSymbol
        ? 'SYMBOL_SPOOF'
        : 'WRONG_TOKEN',
      candidate.address,
    );
  }
  if (
    candidate.decimals !== undefined &&
    candidate.decimals !== expected.asset.decimals
  )
    throw new FundingError('DECIMALS_MISMATCH', String(candidate.decimals));
  if (
    candidate.canonicalAssetId !== undefined &&
    candidate.canonicalAssetId !== expected.asset.canonicalAssetId
  )
    throw new FundingError('WRONG_TOKEN', candidate.canonicalAssetId);
  if (
    candidate.symbol !== undefined &&
    candidate.symbol !== expected.asset.symbol
  )
    throw new FundingError('WRONG_TOKEN', candidate.symbol);
  return expected.asset;
}

/** AUSD for a mutation-enabled profile chain; mainnet resolves only for reads. */
export function ausdForMutation(chainId: number): Asset {
  if (!isMutationEnabledChain(chainId))
    throw new FundingError('MAINNET_DISABLED', String(chainId));
  const d = ausdDeployment(chainId);
  if (!d) throw new FundingError('NOT_AUSD', String(chainId));
  return d.asset;
}

export type AusdChainReader = Pick<
  PublicClient,
  'getChainId' | 'readContract' | 'getStorageAt' | 'getBlockNumber'
>;

export type AusdOnchainEvidence = {
  chainId: number;
  token: Address;
  blockNumber: string;
  symbol: string;
  name: string;
  decimals: number;
  implementation: Address;
  expectedImplementation: Address;
  controls: Record<string, boolean>;
  pausedFunctionAbsent: boolean;
  matchesRegistry: boolean;
  mismatches: string[];
};

/** Read-only on-chain revalidation of the registry AUSD entry for one chain. */
export async function verifyAusdOnChain(
  client: AusdChainReader,
  expectedChainId: number,
): Promise<AusdOnchainEvidence> {
  const expected = ausdDeployment(expectedChainId);
  if (!expected) throw new FundingError('NOT_AUSD', String(expectedChainId));
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId)
    throw new FundingError('WRONG_CHAIN', `RPC reports ${chainId}`);
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const token = expected.asset.address;
  const at = { blockNumber } as const;
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: token,
      abi: ausdAbi,
      functionName,
      args,
      ...at,
    } as Parameters<AusdChainReader['readContract']>[0]) as Promise<T>;
  const [symbol, name, decimals, slot] = await Promise.all([
    read<string>('symbol'),
    read<string>('name'),
    read<number>('decimals'),
    client.getStorageAt({
      address: token,
      slot: EIP1967_IMPLEMENTATION_SLOT,
      ...at,
    }),
  ]);
  const controls: Record<string, boolean> = {};
  for (const reader of AUSD_PAUSE_READERS)
    controls[reader] = await read<boolean>(reader);
  let pausedFunctionAbsent = false;
  try {
    await client.readContract({
      address: token,
      abi: parseAbi(['function paused() view returns (bool)']),
      functionName: 'paused',
      ...at,
    });
  } catch {
    pausedFunctionAbsent = true;
  }
  const implementation = `0x${(slot ?? '0x').slice(-40)}` as Address;
  const mismatches = [
    ...(symbol === expected.asset.symbol ? [] : ['symbol']),
    ...(Number(decimals) === expected.asset.decimals ? [] : ['decimals']),
    ...(same(implementation, expected.implementation)
      ? []
      : ['implementation']),
    ...(pausedFunctionAbsent ? [] : ['paused() unexpectedly present']),
  ];
  return {
    chainId,
    token,
    blockNumber: String(blockNumber),
    symbol,
    name,
    decimals: Number(decimals),
    implementation,
    expectedImplementation: expected.implementation,
    controls,
    pausedFunctionAbsent,
    matchesRegistry: mismatches.length === 0,
    mismatches,
  };
}
