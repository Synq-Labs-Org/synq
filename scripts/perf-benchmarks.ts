/**
 * Local latency benchmarks for the critical in-process paths.
 *
 *   node --import tsx scripts/perf-benchmarks.ts [--iterations 200] [--warmup 20] [--out file.json]
 *
 * Every case runs `warmup` untimed iterations, then `iterations` timed ones,
 * and reports p50/p95/p99/min/max/mean in milliseconds (nearest-rank
 * percentiles over the timed samples only). Nothing here touches a network:
 * chains, models and providers are LOCAL_FIXTURE. The agent-team case uses a
 * deterministic scripted reasoner (label: DETERMINISTIC_MODEL_FIXTURE), so it
 * measures orchestration, guards and the Kernel path, not model latency.
 *
 * Postgres (outbox record + grant claim) uses SYNQ_PERF_DATABASE_URL, default
 * postgresql://postgres@127.0.0.1:55433/synq_m2_secperf; the case is reported
 * as SKIPPED with the error when no database is reachable.
 */
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import {
  decide,
  mandateTypedData,
  type AuthorityConfig,
  type ExecutionGrant,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  computeWaterfall,
  policyHash as allocationPolicyHash,
} from '@synq/allocations';
import {
  takeSnapshot,
  tally,
  voteTypedData,
  type AcceptedVote,
  type BallotVote,
  type Choice,
  type EligibleMember,
  type GovernancePolicy,
} from '@synq/governance';
import { askTeam } from '@synq/agent-runtime';
import type { OutboxRecord } from '@synq/execution-worker/arc-outbox';
import { PostgresOutboxStore } from '@synq/execution-worker/pg-outbox';
import {
  bills1500,
  devInvoice,
  policy1500,
  position,
  receipt1500,
  receivables1500,
  usd,
  vendors,
  T0 as ALLOC_T0,
} from '../tests/allocations/harness.js';
import {
  acceptSig,
  client as dealClient,
  drafted,
  kernel as dealKernel,
  mandate as dealMandate,
  room,
  ESCROW,
} from '../tests/dealroom/harness.js';
import { ScriptedReasoner, teamDesk } from '../tests/agent-team/harness.js';
import { durablePool } from '../tests/durable/pg.js';

type Stats = {
  name: string;
  label: string;
  iterations: number;
  warmup: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  note?: string;
};
type Skipped = { name: string; label: string; skipped: string };

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const ITER = Number(arg('iterations', '200'));
const WARM = Number(arg('warmup', '20'));
const OUT = arg('out', '');
if (!Number.isInteger(ITER) || ITER < 200)
  throw new Error('at least 200 timed iterations are required');

const rank = (sorted: number[], p: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Runs `prepare` (untimed) then `op` (timed) per iteration. */
async function bench<P>(
  name: string,
  label: string,
  prepare: (i: number) => Promise<P> | P,
  op: (p: P, i: number) => Promise<unknown> | unknown,
  opts: { iterations?: number; warmup?: number; note?: string } = {},
): Promise<Stats> {
  const iterations = opts.iterations ?? ITER;
  const warmup = opts.warmup ?? WARM;
  const samples: number[] = [];
  for (let i = 0; i < warmup + iterations; i++) {
    const p = await prepare(i);
    const t = performance.now();
    await op(p, i);
    const dt = performance.now() - t;
    if (i >= warmup) samples.push(dt);
  }
  const s = [...samples].sort((a, b) => a - b);
  const stats: Stats = {
    name,
    label,
    iterations,
    warmup,
    p50: round(rank(s, 50)),
    p95: round(rank(s, 95)),
    p99: round(rank(s, 99)),
    min: round(s[0]!),
    max: round(s[s.length - 1]!),
    mean: round(s.reduce((a, x) => a + x, 0) / s.length),
    ...(opts.note ? { note: opts.note } : {}),
  };
  console.error(
    `${name.padEnd(46)} p50 ${stats.p50.toFixed(3)}  p95 ${stats.p95.toFixed(3)}  p99 ${stats.p99.toFixed(3)} ms (n=${iterations})`,
  );
  return stats;
}

// ---- Kernel decide + grant issue -------------------------------------------
async function kernelCase() {
  const USDC = token('arc-testnet', 'USDC');
  const owner = privateKeyToAccount(keccak256(toHex('perf:kernel-owner')));
  const payer = `0x${'a1'.repeat(20)}` as Address;
  const sarah = `0x${'5a'.repeat(20)}` as Address;
  const NOW = 1_790_000_000;
  const config: AuthorityConfig = {
    grantKey: new Uint8Array(32).fill(7),
    operator: 'perf-executor',
    grantTtlSeconds: 120,
    riskRequiredAbove: 50_000_000n,
  };
  const mandate: PaymentMandate = {
    mandateId: 'mnd_perf',
    version: 1,
    workspaceId: 'wsp_perf',
    owner: owner.address,
    chainId: USDC.chainId,
    token: USDC.address,
    payer,
    recipients: [sarah],
    purposes: ['CONTRACTOR_PAYOUT'],
    perActionCap: 100_000_000n,
    periodBudget: 10n ** 15n,
    periodSeconds: 30 * 86_400,
    validFrom: NOW - 60,
    validUntil: NOW + 30 * 86_400,
  };
  const mandateSignature = await owner.signTypedData(mandateTypedData(mandate));
  const intent = (i: number): PaymentIntent => ({
    intentId: `int_perf_${i}`,
    mandateId: mandate.mandateId,
    mandateVersion: 1,
    chainId: USDC.chainId,
    token: USDC.address,
    payer,
    recipient: sarah,
    amount: 1_000_000n,
    purpose: 'CONTRACTOR_PAYOUT',
    obligationRef: `obl_perf_${i}`,
    evidenceHash: `0x${'e1'.repeat(32)}`,
    proposedBy: 'agent:payments',
  });
  return bench(
    'kernel.decide (mandate verify + grant issue)',
    'LOCAL_FIXTURE',
    (i) => intent(i),
    async (it) => {
      const d = await decide({
        config,
        mandate,
        mandateSignature,
        state: { revoked: false, spends: [] },
        intent: it,
        risk: { flags: [], available: true },
        simulationOk: true,
        now: NOW,
      });
      if (d.outcome !== 'ALLOW') throw new Error('kernel did not allow');
    },
  );
}

// ---- Revenue waterfall plan ---------------------------------------------------
function waterfallCase() {
  const policy = policy1500();
  const input = {
    policy,
    policyHash: allocationPolicyHash(policy),
    receipt: receipt1500(),
    position: position(usd('1500')),
    asOf: ALLOC_T0,
    vendors: vendors(),
    payables: [devInvoice(usd('300'), 5)],
    payableHistory: [devInvoice(usd('300'), 5)],
    obligations: [],
    bills: bills1500(),
    receivables: receivables1500(),
  };
  return bench(
    'allocations.computeWaterfall ($1,500 plan)',
    'LOCAL_FIXTURE',
    () => input,
    (x) => {
      const plan = computeWaterfall(x);
      if (!plan.legs.length) throw new Error('empty plan');
    },
  );
}

// ---- Deal Room: both signatures -> funding authorization (no broadcast) ------
async function dealRoomCase() {
  const m = await dealMandate({
    owner: dealClient,
    id: 'mnd_perf_deal',
    payer: dealClient.address,
    recipients: [ESCROW],
    purposes: ['ESCROW_FUNDING'],
    cap: 10n ** 12n,
    budget: 10n ** 15n,
  });
  return bench(
    'dealroom sign(client)+sign(freelancer)+authorizeFunding',
    'LOCAL_FIXTURE',
    async () => {
      // Untimed: draft the deal from consented chat and produce both EIP-712
      // signatures client-side; the timed part is what the server does.
      const r = room();
      const d = await drafted(r);
      const v = d.view.current;
      return {
        r,
        dealId: d.view.deal.dealId,
        sigC: await acceptSig(r.service, v, 'CLIENT'),
        sigF: await acceptSig(r.service, v, 'FREELANCER'),
      };
    },
    async (p) => {
      await p.r.service.sign({
        dealId: p.dealId,
        version: 1,
        role: 'CLIENT',
        signature: p.sigC,
      });
      await p.r.service.sign({
        dealId: p.dealId,
        version: 1,
        role: 'FREELANCER',
        signature: p.sigF,
      });
      const auth = await p.r.service.authorizeFunding(p.dealId, dealKernel(m));
      if (auth.decision.outcome !== 'ALLOW')
        throw new Error('funding not authorized');
    },
  );
}

// ---- Agent team askTeam with a deterministic model fixture ------------------
async function agentTeamCase() {
  const QUESTION =
    '@Synq, ask your CFO and Risk Agent whether we should pay this contractor';
  return bench(
    'agent-team askTeam (CFO+Risk question)',
    'DETERMINISTIC_MODEL_FIXTURE',
    async () =>
      teamDesk(undefined, {
        reasoner: new ScriptedReasoner({
          'team:supervisor:request': {
            text: JSON.stringify({
              kind: 'TEAM_QUESTION',
              counterparty: null,
              amount: null,
              recipientAddress: null,
              personas: ['CFO', 'RISK'],
            }),
          },
        }),
      }),
    async (desk) => {
      const r = await askTeam(QUESTION, desk);
      if (r.metrics.signing.modelSignatures !== 0)
        throw new Error('model signed');
      // The fixture must really be consulted, or this measures rules only.
      if (r.metrics.modelCalls !== 1 || r.request.classifiedBy === 'RULES')
        throw new Error(
          `scripted model not used (${r.metrics.modelCalls}, ${r.request.classifiedBy})`,
        );
    },
    {
      note: 'scripted reasoner returns a fixed structured reading; measures orchestration, guards, citations and the Kernel port, not model latency',
    },
  );
}

// ---- Governance tally ----------------------------------------------------------
const GOV_POLICY: GovernancePolicy = {
  policyId: 'pol_perf',
  version: 1,
  workspaceId: 'wsp_perf',
  chainId: token('arc-testnet', 'USDC').chainId,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 3600,
  challengeWindowSeconds: 3600,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 3,
  councilThreshold: 2,
  termSeconds: 86_400,
  termsHash: keccak256(toHex('perf terms')),
};

async function tallyCase(size: number, signedVoters: number) {
  const NOW = 1_800_000_000;
  // Signed voters are real secp256k1 wallets; the rest are eligible members
  // who stay silent. Signing happens once, before timing.
  const accounts = Array.from({ length: signedVoters }, (_, n) =>
    privateKeyToAccount(keccak256(toHex(`perf:voter:${n}`))),
  );
  const filler = (n: number) =>
    `0x${(n + 1).toString(16).padStart(40, '0')}` as Address;
  const members: EligibleMember[] = Array.from({ length: size }, (_, n) => ({
    memberId: `m_${n}`,
    wallet: n < signedVoters ? accounts[n]!.address : filler(n),
    channelIds: [],
    weight: 1n,
  }));
  const snapshot = takeSnapshot({
    ballotId: `bal_perf_${size}`,
    proposalHash: keccak256(toHex(`perf ${size}`)),
    policy: GOV_POLICY,
    members,
    now: NOW,
  });
  const choices: Choice[] = ['YES', 'NO', 'ABSTAIN'];
  const votes: AcceptedVote[] = [];
  for (const [n, a] of accounts.entries()) {
    const v: BallotVote = {
      ballotId: snapshot.ballotId,
      snapshotId: snapshot.snapshotId,
      policyHash: snapshot.policyHash,
      chainId: snapshot.chainId,
      voter: a.address,
      choice: choices[n % 3]!,
      onBehalfOf: Object.freeze([]) as readonly Address[],
      castAt: snapshot.opensAt + 1,
    };
    votes.push(
      Object.freeze({
        ...v,
        signature: await a.signTypedData(voteTypedData(v)),
      }),
    );
  }
  const run = () =>
    tally({
      snapshot,
      policy: GOV_POLICY,
      votes,
      delegations: [],
      at: snapshot.closesAt,
    });
  // The first tally recovers every signature (cold); later tallies reuse the
  // verified-vote cache for the same frozen vote objects (warm).
  const t0 = performance.now();
  const first = await run();
  const cold = round(performance.now() - t0);
  if (
    first.eligible.count !== size ||
    first.participated.count !== signedVoters
  )
    throw new Error('tally miscounted');
  const stats = await bench(
    `governance.tally ${size.toLocaleString('en-US')} eligible`,
    'LOCAL_FIXTURE',
    () => null,
    async () => {
      const r = await run();
      if (r.eligible.count !== size) throw new Error('miscount');
    },
    {
      note: `${signedVoters} signed votes (YES/NO/ABSTAIN round-robin), rest silent; warm = signatures already verified once; cold first tally ${cold} ms`,
    },
  );
  return { ...stats, coldFirstTallyMs: cold, signedVoters };
}

// ---- Postgres outbox: signed record + grant consumption in one transaction --
async function outboxCase(): Promise<Stats | Skipped> {
  const url =
    process.env.SYNQ_PERF_DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:55433/synq_m2_secperf';
  let pool: Awaited<ReturnType<typeof durablePool>>;
  try {
    pool = await durablePool(url, 4);
  } catch (e) {
    return {
      name: 'pg outbox createConsumingGrant',
      label: 'LOCAL_POSTGRES',
      skipped: (e as Error).message,
    };
  }
  try {
    const store = new PostgresOutboxStore(pool);
    await store.migrate();
    const USDC = token('arc-testnet', 'USDC');
    const run = `${Date.now().toString(36)}`;
    const from = privateKeyToAccount(generatePrivateKey()).address;
    const record = (i: number): { r: OutboxRecord; g: ExecutionGrant } => {
      const raw = keccak256(toHex(`perf-raw:${run}:${i}`)) as Hex;
      const r: OutboxRecord = {
        key: `perf:${run}:${i}`,
        state: 'SIGNED',
        prepared: {
          chain: 'arc-testnet',
          chainId: USDC.chainId,
          from,
          to: `0x${'5a'.repeat(20)}`,
          amount: moneyFromDecimal(USDC, '0.01'),
          token: USDC.address,
          data: '0x',
          gas: 60_000n,
          maxFeePerGas: 20_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          nonce: i,
          maxGasCostWei: 60_000n * 20_000_000_000n,
          codeHash: `0x${'00'.repeat(32)}`,
        },
        raw,
        hash: keccak256(raw),
        evidence: null,
        note: 'perf benchmark row',
        updatedAt: 1_800_000_000,
      };
      const g = {
        grantId: `grt_perf_${run}_${i}`,
        nonce: keccak256(toHex(`perf-nonce:${run}:${i}`)),
        intentId: `int_perf_${i}`,
        mandateId: 'mnd_perf',
        actionHash: keccak256(toHex(`perf-action:${i}`)),
        chainId: USDC.chainId,
      } as unknown as ExecutionGrant;
      return { r, g };
    };
    return await bench(
      'pg outbox createConsumingGrant (record+claim)',
      'LOCAL_POSTGRES',
      (i) => record(i),
      async ({ r, g }) => {
        const out = await store.createConsumingGrant(r, g, 1_800_000_000);
        if (out !== 'CREATED') throw new Error(out);
      },
      {
        note: 'one transaction: advisory lock, key check, grant row insert, signed-record insert; PG14 on localhost',
      },
    );
  } finally {
    await pool.end();
  }
}

async function main() {
  const machine = {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    platform: `${platform()} ${release()} ${arch()}`,
    node: process.version,
  };
  console.error(`machine: ${JSON.stringify(machine)}`);
  const results: (Stats | Skipped)[] = [];
  results.push(await kernelCase());
  results.push(await waterfallCase());
  results.push(await dealRoomCase());
  results.push(await agentTeamCase());
  results.push(await tallyCase(1_000, 600));
  results.push(await tallyCase(10_000, 6_000));
  results.push(await tallyCase(100_000, 60_000));
  results.push(await outboxCase());
  const report = {
    generatedAt: new Date().toISOString(),
    machine,
    iterations: ITER,
    warmup: WARM,
    percentile: 'nearest-rank over timed samples, milliseconds',
    results,
  };
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
