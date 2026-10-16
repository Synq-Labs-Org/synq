import {
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import {
  MemoryEscrowBroadcastJournal,
  type EscrowBroadcast,
} from '@synq/execution-worker/escrow';

export const USDC = token('arc-testnet', 'USDC');

/**
 * A data-agnostic LOCAL_FIXTURE Arc for the shared signed-call primitive
 * (escrow approve/open/release/refund and ERC-8183 job steps). It mines each
 * distinct signed transaction once per sender nonce and logs every broadcast,
 * so a test can count signatures, broadcasts and inclusions independently.
 * `failWait` makes the next N receipt waits throw, as when a worker dies after
 * the broadcast and before it observes inclusion.
 */
export function callChain() {
  const broadcasts: Hex[] = [];
  const mined = new Map<
    Hex,
    { to: Address; data: Hex; nonce: number; block: bigint }
  >();
  let nonce = 11;
  const fail = { wait: 0 };
  const receipt = (hash: Hex) => {
    const m = mined.get(hash);
    if (!m) throw new Error('receipt not found');
    return {
      status: 'success' as const,
      blockNumber: m.block,
      blockHash: `0x${'cc'.repeat(32)}` as Hex,
      transactionHash: hash,
      gasUsed: 50_000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [],
    };
  };
  const client = {
    getChainId: async () => USDC.chainId,
    call: async () => ({ data: '0x' as Hex }),
    estimateGas: async () => 80_000n,
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      broadcasts.push(hash);
      if (mined.has(hash)) throw new Error('already known');
      const tx = parseTransaction(serializedTransaction);
      if (tx.nonce !== nonce) throw new Error('nonce too low');
      mined.set(hash, {
        to: tx.to!,
        data: tx.data ?? '0x',
        nonce: tx.nonce,
        block: BigInt(500 + mined.size),
      });
      nonce++;
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipt(hash),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (fail.wait > 0) {
        fail.wait--;
        throw new Error('worker died while waiting for the receipt');
      }
      return receipt(hash);
    },
  } as unknown as PublicClient;
  return {
    client,
    broadcasts,
    mined,
    fail,
    /** Distinct transactions ever broadcast. */
    distinct: () => new Set(broadcasts).size,
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

/**
 * The memory journal with a crash injected at `record` (the pre-broadcast
 * marker written right after the signed bytes are durable).
 */
export class CrashAfterSignedJournal extends MemoryEscrowBroadcastJournal {
  override async record(_entry: EscrowBroadcast): Promise<void> {
    throw new Error('crash after durable signed bytes');
  }
}

/** A journal whose durable state survives "process" restarts (shared maps). */
export function durableMemoryJournal() {
  const shared = new MemoryEscrowBroadcastJournal();
  return {
    shared,
    /** A fresh executor process reading the same durable journal. */
    restart: () => shared,
    crashing: () => {
      const j = new CrashAfterSignedJournal();
      // Point the crashing journal's durable signed-call map at the shared one.
      j.signed = (k) => shared.signed(k);
      j.storeSigned = (k, c) => shared.storeSigned(k, c);
      return j;
    },
  };
}
