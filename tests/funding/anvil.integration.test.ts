import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { LOCAL_CHAIN_ID, type Asset } from '@synq/domain';
import {
  AusdGuard,
  FundingError,
  ausdAbi,
  requireOfficialAusd,
} from '@synq/funding';
import { monadTestnetProfile } from '@synq/chain-registry';
import { startAnvil } from '../../apps/demo/src/anvil.js';
import fake from './fixtures/fake-ausd.json' with { type: 'json' };

let node: Awaited<ReturnType<typeof startAnvil>>;
let client: PublicClient;
let token: Address;
let asset: Asset;
const deployer = privateKeyToAccount(generatePrivateKey());
const member = `0x${'5a'.repeat(20)}` as Address;
const recipient = `0x${'6b'.repeat(20)}` as Address;

async function write(functionName: string, args: unknown[]) {
  const wallet = createWalletClient({
    chain: anvil,
    account: deployer,
    transport: http(node.url),
  });
  const hash = await wallet.writeContract({
    address: token,
    abi: fake.abi as Abi,
    functionName,
    args,
  });
  await client.waitForTransactionReceipt({ hash });
}

beforeAll(async () => {
  node = await startAnvil();
  client = createPublicClient({
    chain: anvil,
    transport: http(node.url),
  }) as PublicClient;
  await createTestClient({
    chain: anvil,
    mode: 'anvil',
    transport: http(node.url),
  }).setBalance({
    address: deployer.address,
    value: 10n ** 20n,
  });
  const wallet = createWalletClient({
    chain: anvil,
    account: deployer,
    transport: http(node.url),
  });
  const hash = await wallet.deployContract({
    abi: fake.abi as Abi,
    bytecode: fake.bytecode as Hex,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  token = receipt.contractAddress!.toLowerCase() as Address;
  asset = {
    canonicalAssetId: `eip155:${LOCAL_CHAIN_ID}/erc20:${token}`,
    chainId: LOCAL_CHAIN_ID,
    address: token,
    symbol: 'AUSD',
    decimals: 6,
  };
  await write('mint', [deployer.address, 10_000_000n]);
}, 30_000);
afterAll(() => node?.close());

describe('AUSD guard and registry against a deployed impostor (Anvil)', () => {
  it('AUSD-003 same symbol, wrong contract: on-chain "AUSD" is still rejected by registry identity', async () => {
    const symbol = await client.readContract({
      address: token,
      abi: ausdAbi,
      functionName: 'symbol',
    });
    expect(symbol).toBe('AUSD');
    for (const chainId of [LOCAL_CHAIN_ID, monadTestnetProfile.network.chainId])
      expect(() =>
        requireOfficialAusd(
          { chainId, address: token, symbol, decimals: 6 },
          monadTestnetProfile.network.chainId,
        ),
      ).toThrow(FundingError);
    const guard = new AusdGuard(client);
    const result = await guard.check({
      asset,
      account: deployer.address,
      recipient,
      amount: 1n,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toEqual(['NOT_OFFICIAL_AUSD']);
  });

  it('AUSD-017 freeze/pause simulation blocks before authorization; clean state passes', async () => {
    const guard = new AusdGuard(client, { localToken: asset });
    const input = {
      asset,
      account: deployer.address.toLowerCase() as Address,
      recipient,
      amount: 1_000_000n,
    };
    expect((await guard.check(input)).status).toBe('PASS');

    await write('setTransferPaused', [true]);
    const paused = await guard.check(input);
    expect(paused.status).toBe('BLOCKED');
    expect(paused.reasons).toContain('TRANSFER_PAUSED');
    expect(paused.reasons).toContain('TRANSFER_SIMULATION_REVERTED');
    await expect(guard.require(input)).rejects.toThrow('AUSD_GUARD_BLOCKED');
    await write('setTransferPaused', [false]);

    await write('setFrozen', [recipient, true]);
    const frozen = await guard.check(input);
    expect(frozen.reasons).toEqual(
      expect.arrayContaining([
        'RECIPIENT_FROZEN',
        'TRANSFER_SIMULATION_REVERTED',
      ]),
    );
    await write('setFrozen', [recipient, false]);
    await write('setFrozen', [deployer.address, true]);
    expect((await guard.check(input)).reasons).toContain('SOURCE_FROZEN');
    await write('setFrozen', [deployer.address, false]);

    const broke = await guard.check({ ...input, account: member });
    expect(broke.reasons).toEqual(['TRANSFER_SIMULATION_REVERTED']);
    expect((await guard.check(input)).status).toBe('PASS');
  });

  it('a token without AUSD control readers fails closed (CONTROL_READ_FAILED)', async () => {
    const guard = new AusdGuard(client, {
      localToken: {
        ...asset,
        address: recipient,
        canonicalAssetId: `eip155:${LOCAL_CHAIN_ID}/erc20:${recipient}`,
      },
    });
    const result = await guard.check({
      asset: {
        ...asset,
        address: recipient,
        canonicalAssetId: `eip155:${LOCAL_CHAIN_ID}/erc20:${recipient}`,
      },
      account: deployer.address,
      recipient: member,
      amount: 1n,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toContain('CONTROL_READ_FAILED');
  });

  it('a local guard token is refused on a non-local chain', async () => {
    const forged = {
      ...asset,
      chainId: monadTestnetProfile.network.chainId,
      canonicalAssetId: `eip155:${monadTestnetProfile.network.chainId}/erc20:${token}`,
    } as Asset;
    const guard = new AusdGuard(client, { localToken: forged });
    const result = await guard.check({
      asset: forged,
      account: deployer.address,
      recipient,
      amount: 1n,
    });
    expect(result.reasons).toEqual(['NOT_OFFICIAL_AUSD']);
  });
});
