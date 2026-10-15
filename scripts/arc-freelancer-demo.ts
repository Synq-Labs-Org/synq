/**
 * Synq Freelancer Finance Team: one live end-to-end run on testnets.
 *
 *   set -a; . ~/.synq/p11.env; set +a     # OPENAI_API_KEY for LIVE model mode (optional)
 *   node --import tsx scripts/arc-freelancer-demo.ts
 *
 * Keys (testnet only, under ~/.synq): testnet.key = the freelancer's wallet and
 * operator (funding, Arc mint gas); arc-client.key = the client paying from
 * Sepolia; arc-agent.key = the operational wallet that pays only under Kernel
 * grants; arc-contractor.key = Sarah's verified payout address. Wallet B is
 * generated fresh per run. Postgres: SYNQ_FINANCE_DATABASE_URL or the local
 * throwaway server on 127.0.0.1:55433 (database synq_p08_demo). Evidence:
 * SYNQ_EVIDENCE_DIR (default ./bounty-evidence/arc).
 *
 * Telegram's transport is NOT live (Guest Mode is off for the bot): the real
 * TelegramAdapter runs against a capturing local Bot API transport and no
 * Telegram method is called on the real bot. Circle Wallets are blocked
 * (no credentials): the freelancer's EOA is linked instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia as sepoliaChain } from 'viem/chains';
import { money } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeGrantedTransfer,
  executeTransfer,
  prepareTransfer,
  verifyContract,
} from '@synq/execution-worker/arc';
import {
  burnOnSource,
  mintOnDestination,
  reconcileMint,
} from '@synq/execution-worker/cctp';
import {
  VAULT_POLICY_ABI,
  readVault,
  simulate,
} from '@synq/execution-worker/vault';
import { gatewayBalances } from '@synq/plugin-circle-gateway';
import { FAST_FINALITY, irisFees, irisMessage } from '@synq/plugin-circle-cctp';
import {
  OpenAIStructuredReasoner,
  openAIOptionsFromEnv,
} from '@synq/plugin-openai';
import { PostgresInvoiceStore } from '@synq/invoices';
import { PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import type { ChainReceipt, SettlementEvidence } from '@synq/agent-runtime';
import {
  runFreelancerDemo,
  testTelegramProof,
  type DemoChainPort,
  type FundingRecord,
  type RouteStore,
} from './lib/freelancer-demo.js';

const home = `${process.env.HOME}/.synq`;
const key = (f: string): Hex => {
  const k = readFileSync(join(home, f), 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const owner = privateKeyToAccount(key('testnet.key'));
const agent = privateKeyToAccount(key('arc-agent.key'));
const client = privateKeyToAccount(key('arc-client.key'));
const sarah = privateKeyToAccount(key('arc-contractor.key')).address;
const walletB = privateKeyToAccount(generatePrivateKey()).address;
const arc = await connectChain('arc-testnet');
const sepolia = await connectChain('eth-sepolia');
if (
  arc.profile.environment !== 'ARC_TESTNET' ||
  !arc.profile.mutationEnabled ||
  !sepolia.profile.mutationEnabled
)
  throw new Error('testnets only');
await verifyContract(arc, 'MEMO');
const arcUsdc = token('arc-testnet', 'USDC');
const sepUsdc = token('eth-sepolia', 'USDC');
const now = () => Math.floor(Date.now() / 1000);
const log = (line: string) => console.log(line);

// ---------------------------------------------------------------- Postgres
const url =
  process.env.SYNQ_FINANCE_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55433/synq_p08_demo';
{
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  const db = new URL(url).pathname.slice(1);
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname=$1',
    [db],
  );
  if (!exists.rowCount)
    await admin.query(`CREATE DATABASE "${db.replace(/"/g, '')}"`);
  await admin.end();
}
const pool = new pg.Pool({ connectionString: url });
await migrateFinance(pool);
await pool.query(`CREATE TABLE IF NOT EXISTS synq_cctp_routes (
  destination_tx text PRIMARY KEY,
  invoice_id text NOT NULL,
  data jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now())`);
const routes: RouteStore = {
  async save(r: SettlementEvidence) {
    await pool.query(
      `INSERT INTO synq_cctp_routes (destination_tx, invoice_id, data) VALUES ($1,$2,$3)
       ON CONFLICT (destination_tx) DO NOTHING`,
      [r.destinationTx.toLowerCase(), r.invoiceId, JSON.stringify(r)],
    );
  },
  async list() {
    const r = await pool.query('SELECT data FROM synq_cctp_routes');
    return r.rows.map((x) => x.data as SettlementEvidence);
  },
};

// ---------------------------------------------------------------- model
const reasoner = process.env.OPENAI_API_KEY?.trim()
  ? new OpenAIStructuredReasoner(openAIOptionsFromEnv(process.env))
  : undefined;
log(
  `model: ${reasoner ? `${reasoner.model} (${reasoner.availability().mode})` : 'none (rules only)'}`,
);

// ---------------------------------------------------------------- chain port
const arcRpc = arc.profile.rpcUrls[0]!;
const sepoliaWallet = createWalletClient({
  account: owner,
  chain: sepoliaChain,
  transport: http(
    process.env[sepolia.profile.rpcEnvironment] ?? sepolia.profile.rpcUrls[0],
  ),
});
const receipt = async (hash: Hex): Promise<ChainReceipt | null> => {
  const r = await arc.client.getTransactionReceipt({ hash }).catch(() => null);
  if (!r) return null;
  return {
    status: r.status,
    blockNumber: r.blockNumber,
    from: r.from,
    transfers: parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: r.logs,
    })
      .filter((l) => l.address.toLowerCase() === arcUsdc.address.toLowerCase())
      .map((l) => ({
        from: l.args.from,
        to: l.args.to,
        baseUnits: l.args.value,
      })),
  };
};
const chain: DemoChainPort = {
  labels: { arc: 'LIVE_ARC_TESTNET', sepolia: 'LIVE_SEPOLIA' },
  arcUsdcBalance: async (a) => (await balanceOf(arc, arcUsdc, a)).baseUnits,
  arcNonce: (a) => arc.client.getTransactionCount({ address: a }),
  gatewayAvailable: (depositor) =>
    gatewayBalances([{ chain: 'eth-sepolia', depositor }]),
  probe: async (id) => {
    const at = now();
    if (id === 'ARC_RPC') {
      const b = await arc.client.getBlockNumber();
      return { ok: true, detail: `${arcRpc} block ${b}`, observedAt: at };
    }
    if (id === 'CIRCLE_GATEWAY') {
      await gatewayBalances([
        { chain: 'eth-sepolia', depositor: owner.address },
      ]);
      return {
        ok: true,
        detail: 'gateway-api-testnet /v1/balances answered',
        observedAt: at,
      };
    }
    const fees = await irisFees('eth-sepolia', 'arc-testnet');
    return {
      ok: true,
      detail: `iris fees: ${fees.length} finality tiers`,
      observedAt: at,
    };
  },
  receipt,
  simulateTransfer: async ({ from, to, amount }) => {
    await prepareTransfer(arc, { from, to, amount: money(arcUsdc, amount) });
    return true;
  },
  fund: async (input) => {
    const out: FundingRecord[] = [];
    if (
      (await balanceOf(arc, arcUsdc, input.agent)).baseUnits < input.agentMin
    ) {
      const f = await executeTransfer(arc, owner, {
        from: owner.address,
        to: input.agent,
        amount: money(arcUsdc, input.agentTopUp),
      });
      out.push({
        what: 'agent float (Arc USDC)',
        chain: 'arc-testnet',
        hash: f.hash,
        explorer: f.explorer,
      });
    }
    const clientUsdc = await sepolia.client.readContract({
      address: sepUsdc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [input.client],
    });
    if (clientUsdc < input.clientSepoliaUsdcMin) {
      const f = await executeTransfer(sepolia, owner, {
        from: owner.address,
        to: input.client,
        amount: money(sepUsdc, input.clientSepoliaUsdcMin * 2n),
      });
      out.push({
        what: 'client Sepolia USDC',
        chain: 'eth-sepolia',
        hash: f.hash,
        explorer: f.explorer,
      });
    }
    if (
      (await sepolia.client.getBalance({ address: input.client })) <
      parseEther('0.003')
    ) {
      const h = await sepoliaWallet.sendTransaction({
        to: input.client,
        value: parseEther('0.01'),
      });
      await sepolia.client.waitForTransactionReceipt({ hash: h });
      out.push({
        what: 'client Sepolia ETH (gas)',
        chain: 'eth-sepolia',
        hash: h,
        explorer: `${sepolia.profile.explorer}/tx/${h}`,
      });
    }
    return out;
  },
  cctpMinimumFeeBps: async () => {
    const fees = await irisFees('eth-sepolia', 'arc-testnet');
    const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
    if (!fast) throw new Error('no fast-transfer fee tier from Iris');
    return fast.minimumFee;
  },
  cctpBurn: (t, onBurnHash) =>
    burnOnSource({ chain: sepolia, signer: client, transfer: t, onBurnHash }),
  cctpAttestation: async (burnTx) => {
    for (let polls = 1; polls <= 180; polls++) {
      const m = await irisMessage('eth-sepolia', burnTx).catch(() => null);
      if (m?.status === 'complete' && m.message && m.attestation)
        return { message: m.message, attestation: m.attestation, polls };
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `no attestation for ${burnTx} after 180 reads; recover by reading Iris, never re-burn`,
    );
  },
  cctpMint: (t, message, attestation, onMintHash) =>
    mintOnDestination({
      chain: arc,
      signer: owner,
      transfer: t,
      message,
      attestation,
      onMintHash,
    }),
  cctpReconcile: (t, message, mintTx) => reconcileMint(arc, t, message, mintTx),
  executeGranted: async (input) => {
    const paid = await executeGrantedTransfer({
      chain: arc,
      signer: agent,
      grant: input.grant,
      grantKey: input.grantKey,
      fence: input.fence,
      mandateRevoked: false,
      transfer: {
        from: agent.address,
        to: input.to,
        amount: money(arcUsdc, input.amount),
      },
      now: now(),
      onBroadcast: input.onBroadcast,
    });
    const r = await receipt(paid.hash);
    const raw = await arc.client.getTransactionReceipt({ hash: paid.hash });
    const log = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: raw.logs,
    }).find((l) => l.address.toLowerCase() === arcUsdc.address.toLowerCase());
    if (!r || !log) throw new Error('payout receipt has no USDC transfer');
    return {
      hash: paid.hash,
      blockNumber: paid.blockNumber,
      explorer: paid.explorer,
      logIndex: log.logIndex!,
      feeBaseUnits: paid.feeUsdc?.baseUnits ?? 0n,
    };
  },
  vaultCheck: async ({ operator, verified, changed, amount }) => {
    const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
      .address as Address;
    const vault = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE')
      .address as Address;
    await verifyContract(arc, 'SYNQ_ARC_VAULT_POLICY');
    const health = await readVault(arc, vault);
    const allowlisted = (a: Address) =>
      arc.client.readContract({
        address: policy,
        abi: VAULT_POLICY_ABI,
        functionName: 'isRecipient',
        args: [a],
      });
    const op = await arc.client.readContract({
      address: policy,
      abi: VAULT_POLICY_ABI,
      functionName: 'operator',
    });
    const sim = await simulate(
      arc,
      operator,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'pay',
        args: [changed, amount, `0x${'00'.repeat(31)}01`],
      }),
    );
    return {
      vault,
      policy,
      operator: op,
      operatorIsAgent: op.toLowerCase() === operator.toLowerCase(),
      verifiedAllowlisted: await allowlisted(verified),
      changedAllowlisted: await allowlisted(changed),
      changedPayCall: { ok: sim.ok, reason: sim.ok ? null : sim.reason },
      vaultHealthy: health.healthy,
      vaultProblems: health.problems,
    };
  },
};

// ---------------------------------------------------------------- run
const runId = Date.now().toString(36);
const result = await runFreelancerDemo({
  runId,
  parties: {
    owner,
    agent: agent.address,
    client: client.address,
    sarah,
    walletB,
  },
  chain,
  stores: {
    ledger: new PostgresLedgerStore(pool),
    invoices: new PostgresInvoiceStore(pool),
    routes,
    label: 'POSTGRES',
  },
  ...(reasoner ? { reasoner } : {}),
  telegramProof: testTelegramProof(now()),
  checkout: {
    client: arc.client,
    memoContract: contract('arc-testnet', 'MEMO').address as Address,
    listen: true,
  },
  amounts: { payout: 30_000n, maxInvoice: 1_000_000n, minimumReserve: 50_000n },
  env: process.env,
  blockers: [
    {
      code: 'TELEGRAM_GUEST_MODE_OFF',
      detail:
        '@asksynqbot supports_guest_queries=false: guest round trip is local ingress only',
      ref: 'reports/blockers/P04-20261016-telegram-guest-live.md',
    },
    {
      code: 'CIRCLE_WALLETS_NO_CREDENTIALS',
      detail: 'no Circle API key / entity secret: EOA linked instead',
      ref: 'reports/blockers/P03-20261016-circle-credentials.md',
    },
  ],
  now,
  log,
});
await pool.end();

const shortHash = (
  (result.payout as { hash?: string } | null)?.hash ??
  (result.cctp as { mintTx?: string } | null)?.mintTx ??
  `0x${runId}`
).slice(2, 10);
const dir =
  process.env.SYNQ_EVIDENCE_DIR ??
  join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `freelancer-demo-${shortHash}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      environment: 'ARC_TESTNET + ETH_SEPOLIA',
      generatedAt: new Date().toISOString(),
      reproduce:
        'set -a; . ~/.synq/p11.env; set +a; node --import tsx scripts/arc-freelancer-demo.ts',
      notLive: {
        telegram:
          'LOCAL_INGRESS: real TelegramAdapter + ChannelGateway over a capturing local Bot API transport; Guest Mode is off for @asksynqbot (P04 blocker); no Telegram method was called on the real bot',
        circleWallets:
          'BLOCKED: no credentials (P03 blocker); EOA_WALLET_LINK used',
        telegramLoginProof:
          'TEST_TELEGRAM_PROOF: HMAC-signed with the local transport token and checked by the real verifyTelegramLogin; no real user login',
      },
      ...result,
    },
    (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  ) + '\n',
);
console.log('\n================ summary');
for (const s of result.steps)
  console.log(
    `Step ${s.step} [${s.labels.join(' + ')}] ${s.status}: ${s.title}${s.error ? ` -- ${s.error}` : ''}`,
  );
console.log(`invoice: ${JSON.stringify(result.invoice)}`);
console.log(`ledger: ${JSON.stringify(result.ledger.balances)}`);
console.log(`evidence -> ${file}`);
if (result.steps.some((s) => s.status !== 'OK')) process.exitCode = 1;
