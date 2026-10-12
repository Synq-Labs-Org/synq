import type { Address, Hex, PublicClient } from 'viem';

/** Unsigned call handed to the Agent Wallet; signing stays inside the host. */
export type TxRequest = {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  summary: string;
  details: Record<string, string>;
};

export type TxSubmission = {
  hash: Hex | null;
  status: string;
  failureCode?: string;
  failureDescription?: string;
};

/** What Synq core needs from the Agent Wallet host, nothing more. */
export interface SynqHost {
  publicClient(chainId: number): PublicClient;
  /** Selected wallet first when the host exposes it, then every EVM wallet. */
  walletAddresses(): { selected: Address | null; all: Address[] };
  submit(request: TxRequest): Promise<TxSubmission>;
}
