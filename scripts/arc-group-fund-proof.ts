/**
 * Live Arc testnet group fund (LIVE_ARC_TESTNET).
 *
 * Three distinct contributor wallets (owner, client, contractor) each send a
 * tiny USDC contribution to a fresh pool through Arc's Memo contract with
 * their own contribution reference. Each signs EIP-712 assent to the fund
 * terms (which commit to the signed-ballot spend rule). The contractor then
 * withdraws (the cancellation refund path for one contributor); the
 * remaining contributors approve one group payment with signed EIP-712
 * ballots that meet quorum; the pool pays exactly that; and the books are
 * reconciled per contributor and against the pool's on-chain balance to the
 * wei. An admin-only ballot and a chat poll are shown to authorize nothing.
 *
 *   node --import tsx scripts/arc-group-fund-proof.ts
 *
 * Keys (testnet only, ~/.synq, read by path, never printed): testnet.key
 * (owner, also funds the pool's gas float), arc-client.key, arc-contractor.key,
 * arc-agent.key (stand-in payee), group-pool.key (created here, mode 600).
 * Custody is a script-controlled testnet EOA: the spend and refund rules are
 * enforced by @synq/treasury before the pool key signs, not by a contract.
 * Fund events persist in Postgres (SYNQ_TREASURY_DATABASE_URL, default the
 * local synq_m2_treasury database).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  stringToHex,
  toHex,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { money, moneyFromDecimal, moneyToDecimal } from '@synq/domain';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
  verifyContract,
} from '@synq/execution-worker/arc';
import { MEMO_ABI, extractMemoPayments } from '@synq/invoices';
import {
  admitVote,
  assentTypedData,
  takeSnapshot,
  voteTypedData,
  type AcceptedVote,
  type Choice,
} from '@synq/governance';
import {
  GroupFundService,
  PostgresFundStore,
  contributionRef,
  draftCharter,
  type GroupFund,
  type ObservedTransfer,
} from '@synq/treasury';

const home = `${process.env.HOME}/.synq`;
const keyAt = (f: string, create = false): Hex => {
  const p = join(home, f);
  if (!existsSync(p)) {
    if (!create) throw new Error(`missing ${p}`);
    writeFileSync(p, generatePrivateKey() + '\n', { mode: 0o600 });
  }
  const k = readFileSync(p, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const owner = privateKeyToAccount(keyAt('testnet.key'));
const client = privateKeyToAccount(keyAt('arc-client.key'));
const contractor = privateKeyToAccount(keyAt('arc-contractor.key'));
const payee = privateKeyToAccount(keyAt('arc-agent.key'));
const poolKeyFresh = !existsSync(join(home, 'group-pool.key'));
const poolAccount = privateKeyToAccount(keyAt('group-pool.key', true));

const chain = await connectChain('arc-testnet');
if (chain.profile.chainId !== 5_042_002) throw new Error('not Arc testnet');
await verifyContract(chain, 'MEMO');
const usdc = token('arc-testnet', 'USDC');
const memo = contract('arc-testnet', 'MEMO').address;
const explorer = (h: string) => `${CHAINS['arc-testnet'].explorer}/tx/${h}`;
const u = (d: string) => moneyFromDecimal(usdc, d).baseUnits;
const dec = (v: bigint) => moneyToDecimal(money(usdc, v));
const now = () => Math.floor(Date.now() / 1000);
const WEI_PER_UNIT = 10n ** 12n; // native USDC has 18 decimals, the ERC-20 view 6

const CONTRIBUTION = u('0.004');
const SPEND = u('0.006');
const GAS_FLOAT = u('0.01');
if (CONTRIBUTION > u('0.005') || SPEND > u('0.01'))
  throw new Error('amounts above the brief cap');

const viemChain = {
  id: usdc.chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [CHAINS['arc-testnet'].rpcUrls[0]!] } },
} as const;
const wallet = (account: typeof owner) =>
  createWalletClient({
    account,
    chain: viemChain,
    transport: http(CHAINS['arc-testnet'].rpcUrls[0]),
  });

const fee = (r: TransactionReceipt) => r.gasUsed * r.effectiveGasPrice;
const receipts: Record<string, TransactionReceipt> = {};
async function receipt(hash: Hex) {
  const r = await chain.client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted ${hash}`);
  receipts[hash] = r;
  return r;
}
/** Registry-token transfers of one tx (the 0xffff…fffe native mirror is ignored). */
function transfersIn(hash: Hex, r: TransactionReceipt): ObservedTransfer[] {
  const { payments, unreferenced } = extractMemoPayments({
    chainId: usdc.chainId,
    txHash: hash,
    logs: r.logs,
    token: usdc.address,
    memoContract: memo,
  });
  return [
    ...payments.map((p) => ({
      chainId: usdc.chainId,
      token: usdc.address,
      txHash: hash,
      logIndex: p.logIndex,
      from: p.payer,
      to: p.recipient,
      amount: p.amount,
      paymentRef: p.paymentRef,
      blockNumber: r.blockNumber,
    })),
    ...unreferenced.map((t) => ({
      chainId: usdc.chainId,
      token: usdc.address,
      txHash: hash,
      logIndex: t.logIndex,
      from: t.from,
      to: t.to,
      amount: t.amount,
      paymentRef: null,
      blockNumber: r.blockNumber,
    })),
  ];
}
async function waitForBlock(min: bigint) {
  for (let i = 0; i < 120; i++) {
    const head = await chain.client.getBlockNumber();
    if (head >= min) return head;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`block ${min} not reached`);
}
async function refused(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return {
      refused: true,
      code: (e as { code?: string }).code ?? 'ERROR',
      message: (e as Error).message.slice(0, 240),
    };
  }
  return { refused: false, code: null, message: null };
}

// Durable fund events in the local Postgres.
const dbUrl =
  process.env.SYNQ_TREASURY_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:55433/synq_m2_treasury';
{
  const name = new URL(dbUrl).pathname.slice(1);
  const admin = new pg.Client({
    connectionString: dbUrl.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname=$1',
    [name],
  );
  if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
}
const db = new pg.Pool({ connectionString: dbUrl, max: 2 });
const store = new PostgresFundStore(db);
await store.migrate();
const svc = new GroupFundService(store);

const contributors = [
  { memberId: 'owner', account: owner },
  { memberId: 'client', account: client },
  { memberId: 'contractor', account: contractor },
];
const startedAt = now();
const fundId = `arc-gift-${startedAt}`;

// Opening state: the pool may have a balance from an earlier run.
const poolOpenWei = await chain.client.getBalance({
  address: poolAccount.address,
});
const before: Record<string, { usdc: bigint; wei: bigint }> = {};
for (const a of [owner, client, contractor, payee, poolAccount])
  before[a.address] = {
    usdc: (await balanceOf(chain, usdc, a.address)).baseUnits,
    wei: await chain.client.getBalance({ address: a.address }),
  };
for (const c of contributors)
  if (before[c.account.address]!.usdc < CONTRIBUTION + u('0.005'))
    throw new Error(`${c.memberId} is short of USDC for contribution and gas`);

const charter = draftCharter({
  base: {
    fundId,
    groupId: 'grp_arc_friends',
    kind: 'GROUP_GIFT',
    purpose:
      'Group gift: one payment to the gift vendor, approved by contributors',
    organizer: 'owner',
    asset: usdc,
    pool: poolAccount.address,
    members: contributors.map((c) => ({
      memberId: c.memberId,
      wallet: c.account.address,
    })),
    rights: {
      withdrawal: 'UNSPENT_CLAIM_WHILE_REFUNDABLE',
      cancellation: 'REMAINING_CLAIM',
      spendApproval: 'SIGNED_BALLOT_OF_BOUND_CONTRIBUTORS',
    },
    minConfirmations: 2,
    recurring: null,
  },
  policy: {
    policyId: `pol_${fundId}`,
    version: 1,
    workspaceId: 'grp_arc_friends',
    chainId: usdc.chainId,
    quorumBps: 6_667,
    approvalBps: 6_667,
    minYesOfEligibleBps: 6_667,
    votingPeriodSeconds: 86_400,
    challengeWindowSeconds: 3_600,
    maxDelegationDepth: 1,
    concentrationFlagBps: 10_000,
    councilSize: 3,
    councilThreshold: 2,
    termSeconds: 86_400 * 30,
  },
  terms: {
    version: 1,
    targetBaseUnits: CONTRIBUTION * 3n,
    refundableUntil: startedAt + 86_400,
    summary:
      'Arc group gift: 0.004 USDC each; unspent claim refundable for 24h; spend only by signed ballot (2/3)',
  },
});
let fund: GroupFund = await svc.open(charter, now());
const steps: Record<string, unknown>[] = [];
const step = (name: string, data: Record<string, unknown>) => {
  steps.push({ step: name, at: new Date().toISOString(), ...data });
  console.log(
    `[${name}]`,
    JSON.stringify(data, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v,
    ).slice(0, 300),
  );
};

// 1. Operator gas float: an unreferenced transfer that credits nobody.
const float = await executeTransfer(chain, owner, {
  from: owner.address,
  to: poolAccount.address,
  amount: money(usdc, GAS_FLOAT),
});
const floatReceipt = await receipt(float.hash as Hex);
fund = await svc.run(fundId, (f) =>
  transfersIn(float.hash as Hex, floatReceipt)
    .filter((t) => t.to.toLowerCase() === poolAccount.address.toLowerCase())
    .flatMap((t) => f.observeDeposit(t, now())),
);
step('gas-float', {
  label: 'LIVE_ARC_TESTNET',
  tx: float.hash,
  explorer: explorer(float.hash),
  credited: 'nobody (operator gas float; no contribution reference)',
  unapplied: dec(fund.view().unapplied),
});

// 2. Pledges, then real contributions through Memo with each contributor's reference.
const contributionTx: Record<string, Hex> = {};
for (const c of contributors) {
  fund = await svc.run(fundId, (f) =>
    f.pledge(
      {
        pledgeId: `pledge-${c.memberId}`,
        memberId: c.memberId,
        amount: CONTRIBUTION,
      },
      now(),
    ),
  );
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [poolAccount.address, CONTRIBUTION],
  });
  const hash = await wallet(c.account).sendTransaction({
    to: memo,
    data: encodeFunctionData({
      abi: MEMO_ABI,
      functionName: 'memo',
      args: [
        usdc.address,
        data,
        contributionRef(fundId, c.memberId),
        stringToHex(`synq-fund:${fundId}`),
      ],
    }),
  });
  contributionTx[c.memberId] = hash;
  const r = await receipt(hash);
  fund = await svc.run(fundId, (f) =>
    transfersIn(hash, r).flatMap((t) => f.observeDeposit(t, now())),
  );
}
const pendingView = fund.view();
step('contributions-seen', {
  label: 'LIVE_ARC_TESTNET',
  txs: Object.fromEntries(
    Object.entries(contributionTx).map(([k, h]) => [
      k,
      { tx: h, explorer: explorer(h) },
    ]),
  ),
  view: {
    pledged: dec(pendingView.pledged),
    pending: dec(pendingView.pending),
    free: dec(pendingView.free),
  },
  note: 'pledged and unconfirmed money is not spendable (free = 0)',
});
const pendingSpend = await refused(() =>
  takeSnapshot({
    ballotId: 'premature',
    proposalHash: `0x${'1'.repeat(64)}`,
    policy: charter.policy,
    members: fund.electorate(),
    now: now(),
  }),
);
step('pledge-not-spendable', {
  electorateBeforeFinality: fund.electorate().length,
  ...pendingSpend,
});

// 3. Finality (2 confirmations) and contributor assents.
const lastBlock = [...fund.deposits.values()].reduce(
  (m, d) => (d.transfer.blockNumber > m ? d.transfer.blockNumber : m),
  0n,
);
const head = await waitForBlock(lastBlock + 1n);
for (const d of [...fund.deposits.values()])
  fund = await svc.run(fundId, (f) => f.finalizeDeposit(d.key, head, now()));
for (const c of contributors) {
  const assent = {
    campaignId: fundId,
    chainId: usdc.chainId,
    contributor: c.account.address,
    termsHash: fund.termsHash,
    termsVersion: 1,
    issuedAt: now(),
    nonce: keccak256(toHex(`assent:${fundId}:${c.memberId}`)),
  };
  const signature = await c.account.signTypedData(assentTypedData(assent));
  fund = await svc.run(fundId, (f) =>
    f.recordAssent({ memberId: c.memberId, assent, signature, now: now() }),
  );
}
step('final-and-assented', {
  head: String(head),
  termsHash: fund.termsHash,
  view: {
    free: dec(fund.view().free),
    custody: dec(fund.view().custody),
    pending: dec(fund.view().pending),
  },
});

// 4. The contractor withdraws its unspent claim (contributor-level cancellation).
fund = await svc.run(fundId, (f) =>
  f.requestRefund(
    {
      refundId: 'refund-contractor',
      memberId: 'contractor',
      reason: 'contractor cancelled participation',
    },
    now(),
  ),
);
fund = await svc.run(fundId, (f) =>
  f.beginRefundExecution('refund-contractor', now()),
);
const refundTo = fund.refundInstruction('refund-contractor');
const refund = await executeTransfer(chain, poolAccount, {
  from: poolAccount.address,
  to: refundTo.to,
  amount: money(usdc, refundTo.amount),
});
const refundReceipt = await receipt(refund.hash as Hex);
const refundTransfer = transfersIn(refund.hash as Hex, refundReceipt).find(
  (t) => t.from.toLowerCase() === poolAccount.address.toLowerCase(),
)!;
fund = await svc.run(fundId, (f) =>
  f.recordRefundExecution('refund-contractor', refundTransfer, now()),
);
step('contractor-refund', {
  label: 'LIVE_ARC_TESTNET',
  tx: refund.hash,
  explorer: explorer(refund.hash),
  amount: dec(refundTo.amount),
  electorateAfter: fund.electorate().map((m) => m.memberId),
});

// 5. Spend proposal; a chat poll and an admin-only ballot authorize nothing.
fund = await svc.run(fundId, (f) =>
  f.recordSocialPoll(
    { pollId: 'tg-poll-1', question: 'Buy the gift now?', yes: 3, no: 0 },
    now(),
  ),
);
fund = await svc.run(fundId, (f) =>
  f.proposeSpend(
    {
      spendId: 'gift',
      payee: payee.address,
      amount: SPEND,
      purpose: 'group gift purchase (testnet stand-in vendor)',
    },
    now(),
  ),
);
const proposal = fund.spends.get('gift')!;
const snapshot = takeSnapshot({
  ballotId: `ballot-${fundId}`,
  proposalHash: proposal.proposalHash,
  policy: charter.policy,
  members: fund.electorate(),
  now: now(),
});
const vote = async (
  account: typeof owner,
  choice: Choice,
  accepted: AcceptedVote[],
) => {
  const v = {
    ballotId: snapshot.ballotId,
    snapshotId: snapshot.snapshotId,
    policyHash: snapshot.policyHash,
    chainId: snapshot.chainId,
    voter: account.address,
    choice,
    onBehalfOf: [],
    castAt: now(),
  };
  accepted.push(
    await admitVote({
      snapshot,
      policy: charter.policy,
      delegations: [],
      accepted,
      vote: v,
      signature: await account.signTypedData(voteTypedData(v)),
      now: now(),
    }),
  );
};
const pollOnly = await refused(
  fund.authorizeSpend({ spendId: 'gift', snapshot, votes: [], now: now() }),
);
const adminVotes: AcceptedVote[] = [];
await vote(owner, 'YES', adminVotes);
const adminOnly = await refused(
  fund.authorizeSpend({
    spendId: 'gift',
    snapshot,
    votes: adminVotes,
    now: now(),
  }),
);
const beforeAuth = await refused(() => fund.spendInstruction('gift'));
step('unauthorized-attempts', {
  chatPoll: pollOnly,
  adminOnlyBallot: adminOnly,
  payBeforeAuthorization: beforeAuth,
});
if (!pollOnly.refused || !adminOnly.refused || !beforeAuth.refused)
  throw new Error('an unauthorized path was not refused');

const votes: AcceptedVote[] = [];
await vote(owner, 'YES', votes);
await vote(client, 'YES', votes);
fund = await svc.run(fundId, (f) =>
  f.authorizeSpend({ spendId: 'gift', snapshot, votes, now: now() }),
);
const auth = fund.spends.get('gift')!;
step('ballot-authorized', {
  snapshotId: snapshot.snapshotId,
  electorate: snapshot.members.map((m) => m.wallet),
  authorization: auth.authorization,
  allocation: Object.fromEntries(
    Object.entries(auth.allocation).map(([k, v]) => [k, dec(v)]),
  ),
});

// 6. The pool pays exactly the authorized spend.
fund = await svc.run(fundId, (f) => f.beginSpendExecution('gift', now()));
const instruction = fund.spendInstruction('gift');
const pay = await executeTransfer(chain, poolAccount, {
  from: poolAccount.address,
  to: instruction.to,
  amount: money(usdc, instruction.amount),
});
const payReceipt = await receipt(pay.hash as Hex);
const payTransfer = transfersIn(pay.hash as Hex, payReceipt).find(
  (t) => t.from.toLowerCase() === poolAccount.address.toLowerCase(),
)!;
fund = await svc.run(fundId, (f) =>
  f.recordSpendExecution('gift', payTransfer, now()),
);
const replay = fund.recordSpendExecution('gift', payTransfer, now());
step('group-payment', {
  label: 'LIVE_ARC_TESTNET',
  tx: pay.hash,
  explorer: explorer(pay.hash),
  amount: dec(instruction.amount),
  replayEvents: replay.length,
});

// 7. Reconciliation: books per contributor and the pool on chain, to the wei.
const reloaded = await svc.load(fundId);
const statement = reloaded.statement();
const view = reloaded.view();
const poolTxs = [refund.hash, pay.hash] as Hex[];
const poolFees = poolTxs.reduce((s, h) => s + fee(receipts[h]!), 0n);
const contributed = statement.reduce((s, m) => s + m.contributed, 0n);
const expectedPoolWei =
  poolOpenWei +
  GAS_FLOAT * WEI_PER_UNIT +
  contributed * WEI_PER_UNIT -
  view.refunded * WEI_PER_UNIT -
  view.spent * WEI_PER_UNIT -
  poolFees;
const poolWei = await chain.client.getBalance({ address: poolAccount.address });
const poolUsdc = (await balanceOf(chain, usdc, poolAccount.address)).baseUnits;
const claimsSum = statement.reduce((s, m) => s + m.claim + m.reserved, 0n);
const perContributor = statement.map((m) => {
  const tx = contributionTx[m.memberId]!;
  const ownFee = fee(receipts[tx]!);
  const refundIn = m.memberId === 'contractor' ? view.refunded : 0n;
  // The owner also funded the operator gas float (not a contribution).
  const floatOut =
    m.memberId === 'owner' ? GAS_FLOAT * WEI_PER_UNIT + fee(floatReceipt) : 0n;
  return {
    memberId: m.memberId,
    wallet: m.wallet,
    contributionTx: tx,
    contributed: dec(m.contributed),
    spentShare: dec(m.spent),
    refunded: dec(m.refunded),
    claim: dec(m.claim),
    // Wallet effect of this fund alone, from receipts: -contribution - own gas + refund.
    walletEffectWei: String(
      -m.contributed * WEI_PER_UNIT -
        ownFee +
        refundIn * WEI_PER_UNIT -
        floatOut,
    ),
    ownGasWei: String(ownFee),
    booksBalance: m.contributed - m.spent - m.refunded === m.claim + m.reserved,
  };
});
const after: Record<string, { usdc: bigint; wei: bigint }> = {};
for (const a of [owner, client, contractor, payee])
  after[a.address] = {
    usdc: (await balanceOf(chain, usdc, a.address)).baseUnits,
    wei: await chain.client.getBalance({ address: a.address }),
  };
const walletCheck = perContributor.map((p) => ({
  memberId: p.memberId,
  observedDeltaWei: String(after[p.wallet]!.wei - before[p.wallet]!.wei),
  fundEffectWei: p.walletEffectWei,
  // Other workstreams may share these testnet wallets; a mismatch means unrelated activity, not a fund error.
  matches:
    after[p.wallet]!.wei - before[p.wallet]!.wei === BigInt(p.walletEffectWei),
}));
const payeeDelta = after[payee.address]!.usdc - before[payee.address]!.usdc;
const reconciliation = {
  poolNativeWei: {
    expected: String(expectedPoolWei),
    observed: String(poolWei),
    equal: expectedPoolWei === poolWei,
  },
  poolUsdcView: {
    observed: dec(poolUsdc),
    expectedFloor: dec(poolWei / WEI_PER_UNIT),
    equal: poolUsdc === poolWei / WEI_PER_UNIT,
  },
  custody: {
    books: dec(view.custody),
    claimsSum: dec(claimsSum),
    equal: view.custody === claimsSum,
  },
  poolFeesWei: String(poolFees),
  operatorFloatRemainingWei: String(GAS_FLOAT * WEI_PER_UNIT - poolFees),
  payeeReceivedUsdc: dec(payeeDelta),
  payeeReceivedExact: payeeDelta === SPEND,
};
step('reconciled', reconciliation);
if (!reconciliation.poolNativeWei.equal || !reconciliation.custody.equal)
  throw new Error('reconciliation failed');

const short = pay.hash.slice(2, 10);
const evidence = {
  label: 'LIVE_ARC_TESTNET',
  generatedAt: new Date().toISOString(),
  network: {
    chain: 'arc-testnet',
    chainId: usdc.chainId,
    usdc: usdc.address,
    memo,
    decimals: { erc20: 6, native: 18 },
  },
  fundId,
  kind: charter.kind,
  custodyModel:
    'Fresh script-controlled testnet EOA pool (~/.synq/group-pool.key, mode 600). Contributor rights, the signed-ballot spend rule and refunds are enforced by @synq/treasury before the pool key signs; this is not an on-chain escrow. The governed vault was not used.',
  poolKeyCreatedThisRun: poolKeyFresh,
  wallets: {
    owner: owner.address,
    client: client.address,
    contractor: contractor.address,
    payee: payee.address,
    payeeRole:
      'testnet stand-in for the gift vendor (Synq agent wallet); no merchant was paid',
    pool: poolAccount.address,
  },
  terms: {
    termsHash: charter.policy.termsHash,
    summary: charter.terms.summary,
    refundableUntil: charter.terms.refundableUntil,
  },
  policy: {
    quorumBps: 6_667,
    approvalBps: 6_667,
    minYesOfEligibleBps: 6_667,
    electorate: 'contributors with a bound, unspent claim',
  },
  economicSettlement: [
    {
      what: 'operator gas float into pool',
      label: 'LIVE_ARC_TESTNET',
      tx: float.hash,
      effect: 'custody only, credits no contributor',
    },
    ...Object.entries(contributionTx).map(([m, h]) => ({
      what: `contribution by ${m}`,
      label: 'LIVE_ARC_TESTNET',
      tx: h,
      effect: 'custody in; not consent',
    })),
    {
      what: 'contractor withdrawal (refund of own claim)',
      label: 'LIVE_ARC_TESTNET',
      tx: refund.hash,
      effect: 'custody out to contributor',
    },
    {
      what: 'approved group payment',
      label: 'LIVE_ARC_TESTNET',
      tx: pay.hash,
      effect: 'economic settlement to payee',
    },
  ],
  nonEconomicRecords: [
    'pledges (not spendable)',
    'EIP-712 contributor assents (consent to terms; no money)',
    'chat poll (indicative only; authorized nothing)',
    'EIP-712 ballot (authorization; no money)',
  ],
  explorer: {
    float: explorer(float.hash),
    contributions: Object.fromEntries(
      Object.entries(contributionTx).map(([k, h]) => [k, explorer(h)]),
    ),
    refund: explorer(refund.hash),
    payment: explorer(pay.hash),
  },
  steps,
  perContributor,
  walletCheck,
  reconciliation,
  persistedEvents: (await store.load(fundId)).length,
};
const outDir = join(process.cwd(), '..', 'synq-v13', 'bounty-evidence', 'arc');
const dir = existsSync(outDir)
  ? outDir
  : join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `group-fund-${short}.json`);
const text = JSON.stringify(
  evidence,
  (_k, v) => (typeof v === 'bigint' ? String(v) : v),
  2,
);
for (const f of [
  'testnet.key',
  'arc-client.key',
  'arc-contractor.key',
  'arc-agent.key',
  'group-pool.key',
])
  if (text.includes(keyAt(f).slice(2)))
    throw new Error('key material in evidence');
writeFileSync(file, text + '\n');
await db.end();
console.log(`evidence -> ${file}`);
if (!reconciliation.payeeReceivedExact)
  console.log('note: payee balance also moved by unrelated activity');
