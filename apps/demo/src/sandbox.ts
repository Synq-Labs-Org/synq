import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  encodeFunctionData,
  concat,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type HttpTransport,
} from 'viem';
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
  accountAbi,
  registryAbi,
  moduleAbi,
  tokenAbi,
} from '@synq/execution-worker/abi';
const artifactSchema = z.object({
  bytecode: z.object({
    object: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .transform((v) => v as Hex),
  }),
});
function bytecode(file: string): Hex {
  return artifactSchema.parse(
    JSON.parse(readFileSync(`contracts/out/${file}`, 'utf8')),
  ).bytecode.object;
}
export interface SandboxContext {
  client: PublicClient<HttpTransport, typeof anvil>;
  wallet: WalletClient<HttpTransport, typeof anvil, PrivateKeyAccount>;
  owners: PrivateKeyAccount[];
  operator: PrivateKeyAccount;
  recipient: Address;
  account: Address;
  registry: Address;
  module: Address;
  token: Address;
  deploymentTransactions: Hex[];
  deploymentBlock: bigint | null;
  signDigest(hash: Hex, signers?: PrivateKeyAccount[]): Promise<Hex>;
  governance(target: Address, data: Hex, value?: bigint): Promise<Hex>;
  mintHash: Hex;
}
export async function sandbox(
  url: string,
  groupId: Hex,
): Promise<SandboxContext> {
  const transport = http(url, { retryCount: 0 });
  const client = createPublicClient({ chain: anvil, transport });
  if ((await client.getChainId()) !== 31337)
    throw new Error('SANDBOX_REQUIRES_LOCAL_CHAIN');
  const owners = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  const operator = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const test = createTestClient({ chain: anvil, mode: 'anvil', transport });
  for (const fixture of [...owners, operator])
    await test.setBalance({ address: fixture.address, value: 10n ** 20n });
  const wallet = createWalletClient({
    chain: anvil,
    account: operator,
    transport,
  });
  const deploymentTransactions: Hex[] = [];
  let deploymentBlock: bigint | null = null;
  async function deployed(hash: Hex): Promise<Address> {
    deploymentTransactions.push(hash);
    const receipt = await client.waitForTransactionReceipt({ hash });
    deploymentBlock ??= receipt.blockNumber;
    if (receipt.status !== 'success' || !receipt.contractAddress)
      throw new Error('DEPLOYMENT_REVERTED');
    return receipt.contractAddress;
  }
  const account = await deployed(
    await wallet.deployContract({
      abi: accountAbi,
      bytecode: bytecode('SandboxAccount.sol/SandboxAccount.json'),
      args: [owners.map((o) => o.address) as [Address, Address, Address]],
    }),
  );
  const registry = await deployed(
    await wallet.deployContract({
      abi: registryAbi,
      bytecode: bytecode('MandateRegistry.sol/MandateRegistry.json'),
      args: [account, groupId],
    }),
  );
  const module = await deployed(
    await wallet.deployContract({
      abi: moduleAbi,
      bytecode: bytecode('ExecutionModule.sol/ExecutionModule.json'),
      args: [account, registry],
    }),
  );
  const token = await deployed(
    await wallet.deployContract({
      abi: tokenAbi,
      bytecode: bytecode('LocalTestToken.sol/LocalTestToken.json'),
    }),
  );
  async function signDigest(
    hash: Hex,
    signers: PrivateKeyAccount[] = owners.slice(0, 2),
  ): Promise<Hex> {
    const ordered = [...signers].sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
    );
    return concat(
      await Promise.all(ordered.map((owner) => owner.sign({ hash }))),
    );
  }
  async function governance(
    target: Address,
    data: Hex,
    value = 0n,
  ): Promise<Hex> {
    const nonce = await client.readContract({
      address: account,
      abi: accountAbi,
      functionName: 'ownerNonce',
    });
    const digest = await client.readContract({
      address: account,
      abi: accountAbi,
      functionName: 'ownerTransactionHash',
      args: [target, value, data, nonce],
    });
    const hash = await wallet.writeContract({
      address: account,
      abi: accountAbi,
      functionName: 'ownerExecute',
      args: [target, value, data, await signDigest(digest)],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success')
      throw new Error('OWNER_GOVERNANCE_REVERTED');
    return hash;
  }
  await governance(
    account,
    encodeFunctionData({
      abi: accountAbi,
      functionName: 'setModule',
      args: [module, true],
    }),
  );
  const mintHash = await wallet.writeContract({
    address: token,
    abi: tokenAbi,
    functionName: 'mint',
    args: [account, 200_000_000n],
  });
  if (
    (await client.waitForTransactionReceipt({ hash: mintHash })).status !==
    'success'
  )
    throw new Error('LOCAL_TEST_TOKEN_FUNDING_FAILED');
  return {
    client,
    wallet,
    owners,
    operator,
    recipient,
    account,
    registry,
    module,
    token,
    deploymentTransactions,
    deploymentBlock,
    signDigest,
    governance,
    mintHash,
  };
}
