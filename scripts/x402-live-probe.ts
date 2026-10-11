import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { officialAssets } from '@synq/chain-registry';
import {
  EconomicGrantAuthority,
  artifactHash,
  type EconomicExecution,
} from '@synq/kernel';
import { X402AuthorizationSigner } from '@synq/execution-worker';

const FACILITATOR = 'https://x402-facilitator.molandak.org';
const NETWORK = 'eip155:10143';
const USDC = officialAssets.testnetUSDC;
const PAY_TO = '0x00000000000000000000000000000000000da7a5';
const now = Math.floor(Date.now() / 1000);

async function main() {
  const keyFile = process.env.SYNQ_TESTNET_KEY_FILE;
  if (!keyFile) throw new Error('SYNQ_TESTNET_KEY_FILE required');
  const text = readFileSync(keyFile, 'utf8').trim();
  const account = privateKeyToAccount(
    (text.startsWith('0x') ? text : `0x${text}`) as `0x${string}`,
  );
  const client = createPublicClient({
    transport: http(
      process.env.SYNQ_MONAD_TESTNET_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
    ),
  });
  const balance = await client.readContract({
    address: USDC.address,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [account.address],
  });
  const supported = await (
    await fetch(`${FACILITATOR}/supported`, {
      signal: AbortSignal.timeout(30_000),
    })
  ).json();

  const authority = new EconomicGrantAuthority(
    new Uint8Array(Buffer.from(artifactHash({ probe: now }).slice(2), 'hex')),
  );
  authority.install({
    mandateId: 'x402-probe',
    groupId: 'evidence-group',
    version: 1,
    status: 'ACTIVE',
    domains: ['DATA'],
    providers: ['x402'],
    hosts: ['data.synq.local'],
    perActionCap: { amount: '10000', currency: 'USDC', decimals: 6 },
    cumulativeBudget: { amount: '10000', currency: 'USDC', decimals: 6 },
    autoApproveMax: { amount: '10000', currency: 'USDC', decimals: 6 },
    quorum: 1,
    members: ['probe'],
    maxQuoteAgeSeconds: 60,
    grantTtlSeconds: 120,
    environment: 'TESTNET',
    validUntil: now + 600,
  });
  const requirement = {
    scheme: 'exact' as const,
    network: NETWORK,
    amount: '1000',
    asset: USDC.address,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2' },
  };
  const reqHash = artifactHash({ requirement });
  const execution: EconomicExecution = {
    domain: 'DATA',
    providerId: 'x402',
    host: 'data.synq.local',
    offerId: 'https://data.synq.local/probe',
    subjectHash: reqHash,
    quantity: 1,
    maxAmount: { amount: '1000', currency: 'USDC', decimals: 6 },
    reservationId: 'probe',
    settlementPlanHash: reqHash,
    recipientRef: PAY_TO,
  };
  const decision = authority.authorize(
    {
      intentId: 'x402-probe',
      groupId: 'evidence-group',
      mandateId: 'x402-probe',
      execution,
      quoteExpiresAt: now + 120,
      revalidatedAt: now,
      reservationHeld: true,
    },
    [],
    now,
  );
  if (decision.status !== 'AUTHORIZED') throw new Error(decision.status);
  const signer = new X402AuthorizationSigner(
    account,
    authority,
    new Map([[NETWORK, USDC.chainId]]),
  );
  const payload = await signer.sign({
    grant: decision.grant,
    execution,
    requirement,
    now,
  });
  const verifyRes = await fetch(`${FACILITATOR}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        resource: { url: execution.offerId },
        accepted: requirement,
        payload,
      },
      paymentRequirements: requirement,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const verify = {
    status: verifyRes.status,
    body: (await verifyRes.text()).slice(0, 800),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    label: balance > 0n ? 'REAL_TESTNET_VERIFY_ONLY' : 'BLOCKED_EXTERNAL',
    note: 'Facilitator /verify only; /settle is not called. Settlement needs testnet USDC in the payer wallet (Circle faucet, human step).',
    facilitator: FACILITATOR,
    supported,
    payer: account.address,
    payerUsdcBalance: String(balance),
    grantId: decision.grant.grantId,
    grantConsumed: authority.isConsumed(decision.grant.grantId),
    requirement,
    verify,
  };
  const dir = join(process.cwd(), 'bounty-evidence', 'x402');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `x402-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `${report.label} verify=${verify.status} ${verify.body.slice(0, 200)} -> ${file}`,
  );
}

await main();
