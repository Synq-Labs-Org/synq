import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  DurableHedgeGrantAuthority,
  PerplHedgeEvidenceReader,
  PerplHedgeExecutor,
  PerplHedgeService,
  PostgresHedgeStore,
  trustedHedgeStateLoader,
  type HedgeMandates,
} from '@synq/perpl-executor';
import {
  MarketCatalog,
  PerplRestClient,
  type PerplOrder,
  type PerplPosition,
} from '@synq/plugin-perpl';
import {
  GrantApprovalGateway,
  PostgresIdentityStore,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantTypedData,
} from '../../packages/identity/src/server.js';
import { hedgeIntentHash } from '@synq/kernel';
import type { Mandate } from '@synq/schemas';
import { perplHedgeActivities } from '../../workers/workflow/src/activities/hedge-perpl.js';
import type { HedgeState } from '../../workers/workflow/src/workflows/hedge.js';
import { contextFixture } from '../perpl/context-fixture.js';
import { FakePerplRest, testSigner } from '../perpl/fake-perpl.js';
import {
  GRANT_KEY,
  GROUP_ACCOUNT,
  OPERATOR,
  members,
  hedgeMandate,
  parentMandate,
  testnetPerpl,
} from '../risk/hedge-fixtures.js';
import { startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';
import { fixtureControls } from './harness/controls.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseUrl } from '../durable/pg.js';

const url = testDatabaseUrl('SYNQ_HEDGE_TEST_DATABASE_URL', 'synq_wf_hedge');
const context = contextFixture('testnet');
const NOW = context.markets.find((m) => m.id === 64)!.state!.at.t! + 1_000;
const T = Math.floor(NOW / 1000);
let env: TestWorkflowEnvironment;
let pool: pg.Pool;
let dir: string;
let controls: ReturnType<typeof fixtureControls>;
let seq = 0;

function venue() {
  const server = new FakePerplRest(testnetPerpl.chainId, testnetPerpl.restUrl),
    read = testSigner('read'),
    trade = testSigner('trade');
  server.register(read);
  server.register(trade);
  const posts: { rq: number; t: number; s: number }[] = [],
    events: PerplOrder[] = [],
    positions: PerplPosition[] = [];
  let lfr = 10;
  const ok = (body: unknown) => ({ status: 200, body });
  server.routes.push((r) => {
    if (r.target === '/v1/pub/context') return ok(context);
    if (r.target === '/v1/trading/wallet')
      return ok({
        addr: GROUP_ACCOUNT,
        as: [
          {
            in: 1,
            id: 1058,
            fr: false,
            fw: true,
            lfr,
            b: '100000000',
            lb: '0',
          },
        ],
      });
    if (r.target === '/v1/market-data/64/ticker')
      return ok({
        sn: 70000000,
        d: { '64': context.markets.find((m) => m.id === 64)!.state },
      });
    if (r.target === '/v1/trading/positions') return ok({ d: positions });
    if (r.target === '/v1/trading/orders' && r.method === 'GET')
      return ok({ d: [] });
    if (r.target.startsWith('/v1/trading/order-history'))
      return ok({ d: events, np: '' });
    if (r.target === '/v1/trading/orders' && r.method === 'POST') {
      const o = (
        JSON.parse(r.body) as { d: { rq: number; t: number; s: number }[] }
      ).d[0]!;
      posts.push(o);
      lfr = o.rq;
      events.unshift({
        rq: o.rq,
        t: o.t,
        mkt: 64,
        acc: 1058,
        st: 4,
        fs: o.s,
        fp: 2467,
        r: true,
        oid: 900 + o.rq,
      });
      if (o.t === 2)
        positions.push({
          mkt: 64,
          acc: 1058,
          pid: 1,
          st: 1,
          sd: 2,
          c: '987600',
          ep: 2467,
          s: o.s,
        });
      if (o.t === 4) positions.splice(0);
      return ok({ mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] });
    }
    return undefined;
  });
  const client = (signer: ReturnType<typeof testSigner>) =>
    new PerplRestClient({
      network: testnetPerpl,
      signer,
      fetch: server.fetch,
      transport: 'recorded',
      maxAttempts: 1,
      sleep: async () => {},
    });
  return { restRead: client(read), restTrade: client(trade), posts, positions };
}

const gateway = () =>
  new GrantApprovalGateway(
    new PostgresIdentityStore(pool),
    {
      profile: 'local/anvil',
      rpId: 'localhost',
      origin: 'http://localhost',
      now: () => T,
    },
    { executionModules: { [testnetPerpl.chainId]: GROUP_ACCOUNT } },
  );

async function service(mandates: HedgeMandates) {
  const v = venue();
  const store = new PostgresHedgeStore(pool);
  const authority = new DurableHedgeGrantAuthority({
    store,
    key: GRANT_KEY,
    mode: 'SIMULATION',
    executionModule: GROUP_ACCOUNT,
    approvals: gateway(),
    loadTrusted: trustedHedgeStateLoader({
      store,
      mandates: { current: async () => mandates },
      network: testnetPerpl,
      now: () => NOW,
    }),
  });
  const reader = new PerplHedgeEvidenceReader({
    rest: v.restRead,
    treasury: {
      executionMode: 'SIMULATION',
      nativeBalance: async () => 80n * 10n ** 18n,
      collateralBalance: async () => 100_000_000n,
    },
    accountId: 1058,
    base: 'MON',
    now: () => NOW,
  });
  const svc = new PerplHedgeService({
    store,
    reader,
    mandates: { current: async () => mandates },
    authority,
    executor: () =>
      new PerplHedgeExecutor({
        rest: v.restTrade,
        grants: authority,
        catalog: new MarketCatalog(testnetPerpl, context, NOW),
        mode: 'SIMULATION',
        now: () => NOW,
        sleep: async () => {},
        maxPolls: 1,
      }),
    positions: v.restRead,
    accountId: 1058,
    now: () => NOW,
  });
  return { svc, v };
}

let accountSeq = 0x6000;
async function group(groupId: string): Promise<Mandate> {
  const account = `0x${(++accountSeq).toString(16).padStart(40, '0')}` as const;
  const chainGroupId =
    `0x${accountSeq.toString(16).padStart(64, '0')}` as const;
  const mandate = parentMandate({
    groupId,
    account,
    chainGroupId,
    validAfter: T - 60,
    validUntil: T + 86_400,
  });
  await new PostgresIdentityStore(pool).transaction(async (tx) => {
    await tx.insertGroup({
      groupId: groupId as never,
      chainGroupId,
      chainId: testnetPerpl.chainId,
      account,
      owners: members.map((m) => m.address.toLowerCase() as `0x${string}`),
      threshold: 2,
      executors: [OPERATOR],
      membershipEpoch: 1,
      createdAt: T,
    });
    for (let i = 0; i < 2; i++) {
      const signer = members[i]!.address.toLowerCase() as `0x${string}`;
      const principalId = `wf_member_${i}`;
      await tx.insertMembership({
        groupId: groupId as never,
        memberId: `member_${i}` as never,
        principalId: principalId as never,
        principalKind: 'LOCAL_FIXTURE',
        role: 'APPROVER',
        signer,
        status: 'ACTIVE',
        joinedEpoch: 1,
        joinedAt: T,
        revokedAt: null,
      });
    }
  });
  return mandate;
}
// Two group members sign the registered draft once the workflow has asked for it.
async function approveWhenPending(
  svc: PerplHedgeService,
  groupId: string,
  hedgeId: string,
) {
  const g = gateway();
  for (let i = 0; i < 200; i++) {
    const proposal = await new PostgresHedgeStore(pool).proposal(
      groupId,
      hedgeId,
    );
    const draft = proposal?.intent
      ? await g
          .pendingIntent(hedgeIntentHash(proposal.intent))
          .then((v) => v.draft)
          .catch(() => null)
      : null;
    if (draft) {
      for (let m = 0; m < 2; m++) {
        const request = {
          memberId: `member_${m}`,
          principalId: `wf_member_${m}`,
          requestedAt: T,
        };
        const c = await g.issueChallenge({
          ...request,
          draftDigest: draft.digest,
          requestSignature: await members[m]!.signTypedData(
            challengeRequestTypedData(draft, request),
          ),
        });
        await g.submit({
          challengeId: c.challengeId,
          grantSignature: await members[m]!.signTypedData(
            grantTypedData(draft),
          ),
          attestationSignature: await members[m]!.signTypedData(
            approvalAttestationTypedData(draft, c),
          ),
        });
      }
      return draft.digest;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no approval draft registered');
}
const hm = (groupId: string, changes: Record<string, unknown> = {}) =>
  hedgeMandate({
    groupId,
    validAfter: T - 60,
    validUntil: T + 86_400,
    ...changes,
  });

beforeAll(async () => {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe DB');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
      name,
    ]);
    if (!r.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ connectionString: url, max: 6 });
  await new PostgresHedgeStore(pool).initialize();
  await new PostgresIdentityStore(pool).migrate();
  await pool.query(
    'TRUNCATE synq_hedge_intents,synq_hedge_proposals,identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_membership,identity_group,identity_principal CASCADE',
  );
  await new PostgresIdentityStore(pool).transaction(async (tx) => {
    for (let i = 0; i < 2; i++)
      await tx.insertPrincipal({
        principalId: `wf_member_${i}` as never,
        kind: 'LOCAL_FIXTURE',
        signer: members[i]!.address.toLowerCase() as `0x${string}`,
        rpId: null,
        credential: null,
        providerRef: null,
        status: 'ACTIVE',
        enrolledAt: T,
        lastRecoveredAt: null,
      });
  });
  env = await startTemporal();
  dir = mkdtempSync(join(tmpdir(), 'synq-wf-hedge-'));
});
afterAll(async () => {
  await env?.teardown();
  await pool?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function runWorkflow(
  svc: PerplHedgeService,
  groupId: string,
  hedgeId: string,
  approvers?: () => Promise<unknown>,
): Promise<HedgeState> {
  const config = testConfig('hedge-perpl');
  controls = fixtureControls(join(dir, `controls-${++seq}`), [groupId]);
  return withWorkers(
    env,
    config,
    { ...perplHedgeActivities({ service: svc }), ...controls.activities },
    async () => {
      const handle = await env.client.workflow.start('HedgeWorkflow', {
        workflowId: `hedge-perpl.${process.pid}.${seq}`,
        taskQueue: config.taskQueues.strategy,
        args: [
          {
            groupId,
            hedgeId,
            pollSeconds: 1,
            maxPolls: 3,
            maxApprovalPolls: 20,
          },
        ],
      });
      const [result] = await Promise.all([
        handle.result() as Promise<HedgeState>,
        approvers?.(),
      ]);
      return result;
    },
  );
}

describe('HedgeWorkflow over the Perpl executor activities (SIMULATION venue, isolated PostgreSQL)', () => {
  it('sizes from reader evidence, authorizes through the durable Kernel authority, fills, reconciles and closes', async () => {
    const groupId = `wf_hedge_${process.pid}_${Date.now()}`;
    const mandates = {
      mandate: await group(groupId),
      hedgeMandate: hm(groupId),
    };
    const { svc, v } = await service(mandates);
    const opened = await runWorkflow(svc, groupId, 'open1', () =>
      approveWhenPending(svc, groupId, 'open1'),
    );
    expect(opened).toMatchObject({
      approvals: { required: 2, satisfied: true },
      outcome: 'FILLED',
      reconciled: true,
      position: '-40',
      plan: { action: 'OPEN', side: 'SHORT', size: '40', market: '64' },
    });
    expect(v.posts).toEqual([expect.objectContaining({ t: 2, s: 40 })]);
    const proposal = await svc.proposalByClientOrderId(opened.clientOrderId!);
    expect(proposal?.evidence.executionMode).toBe('SIMULATION');
    expect(proposal?.intent).toMatchObject({
      notional: '987600',
      collateral: '987600',
    });
    mandates.hedgeMandate = hm(groupId, { version: 2, targetHedgeRatioBps: 0 });
    const closed = await runWorkflow(svc, groupId, 'close1');
    expect(closed).toMatchObject({
      approvals: { required: 0, satisfied: true },
      outcome: 'FILLED',
      reconciled: true,
      position: '0',
      plan: { action: 'CLOSE', size: '40' },
    });
    expect(v.posts.map((o) => o.t)).toEqual([2, 4]);
    expect(v.positions).toHaveLength(0);
    const again = await runWorkflow(svc, groupId, 'open1');
    expect(again.outcome).toBe('FILLED');
    expect(v.posts).toHaveLength(2);
  });

  it('a hedge that needs a verified quorum is never sent without one', async () => {
    const groupId = `wf_quorum_${process.pid}_${Date.now()}`;
    const { svc, v } = await service({
      mandate: await group(groupId),
      hedgeMandate: hm(groupId),
    });
    const result = await runWorkflow(svc, groupId, 'q1');
    expect(result).toMatchObject({
      outcome: 'REJECTED',
      approvals: { required: 2, satisfied: false },
    });
    expect(result.approvals?.draftDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.posts).toHaveLength(0);
  });

  it('refuses a plan altered between planning and submission', async () => {
    const groupId = `wf_forged_${process.pid}_${Date.now()}`;
    const { svc, v } = await service({
      mandate: await group(groupId),
      hedgeMandate: hm(groupId),
    });
    const acts = perplHedgeActivities({ service: svc });
    const plan = await acts.planHedge({
      groupId,
      hedgeId: 'f1',
      exposure: '0',
      riskStatus: 'HEALTHY',
    });
    if (plan.action === 'NONE') throw new Error('expected a plan');
    await expect(
      acts.submitHedgeOrder({
        groupId,
        clientOrderId: `synq.${groupId}.f1.open`,
        plan: { ...plan, size: '4000' },
      }),
    ).rejects.toThrow(/plan differs/);
    expect(v.posts).toHaveLength(0);
  });
});
