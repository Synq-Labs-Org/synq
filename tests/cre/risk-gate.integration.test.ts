import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { anvil } from 'viem/chains';
import {
  RpcRiskAttestationReader,
  riskAttestationRegistryAbi,
} from '@synq/plugin-chainlink-cre';
import {
  TOKEN,
  evidence,
  harness,
  hash,
  outputAsset,
  quote,
  swapIntent,
  tradeMandate,
  trust,
  type Harness,
} from '../kernel/fixtures.js';

const AUSD_ID = hash(0xa05d);
let node: ChildProcess;
let url: string;
let registry: Address;
let forwarder: Address;
let attacker: Address;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}

const clients = () => ({
  public: createPublicClient({ chain: anvil, transport: http(url) }),
  test: createTestClient({ chain: anvil, mode: 'anvil', transport: http(url) }),
  wallet: createWalletClient({ chain: anvil, transport: http(url) }),
});

function report(timestamp: bigint, status: number, price = 99_980_000n): Hex {
  return encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'uint256' },
      { type: 'uint32' },
      { type: 'uint64' },
      { type: 'uint8' },
      { type: 'bytes32' },
    ],
    [AUSD_ID, timestamp, price, 2, 30n, status, hash(5)],
  );
}

async function deliver(from: Address, timestamp: bigint, status: number) {
  const c = clients();
  const tx = await c.wallet.writeContract({
    account: from,
    address: registry,
    abi: riskAttestationRegistryAbi,
    functionName: 'onReport',
    args: ['0x', report(timestamp, status, status === 0 ? 0n : 99_980_000n)],
  });
  return c.public.waitForTransactionReceipt({ hash: tx });
}

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  node = spawn(
    'anvil',
    [
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--chain-id',
      '31337',
      '--timestamp',
      '900',
      '--no-mining',
      '--silent',
    ],
    { stdio: 'ignore' },
  );
  const c = clients();
  for (let i = 0; ; i++) {
    try {
      await c.public.getChainId();
      break;
    } catch {
      if (i > 100) throw new Error('anvil unavailable');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await c.test.setAutomine(true);
  [forwarder, attacker] = (await c.wallet.getAddresses()) as [Address, Address];
  const artifact = JSON.parse(
    readFileSync(
      'contracts/out/RiskAttestationRegistry.sol/RiskAttestationRegistry.json',
      'utf8',
    ),
  ) as { abi: Abi; bytecode: { object: Hex } };
  const deploy = await c.wallet.deployContract({
    account: attacker,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [forwarder],
  });
  const receipt = await c.public.waitForTransactionReceipt({ hash: deploy });
  registry = receipt.contractAddress!;
}, 30_000);

afterAll(() => {
  node?.kill('SIGTERM');
});

function kernelWithRegistry(): Harness {
  const reader = new RpcRiskAttestationReader(clients().public, {
    confirmationDepth: 2,
    trustedForwarder: forwarder,
    forwarderKind: 'CRE_MOCK_FORWARDER',
    trustedWorkflowId: hash(0),
  });
  return harness([], [tradeMandate({ outputAssets: [outputAsset] })], {
    stableRisk: {
      reader,
      chainId: 31337,
      registry,
      assets: [{ address: TOKEN, assetId: AUSD_ID }],
      maxAttestationAgeSeconds: 3600,
      trustedSourceConfigHash: hash(5),
      maxReferenceStalenessSeconds: 3900,
      maxHealthyDeviationBps: 50,
      trustedForwarder: forwarder,
      forwarderKind: 'CRE_MOCK_FORWARDER',
      trustedWorkflowId: hash(0),
    },
  });
}

let nonce = 100;
async function decide(h: Harness) {
  nonce += 1;
  const input = evidence(
    swapIntent({
      maxInputAmount: '10',
      nonce: String(nonce),
      intentId: `intent_${nonce}`,
    }),
    quote,
  );
  trust(h, input);
  return h.kernel.authorize({ ...input, approvals: [] });
}

describe('Kernel risk gate against a real RiskAttestationRegistry on Anvil', () => {
  it('reads attestations at confirmation depth and applies HEALTHY / DEGRADED / STALE / UNKNOWN', async () => {
    const h = kernelWithRegistry();
    const mine = (blocks: number) => clients().test.mine({ blocks: blocks });
    expect(await decide(h)).toMatchObject({
      status: 'RISK_REJECTED',
      code: 'STABLE_RISK_UNAVAILABLE',
    });

    expect((await deliver(forwarder, 990n, 1)).status).toBe('success');
    expect(await decide(h)).toMatchObject({
      code: 'STABLE_RISK_UNAVAILABLE',
    });
    await mine(1);
    expect(await decide(h)).toMatchObject({
      status: 'PENDING_APPROVAL',
      tier: 'AUTO',
    });

    expect((await deliver(forwarder, 992n, 2)).status).toBe('success');
    await mine(1);
    expect(await decide(h)).toMatchObject({
      status: 'PENDING_APPROVAL',
      tier: 'CONSENSUS',
    });

    expect((await deliver(forwarder, 994n, 3)).status).toBe('success');
    await mine(1);
    expect(await decide(h)).toMatchObject({
      code: 'STABLE_RISK_UNAVAILABLE',
    });

    expect((await deliver(forwarder, 996n, 0)).status).toBe('success');
    await mine(1);
    expect(await decide(h)).toMatchObject({
      code: 'STABLE_RISK_UNAVAILABLE',
    });
  });

  it('an unauthorized writer and an older attestation cannot change what the Kernel sees', async () => {
    const h = kernelWithRegistry();
    expect((await deliver(forwarder, 998n, 1)).status).toBe('success');
    await clients().test.mine({ blocks: 1 });
    expect(await decide(h)).toMatchObject({ tier: 'AUTO' });
    expect((await deliver(attacker, 999n, 2)).status).toBe('reverted');
    expect((await deliver(forwarder, 997n, 3)).status).toBe('reverted');
    await clients().test.mine({ blocks: 2 });
    const latest = await clients().public.readContract({
      address: registry,
      abi: riskAttestationRegistryAbi,
      functionName: 'latest',
      args: [AUSD_ID],
    });
    expect(latest).toMatchObject({ timestamp: 998n, status: 1 });
    expect(await decide(h)).toMatchObject({ tier: 'AUTO' });
  });
});
