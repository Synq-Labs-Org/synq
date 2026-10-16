/** Owner-run Arc testnet proof. Identity grants no financial authority. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { TEAM_ROLES, agentRegistration } from '@synq/agent-runtime';
import { token } from '@synq/chain-registry/arc';
import { fromJsonb } from '@synq/domain/pg';
import type { SignedCall } from '@synq/execution-worker/cctp';
import {
  decide,
  intentApprovalTypedData,
  mandateTypedData,
  type AuthorityConfig,
  type ExecutionGrant,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  admitAgentJobGrant,
  agentJobIntentId,
  agentJobValue,
  type AgentJobCall,
} from '@synq/kernel/arc-agent-jobs';
import { connectChain, type TransferSigner } from '@synq/execution-worker/arc';
import {
  AGENT_JOBS_ABI,
  executeAgentJob,
  simulateAgentJob,
  readAgentJob,
  verifyAgentStackContract,
} from '@synq/execution-worker/agent-stack';
import { PostgresEscrowJournal } from '@synq/execution-worker/pg-escrow';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import {
  sendEscrowCall,
  type EscrowStep,
  type EscrowTx,
} from '@synq/execution-worker/escrow';
const chain = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const now = () => Math.floor(Date.now() / 1000);
const bigJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const keyDir = join(process.env.HOME!, '.synq');
const account = (name: string) => {
  const k = readFileSync(join(keyDir, name), 'utf8').trim();
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex);
};
const owner = account('testnet.key'),
  client = account('arc-client.key'),
  provider = account('arc-contractor.key');
const path = join(
  process.cwd(),
  '..',
  'synq-v13',
  'bounty-evidence',
  'arc',
  'agent-stack-proof.json',
);
mkdirSync(join(path, '..'), { recursive: true });
type Proof = {
  label: 'LIVE_ARC_TESTNET';
  startedAt: string;
  expiredAt: number;
  feesWei: string;
  identities: Record<string, { id: string; hash: Hex; manifestHash: string }>;
  txs: EscrowTx[];
  jobId?: string;
  job?: Record<string, unknown>;
  grants: Record<string, { call: AgentJobCall; grant: ExecutionGrant }>;
  before: Record<string, string>;
  checks: Record<string, unknown>;
};
const state: Proof = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : {
      label: 'LIVE_ARC_TESTNET',
      startedAt: new Date().toISOString(),
      expiredAt: now() + 86400,
      feesWei: '0',
      identities: {},
      txs: [],
      grants: {},
      before: {},
      checks: {},
    };
for (const saved of Object.values(state.grants)) {
  const c = saved.call as unknown as Record<string, unknown>;
  for (const k of [
    'jobId',
    'budget',
    'expiredAt',
    'platformFeeBps',
    'evaluatorFeeBps',
  ])
    c[k] = BigInt(String(c[k]));
}
const save = () => {
  writeFileSync(path + '.tmp', bigJson(state));
  renameSync(path + '.tmp', path);
};
const HMAC = join(keyDir, 'arc-agent-stack-grant.key');
if (!existsSync(HMAC))
  writeFileSync(HMAC, randomBytes(32).toString('hex'), {
    mode: 0o600,
    flag: 'wx',
  });
if ((statSync(HMAC).mode & 0o077) !== 0)
  throw new Error('grant key permissions must be 600');
const cfg: AuthorityConfig = {
  grantKey: Buffer.from(readFileSync(HMAC, 'utf8').trim(), 'hex'),
  operator: 'arc-agent-stack-proof',
  grantTtlSeconds: 900,
  riskRequiredAbove: 1000000n,
};
if (cfg.grantKey.length !== 32)
  throw new Error('invalid grant authentication key');
const CAP = 50_000n * 10n ** 12n,
  JOB_AMOUNT = 1000n;
let principalSpent =
  state.checks.funded === true ? JOB_AMOUNT * 10n ** 12n : 0n;
const pendingGas = new Map<Hex, bigint>();
const bounded = (a: typeof owner): TransferSigner => ({
  address: a.address,
  async signTransaction(tx) {
    if (tx.chainId !== chain.profile.chainId || (tx.value ?? 0n) !== 0n)
      throw new Error('AGENT_STACK_TRANSACTION_DOMAIN');
    const maxGas = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n);
    if (
      !maxGas ||
      BigInt(state.feesWei) +
        principalSpent +
        [...pendingGas.values()].reduce((n, v) => n + v, 0n) +
        maxGas +
        JOB_AMOUNT * 10n ** 12n >
        CAP
    )
      throw new Error('AGENT_STACK_TOTAL_SPEND_CAP');
    const raw = await a.signTransaction(tx);
    pendingGas.set(keccak256(raw), maxGas);
    return raw;
  },
});
const signers = {
  owner: bounded(owner),
  client: bounded(client),
  provider: bounded(provider),
};
const admin = new pg.Client({
  connectionString: 'postgresql://postgres@127.0.0.1:55433/postgres',
});
await admin.connect();
if (
  !(
    await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='synq_m2_agent_stack'",
    )
  ).rows.length
)
  await admin.query('CREATE DATABASE synq_m2_agent_stack');
await admin.end();
const pool = new pg.Pool({
  connectionString: 'postgresql://postgres@127.0.0.1:55433/synq_m2_agent_stack',
  max: 3,
});
await migrateExecution(pool);
const journal = new PostgresEscrowJournal(pool);
const add = (tx: EscrowTx) => {
  pendingGas.delete(tx.hash);
  if (!state.txs.some((x) => x.hash === tx.hash)) {
    state.txs.push(tx);
    state.feesWei = (BigInt(state.feesWei) + tx.feeWei).toString();
  }
  save();
};
async function send(
  signer: TransferSigner,
  kind: 'ERC8004_IDENTITY_REGISTRY' | 'ERC8183_AGENTIC_COMMERCE',
  step: EscrowStep,
  data: Hex,
) {
  const target = await verifyAgentStackContract(chain, kind);
  const result = await sendEscrowCall(
    chain,
    signer,
    step,
    target.address,
    data,
    { journal, grantId: null, step },
  );
  add(result.tx);
  return result;
}
const identityAbi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
  'function tokenURI(uint256 id) view returns (string)',
  'event Registered(uint256 indexed agentId,string agentURI,address indexed owner)',
]);
async function grant(c: AgentJobCall): Promise<ExecutionGrant> {
  const old = state.grants[c.op];
  if (old) {
    if (agentJobIntentId(old.call) !== agentJobIntentId(c))
      throw new Error('saved job plan differs; manual review');
    return old.grant;
  }
  const v = agentJobValue(c),
    at = now();
  const mandate: PaymentMandate = {
    mandateId: `erc8183:${c.jobId}:${c.op}`,
    version: 1,
    workspaceId: 'synq-demo',
    owner: client.address,
    chainId: 5042002,
    token: usdc.address,
    payer: v.payer,
    recipients: [v.recipient],
    purposes: ['GROUP_EXPENSE'],
    perActionCap: JOB_AMOUNT,
    periodBudget: JOB_AMOUNT,
    periodSeconds: 86400,
    validFrom: at - 30,
    validUntil: at + 3600,
  };
  const intent: PaymentIntent = {
    ...v,
    intentId: agentJobIntentId(c),
    mandateId: mandate.mandateId,
    mandateVersion: 1,
    purpose: 'GROUP_EXPENSE',
    obligationRef: `erc8183:${c.jobId}:${c.op}`,
    evidenceHash: c.descriptionHash,
    proposedBy: 'owner-run-testnet-proof',
  };
  const simulation = await simulateAgentJob(chain, c);
  state.checks[`${c.op}_simulation`] = simulation;
  const args = {
    config: cfg,
    mandate,
    mandateSignature: await client.signTypedData(mandateTypedData(mandate)),
    state: { revoked: false, spends: [] },
    intent,
    risk: { available: false, flags: [] },
    simulationOk: simulation.ok,
    now: at,
    requireOwnerApproval: true,
  };
  const challenge = await decide(args);
  if (challenge.outcome !== 'REQUIRE_OWNER_APPROVAL')
    throw new Error('owner challenge missing');
  const approval = {
    ...challenge.approval,
    signature: await client.signTypedData(
      intentApprovalTypedData(intent, challenge.approval),
    ),
  };
  const result = await decide({ ...args, ownerApproval: approval });
  if (result.outcome !== 'ALLOW') throw new Error('Kernel refused job');
  state.grants[c.op] = { call: c, grant: result.grant };
  state.checks[`${c.op}_approval`] = {
    mandate,
    mandateSignature: args.mandateSignature,
    intent,
    ownerApproval: approval,
  };
  save();
  return result.grant;
}
async function jobCall(
  op: 'FUND' | 'COMPLETE',
  reason: Hex,
): Promise<AgentJobCall> {
  const target = await verifyAgentStackContract(
      chain,
      'ERC8183_AGENTIC_COMMERCE',
    ),
    job = await readAgentJob(chain, BigInt(state.jobId!));
  const [platformFeeBps, evaluatorFeeBps, platformTreasury] = await Promise.all(
    [
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'platformFeeBP',
      }),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'evaluatorFeeBP',
      }),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'platformTreasury',
      }),
    ],
  );
  return {
    op,
    chainId: 5042002,
    contract: target.address,
    token: usdc.address,
    sender: op === 'FUND' ? client.address : owner.address,
    jobId: job.id,
    client: job.client,
    provider: job.provider,
    evaluator: job.evaluator,
    budget: job.budget,
    expiredAt: job.expiredAt,
    descriptionHash: keccak256(toHex(job.description)),
    hook: job.hook,
    reason,
    platformFeeBps,
    evaluatorFeeBps,
    platformTreasury,
  };
}
async function main() {
  // Account every recorded call after a crash, including an approval whose
  // funding receipt was not yet recorded in the proof file. Unknown stays held.
  const recorded = await pool.query(
    'SELECT data FROM synq_escrow_signed_calls',
  );
  for (const row of recorded.rows) {
    const signed = fromJsonb<SignedCall>(row.data);
    if (!state.before[signed.from])
      throw new Error('proof baseline missing; manual reconciliation required');
    const receipt = await chain.client
      .getTransactionReceipt({ hash: signed.hash })
      .catch(() => null);
    if (!receipt)
      throw new Error(
        'recorded call outcome unknown; reconcile before continuing',
      );
    add({
      label: 'recovered recorded call',
      hash: signed.hash,
      from: signed.from,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      explorer: `${chain.profile.explorer}/tx/${signed.hash}`,
    });
  }

  const target = await verifyAgentStackContract(
    chain,
    'ERC8183_AGENTIC_COMMERCE',
  );
  const identity = await verifyAgentStackContract(
    chain,
    'ERC8004_IDENTITY_REGISTRY',
  );
  if (state.jobId) {
    const previous = await readAgentJob(chain, BigInt(state.jobId));
    if ([1, 2, 3].includes(previous.status)) {
      principalSpent = JOB_AMOUNT * 10n ** 12n;
      state.checks.funded = true;
    }
  }

  if (
    !(await chain.client.readContract({
      address: target.address,
      abi: AGENT_JOBS_ABI,
      functionName: 'whitelistedHooks',
      args: [zeroAddress],
    }))
  )
    throw new Error('no-hook job unavailable');
  for (const a of [owner, client, provider]) {
    const balance = await chain.client.getBalance({ address: a.address });
    if (balance < 50_000n * 10n ** 12n)
      throw new Error('test role wallet needs gas; no top-up attempted');
    state.before[a.address] ??= balance.toString();
  }
  save();
  async function ensureIdentities(existingOnly: boolean) {
    for (const role of TEAM_ROLES.filter((r) => r !== 'SUPERVISOR')) {
      const r = agentRegistration(role);
      if (existingOnly && !state.identities[role]) continue;
      const plannedUri = r.compactUri;
      if (!state.identities[role]) {
        let result;
        try {
          result = await send(
            signers.owner,
            'ERC8004_IDENTITY_REGISTRY',
            'IDENTITY_REGISTER',
            encodeFunctionData({
              abi: identityAbi,
              functionName: 'register',
              args: [plannedUri],
            }),
          );
        } catch (e) {
          if ((e as Error).message !== 'AGENT_STACK_TOTAL_SPEND_CAP') throw e;
          state.checks.registrationPending = TEAM_ROLES.filter(
            (r) => r !== 'SUPERVISOR' && !state.identities[r],
          );
          state.checks.registrationBudgetStatus = 'BLOCKED_TESTNET_GAS_BUDGET';
          save();
          break;
        }
        const logs = parseEventLogs({
          abi: identityAbi,
          eventName: 'Registered',
          logs: result.receipt.logs,
        }).filter((l) => isAddressEqual(l.address, identity.address));
        if (
          logs.length !== 1 ||
          logs[0]!.args.agentURI !== plannedUri ||
          !isAddressEqual(logs[0]!.args.owner, owner.address)
        )
          throw new Error('registration event mismatch');
        state.identities[role] = {
          id: logs[0]!.args.agentId.toString(),
          hash: result.tx.hash,
          manifestHash: r.manifestHash,
        };
        save();
      }
      const id = BigInt(state.identities[role]!.id);
      const [who, uri] = await Promise.all([
        chain.client.readContract({
          address: identity.address,
          abi: identityAbi,
          functionName: 'ownerOf',
          args: [id],
        }),
        chain.client.readContract({
          address: identity.address,
          abi: identityAbi,
          functionName: 'tokenURI',
          args: [id],
        }),
      ]);
      if (
        !isAddressEqual(who, owner.address) ||
        (uri !== r.uri && uri !== r.compactUri)
      )
        throw new Error('identity ownership/card commitment mismatch');
      console.log(`Registered ${role} id=${id}; authority=NONE`);
    }
  }
  await ensureIdentities(true);
  const artifact =
    (state.checks.artifact as { artifact?: unknown } | undefined)?.artifact ??
    JSON.parse(
      bigJson({
        label: 'DEVELOPER_TESTNET_ACTORS',
        identities: state.identities,
        description:
          'Canonical specialist capability commitments re-read from Arc, with no signing authority',
      }),
    );
  const deliverable = keccak256(toHex(bigJson(artifact)));
  state.checks.artifact = { artifact, deliverable };
  save();
  if (!state.jobId) {
    const result = await send(
      signers.client,
      'ERC8183_AGENTIC_COMMERCE',
      'JOB_CREATE',
      encodeFunctionData({
        abi: AGENT_JOBS_ABI,
        functionName: 'createJob',
        args: [
          provider.address,
          owner.address,
          BigInt(state.expiredAt),
          `Synq capability audit ${deliverable}`,
          zeroAddress,
        ],
      }),
    );
    const created = parseEventLogs({
      abi: AGENT_JOBS_ABI,
      eventName: 'JobCreated',
      logs: result.receipt.logs,
    }).filter((l) => isAddressEqual(l.address, target.address));
    if (created.length !== 1) throw new Error('job creation event missing');
    state.jobId = created[0]!.args.jobId.toString();
    save();
  }
  const id = BigInt(state.jobId);
  let current = await readAgentJob(chain, id);
  if (current.status === 0 && current.budget !== JOB_AMOUNT)
    await send(
      // The verified deployed EIP-8183 reference implementation lets the
      // provider propose a job budget; funding remains client-authorized.
      signers.provider,
      'ERC8183_AGENTIC_COMMERCE',
      'JOB_BUDGET',
      encodeFunctionData({
        abi: AGENT_JOBS_ABI,
        functionName: 'setBudget',
        args: [id, JOB_AMOUNT, '0x'],
      }),
    );
  current = await readAgentJob(chain, id);
  if (current.status === 0) {
    const c = await jobCall('FUND', `0x${'00'.repeat(32)}`),
      g = await grant(c);
    const result = await executeAgentJob({
      chain,
      signer: signers.client,
      call: c,
      grant: g,
      grantKey: cfg.grantKey,
      now: now(),
      mandateRevoked: false,
      fence: {
        consume: async () => false,
        consumeGrant: (grant, at) => journal.admit(grant, at),
      },
      journal,
    });
    add(result.tx);
    const approve = await journal.signed(`${g.grantId}:JOB_APPROVE`);
    if (approve) {
      const r = await chain.client.getTransactionReceipt({
        hash: approve.hash,
      });
      add({
        label: 'job allowance',
        hash: approve.hash,
        from: client.address,
        blockNumber: r.blockNumber,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        feeWei: r.gasUsed * r.effectiveGasPrice,
        explorer: `${chain.profile.explorer}/tx/${approve.hash}`,
      });
    }
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: result.receipt.logs,
    }).filter((l) => isAddressEqual(l.address, usdc.address));
    if (
      transfers.length !== 1 ||
      !isAddressEqual(transfers[0]!.args.from, client.address) ||
      !isAddressEqual(transfers[0]!.args.to, target.address) ||
      transfers[0]!.args.value !== JOB_AMOUNT
    )
      throw new Error('funding transfer differs');
    state.checks.funded = true;
    principalSpent = JOB_AMOUNT * 10n ** 12n;
    save();
  }
  current = await readAgentJob(chain, id);
  if (current.status === 1)
    await send(
      signers.provider,
      'ERC8183_AGENTIC_COMMERCE',
      'JOB_SUBMIT',
      encodeFunctionData({
        abi: AGENT_JOBS_ABI,
        functionName: 'submit',
        args: [id, deliverable, '0x'],
      }),
    );
  current = await readAgentJob(chain, id);
  if (current.status === 2) {
    const c = await jobCall('COMPLETE', deliverable),
      g = await grant(c);
    let negative = false;
    try {
      await chain.client.call({
        account: provider.address,
        to: target.address,
        data: encodeFunctionData({
          abi: AGENT_JOBS_ABI,
          functionName: 'complete',
          args: [id, deliverable, '0x'],
        }),
      });
    } catch {
      negative = true;
    }
    if (!negative)
      throw new Error('wrong evaluator call unexpectedly accepted');
    let local = false;
    try {
      await admitAgentJobGrant({
        call: { ...c, sender: provider.address },
        grant: g,
        grantKey: cfg.grantKey,
        now: now(),
        mandateRevoked: false,
        fence: {
          consume: async () => {
            throw new Error('negative probe consumed nonce');
          },
        },
      });
    } catch (e) {
      local = (e as { code?: string }).code === 'GRANT_MISMATCH';
    }
    if (!local) throw new Error('wrong evaluator local guard failed');
    state.checks.wrongEvaluator = {
      kernel: 'GRANT_MISMATCH',
      ethCall: 'REVERTED',
      broadcast: false,
    };
    save();
    const result = await executeAgentJob({
      chain,
      signer: signers.owner,
      call: c,
      grant: g,
      grantKey: cfg.grantKey,
      now: now(),
      mandateRevoked: false,
      fence: {
        consume: async () => false,
        consumeGrant: (grant, at) => journal.admit(grant, at),
      },
      journal,
    });
    add(result.tx);
    const logs = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: result.receipt.logs,
    }).filter(
      (l) =>
        isAddressEqual(l.address, usdc.address) &&
        isAddressEqual(l.args.from, target.address),
    );
    const total = logs.reduce((n, l) => n + l.args.value, 0n);
    const net =
      JOB_AMOUNT -
      (JOB_AMOUNT * c.platformFeeBps) / 10000n -
      (JOB_AMOUNT * c.evaluatorFeeBps) / 10000n;
    const providerPaid = logs
      .filter((l) => isAddressEqual(l.args.to, provider.address))
      .reduce((n, l) => n + l.args.value, 0n);
    if (
      total !== JOB_AMOUNT ||
      providerPaid !== net ||
      logs.some(
        (l) =>
          ![provider.address, owner.address, c.platformTreasury].some((a) =>
            isAddressEqual(a, l.args.to),
          ),
      )
    )
      throw new Error('job payout reconciliation failed');
    state.checks.payout = {
      gross: JOB_AMOUNT,
      providerNet: net,
      fees: JOB_AMOUNT - net,
      registryTokenTransfers: logs.map((l) => ({
        to: l.args.to,
        amount: l.args.value,
      })),
      transaction: result.tx.hash,
    };
    save();
  }
  current = await readAgentJob(chain, id);
  if (current.status !== 3) throw new Error('job not completed');
  state.job = JSON.parse(bigJson(current));
  await ensureIdentities(false);
  const checks = [];
  for (const a of [owner, client, provider]) {
    const fees = state.txs
      .filter((t) => isAddressEqual(t.from, a.address))
      .reduce((n, t) => n + BigInt(t.feeWei), 0n);
    const payout = state.checks.payout as {
      registryTokenTransfers: { to: Address; amount: string }[];
    };
    const incoming =
      payout.registryTokenTransfers
        .filter((t) => isAddressEqual(t.to, a.address))
        .reduce((n, t) => n + BigInt(t.amount), 0n) *
      10n ** 12n;
    const outgoing = isAddressEqual(a.address, client.address)
      ? JOB_AMOUNT * 10n ** 12n
      : 0n;
    const expected =
      BigInt(state.before[a.address]!) + incoming - outgoing - fees;
    const actual = await chain.client.getBalance({ address: a.address });
    checks.push({
      wallet: a.address,
      expected,
      actual,
      difference: actual - expected,
    });
    if (actual !== expected)
      throw new Error('role wallet reconciliation mismatch');
  }
  state.checks.books = checks;
  state.checks.totalSpendWei = BigInt(state.feesWei) + principalSpent;
  if (BigInt(state.feesWei) + principalSpent > CAP)
    throw new Error('total cap exceeded');
  state.checks.result =
    Object.keys(state.identities).length === 9
      ? 'IDENTITIES_REGISTERED_JOB_COMPLETED'
      : 'IDENTITY_SUBSET_REGISTERED_JOB_COMPLETED';
  save();
  console.log(
    `Completed job ${id}; ${Object.keys(state.identities).length} identities; total spend wei=${state.checks.totalSpendWei}`,
  );
}
try {
  await main();
} finally {
  await pool.end();
}
