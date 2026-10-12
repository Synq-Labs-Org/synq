import { getAddress, type Address } from 'viem';
import raw from './network.json' with { type: 'json' };

export type SynqNetwork = {
  profile: string;
  chainId: number;
  caip2: string;
  explorerUrl: string;
  confirmationDepth: number;
  ausd: { address: Address; symbol: string; decimals: number };
  mandateRegistry: Address;
  maxContributionBaseUnits: bigint;
};

export const NETWORK: Readonly<SynqNetwork> = Object.freeze({
  profile: raw.profile,
  chainId: raw.chainId,
  caip2: raw.caip2,
  explorerUrl: raw.explorerUrl,
  confirmationDepth: raw.confirmationDepth,
  ausd: Object.freeze({
    address: getAddress(raw.ausd.address),
    symbol: raw.ausd.symbol,
    decimals: raw.ausd.decimals,
  }),
  mandateRegistry: getAddress(raw.mandateRegistry),
  maxContributionBaseUnits: BigInt(raw.maxContributionBaseUnits),
});

export const explorerTxUrl = (hash: string) =>
  `${NETWORK.explorerUrl}/tx/${hash}`;

export const sameAddress = (a: string | null | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase();
