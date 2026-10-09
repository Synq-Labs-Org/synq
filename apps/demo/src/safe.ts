import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
  factoryAbi,
  moduleAbi,
  registryAbi,
  safeAbi,
  tokenAbi,
} from '@synq/execution-worker/abi';
import type { MandateConfig } from '@synq/kernel';

const ArtifactSchema = z.object({
  bytecode: z.object({
    object: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .transform((v) => v as Hex),
  }),
});
function bytecode(file: string): Hex {
  return ArtifactSchema.parse(
    JSON.parse(readFileSync(`contracts/out/${file}`, 'utf8')),
  ).bytecode.object;
}

export interface LocalGovernance {
  setExecutor(who: Address, allowed: boolean): Promise<Hex>;
  configureMandate(mandateId: Hex, config: MandateConfig): Promise<Hex>;
  supersedeMandate(
    mandateId: Hex,
    version: bigint,
    config: MandateConfig,
    securitySensitive: boolean,
  ): Promise<Hex>;
  revokeMandate(mandateId: Hex): Promise<Hex>;
  pause(): Promise<Hex>;
  unpause(): Promise<Hex>;
}
export interface LocalSynq {
  url: string;
  client: PublicClient<HttpTransport, typeof anvil>;
  owners: PrivateKeyAccount[];
  executor: PrivateKeyAccount;
  recipient: Address;
  factory: Address;
  registry: Address;
  module: Address;
  token: Address;
  account: Address;
  chainGroupId: Hex;
  deploymentTransactions: Hex[];
  deploymentBlock: bigint | null;
  governance: LocalGovernance;
  fund(amount: bigint): Promise<Hex>;
}

export async function deployLocalSynq(url: string): Promise<LocalSynq> {
  const transport: HttpTransport = http(url, { retryCount: 0 });
  const client: PublicClient<HttpTransport, typeof anvil> = createPublicClient({
    chain: anvil,
    transport,
  });
  if ((await client.getChainId()) !== 31337)
    throw new Error('LOCAL_SYNQ_REQUIRES_ANVIL');
  const owners = [0, 1, 2]
    .map(() => privateKeyToAccount(generatePrivateKey()))
    .sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
  const deployer = privateKeyToAccount(generatePrivateKey());
  const executor = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const test = createTestClient({ chain: anvil, mode: 'anvil', transport });
  for (const who of [...owners, deployer, executor])
    await test.setBalance({ address: who.address, value: 10n ** 20n });
  const wallet: WalletClient<HttpTransport, typeof anvil, PrivateKeyAccount> =
    createWalletClient({ chain: anvil, account: deployer, transport });
  const deploymentTransactions: Hex[] = [];
  let deploymentBlock: bigint | null = null;
  async function mined(hash: Hex) {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('LOCAL_TX_REVERTED');
    return receipt;
  }
  async function deploy(file: string) {
    const hash = await wallet.sendTransaction({ data: bytecode(file) });
    deploymentTransactions.push(hash);
    const receipt = await mined(hash);
    deploymentBlock ??= receipt.blockNumber;
    if (!receipt.contractAddress) throw new Error('LOCAL_DEPLOYMENT_FAILED');
    return receipt.contractAddress;
  }
  const singleton = await deploy('SafeL2.sol/SafeL2.json');
  const proxyFactory = await deploy(
    'SafeProxyFactory.sol/SafeProxyFactory.json',
  );
  const fallbackHandler = await deploy(
    'CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json',
  );
  const factoryHash = await wallet.deployContract({
    abi: factoryAbi,
    bytecode: bytecode('SynqGroupFactory.sol/SynqGroupFactory.json'),
    args: [singleton, proxyFactory, fallbackHandler],
  });
  deploymentTransactions.push(factoryHash);
  const factory = (await mined(factoryHash)).contractAddress!;
  const registry = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'registry',
  });
  const module = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'module',
  });
  const token = await deploy('LocalTestToken.sol/LocalTestToken.json');
  const salt = keccak256(stringToHex('synq.local.group'));
  const { result } = await client.simulateContract({
    account: deployer,
    address: factory,
    abi: factoryAbi,
    functionName: 'createGroup',
    args: [owners.map((o) => o.address), 2n, salt],
  });
  const [chainGroupId, account] = result;
  const createHash = await wallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'createGroup',
    args: [owners.map((o) => o.address), 2n, salt],
  });
  deploymentTransactions.push(createHash);
  await mined(createHash);

  async function safeExec(
    to: Address,
    data: Hex,
    signers: readonly PrivateKeyAccount[] = owners.slice(0, 2),
  ): Promise<Hex> {
    const nonce = await client.readContract({
      address: account,
      abi: safeAbi,
      functionName: 'nonce',
    });
    const txHash = await client.readContract({
      address: account,
      abi: safeAbi,
      functionName: 'getTransactionHash',
      args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
    });
    const ordered = [...signers].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
    const signatures = concat(
      await Promise.all(ordered.map((o) => o.sign({ hash: txHash }))),
    );
    const hash = await wallet.writeContract({
      address: account,
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
    });
    await mined(hash);
    return hash;
  }
  const governance: LocalGovernance = {
    setExecutor: (who: Address, allowed: boolean) =>
      safeExec(
        module,
        encodeFunctionData({
          abi: moduleAbi,
          functionName: 'setExecutor',
          args: [who, allowed],
        }),
      ),
    configureMandate: (mandateId: Hex, config: MandateConfig) =>
      safeExec(
        registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'configureMandate',
          args: [mandateId, config],
        }),
      ),
    supersedeMandate: (
      mandateId: Hex,
      version: bigint,
      config: MandateConfig,
      securitySensitive: boolean,
    ) =>
      safeExec(
        registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'supersedeMandate',
          args: [mandateId, version, config, securitySensitive],
        }),
      ),
    revokeMandate: (mandateId: Hex) =>
      safeExec(
        registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'revokeMandate',
          args: [mandateId],
        }),
      ),
    pause: () =>
      safeExec(
        module,
        encodeFunctionData({ abi: moduleAbi, functionName: 'pause' }),
      ),
    unpause: () =>
      safeExec(
        module,
        encodeFunctionData({ abi: moduleAbi, functionName: 'unpause' }),
      ),
  };
  async function fund(amount: bigint): Promise<Hex> {
    const hash = await wallet.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: 'mint',
      args: [account, amount],
    });
    await mined(hash);
    return hash;
  }
  return {
    url,
    client,
    owners,
    executor,
    recipient,
    factory,
    registry,
    module,
    token,
    account,
    chainGroupId,
    deploymentTransactions,
    deploymentBlock: deploymentBlock as bigint | null,
    governance,
    fund,
  };
}
