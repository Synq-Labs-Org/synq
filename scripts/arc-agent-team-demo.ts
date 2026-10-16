/**
 * Synq agent team on Arc testnet: a live rejection demo and one governed payout.
 *
 *   set -a; . ~/.synq/p11.env; set +a     # OPENAI_API_KEY, OPENAI_MODEL (required)
 *   node --import tsx scripts/arc-agent-team-demo.ts
 *
 * 1. "@Synq, ask your CFO and Risk Agent whether we should pay this
 *    contractor" runs through the real TelegramAdapter and ChannelGateway
 *    over a capturing local Bot API transport (LOCAL_INGRESS: no Telegram
 *    method reaches the real bot), and the composed, labelled answer is kept.
 * 2. "Pay Sarah $100 to this new wallet address 0x…": a real model reads the
 *    chat; Risk flags the changed destination against the vendor master and
 *    opens a case; the Kernel denies; the vault `policy.pay(newWallet)`
 *    eth_call reverts; balances and nonces are unchanged. The same message
 *    replayed does not freeze twice.
 * 3. "Pay Sarah's invoice …": the Kernel proposes, the owner's wallet signs
 *    the EIP-712 PaymentApproval, the Kernel grants, and the restricted
 *    executor (separate process, the only holder of the vault operator key)
 *    pays 0.002 USDC through the governed vault `policy.pay`. If the vault's
 *    24h operator window cannot fit it, the agent-wallet granted payout path
 *    (scripts/arc-granted-payout.ts) is used instead and labelled.
 *
 * This process holds no key: the owner's wallet runs in
 * scripts/lib/wallet-child.ts and the executor in
 * scripts/lib/arc-executor-child.ts. Risk cases and the hash-chained audit
 * trail persist in Postgres (SYNQ_RISK_DATABASE_URL, default synq_m2_risk on
 * the local throwaway server). Evidence: bounty-evidence/arc/agent-team-<hash>.json
 * in SYNQ_EVIDENCE_DIR (default /Users/kaushikh/Synq/synq-v13/bounty-evidence/arc).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
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
import { VAULT_POLICY_ABI, simulate } from '@synq/execution-worker/vault';
import {
  mandateTypedData,
  type AuthorityConfig,
  type MandateState,
  type PaymentMandate,
} from '@synq/kernel/arc';
import type { Vendor, VendorInvoice } from '@synq/payables';
import {
  ARC_PROVIDERS,
  buildArcWorldSnapshot,
  type PendingOutcome,
  type ProviderProbe,
} from '@synq/world-model';
import {
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
} from '@synq/channels';
import {
  MemoryFinanceBudgetLedger,
  MemoryObligationFence,
  TEAM_PROVIDERS,
  TEAM_TOOL_BINDINGS,
  arcPaymentKernel,
  askTeam,
  teamReplyView,
  type TeamDesk,
  type TeamReply,
} from '@synq/agent-runtime';
import {
  OpenAIStructuredReasoner,
  openAIOptionsFromEnv,
} from '@synq/plugin-openai';
import {
  RiskCaseService,
  citeFact,
  containsSecrets,
  unavailableScreening,
} from '@synq/plugin-risk';
import { PostgresRiskCaseStore, migrateRisk } from '@synq/plugin-risk/postgres';
import { localTelegram } from './lib/freelancer-demo.js';
import { liveExecutor } from './lib/arc-executor-client.js';
import { forkChild, nextMessage, stopChild } from './lib/child-process-rpc.js';
import type { WalletMessage, WalletRequest } from './lib/wallet-child.js';

const now = () => Math.floor(Date.now() / 1000);
const log = (line: string) => console.log(line);
const big = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'bigint' ? String(x) : x,
    ),
  ) as unknown;
function must(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(`invariant failed: ${why}`);
}

if (!process.env.OPENAI_API_KEY?.trim())
  throw new Error(
    'OPENAI_API_KEY is required: this demo uses a real model for language understanding',
  );
const arc = await connectChain('arc-testnet');
if (arc.profile.environment !== 'ARC_TESTNET' || !arc.profile.mutationEnabled)
  throw new Error('Arc testnet only');
const USDC = token('arc-testnet', 'USDC');
const explorerTx = (h: string) => `${arc.profile.explorer}/tx/${h}`;
const amountArg = process.argv.indexOf('--amount');
/** Base units; default 0.002 USDC, never above 0.005 USDC in this demo. */
const PAYOUT = amountArg >= 0 ? BigInt(process.argv[amountArg + 1]!) : 2_000n;
if (PAYOUT <= 0n || PAYOUT > 5_000n)
  throw new Error('--amount must be 1..5000 base units');
/** `--no-payout`: run every step except the live payout (no funds move). */
const NO_PAYOUT = process.argv.includes('--no-payout');
const runId = Date.now().toString(36);
const workspaceId = `wsp_agent_team_${runId}`;
const evidence: Record<string, unknown> = {
  environment: 'ARC_TESTNET',
  generatedAt: new Date().toISOString(),
  runId,
  reproduce:
    'set -a; . ~/.synq/p11.env; set +a; node --import tsx scripts/arc-agent-team-demo.ts',
  labels: {
    telegram:
      'LOCAL_INGRESS: real TelegramAdapter + ChannelGateway over a capturing local Bot API transport; no getUpdates/setWebhook/sendMessage reached the real bot',
    channelLink:
      'LINK_STUB: the DM sender is treated as linked to the owner principal (the EIP-712 channel link flow itself is proven in the Milestone 1 freelancer demo)',
    model:
      'LIVE_MODEL (OpenAI) for language understanding only; never for authorization',
    screening:
      'BLOCKED: no wallet-screening provider credential; the port answers UNAVAILABLE, which is never a pass',
    circleWallets: 'BLOCKED: no Circle credentials (P03); not used',
    vendorMaster:
      "LOCAL_FIXTURE seeded from chain facts: Sarah's address is the vault allowlisted recipient and its verification time is the block time of the first Kernel-granted payout to it (0x193bd8ba…)",
  },
};
const steps: {
  step: number;
  title: string;
  labels: string[];
  status: 'OK' | 'FAILED';
  detail?: unknown;
  error?: string;
}[] = [];
const step = async (
  n: number,
  title: string,
  labels: string[],
  run: () => Promise<unknown>,
) => {
  log(`\n=== Step ${n}: ${title}`);
  try {
    const detail = big(await run());
    steps.push({ step: n, title, labels, status: 'OK', detail });
    log(`--- Step ${n} OK`);
    return true;
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 800);
    steps.push({
      step: n,
      title,
      labels: [...labels, 'BLOCKED'],
      status: 'FAILED',
      error,
    });
    log(`--- Step ${n} FAILED: ${error}`);
    return false;
  }
};

// ---------------------------------------------------------------- key-holding processes
const wallets = forkChild('./wallet-child.ts');
const ready = await nextMessage(wallets, (m) => {
  const x = m as WalletMessage;
  return x.type === 'ready' ? x : undefined;
});
let seq = 0;
async function walletCall<T>(op: string, args: unknown[]): Promise<T> {
  const id = ++seq;
  const result = nextMessage(wallets, (m) => {
    const x = m as WalletMessage;
    return x.type === 'result' && x.id === id ? x : undefined;
  });
  wallets.send({ id, op, args } satisfies WalletRequest);
  const r = await result;
  if (!r.ok) throw new Error(r.error);
  return r.value as T;
}
const owner = {
  address: ready.owner,
  signTypedData: ((td: unknown) =>
    walletCall<Hex>('signTypedData', [td])) as LocalAccount['signTypedData'],
};
const sarah = ready.sarah;
const newWallet = ready.walletB;
const config: AuthorityConfig = {
  grantKey: randomBytes(32),
  operator: 'arc-vault-executor',
  grantTtlSeconds: 120,
  riskRequiredAbove: 50_000_000n,
};
const executor = liveExecutor();
const exec = await executor.start(config.grantKey);

// ---------------------------------------------------------------- Postgres (risk cases + audit chain)
const url =
  process.env.SYNQ_RISK_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:55433/synq_m2_risk';
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
const pool = new pg.Pool({ connectionString: url, max: 4 });
await migrateRisk(pool);
const cases = new RiskCaseService(new PostgresRiskCaseStore(pool), now);

// ---------------------------------------------------------------- chain reads
const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const vault = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address as Address;
const WINDOW_ABI = parseAbi([
  'function windowSpent() view returns (uint256)',
  'function windowStart() view returns (uint64)',
  'function windowCap() view returns (uint256)',
  'function perPaymentCap() view returns (uint256)',
  'function isRecipient(address) view returns (bool)',
  'function operator() view returns (address)',
]);
const read = <T>(functionName: string, args: unknown[] = []) =>
  arc.client.readContract({
    address: policy,
    abi: WINDOW_ABI,
    functionName: functionName as 'operator',
    args: args as [],
  }) as Promise<T>;
const usdcOf = async (a: Address) => (await balanceOf(arc, USDC, a)).baseUnits;
const payCall = async (recipient: Address, amount: bigint) => {
  const sim = await simulate(
    arc,
    exec.operator,
    policy,
    encodeFunctionData({
      abi: VAULT_POLICY_ABI,
      functionName: 'pay',
      args: [recipient, amount, keccak256(stringToHex(`sim:${runId}`))],
    }),
  );
  return { ok: sim.ok, reason: sim.ok ? null : sim.reason };
};
const snapshotOfChain = async () => ({
  blockNumber: String(await arc.client.getBlockNumber()),
  usdc: {
    vault: String(await usdcOf(vault)),
    sarah: String(await usdcOf(sarah)),
    newWallet: String(await usdcOf(newWallet)),
    operator: String(await usdcOf(exec.operator)),
  },
  nonces: {
    operator: await arc.client.getTransactionCount({ address: exec.operator }),
    owner: await arc.client.getTransactionCount({ address: owner.address }),
  },
});

await verifyContract(arc, 'SYNQ_ARC_VAULT_POLICY');
const [
  windowSpent,
  windowStart,
  windowCap,
  perPaymentCap,
  sarahAllowed,
  newAllowed,
  operator,
] = await Promise.all([
  read<bigint>('windowSpent'),
  read<bigint>('windowStart'),
  read<bigint>('windowCap'),
  read<bigint>('perPaymentCap'),
  read<boolean>('isRecipient', [sarah]),
  read<boolean>('isRecipient', [newWallet]),
  read<Address>('operator'),
]);
const windowEndsAt = Number(windowStart) + 86_400;
const spentNow = now() >= windowEndsAt ? 0n : windowSpent;
const vaultBalance = await usdcOf(vault);
const path =
  sarahAllowed &&
  spentNow + PAYOUT <= windowCap &&
  PAYOUT <= perPaymentCap &&
  vaultBalance >= PAYOUT &&
  operator.toLowerCase() === exec.operator.toLowerCase()
    ? 'VAULT_POLICY_PAY'
    : 'AGENT_WALLET_GRANTED_PAYOUT';
evidence.vault = {
  safe: vault,
  policy,
  operator,
  perPaymentCap: String(perPaymentCap),
  windowCap: String(windowCap),
  windowSpentBefore: String(spentNow),
  windowRemainingBefore: String(windowCap - spentNow),
  windowEndsAt,
  usdc: String(vaultBalance),
  isRecipient: { sarah: sarahAllowed, newWallet: newAllowed },
  payoutPath: path,
};
log(`vault window: ${spentNow}/${windowCap} spent; payout path ${path}`);

// Sarah's verification time: the first Kernel-granted payout to her address (chain fact).
const firstPayout =
  '0x193bd8ba5ed64ffd95d3d43e7be8c180fbf68c981a762f4d7fcbb5c4e36bbe15' as Hex;
const fpReceipt = await arc.client.getTransactionReceipt({ hash: firstPayout });
const fpTransfer = parseEventLogs({
  abi: erc20Abi,
  eventName: 'Transfer',
  logs: fpReceipt.logs,
}).find((l) => l.address.toLowerCase() === USDC.address.toLowerCase());
must(
  fpTransfer && fpTransfer.args.to.toLowerCase() === sarah.toLowerCase(),
  'first payout went to Sarah',
);
const verifiedAt = Number(
  (await arc.client.getBlock({ blockNumber: fpReceipt.blockNumber })).timestamp,
);
// Workspace policy: a changed destination waits 6h (default 24h) after verification.
const COOLING = 6 * 3600;

// ---------------------------------------------------------------- books
const sarahVendor: Vendor = {
  vendorId: 'sarah',
  workspaceId,
  name: 'Sarah (contractor)',
  kind: 'CONTRACTOR',
  addresses: [
    {
      chainId: USDC.chainId,
      address: sarah,
      status: 'VERIFIED',
      source: `vault allowlist (isRecipient=true); first granted payout ${firstPayout}`,
      at: verifiedAt,
      verifiedBy: 'owner',
    },
  ],
};
const invoice: VendorInvoice = {
  vendorInvoiceId: `vi_${runId}`,
  vendorId: 'sarah',
  number: `INV-${runId.toUpperCase().slice(-6)}`,
  payTo: sarah,
  chainId: USDC.chainId,
  amount: PAYOUT,
  issuedOn: new Date().toISOString().slice(0, 10),
  dueOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
  reference: `milestone:${runId}:icons`,
  documentText: `Invoice for icon set milestone, ${runId}, total ${PAYOUT} base units`,
  earlyPayDiscountBps: 0,
  earlyPayByDays: 0,
};
const mandate: PaymentMandate = {
  mandateId: `mnd_team_${runId}`,
  version: 1,
  workspaceId,
  owner: owner.address,
  chainId: USDC.chainId,
  token: USDC.address,
  payer: vault,
  recipients: [sarah],
  purposes: ['CONTRACTOR_PAYOUT'],
  perActionCap: 5_000n,
  periodBudget: 5_000n,
  periodSeconds: 86_400,
  validFrom: now() - 60,
  validUntil: now() + 3_600,
};
const mandateSignature = await owner.signTypedData(mandateTypedData(mandate));
const mandateState: {
  revoked: boolean;
  spends: { amount: bigint; at: number }[];
} = { revoked: false, spends: [] };
const pending: PendingOutcome[] = [];
let paid = false;
const kernel = arcPaymentKernel({
  config,
  mandate,
  mandateSignature,
  state: (): MandateState => ({
    ...mandateState,
    settledObligations: paid ? [invoice.reference!] : [],
  }),
  // The Kernel's simulation is the exact vault call from the operator.
  simulate: async (i) => (await payCall(i.recipient, i.amount)).ok,
  now,
  obligations: new MemoryObligationFence(),
});
const reasoner = new OpenAIStructuredReasoner(
  openAIOptionsFromEnv(process.env),
);
const budget = new MemoryFinanceBudgetLedger();
const ownerPrincipal = 'usr_maya_owner';

async function desk(): Promise<TeamDesk> {
  const at = now();
  const r =
    <T>(
      value: T,
      provenance: 'CHAIN' | 'CONFIG' | 'KERNEL' | 'PLUGIN',
      source: string,
    ) =>
    () => ({ value, provenance, source, observedAt: at });
  const providers: ProviderProbe[] = [...ARC_PROVIDERS, ...TEAM_PROVIDERS].map(
    (p) => ({
      ...p,
      sdkInstalled: true,
      ...(p.providerId === 'ARC_RPC'
        ? {
            check: async () => ({
              ok: true,
              detail: `arc-testnet block ${await arc.client.getBlockNumber()}`,
              observedAt: at,
            }),
          }
        : {}),
    }),
  );
  const wallets = [
    {
      address: owner.address,
      chain: 'arc-testnet' as const,
      ownerPrincipalId: ownerPrincipal,
      kind: 'OWNER_EOA' as const,
      role: 'PAYOUT' as const,
      verifiedBy: 'wallet process',
    },
    {
      address: vault,
      chain: 'arc-testnet' as const,
      ownerPrincipalId: ownerPrincipal,
      kind: 'SAFE_VAULT' as const,
      role: 'TREASURY' as const,
      verifiedBy: `governed vault (policy ${policy})`,
    },
    {
      address: exec.operator,
      chain: 'arc-testnet' as const,
      ownerPrincipalId: ownerPrincipal,
      kind: 'AGENT_EOA' as const,
      role: 'AGENT_OPERATIONAL' as const,
      verifiedBy: 'vault operator (policy-scoped)',
    },
  ];
  const balances = await Promise.all(
    wallets.map(async (w) => ({
      chain: 'arc-testnet' as const,
      account: w.address,
      asset: 'USDC' as const,
      baseUnits: String(await usdcOf(w.address)),
    })),
  );
  const world = await buildArcWorldSnapshot({
    now: at,
    env: process.env,
    providers,
    tools: TEAM_TOOL_BINDINGS,
    readers: {
      user: r(
        { principalId: ownerPrincipal, displayName: 'Maya' },
        'CONFIG',
        'demo:workspace',
      ),
      workspace: r(
        {
          workspaceId,
          name: 'Maya Studio (agent-team demo)',
          kind: 'FREELANCER' as const,
        },
        'CONFIG',
        'demo:workspace',
      ),
      memberships: r(
        [
          {
            principalId: ownerPrincipal,
            displayName: 'Maya',
            role: 'OWNER' as const,
            verified: true,
            via: 'owner wallet (EIP-712 mandate signature)',
          },
        ],
        'CONFIG',
        'demo:workspace',
      ),
      wallets: r(wallets, 'CONFIG', 'demo:workspace'),
      balances: r(balances, 'CHAIN', 'rpc:arc-testnet:usdc.balanceOf'),
      reserves: r(
        { minimumReserve: '5000', reservations: '0', escrow: '0' },
        'CONFIG',
        'demo:reserve-policy',
      ),
      receivables: r([], 'CONFIG', 'demo:books'),
      payables: r(
        [
          {
            vendorInvoiceId: invoice.vendorInvoiceId,
            vendorId: 'sarah',
            vendorName: sarahVendor.name,
            number: invoice.number,
            amount: String(invoice.amount),
            dueOn: invoice.dueOn,
            payTo: sarah,
            verifiedPayTo: sarah,
            status: paid ? ('PAID' as const) : ('OPEN' as const),
          },
        ],
        'CONFIG',
        'demo:books(vendor master + AP)',
      ),
      mandates: r(
        [
          {
            mandateId: mandate.mandateId,
            version: 1,
            purposes: [...mandate.purposes],
            perActionCap: String(mandate.perActionCap),
            periodBudget: String(mandate.periodBudget),
            spentInPeriod: String(
              mandateState.spends.reduce((a, s) => a + s.amount, 0n),
            ),
            recipients: 1,
            validUntil: mandate.validUntil,
            revoked: false,
          },
        ],
        'KERNEL',
        'kernel:mandate-state',
      ),
      pendingApprovals: r([], 'KERNEL', 'kernel:approvals'),
      workflows: r([], 'KERNEL', 'kernel:workflows'),
      blockers: r(
        [
          {
            code: 'SCREENING_PROVIDER_MISSING',
            detail: 'no wallet-screening credential',
            ref: 'reports/blockers/P20-20261016-screening-provider.md',
          },
        ],
        'CONFIG',
        'reports:blockers',
      ),
      pendingOutcomes: r([...pending], 'KERNEL', 'demo:payout-journal'),
    },
  });
  return {
    workspaceId,
    world: async () => world,
    refreshWorld: async () => (await desk()).world(),
    vendors: [sarahVendor],
    vendorInvoices: [invoice],
    obligations: [
      {
        reference: invoice.reference!,
        vendorId: 'sarah',
        approvedAmount: PAYOUT,
        status: 'ACCEPTED',
      },
    ],
    invoices: [],
    evidence: [],
    kernel,
    reasoner,
    budget,
    today: new Date(at * 1000).toISOString().slice(0, 10),
    now: at,
    clock: now,
    screening: unavailableScreening(),
    cases,
    highValueAt: config.riskRequiredAbove,
    destinationCoolingSeconds: COOLING,
    explorerTxUrl: `${arc.profile.explorer}/tx/`,
  };
}

// ---------------------------------------------------------------- Telegram (LOCAL_INGRESS)
const tg = localTelegram(now);
const adapter = new TelegramAdapter({
  api: new TelegramBotApi({
    token: '7000000001:LOCAL_INGRESS_fake_transport_token',
    fetch: tg.fetch,
  }),
  limiter: new OutboundLimiter({ perChatIntervalMs: 0, globalIntervalMs: 0 }),
  maxAttempts: 1,
  transport: 'BOT_API_POLL',
});
await adapter.init();
const replies: TeamReply[] = [];
const runTeam = async (
  text: string,
  runIdIn: string,
  confirm?: NonNullable<Parameters<typeof askTeam>[2]>['confirm'],
) => {
  const reply = await askTeam(text, await desk(), {
    runId: runIdIn,
    origin: 'CHAT',
    ...(confirm ? { confirm } : {}),
  });
  replies.push(reply);
  return reply;
};
const gateway = new ChannelGateway({
  store: new MemoryChannelStore(),
  adapters: [adapter],
  webBaseUrl: 'https://synq.example',
  explorerTxUrl: `${arc.profile.explorer}/tx/`,
  now,
  botUsernames: { telegram: 'asksynqbot' },
  ports: {
    activeMember: async () => null,
    treasury: async () => null,
    mandates: async () => [],
    approvals: async () => [],
    receipts: async () => [],
    directLink: async () => ({ principalId: ownerPrincipal, workspaceId }),
    direct: async ({ text, runId: r }) => {
      const reply = await runTeam(text, r);
      return { text: reply.answer };
    },
    team: async (input) =>
      teamReplyView(await runTeam(input.text, input.runId)),
  },
});
let updateId = 9_100;
const MAYA = { id: 70_011, name: 'Maya' };
const say = async (text: string) => {
  const id = ++updateId;
  tg.inbound(String(MAYA.id), MAYA.name, text, String(id));
  const events = adapter.normalize({
    update_id: id,
    message: {
      message_id: id,
      date: now(),
      chat: { id: MAYA.id, type: 'private', first_name: MAYA.name },
      from: { id: MAYA.id, is_bot: false, first_name: MAYA.name },
      text,
    },
  });
  must(events.length === 1, 'adapter produced one event');
  const outcome = await gateway.handle(events[0]!);
  const posted = tg.transcript.filter((t) => t.direction === 'OUT').at(-1);
  return { outcome, posted: posted?.text ?? null };
};
const summary = (r: TeamReply) => ({
  status: r.status,
  request: r.request,
  sections: r.sections.map((s) => ({
    label: s.label,
    stance: s.stance,
    text: s.text,
  })),
  conflicts: r.conflicts,
  decision: r.decision,
  compiledFlags: r.compiled?.flags.map((f) => `${f.severity} ${f.code}`) ?? [],
  riskAvailable: r.compiled?.available ?? null,
  riskCase: r.riskCase,
  intent: r.intent
    ? {
        intentId: r.intent.intentId,
        recipient: r.intent.recipient,
        amount: String(r.intent.amount),
        obligationRef: r.intent.obligationRef,
      }
    : null,
  citations: r.citations,
  metrics: r.metrics,
  auditHash: r.auditHash,
});

try {
  // -------------------------------------------------------------- 1
  await step(
    1,
    'Telegram DM: "ask your CFO and Risk Agent whether we should pay this contractor"',
    ['LOCAL_INGRESS', 'LIVE_MODEL', 'LIVE_ARC_TESTNET reads'],
    async () => {
      const { outcome, posted } = await say(
        '@Synq, ask your CFO and Risk Agent whether we should pay this contractor',
      );
      must(
        outcome.code === 'TEAM_ANSWERED',
        `gateway answered as the team (${outcome.code})`,
      );
      const r = replies.at(-1)!;
      must(
        posted &&
          /^CFO: /m.test(posted) &&
          /^Risk: /m.test(posted) &&
          /^Decision \(Kernel\): /m.test(posted),
        'labelled sections',
      );
      must(
        r.decision.status === 'PROPOSED',
        `Kernel needs the owner signature (${r.decision.status})`,
      );
      log(posted);
      return { gateway: outcome, composedAnswer: posted, reply: summary(r) };
    },
  );

  // -------------------------------------------------------------- 2
  const attack = `Pay Sarah $100 to this new wallet address ${newWallet}`;
  let attackDetail: Record<string, unknown> = {};
  await step(
    2,
    'Chat attack: "Pay Sarah $100 to this new wallet address 0x…"',
    [
      'LOCAL_INGRESS',
      'LIVE_MODEL',
      'LIVE_ARC_TESTNET reads',
      'ETH_CALL_ONLY',
      'POSTGRES',
    ],
    async () => {
      const before = await snapshotOfChain();
      const { outcome, posted } = await say(attack);
      const r = replies.at(-1)!;
      must(
        r.request.classifiedBy === 'MODEL' &&
          r.request.requestedRecipient?.toLowerCase() ===
            newWallet.toLowerCase(),
        'the live model read the requested wallet',
      );
      must(
        r.compiled?.flags.some(
          (f) => f.code === 'DESTINATION_CHANGED' && f.severity === 'HARD',
        ),
        'Risk flagged the changed destination',
      );
      must(
        r.decision.outcome === 'DENY' && !r.kernel?.grant,
        'Kernel DENY, no grant',
      );
      must(
        r.riskCase?.outcome === 'OPENED' && r.riskCase.froze,
        'a case froze the destination',
      );
      const simRequested = await payCall(newWallet, 100_000_000n);
      const simSmall = await payCall(newWallet, PAYOUT);
      must(
        !simRequested.ok && !simSmall.ok,
        'vault policy.pay(newWallet) reverts',
      );
      // Replay: the same message again freezes nothing new.
      const replay = await say(attack);
      const rr = replies.at(-1)!;
      must(
        rr.riskCase?.outcome === 'DUPLICATE_ALERT' && !rr.riskCase.froze,
        'replayed alert does not freeze twice',
      );
      must(rr.decision.outcome === 'DENY', 'replay still denied');
      const after = await snapshotOfChain();
      must(
        JSON.stringify(before.usdc) === JSON.stringify(after.usdc),
        'USDC balances unchanged',
      );
      must(
        JSON.stringify(before.nonces) === JSON.stringify(after.nonces),
        'nonces unchanged',
      );
      log(posted ?? '');
      attackDetail = { before, after, simRequested, simSmall };
      return {
        gateway: outcome,
        composedAnswer: posted,
        reply: summary(r),
        vaultSimulation: {
          'policy.pay(newWallet, 100 USDC)': simRequested,
          [`policy.pay(newWallet, ${PAYOUT} base units)`]: simSmall,
          method: 'eth_call from the vault operator (never broadcast)',
        },
        balancesAndNonces: { before, after, unchanged: true },
        replay: {
          gateway: replay.outcome,
          riskCase: rr.riskCase,
          decision: rr.decision,
        },
      };
    },
  );

  // -------------------------------------------------------------- 2b
  await step(
    21,
    'Conflict: CFO says pay now (cash is available), Risk says hold (changed destination); the Kernel decides',
    [
      'LOCAL_INGRESS',
      'LIVE_MODEL',
      'LIVE_ARC_TESTNET reads',
      'ETH_CALL_ONLY',
      'POSTGRES',
    ],
    async () => {
      const before = await snapshotOfChain();
      const display = (Number(PAYOUT) / 1e6).toFixed(6).replace(/0+$/, '');
      const { posted } = await say(
        `Pay Sarah ${display} USDC now to this new wallet address ${newWallet}`,
      );
      const r = replies.at(-1)!;
      const cfo = r.sections.find((x) => x.persona === 'CFO');
      const risk = r.sections.find((x) => x.persona === 'RISK');
      must(
        cfo?.stance === 'PAY' && risk?.stance === 'VETO',
        `CFO pay vs Risk hold (${cfo?.stance}/${risk?.stance})`,
      );
      must(
        r.conflicts.length === 1 &&
          r.conflicts[0]!.resolvedBy === 'KERNEL' &&
          r.decision.outcome === 'DENY',
        'the Kernel resolved the conflict with DENY',
      );
      must(!r.kernel?.grant, 'no grant exists to execute');
      must(
        r.riskCase && !r.riskCase.froze,
        'the existing case absorbs the new alert without a second freeze',
      );
      const after = await snapshotOfChain();
      must(
        JSON.stringify(before.usdc) === JSON.stringify(after.usdc) &&
          JSON.stringify(before.nonces) === JSON.stringify(after.nonces),
        'no money moved',
      );
      log(posted ?? '');
      return {
        composedAnswer: posted,
        reply: summary(r),
        balancesAndNonces: { before, after, unchanged: true },
      };
    },
  );

  // -------------------------------------------------------------- 3
  let payoutHash: Hex | null = null;
  if (!NO_PAYOUT)
    await step(
      3,
      `Owner-approved payout to Sarah's verified address (${path})`,
      path === 'VAULT_POLICY_PAY'
        ? [
            'LOCAL_INGRESS',
            'LIVE_MODEL',
            'LIVE_ARC_TESTNET',
            'SEPARATE_PROCESS',
          ]
        : ['LIVE_ARC_TESTNET', 'AGENT_WALLET_GRANTED_PAYOUT'],
      async () => {
        const ask = `Pay Sarah's invoice ${invoice.number}`;
        const { posted } = await say(ask);
        const proposal = replies.at(-1)!;
        must(
          proposal.decision.status === 'PROPOSED' &&
            proposal.kernel?.confirmation,
          `chat proposal needs the owner signature (${proposal.decision.status})`,
        );
        const c = proposal.kernel!.confirmation!;
        // The owner's wallet (separate process) signs the exact PaymentApproval.
        const signature = await owner.signTypedData(c.typedData);
        const granted = await runTeam(ask, `confirm_${runId}`, {
          ownerApproval: signature,
          approval: c.approval,
        });
        must(
          granted.decision.status === 'GRANTED' && granted.kernel?.grant,
          `Kernel grant after owner approval (${granted.decision.status}: ${granted.decision.reasons.join('; ')})`,
        );
        const grant = granted.kernel!.grant!;
        // The same owner approval replayed gets nothing (one-use nonce, one grant per obligation).
        const replay = await runTeam(ask, `replay_${runId}`, {
          ownerApproval: signature,
          approval: c.approval,
        });
        must(
          replay.decision.outcome === 'DENY' && !replay.kernel?.grant,
          `replayed owner approval is refused (${replay.decision.status})`,
        );
        const before = await snapshotOfChain();
        let payout: Record<string, unknown>;
        if (path === 'VAULT_POLICY_PAY') {
          const ref = keccak256(stringToHex(grant.intentId));
          pending.push({
            ref: grant.grantId,
            kind: 'ARC_PAYOUT',
            tool: 'payment.submitToKernel',
            amountBaseUnits: String(PAYOUT),
            since: now(),
            detail: 'grant issued; executor paying',
          });
          const p = await executor.pay({
            grant,
            recipient: sarah,
            amount: PAYOUT,
            ref,
            onHash: async (h) => {
              payoutHash = h;
              await cases.record(workspaceId, 'EXECUTOR', 'PAYOUT_SIGNED', {
                hash: h,
                grantId: grant.grantId,
              });
            },
          });
          pending.splice(0);
          paid = true;
          mandateState.spends.push({ amount: PAYOUT, at: now() });
          payoutHash = p.hash;
          payout = {
            ...p,
            path,
            call: `policy.pay(${sarah}, ${PAYOUT}, keccak256(intentId))`,
          };
        } else {
          // Fallback: the agent wallet granted payout path (its own Kernel mandate and grant).
          const out = spawnSync(
            'node',
            [
              '--import',
              'tsx',
              'scripts/arc-granted-payout.ts',
              '--amount',
              (Number(PAYOUT) / 1e6).toFixed(6),
              '--fund',
              '0.01',
            ],
            { encoding: 'utf8', timeout: 300_000 },
          );
          must(
            out.status === 0,
            `granted payout script failed: ${out.stderr.slice(-400)}`,
          );
          const file = /evidence -> (.+)$/m.exec(out.stdout)?.[1] ?? null;
          payout = {
            path,
            evidenceFile: file,
            note: 'vault 24h operator window could not fit the payout; agent-wallet granted payout path used',
          };
        }
        const after = await snapshotOfChain();
        if (path === 'VAULT_POLICY_PAY') {
          must(
            BigInt(after.usdc.sarah) - BigInt(before.usdc.sarah) === PAYOUT,
            'Sarah credited exactly',
          );
          must(
            BigInt(before.usdc.vault) - BigInt(after.usdc.vault) === PAYOUT,
            'vault debited exactly',
          );
          const rec = await arc.client.getTransactionReceipt({
            hash: payoutHash!,
          });
          const t = parseEventLogs({
            abi: erc20Abi,
            eventName: 'Transfer',
            logs: rec.logs,
          }).filter(
            (l) => l.address.toLowerCase() === USDC.address.toLowerCase(),
          );
          must(
            t.some(
              (l) =>
                l.args.from.toLowerCase() === vault.toLowerCase() &&
                l.args.to.toLowerCase() === sarah.toLowerCase() &&
                l.args.value === PAYOUT,
            ),
            'receipt has the exact vault -> Sarah transfer',
          );
          await cases.record(
            workspaceId,
            'AUDIT',
            'PAYOUT_RECONCILED',
            { hash: payoutHash, amount: PAYOUT, recipient: sarah },
            [
              citeFact({
                claim: `${PAYOUT} base units USDC vault -> Sarah`,
                source: 'chain:arc-testnet',
                ref: payoutHash!,
                provenance: 'CHAIN',
                observedAt: now(),
                now: now(),
                verifyUrl: explorerTx(payoutHash!),
              }),
            ],
          );
        }
        return {
          chatProposal: posted,
          proposal: summary(proposal),
          ownerApproval: {
            intentId: c.intent.intentId,
            nonce: c.approval.nonce,
            deadline: c.approval.deadline,
            signature,
            signer: owner.address,
          },
          grant: {
            grantId: grant.grantId,
            recipient: grant.recipient,
            amount: grant.amount,
            expiresAt: grant.expiresAt,
          },
          decision: summary(granted).decision,
          payout,
          explorer: payoutHash ? explorerTx(payoutHash) : null,
          balances: { before, after },
          replay: { decision: replay.decision },
        };
      },
    );

  // -------------------------------------------------------------- 4
  await step(
    4,
    'Forensic audit: hash chain, redaction, zero model signing, metrics',
    ['POSTGRES'],
    async () => {
      const check = await cases.verifyTrail(workspaceId);
      must(check.ok, 'audit chain verifies');
      const trail = await cases.store.audit(workspaceId);
      must(!containsSecrets(trail), 'no secrets in the audit trail');
      const signing = replies.map((r) => r.metrics.signing);
      must(
        signing.every((s) => s.modelSignatures === 0 && s.assertion === 'PASS'),
        'zero model signing in every run',
      );
      const totals = replies.reduce(
        (a, r) => ({
          runs: a.runs + 1,
          modelCalls: a.modelCalls + r.metrics.modelCalls,
          inputTokens: a.inputTokens + r.metrics.inputTokens,
          outputTokens: a.outputTokens + r.metrics.outputTokens,
          toolCalls: a.toolCalls + r.metrics.toolCalls,
          latencyMs: a.latencyMs + r.metrics.latencyMs,
        }),
        {
          runs: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          latencyMs: 0,
        },
      );
      return {
        auditChain: check,
        auditRecords: trail.length,
        database: `${new URL(url).host}/${new URL(url).pathname.slice(1)} (synq_risk_migrations)`,
        metrics: {
          ...totals,
          model: replies.find((r) => r.metrics.model)?.metrics.model ?? null,
          perRun: replies.map((r) => ({
            runId: r.metrics.runId,
            status: r.status,
            decision: r.decision.status,
            modelCalls: r.metrics.modelCalls,
            inputTokens: r.metrics.inputTokens,
            outputTokens: r.metrics.outputTokens,
            toolCalls: r.metrics.toolCalls,
            latencyMs: r.metrics.latencyMs,
            guard: r.metrics.guard,
          })),
        },
        zeroModelSigning: {
          runtime: signing,
          architecture:
            'scripts/architecture.mjs: no planner package (agent-runtime, world-model, plugins) can import a signer; this process loads no key (wallet and executor run as child processes)',
          processes: {
            supervisor: process.pid,
            executor: exec.pid,
            executorOperator: exec.operator,
          },
        },
        attack: attackDetail,
      };
    },
  );
} finally {
  await executor.stop();
  await stopChild(wallets);
  await pool.end();
}

evidence.steps = steps;
evidence.transcript = tg.transcript;
evidence.botApiMethods = [...new Set(tg.calls.map((c) => c.method))];
const shortHash = (
  (
    steps.find((s) => s.step === 3)?.detail as
      | { payout?: { hash?: string } }
      | undefined
  )?.payout?.hash ?? `0x${runId}`
).slice(2, 10);
const dir =
  process.env.SYNQ_EVIDENCE_DIR ??
  '/Users/kaushikh/Synq/synq-v13/bounty-evidence/arc';
mkdirSync(dir, { recursive: true });
const file = join(dir, `agent-team-${shortHash}.json`);
writeFileSync(file, JSON.stringify(big(evidence), null, 2) + '\n');
console.log('\n================ summary');
for (const s of steps)
  console.log(
    `Step ${s.step} [${s.labels.join(' + ')}] ${s.status}: ${s.title}${s.error ? ` -- ${s.error}` : ''}`,
  );
console.log(`evidence -> ${file}`);
if (steps.some((s) => s.status !== 'OK')) process.exitCode = 1;
