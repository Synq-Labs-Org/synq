import { ApplicationFailure } from '@temporalio/common';
import { profileForChainId } from '@synq/chain-registry';

const NON_MAINNET = new Set(['local/anvil', 'sandbox/monad-testnet']);

/** True when the chain is not a known local or testnet profile; unknown chains count as mainnet. */
export function isMainnetChain(chainId: number): boolean {
  const profile = profileForChainId(chainId)?.network.profile;
  return profile === undefined || !NON_MAINNET.has(profile);
}

/**
 * Value-moving Activities call this first. Mainnet stays refused unless SYNQ_ALLOW_MAINNET_BROADCAST
 * is exactly 'true'; even then the chain registry's mutation gate still applies downstream.
 */
export function assertBroadcastAllowed(
  chainId: number,
  allowMainnetBroadcast: boolean,
): void {
  if (isMainnetChain(chainId) && !allowMainnetBroadcast)
    throw ApplicationFailure.nonRetryable(
      `mainnet value movement refused on chain ${chainId}; SYNQ_ALLOW_MAINNET_BROADCAST is not 'true'`,
      'MAINNET_BROADCAST_DISABLED',
    );
}
