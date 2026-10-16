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
export const CARD_MODE: Record<CardExecutionMode, Mode> = {
  REAL_TESTNET: { id: 'REAL_TESTNET', label: 'REAL TESTNET', tone: 'ok' },
  PROVIDER_SANDBOX: {
    id: 'PROVIDER_SANDBOX',
    label: 'SANDBOX',
    tone: 'pending',
  },
  SIMULATION: { id: 'SIMULATION', label: 'SIMULATED', tone: 'muted' },
  MAINNET_SIMULATION: {
    id: 'MAINNET_SIMULATION',
    label: 'SIMULATED',
    tone: 'muted',
  },
  CANARY_READY: { id: 'CANARY_READY', label: 'NOT EXECUTED', tone: 'muted' },
  MAINNET_READ_ONLY: {
    id: 'MAINNET_READ_ONLY',
    label: 'READ ONLY',
    tone: 'muted',
  },
  LIVE_ARC_TESTNET: {
    id: 'LIVE_ARC_TESTNET',
    label: 'ARC TESTNET',
    tone: 'ok',
  },
  LIVE_SEPOLIA: { id: 'LIVE_SEPOLIA', label: 'SEPOLIA', tone: 'ok' },
  LOCAL_FIXTURE: { id: 'LOCAL_FIXTURE', label: 'LOCAL FIXTURE', tone: 'muted' },
};

/**
 * Mode for cards that carry no execution mode, read off the network label
 * only (never guessed): testnets and local chains say so, anything else none.
 */
export const networkMode = (network: string | null): Mode | null =>
  network === null
    ? null
    : /testnet|sepolia/i.test(network)
      ? { id: 'TESTNET', label: 'TESTNET', tone: 'ok' }
      : /local/i.test(network)
        ? { id: 'LOCAL', label: 'LOCAL', tone: 'muted' }
        : null;
