import { profileForChainId } from '@synq/chain-registry';
import { CHAINS, type ChainName } from '@synq/chain-registry/arc';
import type { CardExecutionMode } from '@synq/schemas';
import type { CardContent } from './model.js';

/*
 * Network and execution-mode labels shared by every theme and the text
 * renderings. Labels come from the chain registry only; an unknown chain is
 * shown as its id, never guessed.
 */

const ARC_LABEL: Record<ChainName, string> = {
  'arc-testnet': 'Arc Testnet',
  'arc-mainnet': 'Arc',
  'eth-sepolia': 'Ethereum Sepolia',
  'base-sepolia': 'Base Sepolia',
  'arb-sepolia': 'Arbitrum Sepolia',
};
const PROFILE_LABEL: Record<string, string> = {
  'sandbox/monad-testnet': 'Monad Testnet',
  'proof/monad-mainnet': 'Monad',
  'local/anvil': 'Local chain',
};

/** Human name of a chain id; `null` (no chain) reads "Off-chain". */
export function cardNetworkLabel(chainId: number | null): string {
  if (chainId === null) return 'Off-chain';
  const arc = Object.values(CHAINS).find((c) => c.chainId === chainId);
  if (arc) return ARC_LABEL[arc.name];
  const profile = profileForChainId(chainId)?.network.profile;
  return (profile && PROFILE_LABEL[profile]) ?? `Chain ${chainId}`;
}

type Mode = NonNullable<CardContent['mode']>;
/** Short badge for every card execution mode. */
const mode = (
  id: Mode['id'],
  label: string,
  detail: string,
  tone: Mode['tone'],
): Mode => ({ id, label, detail, tone });
export const CARD_MODE: Record<CardExecutionMode, Mode> = {
  REAL_TESTNET: mode('REAL_TESTNET', 'REAL TESTNET', 'Real testnet tx', 'ok'),
  PROVIDER_SANDBOX: mode(
    'PROVIDER_SANDBOX',
    'SANDBOX',
    'Provider sandbox',
    'pending',
  ),
  SIMULATION: mode('SIMULATION', 'SIMULATED', 'Nothing broadcast', 'muted'),
  MAINNET_SIMULATION: mode(
    'MAINNET_SIMULATION',
    'SIMULATED',
    'Nothing broadcast',
    'muted',
  ),
  CANARY_READY: mode(
    'CANARY_READY',
    'NOT EXECUTED',
    'Canary-ready only',
    'muted',
  ),
  MAINNET_READ_ONLY: mode(
    'MAINNET_READ_ONLY',
    'READ ONLY',
    'Mainnet read only',
    'muted',
  ),
  LIVE_ARC_TESTNET: mode(
    'LIVE_ARC_TESTNET',
    'ARC TESTNET',
    'Live testnet state',
    'ok',
  ),
  LIVE_SEPOLIA: mode('LIVE_SEPOLIA', 'SEPOLIA', 'Live testnet state', 'ok'),
  LOCAL_FIXTURE: mode(
    'LOCAL_FIXTURE',
    'LOCAL FIXTURE',
    'Nothing on any network',
    'muted',
  ),
};

/**
 * Mode for cards that carry no execution mode, read off the network label
 * only (never guessed): testnets and local chains say so, anything else none.
 */
export const networkMode = (network: string | null): Mode | null =>
  network === null
    ? null
    : /testnet|sepolia/i.test(network)
      ? mode('TESTNET', 'TESTNET', 'Testnet state', 'ok')
      : /local/i.test(network)
        ? mode('LOCAL', 'LOCAL', 'Local chain', 'muted')
        : null;
