import type { CommandIO } from '@metamask/agent-wallet/plugin';
import type {
  EvmWalletExecutor,
  EvmWalletRequest,
  WalletStateSnapshot,
} from '@metamask/agent-sdk/evm';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mandateRegistryAbi } from '../src/core/chain.js';
import type { Capability, SynqCommandId } from '../src/core/capabilities.js';
import { NETWORK } from '../src/core/network.js';
import type { HostContext } from '../src/plugin-host.js';

export const ACCOUNTS = [
  privateKeyToAccount(keccak256(toHex('synq-plugin-test-member'))),
  privateKeyToAccount(keccak256(toHex('synq-plugin-test-other'))),
];
export const MEMBER = ACCOUNTS[0]!.address;
export const OTHER = ACCOUNTS[1]!.address;
export const SAFE = getAddress(`0x${'5'.repeat(40)}`);
export const ROGUE_SAFE = getAddress(
  '0x3333333333333333333333333333333333333333',
);
export const CHAIN_GROUP_ID =
  '0x8241ac62ee0888e2065225c17e29cf9c6245069c89c687d2da44aae40811c1ec' as Hex;
export const MANDATE_ID = `0x${'ab'.repeat(32)}` as Hex;
/** Production convention: the identity group id is the chain group id. */
export const GROUP_ID = CHAIN_GROUP_ID;
export const AUSD = NETWORK.ausd.address;

type Mandate = {
  status: number;
  version: bigint;
  token: Address;
  validAfter: bigint;
  validUntil: bigint;
};
type Receipt = {
  hash: Hex;
  from: Address;
  to: Address;
  blockNumber: bigint;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
  ok: boolean;
};

/** In-memory Monad testnet speaking JSON-RPC to a real viem PublicClient. */
export class FakeChain {
  chainId: number = NETWORK.chainId;
  block = 100n;
  balances = new Map<string, bigint>([
    [MEMBER.toLowerCase(), 10_000_000n],
    [OTHER.toLowerCase(), 10_000_000n],
  ]);
  accountOf = new Map<string, Address>([[CHAIN_GROUP_ID.toLowerCase(), SAFE]]);
  groupOf = new Map<string, Hex>([[SAFE.toLowerCase(), CHAIN_GROUP_ID]]);
  mandates = new Map<string, Mandate>();
  receipts = new Map<string, Receipt>();
  private nonce = 0;

  balance(a: string) {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }

  /** Executes an ERC-20 transfer as `from` and mines it. */
  mine(from: Address, to: Address, data: Hex): Hex {
    const hash = keccak256(toHex(`tx-${++this.nonce}-${from}-${data}`));
    const logs: Receipt['logs'] = [];
    let ok = true;
    if (to.toLowerCase() === AUSD.toLowerCase()) {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName === 'transfer') {
        const [dest, value] = call.args as [Address, bigint];
        if (this.balance(from) < value) ok = false;
        else {
          this.balances.set(from.toLowerCase(), this.balance(from) - value);
          this.balances.set(dest.toLowerCase(), this.balance(dest) + value);
          logs.push({
            address: AUSD,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: 'Transfer',
              args: { from, to: dest },
            }) as Hex[],
            data: encodeAbiParameters([{ type: 'uint256' }], [value]),
          });
        }
      }
    }
    this.block += 1n;
    this.receipts.set(hash, {
      hash,
      from,
      to,
      blockNumber: this.block,
      logs: ok ? logs : [],
      ok,
    });
    return hash;
  }

  private call(to: string, data: Hex): Hex {
    if (to.toLowerCase() === AUSD.toLowerCase()) {
      const c = decodeFunctionData({ abi: erc20Abi, data });
      if (c.functionName !== 'balanceOf')
        throw new Error(`unsupported ${c.functionName}`);
      return encodeFunctionResult({
        abi: erc20Abi,
        functionName: 'balanceOf',
        result: this.balance(c.args[0] as string),
      });
    }
    if (to.toLowerCase() === NETWORK.mandateRegistry.toLowerCase()) {
      const c = decodeFunctionData({ abi: mandateRegistryAbi, data });
      switch (c.functionName) {
        case 'accountOf':
          return encodeFunctionResult({
            abi: mandateRegistryAbi,
            functionName: 'accountOf',
            result: this.accountOf.get(c.args[0].toLowerCase()) ?? zeroAddress,
          });
        case 'groupOf':
          return encodeFunctionResult({
            abi: mandateRegistryAbi,
            functionName: 'groupOf',
            result:
              this.groupOf.get(c.args[0].toLowerCase()) ??
              `0x${'00'.repeat(32)}`,
          });
        case 'mandateState': {
          const m = this.mandates.get(
            `${c.args[0].toLowerCase()}:${c.args[1].toLowerCase()}`,
          );
          return encodeFunctionResult({
            abi: mandateRegistryAbi,
            functionName: 'mandateState',
            result: {
              status: m?.status ?? 0,
              currentVersion: m?.version ?? 0n,
              minValidVersion: 1n,
              spentToken: 0n,
              spentNative: 0n,
            },
          });
        }
        case 'mandateTerms': {
          const m = this.mandates.get(
            `${c.args[0].toLowerCase()}:${c.args[1].toLowerCase()}`,
          );
          return encodeFunctionResult({
            abi: mandateRegistryAbi,
            functionName: 'mandateTerms',
            result: {
              mandateHash: `0x${'00'.repeat(32)}`,
              token: m?.token ?? zeroAddress,
              maxTokenPerAction: 0n,
              maxNativePerAction: 0n,
              cumulativeTokenCap: 0n,
              cumulativeNativeCap: 0n,
              validAfter: m?.validAfter ?? 0n,
              validUntil: m?.validUntil ?? 0n,
            },
          });
        }
      }
    }
    throw new Error(`no contract at ${to}`);
  }

  async request({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    const p = (params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        this.block += 1n;
        return toHex(this.block);
      case 'eth_call': {
        const { to, data } = p[0] as { to: string; data: Hex };
        return this.call(to, data);
      }
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(p[0] as string);
        if (!r) return null;
        return {
          transactionHash: r.hash,
          blockHash: keccak256(toHex(r.blockNumber)),
          blockNumber: toHex(r.blockNumber),
          transactionIndex: '0x0',
          from: r.from,
          to: r.to,
          status: r.ok ? '0x1' : '0x0',
          type: '0x2',
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          logs: r.logs.map((l, i) => ({
            ...l,
            logIndex: toHex(i),
            blockNumber: toHex(r.blockNumber),
            blockHash: keccak256(toHex(r.blockNumber)),
            transactionHash: r.hash,
            transactionIndex: '0x0',
            removed: false,
          })),
        };
      }
      default:
        throw new Error(`unsupported rpc ${method}`);
    }
  }

  client() {
    return createPublicClient({
      transport: custom({ request: (a) => this.request(a) }),
      pollingInterval: 5,
      cacheTime: 0,
    });
  }
}

export type ExecutorLog = { source: string; requests: EvmWalletRequest[] };

/** A fake Agent Wallet host built on the published plugin context types. */
export function fakeHostContext(
  chain: FakeChain,
  opts: {
    wallets?: Address[];
    selected?: Address | null;
    signer?: Address;
    typedSigner?: Address;
    rejectWith?: string;
  } = {},
): { ctx: HostContext; log: ExecutorLog[] } {
  const wallets = opts.wallets ?? [MEMBER];
  const selected = opts.selected === undefined ? wallets[0]! : opts.selected;
  const log: ExecutorLog[] = [];
  const snapshot: WalletStateSnapshot = {
    byokWallets: [],
    remoteWallets: wallets.map((address) => ({ address })),
    customEvmChains: [],
    customSolanaChains: [],
    selectedWallet: selected
      ? { mode: 'server', namespace: 'evm', ref: { address: selected } }
      : undefined,
    pendingJobs: [],
  };
  const ctx: HostContext = {
    publicClient: () =>
      chain.client() as unknown as ReturnType<HostContext['publicClient']>,
    walletStateManager: { read: () => snapshot },
    walletExecutor: async (_io, source) => {
      const entry: ExecutorLog = { source, requests: [] };
      log.push(entry);
      const execute: EvmWalletExecutor = async (request) => {
        entry.requests.push(request);
        if (request.kind === 'typed-data') {
          const who = opts.typedSigner ?? selected ?? wallets[0]!;
          const account = ACCOUNTS.find((a) => a.address === getAddress(who));
          if (!account) throw new Error('no key for signer');
          const t = request.typedData;
          return {
            kind: 'signature',
            status: 'SIGNED',
            signature: await account.signTypedData({
              domain: t.domain,
              types: t.types,
              primaryType: t.primaryType,
              message: t.message,
            } as Parameters<typeof account.signTypedData>[0]),
          };
        }
        if (request.kind !== 'transaction')
          throw new Error('unexpected message signature request');
        if (opts.rejectWith)
          return {
            kind: 'transaction',
            hash: '',
            status: 'FAILED',
            failureCode: opts.rejectWith,
            failureDescription: 'blocked by policy',
          };
        const signer = opts.signer ?? selected ?? wallets[0]!;
        const hash = chain.mine(
          signer,
          getAddress(request.transaction.to),
          request.transaction.data ?? '0x',
        );
        return { kind: 'transaction', hash, status: 'CONFIRMED' };
      };
      return execute;
    },
  };
  return { ctx, log };
}

/** Mirrors the host's restricted plugin context: capabilities gate services and the executor. */
export function restrictLikeHost(
  ctx: HostContext,
  command: SynqCommandId,
  granted: readonly Capability[],
): HostContext {
  const denied = (cap: string) => {
    const e = new Error(
      `Plugin '${command}' did not declare the '${cap}' capability.`,
    ) as Error & { code: string };
    e.code = 'PERMISSION_DENIED';
    return e;
  };
  const restricted = {} as HostContext;
  for (const key of ['publicClient', 'walletStateManager'] as const)
    Object.defineProperty(restricted, key, {
      get: () => {
        if (!granted.includes('wallet-read')) throw denied('wallet-read');
        return ctx[key];
      },
    });
  Object.defineProperty(restricted, 'walletExecutor', {
    value: granted.includes('wallet-submit')
      ? ctx.walletExecutor
      : async () => {
          throw denied('wallet-submit');
        },
  });
  return Object.freeze(restricted);
}

export const fakeIo = {} as unknown as CommandIO;
