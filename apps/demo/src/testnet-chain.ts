import { readFileSync } from 'node:fs';
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { assetForRole, monadTestnetProfile } from '@synq/chain-registry';
import {
  factoryAbi,
  moduleAbi,
  registryAbi,
  safeAbi,
  tokenAbi,
} from '@synq/execution-worker/abi';
import { synqDeployment } from '@synq/execution-worker';
import {
  safeTransactionHash,
  type SafeGovernanceTransaction,
} from '@synq/identity';
import type { MandateConfig } from '@synq/kernel';

export class TestnetChainError extends Error {
  constructor(
    readonly code:
      | 'KEY_FILE_REQUIRED'
      | 'KEY_FILE_INVALID'
      | 'WRONG_CHAIN'
      | 'BUDGET_EXCEEDED'
      | 'INSUFFICIENT_FUNDS'
      | 'TX_REVERTED'
      | 'SAFE_HASH_MISMATCH'
      | 'SAFE_EXECUTION_FAILED',
    message: string = code,
  ) {
    super(message);
    this.name = 'TestnetChainError';
  }
}

export const EXPLORER_TX = 'https://testnet.monadvision.com/tx/';

export type RecordedTx = {
  step: string;
  hash: Hex;
  blockNumber: string;
  gasUsed: string;
  gasLimit: string;
  effectiveGasPrice: string;
  explorer: string;
};

export interface OwnerSigner {
  address: Address;
  label: string;
  signSafeTransaction(tx: SafeGovernanceTransaction): Promise<Hex>;
}

export function loadTestnetSigner(
  path = process.env.SYNQ_TESTNET_KEY_FILE,
): PrivateKeyAccount {
  if (!path) throw new TestnetChainError('KEY_FILE_REQUIRED');
  const text = readFileSync(path, 'utf8').trim();
  const key = (text.startsWith('0x') ? text : `0x${text}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new TestnetChainError('KEY_FILE_INVALID');
  return privateKeyToAccount(key);
}

export function testnetRpcUrl(): string {
  return (
    process.env[monadTestnetProfile.rpcEnvironment] ??
    monadTestnetProfile.defaultRpcUrl
  );
}

export type TestnetGovernance = {
  setExecutor(who: Address, allowed: boolean): Promise<TransactionReceipt>;
  configureMandate(
    mandateId: Hex,
    config: MandateConfig,
  ): Promise<TransactionReceipt>;
  supersedeMandate(
    mandateId: Hex,
    version: bigint,
    config: MandateConfig,
    securitySensitive: boolean,
  ): Promise<TransactionReceipt>;
  revokeMandate(mandateId: Hex): Promise<TransactionReceipt>;
  pause(): Promise<TransactionReceipt>;
  unpause(): Promise<TransactionReceipt>;
};
export type TestnetChain = {
  client: PublicClient;
  deployer: PrivateKeyAccount;
  deployment: ReturnType<typeof synqDeployment>;
  ausd: ReturnType<typeof assetForRole>;
  transactions: RecordedTx[];
  createGroup(
    owners: readonly Address[],
    salt: Hex,
  ): Promise<{ chainGroupId: Hex; account: Address; blockNumber: bigint }>;
  governance(
    account: Address,
    owners: readonly OwnerSigner[],
  ): TestnetGovernance;
  fund(account: Address, amount: bigint): Promise<TransactionReceipt>;
  balanceOf(who: Address, blockNumber?: bigint): Promise<bigint>;
};

/** Deployer/gas payer and module executor on Monad testnet; addresses come from the manifest and registry only. */
export async function connectTestnet(
  deployer: PrivateKeyAccount,
): Promise<TestnetChain> {
  const transport = http(testnetRpcUrl(), {
    batch: { wait: 16 },
    retryCount: 6,
    retryDelay: 500,
  });
  const client = createPublicClient({
    chain: monadTestnet,
    transport,
  }) as PublicClient;
  const wallet = createWalletClient({
    chain: monadTestnet,
    account: deployer,
    transport,
  });
  if ((await client.getChainId()) !== monadTestnetProfile.network.chainId)
    throw new TestnetChainError('WRONG_CHAIN');
  const deployment = synqDeployment('sandbox/monad-testnet');
  const ausd = assetForRole(monadTestnetProfile, 'treasuryAsset');
  const transactions: RecordedTx[] = [];

  async function mined(
    step: string,
    hash: Hex,
    gasLimit: bigint,
  ): Promise<TransactionReceipt> {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: monadTestnetProfile.confirmationDepth,
    });
    transactions.push({
      step,
      hash,
      blockNumber: String(receipt.blockNumber),
      gasUsed: String(receipt.gasUsed),
      gasLimit: String(gasLimit),
      effectiveGasPrice: String(receipt.effectiveGasPrice),
      explorer: `${EXPLORER_TX}${hash}`,
    });
    if (receipt.status !== 'success')
      throw new TestnetChainError('TX_REVERTED', `${step} ${hash}`);
    return receipt;
  }

  /** Sends a deployer transaction with a gas limit tightened from the estimate (Monad bills the limit). */
  async function send(
    step: string,
    to: Address,
    data: Hex,
    percent = 130n,
  ): Promise<TransactionReceipt> {
    const estimate = await client.estimateGas({
      account: deployer.address,
      to,
      data,
    });
    const gas = (estimate * percent) / 100n;
    const hash = await wallet.sendTransaction({ to, data, gas, value: 0n });
    return mined(step, hash, gas);
  }

  async function createGroup(owners: readonly Address[], salt: Hex) {
    const args = [[...owners], 2n, salt] as const;
    const { result } = await client.simulateContract({
      account: deployer,
      address: deployment.factory,
      abi: factoryAbi,
      functionName: 'createGroup',
      args,
    });
    const [chainGroupId, account] = result;
    const receipt = await send(
      'SynqGroupFactory.createGroup',
      deployment.factory,
      encodeFunctionData({
        abi: factoryAbi,
        functionName: 'createGroup',
        args,
      }),
      120n,
    );
    const [created] = parseEventLogs({
      abi: factoryAbi,
      eventName: 'GroupCreated',
      logs: receipt.logs,
    });
    if (
      !created ||
      created.args.groupId !== chainGroupId ||
      created.args.account.toLowerCase() !== account.toLowerCase()
    )
      throw new TestnetChainError('TX_REVERTED', 'GroupCreated mismatch');
    return {
      chainGroupId,
      account: account.toLowerCase() as Address,
      blockNumber: receipt.blockNumber,
    };
  }

  function governance(
    account: Address,
    owners: readonly OwnerSigner[],
  ): TestnetGovernance {
    async function safeExec(
      step: string,
      to: Address,
      data: Hex,
      signers: readonly OwnerSigner[],
    ): Promise<TransactionReceipt> {
      const nonce = await client.readContract({
        address: account,
        abi: safeAbi,
        functionName: 'nonce',
      });
      const tx: SafeGovernanceTransaction = {
        safe: account,
        chainId: monadTestnetProfile.network.chainId,
        to,
        data,
        nonce,
      };
      const onchain = await client.readContract({
        address: account,
        abi: safeAbi,
        functionName: 'getTransactionHash',
        args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
      });
      if (onchain !== safeTransactionHash(tx))
        throw new TestnetChainError('SAFE_HASH_MISMATCH');
      const ordered = [...signers].sort((a, b) =>
        a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
      );
      const signatures = concat(
        await Promise.all(ordered.map((o) => o.signSafeTransaction(tx))),
      );
      const receipt = await send(
        step,
        account,
        encodeFunctionData({
          abi: safeAbi,
          functionName: 'execTransaction',
          args: [
            to,
            0n,
            data,
            0,
            0n,
            0n,
            0n,
            zeroAddress,
            zeroAddress,
            signatures,
          ],
        }),
        150n,
      );
      const outcome = parseEventLogs({ abi: safeAbi, logs: receipt.logs });
      if (!outcome.some((e) => e.eventName === 'ExecutionSuccess'))
        throw new TestnetChainError('SAFE_EXECUTION_FAILED', step);
      return receipt;
    }
    const quorum = owners.slice(0, 2);
    return {
      setExecutor: (who: Address, allowed: boolean) =>
        safeExec(
          'Safe.execTransaction(ExecutionModule.setExecutor)',
          deployment.module,
          encodeFunctionData({
            abi: moduleAbi,
            functionName: 'setExecutor',
            args: [who, allowed],
          }),
          quorum,
        ),
      configureMandate: (mandateId: Hex, config: MandateConfig) =>
        safeExec(
          'Safe.execTransaction(MandateRegistry.configureMandate)',
          deployment.registry,
          encodeFunctionData({
            abi: registryAbi,
            functionName: 'configureMandate',
            args: [mandateId, config],
          }),
          quorum,
        ),
      supersedeMandate: (
        mandateId: Hex,
        version: bigint,
        config: MandateConfig,
        securitySensitive: boolean,
      ) =>
        safeExec(
          'Safe.execTransaction(MandateRegistry.supersedeMandate)',
          deployment.registry,
          encodeFunctionData({
            abi: registryAbi,
            functionName: 'supersedeMandate',
            args: [mandateId, version, config, securitySensitive],
          }),
          quorum,
        ),
      revokeMandate: (mandateId: Hex) =>
        safeExec(
          'Safe.execTransaction(MandateRegistry.revokeMandate)',
          deployment.registry,
          encodeFunctionData({
            abi: registryAbi,
            functionName: 'revokeMandate',
            args: [mandateId],
          }),
          quorum,
        ),
      pause: () =>
        safeExec(
          'Safe.execTransaction(ExecutionModule.pause)',
          deployment.module,
          encodeFunctionData({ abi: moduleAbi, functionName: 'pause' }),
          quorum,
        ),
      unpause: () =>
        safeExec(
          'Safe.execTransaction(ExecutionModule.unpause)',
          deployment.module,
          encodeFunctionData({ abi: moduleAbi, functionName: 'unpause' }),
          quorum,
        ),
    };
  }

  const balanceOf = (who: Address, blockNumber?: bigint) =>
    client.readContract({
      address: ausd.address,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [who],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });

  async function fund(account: Address, amount: bigint) {
    if ((await balanceOf(deployer.address)) < amount)
      throw new TestnetChainError('INSUFFICIENT_FUNDS', 'AUSD');
    return send(
      'AUSD.transfer(deployer -> Safe)',
      ausd.address,
      encodeFunctionData({
        abi: tokenAbi,
        functionName: 'transfer',
        args: [account, amount],
      }),
    );
  }

  return {
    client,
    deployer,
    deployment,
    ausd,
    transactions,
    createGroup,
    governance,
    fund,
    balanceOf,
  };
}
