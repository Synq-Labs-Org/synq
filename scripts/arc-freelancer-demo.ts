/**
 * Synq Freelancer Finance Team: one live end-to-end run on testnets.
 *
 *   set -a; . ~/.synq/p11.env; set +a     # OPENAI_API_KEY for LIVE model mode (optional)
 *   node --import tsx scripts/arc-freelancer-demo.ts
 *
 * Process layout. This process runs the Supervisor, the model calls, the
 * Kernel, the channel gateway and the books; it loads no key. Two child
 * processes hold keys:
 *   - scripts/lib/wallet-child.ts: the parties' wallets (testnet.key = the
 *     freelancer's wallet and operator; arc-client.key = the client paying from
 *     Sepolia; Sarah's address from arc-contractor.key; Wallet B generated);
 *   - scripts/lib/arc-executor-child.ts: the restricted executor, the only
 *     holder of arc-agent.key (the governed vault's operator). It accepts only a
 *     Kernel grant plus the exact call.
 *
 * Postgres: SYNQ_FINANCE_DATABASE_URL or the local throwaway server on
 * 127.0.0.1:55433 (database synq_p08_demo). Evidence: SYNQ_EVIDENCE_DIR
 * (default ./bounty-evidence/arc).
 *
 * Telegram's transport is NOT live (Guest Mode is off for the bot): the real
 * TelegramAdapter and ChannelGateway run against a capturing local Bot API
 * transport, and no Telegram method is called on the real bot. Circle Wallets
 * are blocked (no credentials): the freelancer's EOA is linked instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  verifyContract,
} from '@synq/execution-worker/arc';
import { reconcileMint } from '@synq/execution-worker/cctp';
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
  type PayoutJournal,
  type RouteStore,
} from './lib/freelancer-demo.js';
import { liveExecutor } from './lib/arc-executor-client.js';
import { forkChild, nextMessage, stopChild } from './lib/child-process-rpc.js';
import type { WalletMessage, WalletRequest } from './lib/wallet-child.js';

const now = () => Math.floor(Date.now() / 1000);
const log = (line: string) => console.log(line);
const arc = await connectChain('arc-testnet');
if (arc.profile.environment !== 'ARC_TESTNET' || !arc.profile.mutationEnabled)
  throw new Error('testnets only');
await verifyContract(arc, 'MEMO');
const arcUsdc = token('arc-testnet', 'USDC');

// ---------------------------------------------------------------- wallets process
const wallets = forkChild('./wallet-child.ts');
const ready = await nextMessage(wallets, (m) => {
  const x = m as WalletMessage;
  return x.type === 'ready' ? x : undefined;
});
let rpcSeq = 0;
async function walletCall<T>(
  op: string,
  args: unknown[],
  onEvent?: (name: string, value: unknown) => void,
): Promise<T> {
  const id = ++rpcSeq;
  const events = (m: unknown) => {
    const x = m as WalletMessage;
    if (x.type === 'event' && x.id === id) onEvent?.(x.name, x.value);
  };
  wallets.on('message', events);
  try {
    const result = nextMessage(wallets, (m) => {
      const x = m as WalletMessage;
      return x.type === 'result' && x.id === id ? x : undefined;
    });
    wallets.send({ id, op, args } satisfies WalletRequest);
    const r = await result;
    if (!r.ok) throw new Error(r.error);
    return r.value as T;
  } finally {
    wallets.off('message', events);
  }
}
const owner = {
  address: ready.owner,
  signTypedData: ((typedData: unknown) =>
    walletCall<Hex>('signTypedData', [
      typedData,
    ])) as LocalAccount['signTypedData'],
};

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
await pool.query(
  'ALTER TABLE synq_cctp_routes ADD COLUMN IF NOT EXISTS workspace_id text',
);
await pool.query(`CREATE TABLE IF NOT EXISTS synq_payout_journal (
  tx_hash text PRIMARY KEY,
  grant_id text NOT NULL UNIQUE,
  workspace_id text NOT NULL,
  state text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now())`);
const routes: RouteStore = {
  async save(workspaceId, r: SettlementEvidence) {
    await pool.query(
      `INSERT INTO synq_cctp_routes (destination_tx, invoice_id, workspace_id, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (destination_tx) DO NOTHING`,
      [
        r.destinationTx.toLowerCase(),
        r.invoiceId,
        workspaceId,
        JSON.stringify(r),
      ],
    );
  },
  async list(workspaceId) {
    const r = await pool.query(
      'SELECT data FROM synq_cctp_routes WHERE workspace_id=$1',
      [workspaceId],
    );
    return r.rows.map((x) => x.data as SettlementEvidence);
  },
};
const payouts: PayoutJournal = {
  async record(r) {
    // Committed before the executor may broadcast (it waits for this ack).
    await pool.query(
      'INSERT INTO synq_payout_journal (tx_hash, grant_id, workspace_id, state) VALUES ($1,$2,$3,$4)',
      [r.hash.toLowerCase(), r.grantId, r.workspaceId, r.state],
    );
  },
};

// ---------------------------------------------------------------- model
const reasoner = process.env.OPENAI_API_KEY?.trim()
  ? new OpenAIStructuredReasoner(openAIOptionsFromEnv(process.env))
  : undefined;
log(
  `model: ${reasoner ? `${reasoner.model} (${reasoner.availability().mode})` : 'none (rules only)'}`,
);

// ---------------------------------------------------------------- chain port (reads here; writes in the wallets process)
const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const vaultSafe = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE')
  .address as Address;
const WINDOW_ABI = parseAbi([
  'function windowSpent() view returns (uint256)',
  'function windowStart() view returns (uint64)',
]);
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
  nativeBalance: (a) => arc.client.getBalance({ address: a }),
  arcNonce: (a) => arc.client.getTransactionCount({ address: a }),
  gatewayAvailable: (depositor) =>
    gatewayBalances([{ chain: 'eth-sepolia', depositor }]),
  probe: async (id) => {
    const at = now();
    if (id === 'ARC_RPC') {
      const b = await arc.client.getBlockNumber();
      return { ok: true, detail: `arc-testnet block ${b}`, observedAt: at };
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
  txGas: async (hash) => {
    const r = await arc.client.getTransactionReceipt({ hash });
    return { payer: r.from, feeWei: r.gasUsed * r.effectiveGasPrice };
  },
  vaultInfo: async (check) => {
    await verifyContract(arc, 'SYNQ_ARC_VAULT_POLICY');
    const health = await readVault(arc, vaultSafe);
    const read = <T>(functionName: string) =>
      arc.client.readContract({
        address: policy,
        abi: [...VAULT_POLICY_ABI, ...WINDOW_ABI],
        functionName: functionName as 'operator',
      }) as Promise<T>;
    const [
      operator,
      perPaymentCap,
      windowCap,
      windowSpent,
      windowStart,
      bound,
    ] = await Promise.all([
      read<Address>('operator'),
      read<bigint>('perPaymentCap'),
      read<bigint>('windowCap'),
      read<bigint>('windowSpent'),
      read<bigint>('windowStart'),
      read<Address>('safe'),
    ]);
    if (bound.toLowerCase() !== vaultSafe.toLowerCase())
      throw new Error('vault policy is not bound to the registry vault');
    const allowlisted: Record<string, boolean> = {};
    for (const a of check)
      allowlisted[a.toLowerCase()] = await arc.client.readContract({
        address: policy,
        abi: VAULT_POLICY_ABI,
        functionName: 'isRecipient',
        args: [a],
      });
    return {
      vault: vaultSafe,
      policy,
      operator,
      healthy: health.healthy,
      problems: health.problems,
      perPaymentCap,
      windowCap,
      windowSpent,
      windowEndsAt: Number(windowStart) + 86_400,
      allowlisted,
    };
  },
  vaultPayCall: async ({ operator, recipient, amount }) => {
    const sim = await simulate(
      arc,
      operator,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'pay',
        args: [recipient, amount, `0x${'00'.repeat(31)}01`],
      }),
    );
    return { ok: sim.ok, reason: sim.ok ? null : sim.reason };
  },
  fund: (input) => walletCall<FundingRecord[]>('fund', [input]),
  cctpMinimumFeeBps: async () => {
    const fees = await irisFees('eth-sepolia', 'arc-testnet');
    const fast = fees.find((f) => f.finalityThreshold === FAST_FINALITY);
    if (!fast) throw new Error('no fast-transfer fee tier from Iris');
    return fast.minimumFee;
  },
  cctpBurn: (t, onBurnHash) =>
    walletCall('cctpBurn', [t], (name, value) => {
      if (name === 'burnHash') void onBurnHash(value as Hex);
    }),
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
    walletCall('cctpMint', [t, message, attestation], (name, value) => {
      if (name === 'mintHash') void onMintHash(value as Hex);
    }),
  cctpReconcile: (t, message, mintTx) => reconcileMint(arc, t, message, mintTx),
};

// ---------------------------------------------------------------- run
const runId = Date.now().toString(36);
const executor = liveExecutor();
let result: Awaited<ReturnType<typeof runFreelancerDemo>>;
try {
  result = await runFreelancerDemo({
    runId,
    parties: {
      owner,
      agent: (await chain.vaultInfo([])).operator,
      client: ready.client,
      sarah: ready.sarah,
      walletB: ready.walletB,
    },
    chain,
    executor,
    stores: {
      ledger: new PostgresLedgerStore(pool),
      invoices: new PostgresInvoiceStore(pool),
      routes,
      payouts,
      label: 'POSTGRES',
    },
    ...(reasoner ? { reasoner } : {}),
    telegramProof: testTelegramProof(now()),
    checkout: {
      client: arc.client,
      memoContract: contract('arc-testnet', 'MEMO').address as Address,
      listen: true,
    },
    // The governed vault allows 0.01 per payment and 0.02 per 24h.
    amounts: {
      payout: 5_000n,
      maxInvoice: 1_000_000n,
      minimumReserve: 10_000n,
    },
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
} finally {
  await executor.stop();
  await stopChild(wallets);
  await pool.end();
}

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
      processes: {
        supervisor:
          'this process: Supervisor, model, Kernel, gateway, books; loads no key',
        wallets: 'scripts/lib/wallet-child.ts: testnet.key, arc-client.key',
        executor:
          'scripts/lib/arc-executor-child.ts: arc-agent.key (vault operator), grant + call only',
      },
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
console.log(
  `reconciliation: ${JSON.stringify((result.reconciliation as { detail?: string } | null)?.detail)}`,
);
console.log(`evidence -> ${file}`);
if (result.steps.some((s) => s.status !== 'OK')) process.exitCode = 1;
