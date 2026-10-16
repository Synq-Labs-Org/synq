import { readFileSync } from 'node:fs';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  parseTransaction,
  decodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';

export const USDC = token('arc-testnet', 'USDC');
const USDC_CODE = readFileSync(
  new URL('../arc/fixtures/arc-testnet-usdc.code', import.meta.url),
  'utf8',
).trim() as Hex;

/**
 * A tiny Arc: a mempool that mines what it receives (once per hash), with one
 * nonce per chain. Every broadcast is logged in `sent`, so a test can count
 * how many distinct transactions were ever signed and paid.
 */
export function fakeArc() {
  const sent: Hex[] = [];
  const mined = new Map<
    Hex,
    { blockNumber: bigint; to: Address; value: bigint }
  >();
  let nonce = 7;
  const receiptOf = (hash: Hex, from: Address) => {
    const m = mined.get(hash);
    if (!m) throw new Error('receipt not found');
    return {
      status: 'success',
      blockNumber: m.blockNumber,
      blockHash: `0x${'bb'.repeat(32)}`,
      gasUsed: 50_000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [
        {
          address: USDC.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: 'Transfer',
            args: { from, to: m.to },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [m.value]),
          blockNumber: m.blockNumber,
          transactionHash: hash,
          logIndex: 0,
          blockHash: `0x${'bb'.repeat(32)}`,
          transactionIndex: 0,
          removed: false,
        },
      ],
    };
  };
  let payer: Address = '0x0000000000000000000000000000000000000000';
  const client = {
    getChainId: async () => 5042002,
    getCode: async () => USDC_CODE,
    readContract: async () => 50_000_000n,
    getBalance: async () => 50n * 10n ** 18n,
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    call: async () => ({
      data: encodeAbiParameters([{ type: 'bool' }], [true]),
    }),
    estimateGas: async () => 60_000n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      sent.push(serializedTransaction);
      if (mined.has(hash)) throw new Error('already known');
      const tx = parseTransaction(serializedTransaction);
      if (tx.nonce !== nonce) throw new Error('nonce too low');
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
      const [to, value] = call.args as [Address, bigint];
      mined.set(hash, {
        blockNumber: BigInt(100 + mined.size),
        to,
        value,
      });
      nonce++;
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, payer),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, payer),
  } as unknown as PublicClient;
  return {
    client,
    sent,
    mined,
    setPayer: (a: Address) => (payer = a),
    /** Another transaction from the same sender lands first. */
    bumpNonce: () => nonce++,
  };
}

export function countingSigner(account: LocalAccount) {
  let signatures = 0;
  return {
    address: account.address,
    signTransaction: async (
      tx: Parameters<LocalAccount['signTransaction']>[0],
    ) => {
      signatures++;
      return account.signTransaction(tx);
    },
    get count() {
      return signatures;
    },
  };
}
