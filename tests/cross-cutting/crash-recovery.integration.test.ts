import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { keccak256, toHex, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contract } from '@synq/chain-registry/arc';
import {
  decide,
  intentApprovalTypedData,
  mandateTypedData,
  type NonceFence,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  admitAgentJobGrant,
  agentJobIntentId,
  agentJobValue,
  type AgentJobCall,
} from '@synq/kernel/arc-agent-jobs';
import { connectChain } from '@synq/execution-worker/arc';
import type { EscrowBroadcast } from '@synq/execution-worker/escrow';
import { PostgresEscrowJournal } from '@synq/execution-worker/pg-escrow';
import {
  PostgresGrantFence,
  PostgresOutboxStore,
} from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { vaultPayOnce } from '@synq/execution-worker/vault-outbox';
import { PostgresFundStore, migrateTreasury } from '@synq/treasury';
import {
  DEV,
  USDC,
  countingSigner as vaultSigner,
  fakeVaultChain,
  usd,
} from '../allocations/harness.js';
import { durablePool, runId } from '../durable/pg.js';
import { groupFundRefundCrash, signedStepsCrash } from './crash-scenarios.js';
import { testDatabaseUrl } from '../durable/pg.js';

/**
 * P23-02 Postgres twins of crash-recovery.test.ts: the durable stores a real
 * executor uses (outbox, escrow journal + admissions, fund event log).
 * The database is recreated per run, because fixture signers (the vault
 * operator) restart at the same fake-chain nonce and the outbox is unique on
 * sender+nonce. Locally:
 *   SYNQ_CROSS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/synq_m2_secperf_crash
 */
const URL = testDatabaseUrl(
  'SYNQ_CROSS_TEST_DATABASE_URL',
  'synq_m2_secperf_crash',
);
let pool: pg.Pool;
beforeAll(async () => {
  const name = new globalThis.URL(URL).pathname.slice(1);
  if (!/^synq_m2_secperf_[a-z0-9_]+$/.test(name))
    throw new Error('cross-cutting test database must be synq_m2_secperf_*');
  const admin = new pg.Client({
    connectionString: URL.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  pool = await durablePool(URL);
  await migrateExecution(pool);
  await migrateTreasury(pool);
});
afterAll(async () => {
  await pool?.end();
});

const client = privateKeyToAccount(keccak256(toHex('p23-job-client')));
const evaluator = privateKeyToAccount(keccak256(toHex('p23-job-evaluator')));
const provider = privateKeyToAccount(keccak256(toHex('p23-job-provider')));
const NOW = 1_792_146_000;
const CFG = {
  grantKey: new Uint8Array(32).fill(9),
  operator: 'p23-agent-job-executor',
  grantTtlSeconds: 600,
  riskRequiredAbove: 1_000_000n,
};

function jobCall(jobId: bigint): AgentJobCall {
  return {
    op: 'FUND',
    chainId: USDC.chainId,
    token: USDC.address,
    contract: contract('arc-testnet', 'ERC8183_AGENTIC_COMMERCE').address,
    sender: client.address,
    client: client.address,
    provider: provider.address,
    evaluator: evaluator.address,
    jobId,
    budget: 1000n,
    expiredAt: BigInt(NOW + 3600),
    descriptionHash: keccak256(toHex('p23 job')),
    hook: zeroAddress,
    reason: keccak256(toHex('p23 accepted')),
    platformFeeBps: 0n,
    evaluatorFeeBps: 0n,
    platformTreasury: zeroAddress,
  };
}

/** The owner-approved Kernel grant for one job call (as the proof script obtains it). */
async function jobGrant(c: AgentJobCall) {
  const value = agentJobValue(c);
  const m: PaymentMandate = {
    mandateId: `job_${c.jobId}`,
    version: 1,
    workspaceId: 'p23',
    owner: client.address,
    chainId: c.chainId,
    token: c.token,
    payer: value.payer,
    recipients: [value.recipient],
    purposes: ['GROUP_EXPENSE'],
    perActionCap: 1000n,
    periodBudget: 1000n,
    periodSeconds: 86_400,
    validFrom: NOW - 60,
    validUntil: NOW + 3600,
  };
  const intent: PaymentIntent = {
    ...value,
    intentId: agentJobIntentId(c),
    mandateId: m.mandateId,
    mandateVersion: 1,
    purpose: 'GROUP_EXPENSE',
    obligationRef: `job:${c.jobId}:fund`,
    evidenceHash: c.descriptionHash,
    proposedBy: 'p23-test',
  };
  const args = {
    config: CFG,
    mandate: m,
    mandateSignature: await client.signTypedData(mandateTypedData(m)),
    state: { revoked: false, spends: [] },
    intent,
    risk: { flags: [], available: true },
    simulationOk: true,
    now: NOW,
    requireOwnerApproval: true,
  };
  const first = await decide(args);
  if (first.outcome !== 'REQUIRE_OWNER_APPROVAL')
    throw new Error('no challenge');
  const d = await decide({
    ...args,
    ownerApproval: {
      ...first.approval,
      signature: await client.signTypedData(
        intentApprovalTypedData(intent, first.approval),
      ),
    },
  });
  if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
  return d.grant;
}

class CrashingEscrowJournal extends PostgresEscrowJournal {
  override async record(_entry: EscrowBroadcast): Promise<void> {
    throw new Error('crash after durable signed bytes');
  }
}

describe('P23-02 crash recovery on the durable Postgres stores', () => {
  it('P23-02 group fund refund (Postgres event log): crash after execution start, restart, one refund credited, racing writers fenced', async () => {
    await groupFundRefundCrash(
      () => new PostgresFundStore(pool),
      `p23_refund_${runId()}`,
    );
  });

  for (const steps of [
    ['APPROVE', 'OPEN'],
    ['RELEASE'],
    ['REFUND'],
    ['JOB_APPROVE', 'JOB_FUND'],
    ['JOB_COMPLETE'],
  ] as const)
    it(`P23-02 ${steps.join('->')} (Postgres escrow journal): crash after signed bytes and after broadcast; signed and included once`, async () => {
      await signedStepsCrash({
        steps,
        grantId: `grt_p23_${runId()}`,
        journal: () => new PostgresEscrowJournal(pool),
        crashing: () => new CrashingEscrowJournal(pool),
      });
    });

  it('P23-02 agent job: a journal-backed admission resumes the same grant after a crash; another grant, a revoked nonce or a plain fence cannot', async () => {
    const c = jobCall(BigInt(Date.now()));
    const g = await jobGrant(c);
    // Exactly how scripts/arc-agent-stack-proof.ts wires executeAgentJob.
    const journalFence = (): NonceFence => {
      const j = new PostgresEscrowJournal(pool);
      return {
        consume: async () => false,
        consumeGrant: (grant, at) => j.admit(grant, at),
      };
    };
    const admit = (fence: NonceFence) =>
      admitAgentJobGrant({
        call: c,
        grant: g,
        grantKey: CFG.grantKey,
        now: NOW,
        mandateRevoked: false,
        fence,
      });
    await admit(journalFence());
    // Crash; a new process resumes the same operation under the same grant.
    await admit(journalFence());
    expect(await new PostgresGrantFence(pool).consumed(g.grantId)).toBe(NOW);
    // A different grant id with the same nonce is a replay.
    expect(
      await new PostgresEscrowJournal(pool).admit(
        { ...g, grantId: `${g.grantId}_forged` },
        NOW,
      ),
    ).toBe(false);
    // A plain fence (no resumable admission) fails closed on resume.
    await expect(admit(new PostgresGrantFence(pool))).rejects.toMatchObject({
      code: 'GRANT_REPLAYED',
    });
    // Revocation stops resumption too.
    await new PostgresGrantFence(pool).revoke(g.nonce);
    await expect(admit(journalFence())).rejects.toMatchObject({
      code: 'GRANT_REPLAYED',
    });
  });

  it('P23-02 vault pay-once (Postgres outbox): crash before broadcast, a new store instance resumes the recorded bytes; one payment', async () => {
    const fake = fakeVaultChain();
    const chain = await connectChain('arc-testnet', undefined, fake.client);
    const signer = vaultSigner();
    const key = `p23-vault-pg-${runId()}`;
    const ref = keccak256(toHex(key)) as Hex;
    const pay = (afterRecord?: () => void) =>
      vaultPayOnce({
        store: new PostgresOutboxStore(pool),
        key,
        chain,
        signer,
        asset: USDC,
        call: { recipient: DEV, amount: usd('1'), ref },
        authorize: async () => undefined,
        now: () => NOW,
        ...(afterRecord ? { afterRecord } : {}),
      });
    await expect(
      pay(() => {
        throw new Error('killed');
      }),
    ).rejects.toThrow(/killed/);
    const recorded = (await new PostgresOutboxStore(pool).get(key))!;
    expect(recorded.state).toBe('SIGNED');
    const r = await pay();
    expect(r.signedNow).toBe(false);
    expect(r.record.hash).toBe(recorded.hash);
    expect(r.record.state).toBe('CONFIRMED');
    expect(signer.total).toBe(1);
    expect(fake.paid).toHaveLength(1);
  });
});
