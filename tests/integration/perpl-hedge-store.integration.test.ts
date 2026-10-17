import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GrantDraftSchema } from '@synq/schemas';
import {
  HedgePolicy,
  MandateResolver,
  artifactHash,
  HedgeIntentSchema,
  hedgeIntentHash,
  onchainMandateId,
  onchainPluginId,
} from '@synq/kernel';
import {
  DurableHedgeGrantAuthority,
  PerplHedgeExecutor,
  PostgresHedgeStore,
  PostgresHedgeMandateSource,
  type TrustedHedgeState,
} from '@synq/perpl-executor';
import {
  MarketCatalog,
  PerplRestClient,
  type PerplOrder,
} from '@synq/plugin-perpl';
import {
  GrantApprovalGateway,
  PostgresIdentityStore,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantDigest,
  grantTypedData,
} from '../../packages/identity/src/server.js';
import {
  GRANT_KEY,
  GROUP_ACCOUNT,
  OPERATOR,
  T0,
  factsFor,
  hedgeIntent,
  hedgeMandate,
  members,
  parentMandate,
  testnetPerpl,
} from '../risk/hedge-fixtures.js';
import { contextFixture } from '../perpl/context-fixture.js';
import { FakePerplRest, testSigner } from '../perpl/fake-perpl.js';
import { testDatabaseUrl } from '../durable/pg.js';

const url = testDatabaseUrl(
  'SYNQ_HEDGE_TEST_DATABASE_URL',
  'synq_resume_p10_hedge',
);
let pool: pg.Pool;
let store: PostgresHedgeStore;
let identity: PostgresIdentityStore;
let gateway: GrantApprovalGateway;
const MODULE = GROUP_ACCOUNT;
const trusted = new Map<string, TrustedHedgeState>();
function authority() {
  return new DurableHedgeGrantAuthority({
    store: new PostgresHedgeStore(pool),
    key: GRANT_KEY,
    mode: 'SIMULATION',
    loadTrusted: async (id) => {
      const state = trusted.get(id);
      if (!state) throw new Error('trusted intent missing');
      return structuredClone(state);
    },
    approvals: gateway,
  });
}
function state(
  id = 'hedge_one',
  changes: Record<string, unknown> = {},
  factChanges: Parameters<typeof factsFor>[1] = {},
): TrustedHedgeState {
  const intent = HedgeIntentSchema.parse(
    hedgeIntent({ intentId: id, ...changes }),
  );
  const facts = factsFor(intent, factChanges);
  return {
    intent: {
      ...intent,
      riskPacketHash: facts.riskPacketHash as `0x${string}`,
    },
    mandate: parentMandate(),
    hedgeMandate: hedgeMandate(),
    facts,
  };
}
async function approve(
  s: TrustedHedgeState,
  count = 2,
  changes: Record<string, unknown> = {},
) {
  trusted.set(s.intent.intentId, s);
  const hash = hedgeIntentHash(s.intent),
    m = s.mandate;
  const base = {
    schemaVersion: 1,
    groupId: m.groupId,
    hedgeIntent: s.intent,
    domain: {
      name: 'SynqExecutionModule',
      version: '1',
      chainId: testnetPerpl.chainId,
      verifyingContract: MODULE,
    },
    requiredApprovals: 2,
    createdAt: T0,
    grant: {
      groupId: m.chainGroupId,
      account: m.account,
      mandateId: onchainMandateId(m),
      mandateVersion: String(m.version),
      executor: OPERATOR,
      pluginId: onchainPluginId('perpl'),
      chainId: String(m.network.chainId),
      target: s.hedgeMandate.exchange,
      selector: m.bindings[0]!.selector,
      calldataHash: hash,
      token: m.inputAsset.address,
      maxInputAmount: s.intent.collateral,
      nativeValue: '0',
      minOutputAmount: '0',
      recipient: m.account,
      validAfter: String(T0 - 1),
      validUntil: String(s.intent.expiresAt),
      nonce: '1',
      intentHash: hash,
      ...changes,
    },
    digest: `0x${'00'.repeat(32)}`,
  };
  const parsed = GrantDraftSchema.parse(base),
    draft = { ...parsed, digest: grantDigest(parsed) };
  await gateway.registerDraft({ draft, asset: m.inputAsset });
  for (let i = 0; i < count; i++) {
    const member = members[i]!,
      request = {
        memberId: `member_${i}`,
        principalId: `local_${i}`,
        requestedAt: T0,
      };
    const c = await gateway.issueChallenge({
      ...request,
      draftDigest: draft.digest,
      requestSignature: await member.signTypedData(
        challengeRequestTypedData(draft, request),
      ),
    });
    await gateway.submit({
      challengeId: c.challengeId,
      grantSignature: await member.signTypedData(grantTypedData(draft)),
      attestationSignature: await member.signTypedData(
        approvalAttestationTypedData(draft, c),
      ),
    });
  }
  return draft;
}
function venue(
  opts: {
    positionsFailAfterPost?: boolean;
    crashAfterPost?: boolean;
    crashBeforePost?: boolean;
    closed?: boolean;
  } = {},
) {
  const context = contextFixture('testnet');
  if (opts.closed)
    context.markets.find((m) => m.id === 64)!.config.is_open = false;
  const catalog = new MarketCatalog(testnetPerpl, context, T0 * 1000),
    server = new FakePerplRest(testnetPerpl.chainId, testnetPerpl.restUrl),
    signer = testSigner('trade');
  server.register(signer);
  const orders: { rq: number; t: number; s: number }[] = [],
    events: PerplOrder[] = [];
  let lfr = 10,
    crashed = false;
  server.routes.push((r) => {
    if (r.target === '/v1/trading/wallet')
      return {
        status: 200,
        body: {
          mt: 19,
          sn: 70000000,
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
        },
      };
    if (r.target === '/v1/market-data/64/ticker')
      return {
        status: 200,
        body: {
          mt: 9,
          sn: 70000000,
          d: { '64': context.markets.find((m) => m.id === 64)!.state },
        },
      };
    if (r.target === '/v1/trading/positions')
      return opts.positionsFailAfterPost && orders.length
        ? { status: 500, body: { error: 'unknown position state' } }
        : { status: 200, body: { mt: 26, sn: 70000000, d: [] } };
    if (r.target === '/v1/trading/orders' && r.method === 'GET')
      return { status: 200, body: { mt: 23, sn: 70000000, d: [] } };
    if (r.target.startsWith('/v1/trading/order-history'))
      return { status: 200, body: { d: events, np: '' } };
    if (r.target === '/v1/trading/orders' && r.method === 'POST') {
      const o = (
        JSON.parse(r.body) as { d: { rq: number; t: number; s: number }[] }
      ).d[0]!;
      orders.push(o);
      lfr = o.rq;
      events.unshift({
        rq: o.rq,
        t: o.t,
        mkt: 64,
        acc: 1058,
        st: o.t === 5 ? 5 : 4,
        fs: o.s,
        fp: 2400,
        r: true,
        oid: 500,
      });
      return {
        status: 200,
        body: { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] },
      };
    }
    return undefined;
  });
  const rest = new PerplRestClient({
    network: testnetPerpl,
    signer,
    fetch: server.fetch,
    transport: 'recorded',
    maxAttempts: 1,
    sleep: async () => {},
  });
  const submit = rest.submitOrders.bind(rest);
  rest.submitOrders = async (...args) => {
    if (opts.crashBeforePost && !crashed) {
      crashed = true;
      throw new Error('injected worker crash before HTTP');
    }
    const result = await submit(...args);
    if (opts.crashAfterPost && !crashed) {
      crashed = true;
      throw new Error('injected worker crash after HTTP');
    }
    return result;
  };
  return { rest, catalog, orders, options: opts };
}
function executor(v: ReturnType<typeof venue>, a = authority()) {
  return new PerplHedgeExecutor({
    rest: v.rest,
    grants: a,
    catalog: v.catalog,
    mode: 'SIMULATION',
    now: () => (T0 + 1) * 1000,
    sleep: async () => {},
    maxPolls: 1,
  });
}

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
  store = new PostgresHedgeStore(pool);
  await store.initialize();
  identity = new PostgresIdentityStore(pool);
  await identity.migrate();
});
beforeEach(async () => {
  trusted.clear();
  await pool.query(
    'TRUNCATE synq_hedge_intents,identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_membership,identity_group,identity_principal CASCADE',
  );
  const mandate = parentMandate();
  await identity.transaction(async (tx) => {
    await tx.insertGroup({
      groupId: mandate.groupId,
      chainGroupId: mandate.chainGroupId,
      chainId: testnetPerpl.chainId,
      account: mandate.account,
      owners: members.map((m) => m.address.toLowerCase() as `0x${string}`),
      threshold: 2,
      executors: [OPERATOR],
      membershipEpoch: 1,
      createdAt: T0,
    });
    for (let i = 0; i < 2; i++) {
      const signer = members[i]!.address.toLowerCase() as `0x${string}`;
      await tx.insertPrincipal({
        principalId: `local_${i}`,
        kind: 'LOCAL_FIXTURE',
        signer,
        rpId: null,
        credential: null,
        providerRef: null,
        status: 'ACTIVE',
        enrolledAt: T0,
        lastRecoveredAt: null,
      });
      await tx.insertMembership({
        groupId: mandate.groupId,
        memberId: `member_${i}` as never,
        principalId: `local_${i}` as never,
        principalKind: 'LOCAL_FIXTURE',
        role: 'APPROVER',
        signer,
        status: 'ACTIVE',
        joinedEpoch: 1,
        joinedAt: T0,
        revokedAt: null,
      });
    }
  });
  gateway = new GrantApprovalGateway(
    identity,
    {
      profile: 'local/anvil',
      rpId: 'localhost',
      origin: 'http://localhost',
      now: () => T0,
    },
    { executionModules: { [testnetPerpl.chainId]: MODULE } },
  );
});
afterAll(async () => {
  await pool?.end();
});
describe('durable hedge authority and executor on isolated PostgreSQL, SIMULATION only', () => {
  it('requires persisted signed P05 quorum bound to the exact hedge tuple', async () => {
    const s = state();
    await approve(s, 1);
    await expect(authority().issue(s.intent.intentId)).rejects.toThrow(
      /APPROVALS_MISSING/,
    );
    const draft = await gateway.pendingIntent(hedgeIntentHash(s.intent));
    expect(draft.preview).toMatchObject({
      action: 'PERP_HEDGE',
      target: testnetPerpl.exchange,
      hedgeIntent: s.intent,
    });
  });
  it('a REAL_TESTNET authority refuses SIMULATION evidence even with a verified quorum', async () => {
    const s = state('simulated_evidence');
    await approve(s);
    const live = new DurableHedgeGrantAuthority({
      ...authority().options,
      mode: 'REAL_TESTNET',
    });
    await expect(live.issue(s.intent.intentId)).rejects.toThrow(
      /SIMULATION evidence for a REAL_TESTNET authority/,
    );
    const rows = await pool.query('SELECT 1 FROM synq_hedge_intents');
    expect(rows.rows).toHaveLength(0);
  });
  it('uses two signed proofs, and membership revocation invalidates execution', async () => {
    const s = state();
    await approve(s);
    const a = authority(),
      grant = await a.issue(s.intent.intentId);
    expect(grant.approvals).toEqual(['member_0', 'member_1']);
    await identity.transaction(async (tx) => {
      await tx.revokeMembership(s.intent.groupId, 'member_0', T0);
      await tx.setGroupEpoch(s.intent.groupId, 2);
    });
    const v = venue();
    await expect(executor(v, a).execute(grant)).rejects.toThrow(
      /APPROVALS_MISSING/,
    );
    expect(v.orders).toHaveLength(0);
  });
  it('rejects a signed draft bound to another parent version', async () => {
    const s = state();
    await approve(s, 2, { mandateVersion: '2' });
    await expect(authority().issue(s.intent.intentId)).rejects.toThrow(
      /P05 draft not bound/,
    );
  });
  it('revalidates trusted current limits instead of trusting a cached decision', async () => {
    const s = state();
    await approve(s);
    const a = authority(),
      g = await a.issue(s.intent.intentId);
    s.mandate = parentMandate({ perActionCap: '1' });
    trusted.set(s.intent.intentId, s);
    const v = venue();
    await expect(executor(v, a).execute(g)).rejects.toThrow(
      /DECISION_NOT_AUTHORIZABLE/,
    );
    expect(v.orders).toHaveLength(0);
  });
  it('atomically reserves shared treasury across distinct concurrent connections', async () => {
    const a = state('reserve_a', {}, { freeCoreTreasury: '1000000' }),
      b = state('reserve_b', {}, { freeCoreTreasury: '1000000' });
    await approve(a);
    await approve(b);
    const results = await Promise.allSettled([
      authority().issue(a.intent.intentId),
      authority().issue(b.intent.intentId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rows = await pool.query('SELECT record FROM synq_hedge_intents');
    expect(rows.rows).toHaveLength(1);
  });
  it('shares venue collateral reservations across different groups bound to the same account', async () => {
    const a = state(
      'group_a',
      {},
      { perpFreeCollateral: '1000000', freeCoreTreasury: '0' },
    );
    const b = state(
      'group_b',
      {},
      { perpFreeCollateral: '1000000', freeCoreTreasury: '0' },
    );
    b.intent = { ...b.intent, groupId: 'other_group' as never };
    b.mandate = {
      ...b.mandate,
      groupId: b.intent.groupId,
      chainGroupId: `0x${'88'.repeat(32)}`,
      account: `0x${'5aff'.padStart(40, '0')}`,
    };
    b.hedgeMandate = { ...b.hedgeMandate, groupId: b.intent.groupId };
    await identity.transaction(async (tx) => {
      const group = await tx.getGroup(a.intent.groupId);
      await tx.insertGroup({
        ...group!,
        groupId: b.intent.groupId,
        chainGroupId: b.mandate.chainGroupId,
        account: b.mandate.account,
      });
      for (const m of await tx.listMemberships(a.intent.groupId))
        await tx.insertMembership({ ...m, groupId: b.intent.groupId });
    });
    await approve(a);
    await approve(b);
    const results = await Promise.allSettled([
      authority().issue(a.intent.intentId),
      authority().issue(b.intent.intentId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('requires a fresh risk observation after a prior settled venue receipt', async () => {
    const first = state();
    await approve(first);
    const g = await authority().issue(first.intent.intentId),
      v = venue();
    await executor(v).execute(g);
    const next = state('old_observation');
    await approve(next);
    await expect(authority().issue(next.intent.intentId)).rejects.toThrow(
      /risk snapshot predates/,
    );
  });
  it('returns the saved receipt after authority/executor restart or concurrent dispatch, without a new rq', async () => {
    const s = state();
    await approve(s);
    const grant = await authority().issue(s.intent.intentId),
      v = venue();
    const [r1, r2] = await Promise.all([
      executor(v).execute(grant),
      executor(v).execute(grant),
    ]);
    expect(r1).toEqual(r2);
    expect(v.orders).toHaveLength(1);
    const replayGrant = await authority().issue(s.intent.intentId);
    expect(replayGrant).toEqual(grant);
    expect(await executor(v).execute(replayGrant)).toEqual(r1);
    expect(v.orders).toHaveLength(1);
  });
  it('crash after submission recovers the persisted rq by reconciliation, without another POST', async () => {
    const s = state();
    await approve(s);
    const g = await authority().issue(s.intent.intentId),
      v = venue({ crashAfterPost: true });
    await expect(executor(v).execute(g)).rejects.toThrow(
      /injected worker crash/,
    );
    const r = await executor(v).execute(g);
    expect(r).toMatchObject({
      rq: 11,
      reconciliation: 'SETTLED',
      filledSize: '40',
    });
    expect(v.orders).toHaveLength(1);
  });
  it('crash before submission remains UNKNOWN and blocks a new increasing order', async () => {
    const s = state();
    await approve(s);
    const g = await authority().issue(s.intent.intentId),
      v = venue({ crashBeforePost: true });
    await expect(executor(v).execute(g)).rejects.toThrow(
      /injected worker crash/,
    );
    expect((await executor(v).execute(g)).reconciliation).toBe('UNKNOWN');
    expect(v.orders).toHaveLength(0);
    const next = state('next_open', { size: '1' });
    await approve(next);
    const nextGrant = await authority().issue(next.intent.intentId);
    await expect(executor(v).execute(nextGrant)).rejects.toThrow(
      /UNKNOWN_OUTCOME/,
    );
    expect(v.orders).toHaveLength(0);
  });
  it('position-read failure stays UNKNOWN, retains reservation, and recovers before a new increase', async () => {
    const s = state();
    await approve(s);
    const g = await authority().issue(s.intent.intentId),
      v = venue({ positionsFailAfterPost: true });
    expect(await executor(v).execute(g)).toMatchObject({
      reconciliation: 'UNKNOWN',
      positionsStatus: 'UNKNOWN',
    });
    v.options.positionsFailAfterPost = false;
    expect(await executor(v).execute(g)).toMatchObject({
      reconciliation: 'SETTLED',
      positionsStatus: 'KNOWN',
    });
    expect(v.orders).toHaveLength(1);
  });
  it('closed markets allow known reduce-only cancellation and never allow a new increase', async () => {
    const s = state(
      'cancel_closed',
      { kind: 'CANCEL', orderId: '500', size: '0', leverageHundredths: 0 },
      { marketOpen: false },
    );
    trusted.set(s.intent.intentId, s);
    const g = await authority().issue(s.intent.intentId),
      v = venue({ closed: true });
    expect(await executor(v).execute(g)).toMatchObject({
      reconciliation: 'SETTLED',
      orderType: 5,
    });
    const open = state('closed_open', {}, { marketOpen: false });
    trusted.set(open.intent.intentId, open);
    expect(new HedgePolicy().evaluate(open).rejection?.code).toBe(
      'MARKET_CLOSED',
    );
    await expect(authority().issue(open.intent.intentId)).rejects.toThrow(
      /DECISION_NOT_AUTHORIZABLE/,
    );
    expect(v.orders.every((o) => o.t === 5)).toBe(true);
  });
});

it('P10-N5 resolves persisted hedge versions through the governed parent commitment', async () => {
  const first = hedgeMandate();
  const parent = parentMandate({ hedgePolicyHash: artifactHash(first) });
  const governance = new MandateResolver([parent]);
  const make = () =>
    new PostgresHedgeMandateSource({
      pool,
      parents: {
        current: async (groupId) =>
          governance.current(groupId, parent.mandateId),
      },
    });
  await make().migrate();
  await pool.query(
    'DELETE FROM synq_hedge_mandate_artifacts WHERE group_id=$1',
    [parent.groupId],
  );
  await make().publish(first);
  expect((await make().current(parent.groupId)).hedgeMandate.version).toBe(1);
  await expect(make().publish({ ...first, maxNotional: '1' })).rejects.toThrow(
    'current parent governance',
  );
  const second = hedgeMandate({
    version: 2,
    parentMandateVersion: 2,
    maxNotional: '4000000',
  });
  const next = parentMandate({
    version: 2,
    hedgePolicyHash: artifactHash(second),
  });
  expect(() =>
    governance.supersede(next, { securitySensitive: false }),
  ).toThrow('NARROWING_REQUIRES_INVALIDATION');
  governance.supersede(next, { securitySensitive: true });
  await expect(make().current(parent.groupId)).rejects.toThrow(
    'artifact missing',
  );
  await expect(make().publish(first)).rejects.toThrow(
    'current parent governance',
  );
  await make().publish(second);
  expect(await make().current(parent.groupId)).toMatchObject({
    mandate: { version: 2 },
    hedgeMandate: { version: 2 },
  });
  governance.revoke(parent.groupId, parent.mandateId);
  expect((await make().current(parent.groupId)).mandate.status).toBe('REVOKED');
  await expect(make().publish(second)).rejects.toThrow('parent revoked');
});
