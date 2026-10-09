import { hashTypedData, zeroAddress, type Address, type Hex } from 'viem';

/** A Safe 1.4.1 owner transaction Synq governance proposes: CALL only, no refunds. */
export type SafeGovernanceTransaction = {
  safe: Address;
  chainId: number;
  to: Address;
  data: Hex;
  nonce: bigint;
};

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export function safeTransactionTypedData(tx: SafeGovernanceTransaction) {
  return {
    domain: { chainId: tx.chainId, verifyingContract: tx.safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: {
      to: tx.to,
      value: 0n,
      data: tx.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: tx.nonce,
    },
  };
}

export function safeTransactionHash(tx: SafeGovernanceTransaction): Hex {
  return hashTypedData(safeTransactionTypedData(tx));
}
