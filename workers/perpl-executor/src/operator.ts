import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import {
  profileConfiguration,
  type PerplNetworkConfig,
} from '@synq/chain-registry';
import {
  ExchangeReader,
  erc20Abi,
  exchangeAbi,
  exchangeCalls,
  type ExchangeAccount,
} from '@synq/plugin-perpl';

// The Perpl account used for REAL_TESTNET evidence is owned by the funded
// test-only operator key: a test-harness operator account, not a group
// treasury and not a custody design. Mainnet is refused unconditionally.
export const OPERATOR_ACCOUNT_LABEL = 'TEST_HARNESS_OPERATOR_ACCOUNT';

export class OperatorError extends Error {
  constructor(
    readonly code:
      | 'KEY_FILE_REQUIRED'
      | 'KEY_FILE_INVALID'
      | 'MAINNET_REFUSED'
      | 'WRONG_CHAIN'
      | 'TX_REVERTED'
      | 'SPEND_CAP'
      | 'INSUFFICIENT_COLLATERAL',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'OperatorError';
  }
}

export type RecordedTx = Readonly<{
  step: string;
  hash: Hex;
  blockNumber: string;
  gasUsed: string;
  gasLimit: string;
  effectiveGasPrice: string;
  feeWei: string;
  status: 'success' | 'reverted';
}>;

export function loadOperatorAccount(
  path = process.env.SYNQ_TESTNET_KEY_FILE,
): PrivateKeyAccount {
  if (!path) throw new OperatorError('KEY_FILE_REQUIRED');
  const text = readFileSync(path, 'utf8').trim();
  const key = (text.startsWith('0x') ? text : `0x${text}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new OperatorError('KEY_FILE_INVALID');
  return privateKeyToAccount(key);
}

export interface OperatorHarness {
  readonly label: typeof OPERATOR_ACCOUNT_LABEL;
  readonly address: Address;
  readonly client: PublicClient;
  readonly transactions: RecordedTx[];
  spentWei(): bigint;
  collateralBalance(): Promise<bigint>;
  nativeBalance(): Promise<bigint>;
  exchangeAccount(): Promise<ExchangeAccount | null>;
  faucet(faucetAddress: Address): Promise<TransactionReceipt>;
  approveExact(amount: bigint): Promise<TransactionReceipt | null>;
  createAccount(
    amount: bigint,
  ): Promise<{ receipt: TransactionReceipt; accountId: bigint | null }>;
  allowOrderForwarding(allow: boolean): Promise<{
    receipt: TransactionReceipt;
    event: { accountId: bigint; allowed: boolean } | null;
  }>;
  signTypedData(definition: TypedDataDefinition): Promise<Hex>;
}

export async function connectOperator(
  network: PerplNetworkConfig,
  account: PrivateKeyAccount,
  options: { maxSpendWei: bigint; rpcUrl?: string },
): Promise<OperatorHarness> {
  if (network.label !== 'TESTNET' || !network.mutationEnabled)
    throw new OperatorError('MAINNET_REFUSED', network.profile);
  const config = profileConfiguration(network.profile);
  const transport = http(
    options.rpcUrl ??
      process.env[config.rpcEnvironment] ??
      config.defaultRpcUrl,
    { retryCount: 4, retryDelay: 500 },
  );
  const client = createPublicClient({
    chain: monadTestnet,
    transport,
  }) as PublicClient;
  if ((await client.getChainId()) !== network.chainId)
    throw new OperatorError('WRONG_CHAIN');
  const wallet = createWalletClient({
    chain: monadTestnet,
    account,
    transport,
  });
  const reader = new ExchangeReader(client, network);
  const transactions: RecordedTx[] = [];
  let spentWei = 0n;

  async function send(
    step: string,
    to: Address,
    data: Hex,
  ): Promise<TransactionReceipt> {
    const gas = await client.estimateGas({
      account: account.address,
      to,
      data,
    });
    const gasLimit = (gas * 12n) / 10n;
    const fees = await client.estimateFeesPerGas();
    // Monad charges the gas limit, so the cap is enforced on the worst case.
    const worst = gasLimit * fees.maxFeePerGas;
    if (spentWei + worst > options.maxSpendWei)
      throw new OperatorError(
        'SPEND_CAP',
        `${step}: ${spentWei + worst} > ${options.maxSpendWei}`,
      );
    // The test key may be shared with other harness processes: take the
    // pending nonce and retry a bounded number of times on nonce races.
    let hash: Hex | null = null;
    for (let attempt = 0; hash === null; attempt++) {
      const nonce = await client.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      });
      try {
        hash = await wallet.sendTransaction({
          to,
          data,
          gas: gasLimit,
          nonce,
          chain: monadTestnet,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (
          attempt >= 3 ||
          !/higher priority|nonce too low|already known|replacement/i.test(text)
        )
          throw error;
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
    });
    const fee = gasLimit * receipt.effectiveGasPrice;
    spentWei += fee;
    transactions.push({
      step,
      hash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      gasLimit: gasLimit.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      feeWei: fee.toString(),
      status: receipt.status,
    });
    if (receipt.status !== 'success')
      throw new OperatorError('TX_REVERTED', `${step} ${hash}`);
    return receipt;
  }

  const collateral = network.collateral.address;
  return {
    label: OPERATOR_ACCOUNT_LABEL,
    address: account.address.toLowerCase() as Address,
    client,
    transactions,
    spentWei: () => spentWei,
    collateralBalance: () =>
      client.readContract({
        address: collateral,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      }),
    nativeBalance: () => client.getBalance({ address: account.address }),
    exchangeAccount: (): Promise<ExchangeAccount | null> =>
      reader.accountOf(account.address),
    async faucet(faucetAddress: Address) {
      return send(
        'agora-faucet.requestFunds',
        faucetAddress,
        exchangeCalls.requestFunds(account.address),
      );
    },
    async approveExact(amount: bigint) {
      const current = await client.readContract({
        address: collateral,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, network.exchange],
      });
      if (current === amount) return null;
      return send(
        'collateral.approve(exact)',
        collateral,
        exchangeCalls.approve(network.exchange, amount),
      );
    },
    async createAccount(amount: bigint) {
      const balance = await client.readContract({
        address: collateral,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      if (balance < amount)
        throw new OperatorError(
          'INSUFFICIENT_COLLATERAL',
          `${balance} < ${amount}`,
        );
      const receipt = await send(
        'exchange.createAccount',
        network.exchange,
        exchangeCalls.createAccount(amount),
      );
      const created = parseEventLogs({
        abi: exchangeAbi,
        logs: receipt.logs,
        eventName: 'AccountCreated',
      });
      return { receipt, accountId: created[0]?.args.id ?? null };
    },
    async allowOrderForwarding(allow: boolean) {
      const receipt = await send(
        `exchange.allowOrderForwarding(${allow})`,
        network.exchange,
        exchangeCalls.allowOrderForwarding(allow),
      );
      const events = parseEventLogs({
        abi: exchangeAbi,
        logs: receipt.logs,
        eventName: 'OrderForwardingUpdated',
      });
      return { receipt, event: events[0]?.args ?? null };
    },
    signTypedData: (definition) => account.signTypedData(definition),
  };
}
