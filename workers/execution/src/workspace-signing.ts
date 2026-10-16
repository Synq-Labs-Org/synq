import {
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from 'viem';
import { ArcExecutionError, type TransferSigner } from './arc.js';
export function boundedWorkspaceSigner(signer: TransferSigner): TransferSigner {
  return {
    address: signer.address,
    signTransaction: async (tx) => {
      if ((tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > 50_000_000_000_000_000n)
        throw new ArcExecutionError('FEE_ABOVE_CAP');
      const raw = await signer.signTransaction(tx),
        parsed = parseTransaction(raw);
      if (
        parsed.chainId !== tx.chainId ||
        parsed.to?.toLowerCase() !== tx.to?.toLowerCase() ||
        parsed.data !== tx.data ||
        (parsed.value ?? 0n) !== (tx.value ?? 0n) ||
        parsed.nonce !== tx.nonce ||
        parsed.gas !== tx.gas ||
        parsed.maxFeePerGas !== tx.maxFeePerGas ||
        parsed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas ||
        (
          await recoverTransactionAddress({
            serializedTransaction: raw as TransactionSerialized,
          })
        ).toLowerCase() !== signer.address.toLowerCase()
      )
        throw new ArcExecutionError('TX_MISMATCH');
      return raw;
    },
  };
}
