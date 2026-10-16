import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  padHex,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { contract, chainProfile } from '@synq/chain-registry/arc';
import type { VaultSetup } from '@synq/kernel/arc-vault-setup';
import {
  SAFE_GUARD_SLOT,
  SAFE_FALLBACK_HANDLER_SLOT,
  VAULT_FACTORY_ABI,
} from '@synq/execution-worker/vault';
import type { ArcChain } from '@synq/execution-worker/arc';
import codes from './fixtures/factory-infrastructure.json' with { type: 'json' };

/** LOCAL_FIXTURE: real signed bytes and PG journal; no transaction leaves this fake chain. */
export function fakeVaultChain(s: VaultSetup, safe: Address, policy: Address) {
  const hashes = new Set<Hex>();
  const broadcasts: Hex[] = [];
  let nonce = 7;
  let throwAfterBroadcast = false;
  let owners = s.owners;
  const blockHash = `0x${'ab'.repeat(32)}` as Hex;
  const vaultId = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        BigInt(s.chainId),
        getAddress(s.factory),
        getAddress(s.sponsor),
        s.salt as Hex,
      ],
    ),
  );
  const receipt = (hash: Hex) => {
    if (!hashes.has(hash)) throw new Error('receipt not found');
    return {
      status: 'success',
      from: getAddress(s.sponsor),
      to: getAddress(s.factory),
      transactionHash: hash,
      blockNumber: 100n,
      blockHash,
      gasUsed: 2_000_000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [
        {
          address: getAddress(s.factory),
          topics: encodeEventTopics({
            abi: VAULT_FACTORY_ABI,
            eventName: 'VaultCreated',
            args: { vaultId, safe, policy },
          }),
          data: encodeAbiParameters(
            [
              { type: 'address[]' },
              { type: 'uint256' },
              { type: 'address' },
              { type: 'address' },
              { type: 'uint256' },
              { type: 'address' },
            ],
            [
              s.owners.map((a) => getAddress(a)),
              BigInt(s.threshold),
              getAddress(s.guardian),
              getAddress(s.operator),
              BigInt(s.delay),
              getAddress(s.sponsor),
            ],
          ),
          logIndex: 0,
          transactionIndex: 0,
          transactionHash: hash,
          blockHash,
          blockNumber: 100n,
          removed: false,
        },
      ],
    };
  };
  const client = {
    getChainId: async () => chainProfile('arc-testnet').chainId,
    getCode: async ({ address }: { address: string }) => {
      if (address.toLowerCase() === policy.toLowerCase()) return '0x60006000';
      const kind = (
        [
          'SAFE_L2_SINGLETON',
          'SAFE_PROXY_FACTORY',
          'SYNQ_ARC_VAULT_FACTORY',
        ] as const
      ).find(
        (kind) =>
          contract('arc-testnet', kind).address.toLowerCase() ===
          address.toLowerCase(),
      );
      return kind ? `0x${codes[kind].join('')}` : '0x';
    },
    getBalance: async () => 10n ** 18n,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    estimateGas: async () => 2_000_000n,
    call: async () => ({ data: '0x' }),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      switch (functionName) {
        case 'token':
          return s.token;
        case 'safe':
          return safe;
        case 'getOwners':
          return owners;
        case 'getThreshold':
          return BigInt(s.threshold);
        case 'nonce':
          return 0n;
        case 'VERSION':
          return '1.4.1';
        case 'getModulesPaginated':
          return [[policy], '0x0000000000000000000000000000000000000001'];
        case 'operator':
          return s.operator;
        case 'perPaymentCap':
          return BigInt(s.perPaymentCap);
        case 'windowCap':
          return BigInt(s.windowCap);
        case 'paused':
          return false;
        case 'getStorageAt': {
          const slot = args?.[0];
          const address =
            slot === SAFE_GUARD_SLOT
              ? policy
              : slot === SAFE_FALLBACK_HANDLER_SLOT
                ? contract('arc-testnet', 'SYNQ_ARC_FALLBACK_HANDLER').address
                : contract('arc-testnet', 'SAFE_L2_SINGLETON').address;
          return padHex(address, { size: 32 });
        }
        default:
          throw new Error(`unsupported fixture read ${functionName}`);
      }
    },
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      if (hashes.has(hash)) throw new Error('already known');
      const tx = parseTransaction(serializedTransaction);
      if (tx.nonce !== nonce) throw new Error('nonce too low');
      broadcasts.push(serializedTransaction);
      hashes.add(hash);
      nonce++;
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipt(hash),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (throwAfterBroadcast) {
        throwAfterBroadcast = false;
        throw new Error('connection lost after broadcast');
      }
      return receipt(hash);
    },
  } as unknown as PublicClient;
  return {
    chain: { profile: chainProfile('arc-testnet'), client } as ArcChain,
    broadcasts,
    failAfterBroadcast: () => {
      throwAfterBroadcast = true;
    },
    changeOwners: (value: string[]) => {
      owners = value as Address[];
    },
  };
}
