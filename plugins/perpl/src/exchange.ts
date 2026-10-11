import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { PerplNetworkConfig } from '@synq/chain-registry';
import { PerplError } from './errors.js';

// Subset of the Exchange ABI from PerplFoundation/dex-sdk
// crates/sdk/abi/dex/Exchange.json (REVISION rc_v1.1.7-203-g0e5902dd).
// Withdrawal and transfer entry points are deliberately absent.
const accountInfo = {
  name: 'accountInfo',
  type: 'tuple',
  components: [
    { name: 'accountId', type: 'uint256' },
    { name: 'balanceCNS', type: 'uint256' },
    { name: 'lockedBalanceCNS', type: 'uint256' },
    { name: 'frozen', type: 'uint8' },
    { name: 'accountAddr', type: 'address' },
    {
      name: 'positions',
      type: 'tuple',
      components: [
        { name: 'bank1', type: 'uint256' },
        { name: 'bank2', type: 'uint256' },
        { name: 'bank3', type: 'uint256' },
        { name: 'bank4', type: 'uint256' },
      ],
    },
  ],
} as const;
export const exchangeAbi = [
  {
    type: 'function',
    name: 'getAccountByAddr',
    stateMutability: 'view',
    inputs: [{ name: 'accountAddress', type: 'address' }],
    outputs: [accountInfo],
  },
  {
    type: 'function',
    name: 'getAccountById',
    stateMutability: 'view',
    inputs: [{ name: 'accountId', type: 'uint256' }],
    outputs: [accountInfo],
  },
  {
    type: 'function',
    name: 'getExchangeInfo',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'balanceCNS', type: 'uint256' },
      { name: 'protocolBalanceCNS', type: 'uint256' },
      { name: 'recycleBalanceCNS', type: 'uint256' },
      { name: 'collateralDecimals', type: 'uint256' },
      { name: 'collateralToken', type: 'address' },
      { name: 'verifierProxy', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'getMinAccountOpenCNS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'minAccountOpenCNS', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountCNS', type: 'uint256' }],
    outputs: [{ name: 'accountId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowOrderForwarding',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'allow', type: 'bool' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'AccountCreated',
    anonymous: false,
    inputs: [
      { name: 'account', type: 'address', indexed: false },
      { name: 'id', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OrderForwardingUpdated',
    anonymous: false,
    inputs: [
      { name: 'accountId', type: 'uint256', indexed: false },
      { name: 'allowed', type: 'bool', indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;
export const ausdFaucetAbi = [
  {
    type: 'function',
    name: 'requestFunds',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [],
  },
] as const;

export type ExchangeAccount = Readonly<{
  accountId: bigint;
  balance: bigint;
  lockedBalance: bigint;
  frozen: number;
  owner: Address;
}>;
export type ExchangeInfo = Readonly<{
  collateralToken: Address;
  collateralDecimals: number;
  minAccountOpen: bigint;
}>;

export class ExchangeReader {
  constructor(
    private readonly client: PublicClient,
    readonly network: PerplNetworkConfig,
  ) {}
  async info(): Promise<ExchangeInfo> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.network.chainId)
      throw new PerplError('PROFILE_MISMATCH', `rpc is chain ${chainId}`);
    const [info, minOpen] = await Promise.all([
      this.client.readContract({
        address: this.network.exchange,
        abi: exchangeAbi,
        functionName: 'getExchangeInfo',
      }),
      this.client.readContract({
        address: this.network.exchange,
        abi: exchangeAbi,
        functionName: 'getMinAccountOpenCNS',
      }),
    ]);
    return Object.freeze({
      collateralToken: info[4].toLowerCase() as Address,
      collateralDecimals: Number(info[3]),
      minAccountOpen: minOpen,
    });
  }
  async accountOf(owner: Address): Promise<ExchangeAccount | null> {
    try {
      const a = await this.client.readContract({
        address: this.network.exchange,
        abi: exchangeAbi,
        functionName: 'getAccountByAddr',
        args: [owner],
      });
      if (a.accountId === 0n) return null;
      return Object.freeze({
        accountId: a.accountId,
        balance: a.balanceCNS,
        lockedBalance: a.lockedBalanceCNS,
        frozen: a.frozen,
        owner: a.accountAddr.toLowerCase() as Address,
      });
    } catch (error) {
      if (
        error instanceof BaseError &&
        error.walk((e) => e instanceof ContractFunctionRevertedError)
      )
        return null;
      throw error;
    }
  }
}

export const exchangeCalls = {
  createAccount(amount: bigint): Hex {
    if (amount <= 0n) throw new PerplError('INVALID_REQUEST', 'amount');
    return encodeFunctionData({
      abi: exchangeAbi,
      functionName: 'createAccount',
      args: [amount],
    });
  },
  allowOrderForwarding(allow: boolean): Hex {
    return encodeFunctionData({
      abi: exchangeAbi,
      functionName: 'allowOrderForwarding',
      args: [allow],
    });
  },
  approve(spender: Address, amount: bigint): Hex {
    return encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    });
  },
  requestFunds(recipient: Address): Hex {
    return encodeFunctionData({
      abi: ausdFaucetAbi,
      functionName: 'requestFunds',
      args: [recipient],
    });
  },
} as const;
