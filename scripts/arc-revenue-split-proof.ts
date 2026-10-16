/**
 * Live Arc testnet proof of the post-receipt revenue waterfall and split.
 *
 *   # 1. client pays an invoice into the treasury; the split runs and the
 *   #    process dies after leg 1 is paid and leg 2 is signed (exit 137)
 *   node --import tsx scripts/arc-revenue-split-proof.ts --dir <run dir> --crash
 *   # 2. restart: resume from Postgres + the outbox, finish, reconcile, prove caps
 *   node --import tsx scripts/arc-revenue-split-proof.ts --dir <run dir>
 *
 * Scenario: the $1,500 freelancer receipt at 1:100,000 scale (0.015 USDC).
 * Principals (testnet keys under ~/.synq, read by path, never printed):
 *   owner      testnet.key         signs the invoice, the revenue policy and its mandate
 *   client     arc-client.key      pays the invoice through Arc's Memo contract
 *   operator   arc-agent.key       vault operator: sends policy.pay for each leg
 *   contractor arc-contractor.key  (address only) verified vendor, vault allowlisted
 * Treasury: the governed vault (SYNQ_ARC_VAULT_SAFE). Each transfer leg is
 * a Kernel grant bound to the exact call, paid once through
 * `policy.pay` (contract caps 0.01/payment, 0.02/24h), recorded before
 * broadcast. Live vault spend is held to 0.003 USDC (coordinator budget
 * 0.01); the window is read before each leg. If the window cannot cover
 * the legs, `--mode wallet` pays from the operator wallet with `payOnce`
 * instead (labelled AGENT_WALLET_FALLBACK). Over-cap proofs are eth_call only.
 *
 * State: Postgres `synq_m2_allocations` (ledger, invoices, vendors, split
 * workflow) plus a file outbox and journal under --dir.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  createWalletClient,
  erc20Abi,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  decide,
  mandateTypedData,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  Ledger,
  PostgresLedgerStore,
  walletCashWei,
  walletTag,
} from '@synq/ledger';
import {
  InvoiceService,
  PostgresInvoiceStore,
  draftInvoice,
  extractMemoPayments,
  issueTypedData,
  payCall,
  type Invoice,
} from '@synq/invoices';
import {
  PostgresVendorStore,
  vendorDirectory,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import {
  PostgresSplitStore,
  SCENARIOS,
  SplitRunner,
  canDeployToYield,
  computeWaterfall,
  explainAllocation,
  forecastCash,
  isoDay,
  legRef,
  mandateFromPolicy,
  openPayables,
  parsePolicy,
  policyHash,
  policyTypedData,
  receiptKey,
  receivablesFromInvoices,
  totals,
  units,
  type FinalReceipt,
  type RecurringBill,
  type RevenuePolicy,
  type SignedRevenuePolicy,
  type TreasuryBooks,
} from '@synq/allocations';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import {
  PostgresOutboxStore,
  PostgresGrantFence,
} from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { SAFE_ABI, simulate } from '@synq/execution-worker/vault';
import {
  readVaultWindow,
  vaultPayData,
} from '@synq/execution-worker/vault-outbox';
import { migrateFinance } from '@synq/ledger';
import { vaultLegExecutor, walletLegExecutor } from './lib/split-executor.js';

// ------------------------------------------------------------------ setup

const arg = (n: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : null;
const flag = (n: string) => process.argv.includes(`--${n}`);
const dir = arg('dir');
if (!dir) throw new Error('--dir <run dir> is required');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const crash = flag('crash');
const evidenceDir =
  arg('evidence') ??
  join(process.env.HOME!, 'Synq', 'synq-v13', 'bounty-evidence', 'arc');
const DB =
  process.env.SYNQ_ALLOCATIONS_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:55433/synq_m2_allocations';
const key = (f: string) => {
  const k = readFileSync(join(process.env.HOME!, '.synq', f), 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const owner = privateKeyToAccount(key('testnet.key'));
const client = privateKeyToAccount(key('arc-client.key'));
const agent = privateKeyToAccount(key('arc-agent.key'));
const contractorAddr = privateKeyToAccount(key('arc-contractor.key')).address;
const chain = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const memo = contract('arc-testnet', 'MEMO').address as Address;
const VAULT = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address as Address;
const POLICY = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const explorer = CHAINS['arc-testnet'].explorer;
const u = (d: string) => moneyFromDecimal(usdc, d).baseUnits;
const now = () => Math.floor(Date.now() / 1000);
const journalPath = join(dir, 'journal.log');
const note = (m: string) => {
  appendFileSync(
    journalPath,
    `${new Date().toISOString()} pid=${process.pid} ${m}\n`,
  );
  console.log(m);
};
const enc = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2);
const dec = <T>(s: string): T =>
  JSON.parse(s, (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;
const pool = new pg.Pool({ connectionString: DB, max: 4 });
await migrateFinance(pool);
const splitStore = new PostgresSplitStore(pool);
await splitStore.migrate();
const sha = execSync('git rev-parse HEAD').toString().trim();

type RunState = {
  runId: string;
  mode: 'VAULT' | 'AGENT_WALLET_FALLBACK';
  workspaceId: string;
  treasury: Address;
  grantKeyFile: string;
  policy: RevenuePolicy;
  signed: SignedRevenuePolicy;
  vendorInvoices: VendorInvoice[];
  bills: RecurringBill[];
  invoiceId: string;
  arInvoiceId: string;
  receipt: FinalReceipt | null;
  startBlock: bigint;
  before: Record<string, bigint>;
  windowBefore: Record<string, string>;
  fundingTxs: { label: string; hash: Hex }[];
  paymentTx: Hex | null;
  setupAt: number;
};
const statePath = join(dir, 'run.json');
const fresh = !existsSync(statePath);

const balances = async (wallets: Record<string, Address>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(wallets).map(async ([k, a]) => [
        k,
        await chain.client.getBalance({ address: a }),
      ]),
    ),
  ) as Record<string, bigint>;

const windowJson = (w: Awaited<ReturnType<typeof readVaultWindow>>) => ({
  perPaymentCap: units(w.perPaymentCap, 6),
  windowCap: units(w.windowCap, 6),
  windowSpent: units(w.windowSpent, 6),
  remaining: units(w.remaining, 6),
  resetsAt: new Date(Number(w.resetsAt) * 1000).toISOString(),
  paused: String(w.paused),
});

// ------------------------------------------------------------------ first run: invoice, policy, payment

let st: RunState;
if (fresh) {
  const runId = randomBytes(4).toString('hex');
  const window = await readVaultWindow(chain);
  // Live transfer legs: $200 + $100 contractor milestones = 0.003 USDC.
  const legSpend = u('0.003');
  const forced = arg('mode');
  const mode: RunState['mode'] =
    forced === 'wallet' ||
    window.remaining < legSpend + u('0.005') ||
    window.paused
      ? 'AGENT_WALLET_FALLBACK'
      : 'VAULT';
  const treasury = mode === 'VAULT' ? VAULT : agent.address;
  note(
    `setup run=${runId} mode=${mode} vault window remaining=${units(window.remaining, 6)} (needs ${units(legSpend, 6)} + 0.005 kept for the agent-team builder)`,
  );
  const wallets = { treasury, operator: agent.address, client: client.address };
  const bal = await balances(wallets);
  if (bal.client! < u('0.05') * 10n ** 12n)
    throw new Error('client wallet below 0.05 USDC: top up first');
  if (bal.operator! < u('0.05') * 10n ** 12n)
    throw new Error('operator wallet below 0.05 USDC for gas');
  const grantKeyFile = join(dir, 'grant.key');
  writeFileSync(grantKeyFile, randomBytes(32).toString('hex') + '\n', {
    mode: 0o600,
  });
  const workspaceId = `wsp_split_${runId}`;
  const vendors = new PostgresVendorStore(pool);
  const contractor: Vendor = {
    vendorId: `vnd_contractor_${runId}`,
    workspaceId,
    name: 'Dev Contractor (test)',
    kind: 'CONTRACTOR',
    addresses: [
      {
        chainId: usdc.chainId,
        address: contractorAddr,
        status: 'VERIFIED',
        source: 'onboarding: signed challenge from arc-contractor.key',
        at: now(),
        verifiedBy: 'owner',
      },
    ],
  };
  await vendors.save(contractor, null);
  const today = isoDay(now());
  const inDays = (n: number) => isoDay(now() + n * 86_400);
  const vendorInvoices: VendorInvoice[] = [
    ['m1', '0.002', 5],
    ['m2', '0.001', 9],
  ].map(([m, amt, due]) => ({
    vendorInvoiceId: `vin_${runId}_${m}`,
    vendorId: contractor.vendorId,
    number: `DEV-${runId}-${m}`,
    payTo: contractorAddr,
    chainId: usdc.chainId,
    token: usdc.address,
    decimals: usdc.decimals,
    amount: u(amt as string),
    issuedOn: today,
    dueOn: inDays(due as number),
    reference: null,
    documentText: `Contractor milestone ${m} for run ${runId}: implementation and review`,
    earlyPayDiscountBps: 0,
    earlyPayByDays: 0,
  }));
  const bills: RecurringBill[] = [
    {
      billId: 'bill_software',
      label: 'Design software',
      kind: 'SUBSCRIPTION',
      amount: u('0.00045'),
      nextDueOn: inDays(12),
      cadenceDays: 30,
    },
    {
      billId: 'bill_cowork',
      label: 'Co-working desk',
      kind: 'RENT',
      amount: u('0.0025'),
      nextDueOn: inDays(20),
      cadenceDays: 30,
    },
  ];
  // This workspace's floor is funded only from its booked receipt, even
  // though other workspaces may share the same on-chain treasury.
  const policy = parsePolicy({
    policyId: `freelancer_revenue_${runId}`,
    version: 1,
    workspaceId,
    owner: owner.address,
    chainId: usdc.chainId,
    token: usdc.address,
    decimals: 6,
    treasury,
    validFrom: now() - 60,
    validUntil: now() + 7 * 86_400,
    taxReserveBps: 1_500,
    operatingFloor: u('0.005'),
    obligationHorizonDays: 30,
    allowedBeneficiaries: [
      {
        beneficiaryId: contractor.vendorId,
        address: contractorAddr,
        label: 'Dev contractor',
      },
    ],
    distributions: [],
    limits: {
      // Never above the vault's own per-payment cap; the window limit is this proof's budget.
      maxAutonomousPerLeg:
        window.perPaymentCap < u('0.005') ? window.perPaymentCap : u('0.005'),
      maxAutonomousPerWindow: u('0.005'),
      windowSeconds: 86_400,
      maxSplitsPerWindow: 3,
    },
    maxBalanceAgeSeconds: 600,
    remainder: 'FREE_CASH',
    cancellation: 'BEFORE_EXECUTION',
    recovery: 'RECONCILE_THEN_REVIEW',
  });
  const mandate = mandateFromPolicy(policy);
  const signed: SignedRevenuePolicy = {
    policy,
    policySignature: await owner.signTypedData(policyTypedData(policy)),
    mandate,
    mandateSignature: await owner.signTypedData(mandateTypedData(mandate)),
  };
  // Invoices: the $1,500 one the client pays now, and a $2,000 one still open (AR).
  const ledger = new Ledger(
    new PostgresLedgerStore(pool),
    vendorDirectory([contractor]),
  );
  const invoices = new InvoiceService(
    new PostgresInvoiceStore(pool),
    ledger,
    now,
  );
  const mk = async (n: string, payer: string, total: string, due: number) => {
    const d = draftInvoice({
      workspaceId,
      number: `INV-SPLIT-${runId}-${n}`,
      issuer: {
        principalId: 'prn_freelancer',
        name: 'Synq Studio (test)',
        wallet: owner.address,
        payoutAddress: treasury,
      },
      payer: { name: payer, contact: null },
      asset: usdc,
      lineItems: [
        {
          description: `Project work (${payer})`,
          quantity: 1,
          unitPrice: u(total),
        },
      ],
      dueDate: inDays(due),
      draftedBy: 'agent:invoice',
      now: now(),
    });
    await invoices.create(d);
    return (
      await invoices.issue(
        d.invoiceId,
        await owner.signTypedData(issueTypedData(d)),
      )
    ).invoice;
  };
  const inv = await mk('1', 'Acme (test client)', '0.015', 7);
  const ar = await mk('2', 'Globex (test client)', '0.02', 20);
  st = {
    runId,
    mode,
    workspaceId,
    treasury,
    grantKeyFile,
    policy,
    signed,
    vendorInvoices,
    bills,
    invoiceId: inv.invoiceId,
    arInvoiceId: ar.invoiceId,
    receipt: null,
    startBlock: await chain.client.getBlockNumber(),
    before: await balances({ treasury, operator: agent.address }),
    windowBefore: windowJson(window),
    fundingTxs: [],
    paymentTx: null,
    setupAt: now(),
  };
  writeFileSync(statePath, enc(st), { mode: 0o600 });
  // The client pays through Memo: transfer(treasury, 0.015) tagged with the invoice reference.
  await verifyContract(chain, 'MEMO');
  const call = payCall(inv, inv.total);
  const wallet = createWalletClient({
    account: client,
    chain: {
      id: usdc.chainId,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [CHAINS['arc-testnet'].rpcUrls[0]!] } },
    },
    transport: http(CHAINS['arc-testnet'].rpcUrls[0]),
  });
  const hash = await wallet.sendTransaction({ to: memo, data: call.calldata });
  st.paymentTx = hash;
  writeFileSync(statePath, enc(st), { mode: 0o600 });
  note(`client paid invoice ${inv.number}: ${explorer}/tx/${hash}`);
} else {
  st = dec<RunState>(readFileSync(statePath, 'utf8'));
  note(`restart run=${st.runId} mode=${st.mode}`);
}

// ------------------------------------------------------------------ shared wiring

const grantKey = Buffer.from(
  readFileSync(st.grantKeyFile, 'utf8').trim(),
  'hex',
);
const vendorStore = new PostgresVendorStore(pool);
const vendors = await vendorStore.list(st.workspaceId);
const ledger = new Ledger(
  new PostgresLedgerStore(pool),
  vendorDirectory(vendors),
);
const invoiceStore = new PostgresInvoiceStore(pool);
const invoices = new InvoiceService(invoiceStore, ledger, now);

/** Re-reads a Memo payment at a finalized block and settles the invoice (idempotent). */
async function finalReceipt(hash: Hex): Promise<FinalReceipt> {
  const receipt = await chain.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`payment reverted ${hash}`);
  const finalized = await chain.client.getBlock({ blockTag: 'finalized' });
  const { payments, unreferenced } = extractMemoPayments({
    chainId: usdc.chainId,
    txHash: hash,
    logs: receipt.logs,
    token: usdc.address,
    memoContract: memo,
  });
  if (payments.length !== 1 || unreferenced.length)
    throw new Error(
      `unexpected memo match ${payments.length}/${unreferenced.length}`,
    );
  const p = payments[0]!;
  const settled = await invoices.settle(p);
  if (settled.outcome === 'UNMATCHED') throw new Error(settled.reason);
  const inv = settled.invoice;
  if (inv.invoiceId !== st.invoiceId)
    throw new Error('Memo payment matched another invoice');
  return {
    receiptId: receiptKey(p.chainId, p.txHash, p.logIndex),
    chainId: p.chainId,
    token: usdc.address,
    txHash: p.txHash,
    logIndex: p.logIndex,
    blockNumber: receipt.blockNumber,
    amount: p.amount,
    recipient: p.recipient,
    payer: p.payer,
    invoiceId: inv.invoiceId,
    invoiceNumber: inv.number,
    source: 'MEMO_INVOICE',
    finality: finalized.number >= receipt.blockNumber ? 'FINAL' : 'PENDING',
  };
}

const books: TreasuryBooks = {
  async position() {
    const finalized = await chain.client.getBlock({ blockTag: 'finalized' });
    const cash = await chain.client.readContract({
      address: usdc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [st.treasury],
      blockNumber: finalized.number,
    });
    const bal = await ledger.balances(st.workspaceId, usdc.assetId);
    return {
      treasury: st.treasury,
      onChainFinalized: cash,
      observedBlock: finalized.number,
      observedAt: Number(finalized.timestamp),
      source: `rpc:arc-testnet usdc.balanceOf(${st.treasury})@finalized#${finalized.number}`,
      committedOutgoing: 0n,
      escrowLiabilities: -bal.ESCROW_LIABILITY,
      refundLiabilities: -bal.REFUND_LIABILITY,
      invested: 0n,
    };
  },
  vendors: async () => vendors,
  payables: async () =>
    openPayables(st.vendorInvoices, await ledger.store.entries(st.workspaceId)),
  payableHistory: async () => st.vendorInvoices,
  obligations: async () => [],
  bills: async () => st.bills,
  receivables: async () =>
    receivablesFromInvoices(
      (await invoiceStore.list(st.workspaceId)).map(
        (x) => x.invoice as Invoice,
      ),
    ),
};

await migrateExecution(pool);
const outbox = new PostgresOutboxStore(pool);
const countingSigner = {
  address: agent.address,
  async signTransaction(tx: Parameters<typeof agent.signTransaction>[0]) {
    note(
      `SIGNED nonce=${tx.nonce} to=${tx.to} data=${String(tx.data).slice(0, 10)}…`,
    );
    return agent.signTransaction(tx);
  },
};
let transferLegKeys: string[] = [];
const windows: {
  at: string;
  legKey: string | null;
  window: Record<string, string>;
}[] = [];
const common = {
  chain,
  store: outbox,
  signer: countingSigner,
  asset: usdc,
  grantKey,
  fence: new PostgresGrantFence(pool),
  now,
  afterRecord: async (legKey: string, r: { hash: Hex }) => {
    note(`RECORDED ${legKey} hash=${r.hash} (durable before broadcast)`);
    if (crash && legKey === transferLegKeys[1]) {
      note(
        `CRASH: killing the process after recording leg ${legKey}, before broadcast`,
      );
      process.exit(137);
    }
  },
};
const baseExecutor =
  st.mode === 'VAULT' ? vaultLegExecutor(common) : walletLegExecutor(common);
// Read the live vault window before every leg (coordinator rule).
const executor: typeof baseExecutor = {
  ...baseExecutor,
  async pay(call) {
    if (st.mode === 'VAULT') {
      const w = await readVaultWindow(chain);
      windows.push({
        at: new Date().toISOString(),
        legKey: call.legKey,
        window: windowJson(w),
      });
      note(`window before ${call.legKey}: remaining ${units(w.remaining, 6)}`);
      if (!(await outbox.get(call.legKey)) && w.remaining < call.amount)
        throw new Error(
          `vault window has ${w.remaining} left, leg needs ${call.amount}`,
        );
    }
    return baseExecutor.pay(call);
  },
};
const kernel: AuthorityConfig = {
  grantKey,
  operator: `allocations:${st.runId}`,
  grantTtlSeconds: 1_800,
  riskRequiredAbove: u('1'),
};
const trace: { at: string; event: string; detail: Record<string, unknown> }[] =
  [];
const runner = new SplitRunner({
  store: splitStore,
  ledger,
  executor,
  receipts: {
    verify: async (r) => {
      const again = await finalReceipt(r.txHash);
      if (again.receiptId !== r.receiptId)
        throw new Error('receipt key changed');
      return again;
    },
  },
  books,
  signedPolicy: st.signed,
  registry: {
    async principals(workspaceId) {
      if (workspaceId !== st.workspaceId) throw new Error('unknown workspace');
      const owners =
        st.mode === 'VAULT'
          ? await chain.client.readContract({
              address: st.treasury,
              abi: SAFE_ABI,
              functionName: 'getOwners',
            })
          : [owner.address];
      return {
        treasury: st.treasury,
        owners: owners.filter(
          (a) => a.toLowerCase() === owner.address.toLowerCase(),
        ),
        source: 'configured workspace owner intersected with live Safe owners',
      };
    },
  },
  kernel,
  assetId: usdc.assetId,
  chain: 'arc-testnet',
  now,
  trace: (event, detail) => {
    trace.push({ at: new Date().toISOString(), event, detail });
    note(
      `${event} ${JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`,
    );
  },
});

// ------------------------------------------------------------------ run / resume

if (!st.receipt) {
  st.receipt = await finalReceipt(st.paymentTx!);
  writeFileSync(statePath, enc(st), { mode: 0o600 });
  note(
    `receipt ${st.receipt.receiptId} finality=${st.receipt.finality} amount=${units(st.receipt.amount, 6)}`,
  );
}
const triggered = await runner.trigger(st.receipt);
const again = await runner.trigger(st.receipt);
note(
  `trigger split=${triggered.split.splitId} duplicate=${triggered.duplicate}; second trigger duplicate=${again.duplicate}`,
);
const splitId = triggered.split.splitId;
// Know the transfer leg keys before execution (for the crash point).
const planned = await runner.run(splitId, { stopAt: 'SPLIT_AUTHORIZED' });
transferLegKeys = (await splitStore.legs(splitId))
  .filter((l) => l.kind === 'TRANSFER')
  .map((l) => l.legKey);
note(`state ${planned.state}; transfer legs ${transferLegKeys.join(', ')}`);
let final = await runner.run(splitId);
if (final.state === 'FAILED') {
  note(`split FAILED (${final.note}); resuming once`);
  final = await runner.run(splitId);
}
note(`final state ${final.state}`);

// ------------------------------------------------------------------ reconcile ledger vs chain, per wallet

const legs = await splitStore.legs(splitId);
const myTxs = [
  st.paymentTx!,
  ...legs.filter((l) => l.txHash).map((l) => l.txHash!),
];
const tracked = { treasury: st.treasury, operator: agent.address };
const effects: Record<string, bigint> = { treasury: 0n, operator: 0n };
const txRows = [];
for (const h of myTxs) {
  const [r, tx] = await Promise.all([
    chain.client.getTransactionReceipt({ hash: h }),
    chain.client.getTransaction({ hash: h }),
  ]);
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r.logs,
  }).filter((l) => l.address.toLowerCase() === usdc.address.toLowerCase());
  const fee = r.gasUsed * r.effectiveGasPrice;
  for (const [role, addr] of Object.entries(tracked)) {
    const a = addr.toLowerCase();
    for (const t of transfers) {
      if (t.args.to.toLowerCase() === a)
        effects[role]! += t.args.value * 10n ** 12n;
      if (t.args.from.toLowerCase() === a)
        effects[role]! -= t.args.value * 10n ** 12n;
    }
    if (tx.from.toLowerCase() === a) effects[role]! -= fee;
  }
  txRows.push({
    hash: h,
    block: String(r.blockNumber),
    from: tx.from,
    feeWei: String(fee),
    explorer: `${explorer}/tx/${h}`,
  });
}
const entries = await ledger.store.entries(st.workspaceId);
const ledgerCash = walletCashWei(entries, usdc.assetId);
const after = await balances(tracked);
const endBlock = await chain.client.getBlockNumber({ cacheTime: 0 });
const reconciliation = Object.entries(tracked).map(([role, addr]) => {
  const book = ledgerCash.get(walletTag(addr)) ?? 0n;
  const delta = after[role]! - st.before[role]!;
  return {
    role,
    address: addr,
    ledgerWei: String(book),
    chainEffectOfOurTxsWei: String(effects[role]),
    matchesToTheWei: book === effects[role],
    balanceDeltaWei: String(delta),
    foreignActivityWei: String(delta - effects[role]!),
  };
});
const reconciled = reconciliation.every((r) => r.matchesToTheWei);
note(
  `reconciliation ${reconciled ? 'RECONCILED' : 'UNRECONCILED'}: ${JSON.stringify(reconciliation)}`,
);

// ------------------------------------------------------------------ P14-05: over-cap leg refused in TS and by the contract

const liveWindow = await readVaultWindow(chain);
const overCap = liveWindow.perPaymentCap + u('0.002');
const tsPlan = computeWaterfall({
  policy: st.policy,
  policyHash: policyHash(st.policy),
  receipt: { ...st.receipt, receiptId: `${st.receipt.receiptId}:what-if` },
  position: {
    ...(await books.position()),
    reservations: 0n,
    onChainFinalized: st.receipt.amount + u('0.05'),
  },
  asOf: now(),
  vendors,
  payables: [
    {
      ...st.vendorInvoices[0]!,
      vendorInvoiceId: 'vin_overcap',
      number: 'DEV-OVERCAP',
      amount: overCap,
      documentText:
        'Over-cap what-if: a single large contractor payout above the vault cap',
    },
  ],
  payableHistory: st.vendorInvoices,
  obligations: [],
  bills: [],
  receivables: [],
});
const overLeg = tsPlan.legs.find((l) => l.documentRef === 'vin_overcap');
const kernelOver = await decide({
  config: kernel,
  mandate: st.signed.mandate,
  mandateSignature: st.signed.mandateSignature,
  state: { revoked: false, spends: [] },
  intent: {
    intentId: 'int_overcap',
    mandateId: st.signed.mandate.mandateId,
    mandateVersion: st.signed.mandate.version,
    chainId: usdc.chainId,
    token: usdc.address,
    payer: st.treasury,
    recipient: contractorAddr,
    amount: overCap,
    purpose: 'CONTRACTOR_PAYOUT',
    obligationRef: 'payable:vin_overcap',
    evidenceHash: legRef('overcap'),
    proposedBy: 'proof',
  },
  risk: { flags: [], available: true },
  simulationOk: true,
  now: now(),
});
const overRef = legRef(`${st.receipt.receiptId}#overcap`);
const simPerPayment = await simulate(
  chain,
  agent.address,
  POLICY,
  vaultPayData({ recipient: contractorAddr, amount: overCap, ref: overRef }),
);
const windowProbe =
  liveWindow.remaining < liveWindow.perPaymentCap
    ? liveWindow.remaining + 1n
    : null;
const simWindow = windowProbe
  ? await simulate(
      chain,
      agent.address,
      POLICY,
      vaultPayData({
        recipient: contractorAddr,
        amount: windowProbe,
        ref: overRef,
      }),
    )
  : null;
const simInCap = await simulate(
  chain,
  agent.address,
  POLICY,
  vaultPayData({ recipient: contractorAddr, amount: 1n, ref: overRef }),
);
note(
  `over-cap ${units(overCap, 6)}: TS autonomy=${overLeg?.autonomy} kernel=${kernelOver.outcome}; vault eth_call ${simPerPayment.ok ? 'OK (!)' : simPerPayment.reason}`,
);

// ------------------------------------------------------------------ forecast + yield gate from the real books

const pos = await books.position();
const heldTax = (await splitStore.reservations(st.workspaceId))
  .filter((r) => r.status === 'ACTIVE' && r.purpose === 'TAX_ESTIMATE')
  .reduce((a, r) => a + r.amount, 0n);
const forecastInputs = {
  asOf: now(),
  position: { ...pos, reservations: 0n },
  heldForTax: heldTax,
  payables: await books.payables(),
  bills: st.bills,
  receivables: await books.receivables(),
};
const forecasts = SCENARIOS.map((scenario) =>
  forecastCash({ ...forecastInputs, scenario }),
);
const yieldAsk = u('0.02');
const gate = canDeployToYield({
  amount: yieldAsk,
  lockDays: 30,
  operatingFloor: st.policy.operatingFloor,
  stressBuffer: 0n,
  forecasts,
  obligationsImported: true,
  forecastBuiltAt: now(),
  now: now(),
  maxForecastAgeSeconds: 600,
  activeDisputes: 0,
  productEligible: true,
});

// ------------------------------------------------------------------ $1,500 scenario through the same code (fixture numbers)

const scale = (x: bigint) => x * 100_000n;
const fullPlan = computeWaterfall({
  policy: {
    ...st.policy,
    operatingFloor: u('500'),
    limits: {
      ...st.policy.limits,
      maxAutonomousPerLeg: u('400'),
      maxAutonomousPerWindow: u('1000'),
    },
  },
  policyHash: policyHash(st.policy),
  receipt: { ...st.receipt, amount: u('1500'), receiptId: 'fixture:1500' },
  position: {
    ...(await books.position()),
    onChainFinalized: u('1500'),
    reservations: 0n,
    escrowLiabilities: 0n,
    refundLiabilities: 0n,
  },
  asOf: now(),
  vendors,
  payables: st.vendorInvoices.map((i) => ({ ...i, amount: scale(i.amount) })),
  payableHistory: st.vendorInvoices.map((i) => ({
    ...i,
    amount: scale(i.amount),
  })),
  obligations: [],
  bills: st.bills.map((b) => ({ ...b, amount: scale(b.amount) })),
  receivables: [
    {
      invoiceId: 'fixture_ar',
      number: 'INV-2002',
      payer: 'Globex',
      amountDue: u('2000'),
      dueOn: isoDay(now() + 20 * 86_400),
      payerDaysLate: [],
    },
  ],
});

// ------------------------------------------------------------------ evidence

const split = (await splitStore.get(splitId))!;
const reservations = await splitStore.reservations(st.workspaceId);
const explanation = explainAllocation({
  split,
  legs,
  reservations,
  decimals: 6,
  symbol: 'USDC',
  explorer,
});
const journal = readFileSync(journalPath, 'utf8').trim().split('\n');
const signedLines = journal.filter((l) => / SIGNED nonce=/.test(l));
const t = split.plan ? totals(split.plan) : null;
const shortHash = (legs.find((l) => l.txHash)?.txHash ?? st.paymentTx!).slice(
  2,
  10,
);
const label =
  st.mode === 'VAULT'
    ? 'LIVE_ARC_TESTNET'
    : 'LIVE_ARC_TESTNET (AGENT_WALLET_FALLBACK)';
const evidence = {
  label,
  generatedAt: new Date().toISOString(),
  gitSha: sha,
  runId: st.runId,
  mode: st.mode,
  network: {
    chain: 'arc-testnet',
    chainId: usdc.chainId,
    usdc: usdc.address,
    vault: VAULT,
    vaultPolicy: POLICY,
  },
  principals: {
    owner: owner.address,
    client: client.address,
    operator: agent.address,
    contractor: contractorAddr,
    treasury: st.treasury,
  },
  scale: '1:100,000 ($1,500 = 0.015 USDC)',
  vaultWindow: {
    atSetup: st.windowBefore,
    beforeEachLeg: windows,
    atEnd: windowJson(liveWindow),
  },
  invoice: {
    invoiceId: st.invoiceId,
    paymentTx: `${explorer}/tx/${st.paymentTx}`,
    receipt: st.receipt,
  },
  receivableNotSpendable: {
    invoiceId: st.arInvoiceId,
    label: 'issued, unpaid; excluded from cash',
  },
  policy: {
    policyId: st.policy.policyId,
    version: st.policy.version,
    policyHash: policyHash(st.policy),
    owner: st.policy.owner,
    mandateId: st.signed.mandate.mandateId,
    limits: st.policy.limits,
    taxReserveBps: st.policy.taxReserveBps,
    operatingFloor: units(st.policy.operatingFloor, 6),
  },
  split: {
    splitId,
    state: split.state,
    note: split.note,
    events: await splitStore.events(splitId),
    plan: split.plan,
    totals:
      t &&
      Object.fromEntries(Object.entries(t).map(([k, v]) => [k, units(v, 6)])),
  },
  legs: legs.map((l) => ({
    legKey: l.legKey,
    kind: l.kind,
    purpose: l.purpose,
    amount: units(l.amount, 6),
    state: l.state,
    payTo: l.payTo,
    txHash: l.txHash,
    explorer: l.txHash ? `${explorer}/tx/${l.txHash}` : null,
    onChainRef: l.kind === 'TRANSFER' ? legRef(l.legKey) : null,
    grantId: l.grant?.grantId ?? null,
    reasons: l.reasons,
  })),
  reservations: reservations.map((r) => ({ ...r, amount: units(r.amount, 6) })),
  crashRestart: {
    signatures: signedLines.length,
    transferLegs: transferLegKeys.length,
    oneSignaturePerLeg: signedLines.length === transferLegKeys.length,
    journal,
  },
  reconciliation: {
    status: reconciled ? 'RECONCILED' : 'UNRECONCILED',
    startBlock: String(st.startBlock),
    endBlock: String(endBlock),
    wallets: reconciliation,
    transactions: txRows,
  },
  overCap: {
    amount: units(overCap, 6),
    tsRefusal: {
      planAutonomy: overLeg?.autonomy,
      kernelOutcome: kernelOver.outcome,
      kernelReasons: kernelOver.reasons,
    },
    contractRefusal: {
      method: 'eth_call policy.pay from the operator (no broadcast)',
      perPayment: simPerPayment,
      windowProbe:
        windowProbe === null
          ? null
          : { amount: units(windowProbe, 6), result: simWindow },
      inCapControl: simInCap,
    },
  },
  forecast: forecasts.map((f) => ({
    scenario: f.scenario,
    startCash: units(f.startCash, 6),
    receivablesExcluded: units(f.receivablesExcluded, 6),
    points: f.points.map((p) => ({
      days: p.days,
      committedCash: units(p.committedCash, 6),
      expectedCash: units(p.expectedCash, 6),
      lowPoint: units(p.lowPoint, 6),
    })),
  })),
  yieldGate: {
    amount: units(yieldAsk, 6),
    ...gate,
    checks: gate.checks.map((c) => ({
      ...c,
      lowAfterDeposit: units(c.lowAfterDeposit, 6),
    })),
  },
  scenario1500: {
    label: 'LOCAL_FIXTURE (same code, $ amounts)',
    totals: Object.fromEntries(
      Object.entries(totals(fullPlan)).map(([k, v]) => [k, units(v, 6)]),
    ),
    legs: fullPlan.legs.map((l) => ({
      purpose: l.purpose,
      amount: units(l.amount, 6),
      basis: l.basis,
    })),
  },
  explanation,
};
mkdirSync(evidenceDir, { recursive: true });
const file = join(evidenceDir, `revenue-split-${shortHash}.json`);
writeFileSync(file, enc(evidence) + '\n');
note(`evidence -> ${file}`);
console.log(explanation.headline);
await pool.end();
if (split.state !== 'COMPLETED' || !reconciled || simPerPayment.ok)
  process.exit(1);
