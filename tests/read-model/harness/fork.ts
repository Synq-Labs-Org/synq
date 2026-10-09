import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  contractAddress,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import factoryAbiJson from '../../../contracts/abi/SynqGroupFactory.json' with { type: 'json' };
import registryAbiJson from '../../../contracts/abi/MandateRegistry.json' with { type: 'json' };
import moduleAbiJson from '../../../contracts/abi/ExecutionModule.json' with { type: 'json' };
import safeAbiJson from '../../../contracts/abi/SafeL2.json' with { type: 'json' };

export const factoryAbi = factoryAbiJson as Abi;
export const registryAbi = registryAbiJson as Abi;
export const moduleAbi = moduleAbiJson as Abi;
export const safeAbi = safeAbiJson as Abi;
export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const faucetAbi = parseAbi([
  'function requestFunds(address recipient)',
  'function faucetDripAmount() view returns (uint256)',
]);
export const AUSD = getAddress(officialAssets.testnetAUSD.address);
export const FAUCET = getAddress(monadTestnetProfile.faucetAddress!);
export const CHAIN_ID = 10143;
const chain = {
  id: CHAIN_ID,
  name: 'monad-testnet-fork',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
} as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}

export interface Owner {
  address: Address;
  sign(hash: Hex): Promise<Hex>;
  signGrant(module: Address, grant: Grant): Promise<Hex>;
}
export interface Grant {
  groupId: Hex;
  account: Address;
  mandateId: Hex;
  mandateVersion: bigint;
  executor: Address;
  pluginId: Hex;
  chainId: bigint;
  target: Address;
  selector: Hex;
  calldataHash: Hex;
  token: Address;
  maxInputAmount: bigint;
  nativeValue: bigint;
  minOutputAmount: bigint;
  recipient: Address;
  validAfter: bigint;
  validUntil: bigint;
  nonce: bigint;
  intentHash: Hex;
}
const grantTypes = {
  ExecutionGrant: [
    { name: 'groupId', type: 'bytes32' },
    { name: 'account', type: 'address' },
    { name: 'mandateId', type: 'bytes32' },
    { name: 'mandateVersion', type: 'uint256' },
    { name: 'executor', type: 'address' },
    { name: 'pluginId', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'calldataHash', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'maxInputAmount', type: 'uint256' },
    { name: 'nativeValue', type: 'uint256' },
    { name: 'minOutputAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'intentHash', type: 'bytes32' },
  ],
} as const;

export function makeOwner(): Owner {
  const signer = privateKeyToAccount(generatePrivateKey());
  return {
    address: signer.address,
    sign: (hash) => signer.sign({ hash }),
    signGrant: (module, grant) =>
      signer.signTypedData({
        domain: {
          name: 'SynqExecutionModule',
          version: '1',
          chainId: CHAIN_ID,
          verifyingContract: module,
        },
        types: grantTypes,
        primaryType: 'ExecutionGrant',
        message: grant,
      }),
  };
}

export interface ForkDeployment {
  factory: Address;
  registry: Address;
  module: Address;
  deploymentBlock: number;
  transactionHash: Hex;
}
export interface CreatedGroup {
  groupId: Hex;
  account: Address;
  owners: Owner[];
  blockNumber: number;
  transactionHash: Hex;
}

export class ForkChain {
  readonly client: PublicClient;
  readonly test;
  readonly relayer: Address = getAddress(
    '0x00000000000000000000000000000000000a11ce',
  );
  private constructor(
    readonly url: string,
    private readonly process: ChildProcess,
  ) {
    const transport = http(url, { retryCount: 0, timeout: 60_000 });
    this.client = createPublicClient({ chain, transport });
    this.test = createTestClient({ chain, mode: 'anvil', transport });
  }
  static async start(
    forkUrl = process.env.SYNQ_MONAD_TESTNET_RPC_URL ??
      monadTestnetProfile.defaultRpcUrl,
  ): Promise<ForkChain> {
    const port = await freePort();
    const child = spawn(
      process.env.SYNQ_ANVIL_BIN ?? 'anvil',
      [
        '--fork-url',
        forkUrl,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--silent',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += String(c)));
    const fork = new ForkChain(`http://127.0.0.1:${port}`, child);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr}`);
      try {
        if ((await fork.client.getChainId()) === CHAIN_ID) {
          await fork.test.setBalance({
            address: fork.relayer,
            value: 10n ** 21n,
          });
          await fork.test.impersonateAccount({ address: fork.relayer });
          return fork;
        }
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill('SIGKILL');
    throw new Error(`anvil fork unavailable: ${stderr}`);
  }
  async stop(): Promise<void> {
    if (this.process.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.process.once('exit', () => resolve());
      this.process.kill('SIGTERM');
    });
  }
  private wallet(from: Address) {
    return createWalletClient({
      chain,
      account: from,
      transport: http(this.url, { retryCount: 0, timeout: 60_000 }),
    });
  }
  async send(to: Address | null, data: Hex, from: Address = this.relayer) {
    const hash = await this.wallet(from).sendTransaction({
      to: to ?? undefined,
      data,
      account: from,
      chain,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted ${hash}`);
    return receipt;
  }
  async deployFactory(): Promise<ForkDeployment> {
    const artifact = JSON.parse(
      readFileSync(
        'contracts/out/SynqGroupFactory.sol/SynqGroupFactory.json',
        'utf8',
      ),
    ) as { bytecode: { object: Hex } };
    const args = encodeFunctionData({
      abi: parseAbi(['function constructorArgs(address,address,address)']),
      functionName: 'constructorArgs',
      args: [
        contractAddress(CHAIN_ID, 'SAFE_L2'),
        contractAddress(CHAIN_ID, 'SAFE_PROXY_FACTORY'),
        contractAddress(CHAIN_ID, 'SAFE_COMPATIBILITY_FALLBACK_HANDLER'),
      ],
    });
    const receipt = await this.send(
      null,
      concat([artifact.bytecode.object, `0x${args.slice(10)}`]),
    );
    const factory = getAddress(receipt.contractAddress!);
    const read = (functionName: string) =>
      this.client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName,
      }) as Promise<Address>;
    return {
      factory,
      registry: getAddress(await read('registry')),
      module: getAddress(await read('module')),
      deploymentBlock: Number(receipt.blockNumber),
      transactionHash: receipt.transactionHash,
    };
  }
  receipts(d: ForkDeployment) {
    return {
      deployment: {
        chainId: CHAIN_ID,
        SynqGroupFactory: d.factory,
        MandateRegistry: d.registry,
        ExecutionModule: d.module,
      },
      receipts: {
        chainId: CHAIN_ID,
        transactions: [
          {
            hash: d.transactionHash,
            blockNumber: d.deploymentBlock,
            status: 1,
          },
        ],
      },
    };
  }
  async createGroup(
    d: ForkDeployment,
    label: string,
    threshold = 2n,
  ): Promise<CreatedGroup> {
    const owners = [makeOwner(), makeOwner(), makeOwner()];
    const receipt = await this.send(
      d.factory,
      encodeFunctionData({
        abi: factoryAbi,
        functionName: 'createGroup',
        args: [
          owners.map((o) => o.address),
          threshold,
          keccak256(stringToHex(label)),
        ],
      }),
    );
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== d.factory.toLowerCase()) continue;
      const decoded = decodeEventLog({
        abi: factoryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'GroupCreated') {
        const args = decoded.args as unknown as {
          groupId: Hex;
          account: Address;
        };
        return {
          groupId: args.groupId,
          account: getAddress(args.account),
          owners,
          blockNumber: Number(receipt.blockNumber),
          transactionHash: receipt.transactionHash,
        };
      }
    }
    throw new Error('GroupCreated missing');
  }
  async safeExec(
    group: CreatedGroup,
    to: Address,
    data: Hex,
    signers = group.owners.slice(0, 2),
  ) {
    const nonce = (await this.client.readContract({
      address: group.account,
      abi: safeAbi,
      functionName: 'nonce',
    })) as bigint;
    const zero = '0x0000000000000000000000000000000000000000' as Address;
    const txHash = (await this.client.readContract({
      address: group.account,
      abi: safeAbi,
      functionName: 'getTransactionHash',
      args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, nonce],
    })) as Hex;
    const sorted = [...signers].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
    const signatures = concat(
      await Promise.all(sorted.map((s) => s.sign(txHash))),
    );
    return this.send(
      group.account,
      encodeFunctionData({
        abi: safeAbi,
        functionName: 'execTransaction',
        args: [to, 0n, data, 0, 0n, 0n, 0n, zero, zero, signatures],
      }),
    );
  }
  async fundFromFaucet(recipient: Address) {
    const holder = privateKeyToAccount(generatePrivateKey()).address;
    await this.test.setBalance({ address: holder, value: 10n ** 20n });
    await this.test.impersonateAccount({ address: holder });
    await this.test.increaseTime({ seconds: 2 * 86_400 });
    await this.send(
      FAUCET,
      encodeFunctionData({
        abi: faucetAbi,
        functionName: 'requestFunds',
        args: [holder],
      }),
      holder,
    );
    return this.send(
      AUSD,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, await this.faucetDrip()],
      }),
      holder,
    );
  }
  async faucetDrip(): Promise<bigint> {
    return (await this.client.readContract({
      address: FAUCET,
      abi: faucetAbi,
      functionName: 'faucetDripAmount',
    })) as bigint;
  }
  async balanceOf(account: Address, blockNumber?: bigint): Promise<bigint> {
    return (await this.client.readContract({
      address: AUSD,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
      blockNumber,
    })) as bigint;
  }
  async mine(blocks = 1) {
    await this.test.mine({ blocks });
  }
  async head(): Promise<number> {
    return Number(await this.client.getBlockNumber({ cacheTime: 0 }));
  }
}

export const MANDATE_ID = keccak256(stringToHex('read-model-mandate'));
export function mandateConfig(recipient: Address, mandateHash: Hex) {
  return {
    mandateHash,
    token: AUSD,
    maxTokenPerAction: 5_000_000n,
    maxNativePerAction: 0n,
    cumulativeTokenCap: 20_000_000n,
    cumulativeNativeCap: 0n,
    validAfter: 0n,
    validUntil: 4_000_000_000n,
    callTargets: [AUSD],
    callSelectors: ['0xa9059cbb' as Hex],
    recipients: [recipient],
  };
}

export async function executeTransfer(
  fork: ForkChain,
  d: ForkDeployment,
  group: CreatedGroup,
  executor: Address,
  recipient: Address,
  amount: bigint,
  nonce: bigint,
) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amount],
  });
  const block = await fork.client.getBlock();
  const grant: Grant = {
    groupId: group.groupId,
    account: group.account,
    mandateId: MANDATE_ID,
    mandateVersion: 1n,
    executor,
    pluginId: keccak256(stringToHex('plugin:transfer')),
    chainId: BigInt(CHAIN_ID),
    target: AUSD,
    selector: '0xa9059cbb',
    calldataHash: keccak256(data),
    token: AUSD,
    maxInputAmount: amount,
    nativeValue: 0n,
    minOutputAmount: amount,
    recipient,
    validAfter: block.timestamp - 10n,
    validUntil: block.timestamp + 3600n,
    nonce,
    intentHash: keccak256(stringToHex(`intent-${nonce}`)),
  };
  const sorted = [...group.owners.slice(0, 2)].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  );
  const signatures = concat(
    await Promise.all(sorted.map((o) => o.signGrant(d.module, grant))),
  );
  await fork.test.setBalance({ address: executor, value: 10n ** 20n });
  await fork.test.impersonateAccount({ address: executor });
  return fork.send(
    d.module,
    encodeFunctionData({
      abi: moduleAbi,
      functionName: 'execute',
      args: [grant, data, signatures],
    }),
    executor,
  );
}
