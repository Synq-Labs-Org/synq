import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { officialAssets } from '@synq/chain-registry';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
} from '@synq/kernel';
import { X402AuthorizationSigner } from '@synq/execution-worker';
import {
  MemoryReservationStore,
  payForResource,
  type X402Fetch,
} from '@synq/settlement';

const FACILITATOR = 'https://x402-facilitator.molandak.org';
const NETWORK = 'eip155:10143';
const USDC = officialAssets.testnetUSDC;
const RESOURCE = 'https://data.synq.test/v1/ausd-reference';
const AMOUNT = process.env.SYNQ_X402_AMOUNT ?? '50000';
const now = () => Math.floor(Date.now() / 1000);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

async function main() {
  if (BigInt(AMOUNT) > 100_000n)
    throw new Error('probe payments are capped at 0.10 USDC');
  const keyFile = process.env.SYNQ_TESTNET_KEY_FILE;
  if (!keyFile) throw new Error('SYNQ_TESTNET_KEY_FILE required');
  const text = readFileSync(keyFile, 'utf8').trim();
  const account = privateKeyToAccount(
    (text.startsWith('0x') ? text : `0x${text}`) as `0x${string}`,
  );
  const chain = createPublicClient({
    transport: http(
      process.env.SYNQ_MONAD_TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
    ),
  });
  const balanceOf = () =>
    chain.readContract({
      address: USDC.address,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [account.address],
    });
  const before = await balanceOf();
  const supported = await (
    await fetch(`${FACILITATOR}/supported`, {
      signal: AbortSignal.timeout(30_000),
    })
  ).json();

  // Resource server (Synq-operated, in-process): 402 challenge, then facilitator verify + settle.
  const payTo = account.address.toLowerCase();
  const requirement = {
    scheme: 'exact',
    network: NETWORK,
    amount: AMOUNT,
    asset: USDC.address,
    payTo,
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2' },
  };
  const facilitator: { verify?: unknown; settle?: unknown } = {};
  const resourceServer: X402Fetch = async (url, init) => {
    const reply = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
    });
    if (url !== RESOURCE) return reply(404, '{}');
    const sig = init.headers['PAYMENT-SIGNATURE'];
    if (!sig)
      return reply(402, '{}', {
        'payment-required': b64({
          x402Version: 2,
          resource: { url },
          accepts: [requirement],
        }),
      });
    const paymentPayload = JSON.parse(
      Buffer.from(sig, 'base64').toString('utf8'),
    );
    const call = async (path: string) => {
      const res = await fetch(`${FACILITATOR}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: requirement,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      return {
        status: res.status,
        body: JSON.parse(await res.text()) as Record<string, unknown>,
      };
    };
    facilitator.verify = await call('/verify');
    if (
      (facilitator.verify as { body: { isValid?: boolean } }).body.isValid !==
      true
    )
      return reply(402, '{}', {
        'payment-response': b64({
          success: false,
          errorReason: 'verify_failed',
        }),
      });
    const settle = await call('/settle');
    facilitator.settle = settle;
    return settle.body.success === true
      ? reply(
          200,
          JSON.stringify({ ausdUsd: '1.0000', source: 'synq-probe' }),
          { 'payment-response': b64(settle.body) },
        )
      : reply(402, '{}', { 'payment-response': b64(settle.body) });
  };

  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: 'evidence-group',
    assetId: USDC.canonicalAssetId,
    confirmed: before,
    asOf: now(),
  });
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(randomBytes(32)),
    reservations,
    ledger: new MemoryEconomicGrantLedger(),
    approvals: {
      ledger: { isConsumed: async () => false },
      directory: {
        activeMember: async () => null,
        membershipEpoch: async () => null,
      },
    },
  });
  const unit = { currency: 'USDC', decimals: 6 };
  await authority.install({
    mandateId: 'x402-probe',
    groupId: 'evidence-group',
    version: 1,
    status: 'ACTIVE',
    domains: ['DATA'],
    providers: ['x402'],
    hosts: ['data.synq.test'],
    perActionCap: { ...unit, amount: '100000' },
    cumulativeBudget: { ...unit, amount: '100000' },
    autoApproveMax: { ...unit, amount: '100000' },
    quorum: 1,
    members: ['probe'],
    maxQuoteAgeSeconds: 60,
    grantTtlSeconds: 120,
    environment: 'TESTNET',
    validUntil: now() + 600,
  });
  const assets = [
    { chainId: USDC.chainId, address: USDC.address, decimals: 6 },
  ];
  const networks = new Map([[NETWORK, USDC.chainId]]);
  const signer = new X402AuthorizationSigner(
    account,
    authority,
    networks,
    assets,
  );
  const receipt = await payForResource(
    {
      fetch: resourceServer,
      authority,
      reservations,
      signer,
      groupId: 'evidence-group',
      mandateId: 'x402-probe',
      edgeAssetId: USDC.canonicalAssetId,
      label: 'REAL_TESTNET',
      now,
      allowance: {
        hosts: ['data.synq.test'],
        networks,
        assets,
        payTo: [payTo],
        maxPerRequest: 100_000n,
      },
    },
    RESOURCE,
  );
  const tx = receipt.transaction as `0x${string}` | null;
  const onchain = tx
    ? await chain.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
    : null;
  const after = await balanceOf();
  const report = {
    generatedAt: new Date().toISOString(),
    label:
      receipt.status === 'PAID' && onchain?.status === 'success'
        ? 'REAL_TESTNET'
        : 'BLOCKED_EXTERNAL',
    flow: 'challenge -> allowance -> edge reservation -> Kernel grant -> execution-worker EIP-3009 signature -> facilitator verify/settle -> paid data -> capture',
    facilitator: FACILITATOR,
    supportedExactOnTestnet:
      JSON.stringify(supported).includes(
        '"network":"eip155:10143","scheme":"exact"',
      ) || JSON.stringify(supported).includes('"scheme":"exact"'),
    payer: account.address,
    payTo,
    note: 'payTo is the probe wallet itself (self-transfer); the facilitator relays the transfer and pays gas',
    requirement,
    receipt: { ...receipt, body: receipt.body?.slice(0, 200) ?? null },
    grantConsumed: receipt.grantId
      ? await authority.isConsumed(receipt.grantId)
      : false,
    reservation: receipt.reservationId
      ? await reservations.get(receipt.reservationId)
      : null,
    facilitatorVerify: facilitator.verify ?? null,
    facilitatorSettle: facilitator.settle ?? null,
    chainReceipt: onchain
      ? {
          transactionHash: onchain.transactionHash,
          blockNumber: String(onchain.blockNumber),
          status: onchain.status,
          from: onchain.from,
          to: onchain.to,
        }
      : null,
    usdcBalanceBefore: String(before),
    usdcBalanceAfter: String(after),
  };
  const dir = join(process.cwd(), 'bounty-evidence', 'x402');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `x402-${report.label === 'REAL_TESTNET' ? 'payment' : 'probe'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      report,
      (_, v) => (typeof v === 'bigint' ? String(v) : v),
      2,
    ) + '\n',
  );
  console.log(
    `${report.label} status=${receipt.status} tx=${tx} reason=${receipt.reason} -> ${file}`,
  );
}

await main();
