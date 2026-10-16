import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, type Hex } from 'viem';
import { connectChain } from '@synq/execution-worker/arc';
import { WorkspacePayoutExecutor } from '@synq/execution-worker/workspace-payout';
import { WorkspacePayouts } from '@synq/workspaces/payouts';
import {
  intentApprovalTypedData,
  mandateTypedData,
} from '@synq/kernel/arc-payment-data';
import {
  payoutIntent,
  payoutMandate,
} from '@synq/workspaces/finance-contracts';
import type { WalletScreeningPort } from '@synq/plugin-risk';
import { fakeVaultChain } from '../allocations/harness.js';
import { WorkspaceNotifications } from '../../apps/demo/src/workspace-notifications.js';
import { WorkspaceChannelLinks } from '@synq/workspaces';
import { channelLinkTypedData } from '@synq/identity/channel-link-data';
import { WorkspaceGovernance } from '@synq/workspaces/governance';
import { WorkspaceGovernanceExecutor } from '@synq/execution-worker/workspace-governance';
import {
  safeActionApprovalTypedData,
  safeActionTypedData,
} from '@synq/kernel/arc-safe-action';
import { fakeGovernanceChain } from './fake-governance-chain.js';
import { workspaceCommandPort } from '../../apps/demo/src/workspace-commands.js';
import Fastify from 'fastify';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';
import { token } from '@synq/chain-registry/arc';
import { PostgresWorkspaceStore, loginTypedData } from '@synq/workspaces';
import {
  WorkspaceFinance,
  type WorkspaceAuthority,
} from '../../packages/workspaces/src/finance.js';
import {
  financeChangeTypedData,
  type FinanceChange,
} from '../../packages/workspaces/src/finance-contracts.js';
import { workspacePool } from './pg.js';
import { testDatabaseUrl } from '../durable/pg.js';

let pool: Pool;
beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl(
      'SYNQ_WORKSPACE_FINANCE_TEST_DATABASE_URL',
      'synq_m2_workspace_finance',
    ),
  );
  await new PostgresWorkspaceStore(pool, 'https://synq.test').migrate();
});
afterAll(async () => {
  await pool?.end();
});
const account = () => privateKeyToAccount(generatePrivateKey());
async function fixture() {
  let now = 2_000_000_000;
  const store = new PostgresWorkspaceStore(
    pool,
    'https://synq.test',
    () => now,
  );
  const actors = await Promise.all(
    [0, 1, 2].map(async () => {
      const a = account();
      const c = await store.challenge({ wallet: a.address });
      const auth = await store.login(
        c.id,
        await a.signTypedData({
          ...loginTypedData(c),
          message: {
            ...loginTypedData(c).message,
            wallet: getAddress(c.wallet),
            expiresAt: BigInt(c.expiresAt),
          },
        }),
      );
      return { ...auth, a };
    }),
  );
  const [owner, coowner, outsider] = actors as [
    (typeof actors)[number],
    (typeof actors)[number],
    (typeof actors)[number],
  ];
  const { workspace: w } = await store.create(owner.principalId, {
    displayName: 'Finance workspace',
    kind: 'BUSINESS',
  });
  const invite = await store.invite(w.id, owner.principalId, { role: 'OWNER' });
  await store.accept(coowner.principalId, invite.token);
  const vault = account().address,
    policy = account().address;
  await pool.query(
    "UPDATE synq_workspaces SET status='ACTIVE',vault=$2,policy=$3,threshold=2 WHERE id=$1",
    [w.id, vault, policy],
  );
  let authority: WorkspaceAuthority = {
    vault,
    policy,
    token: token('arc-testnet', 'USDC').address,
    policyCodeHash: `0x${'ab'.repeat(32)}`,
    owners: [owner.a.address, coowner.a.address],
    threshold: 2,
    blockNumber: 1n,
    nonce: 0n,
  };
  const finance = new WorkspaceFinance(store, async () => authority);
  await finance.migrate();
  const approve = async (
    c: { change: FinanceChange; hash: string },
    actor = owner,
    svc = finance,
  ) =>
    svc.approve(
      w.id,
      actor.principalId,
      c.hash as Hex,
      await actor.a.signTypedData(financeChangeTypedData(c.change)),
    );
  return {
    store,
    w,
    owner,
    coowner,
    outsider,
    finance,
    approve,
    advance: (s: number) => {
      now += s;
    },
    setAuthority: (a: WorkspaceAuthority) => {
      authority = a;
    },
    authority,
  };
}

describe('G5 signed vendor master and policies — LOCAL_FIXTURE with real Postgres', () => {
  it('uses reversible independent migrations and rechecks Safe quorum after restart', async () => {
    const f = await fixture();
    await f.finance.migrate(0);
    await f.finance.migrate();
    const c = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'VENDOR',
      vendorId: randomUUID(),
      name: 'Vendor',
      address: account().address,
      verification: 'OWNER_ATTESTATION',
    });
    expect((await f.approve(c)).state).toBe('PENDING');
    expect((await f.finance.list(f.w.id, f.owner.principalId)).vendors).toEqual(
      [],
    );
    const restarted = new WorkspaceFinance(f.store, async () => f.authority);
    expect((await f.approve(c, f.coowner, restarted)).state).toBe('APPLIED');
    expect(
      (await restarted.list(f.w.id, f.owner.principalId)).vendors[0]?.status,
    ).toBe('VERIFIED');
    await expect(
      f.finance.list(f.w.id, f.outsider.principalId),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
  it('rejects wrong signatures, expired edits, stale revisions and drifted owners', async () => {
    const f = await fixture();
    const edit = {
      kind: 'BUDGET',
      perPayment: '50000',
      daily: '100000',
      reserve: '10000',
      aiDaily: '0',
    };
    const c = await f.finance.propose(f.w.id, f.owner.principalId, edit);
    const wrong = await f.outsider.a.signTypedData(
      financeChangeTypedData(c.change),
    );
    await expect(
      f.finance.approve(f.w.id, f.owner.principalId, c.hash, wrong),
    ).rejects.toMatchObject({ code: 'INVALID_OWNER_SIGNATURE' });
    f.setAuthority({
      ...f.authority,
      owners: [f.owner.a.address, f.outsider.a.address],
    });
    await expect(f.approve(c)).rejects.toMatchObject({
      code: 'ONCHAIN_AUTHORITY_CHANGED',
    });
    f.setAuthority(f.authority);
    f.advance(901);
    await expect(f.approve(c)).rejects.toMatchObject({ code: 'STALE_CHANGE' });
  });
  it('serializes competing revisions and preserves immutable audit history', async () => {
    const f = await fixture();
    const edit = {
      kind: 'BUDGET',
      perPayment: '50000',
      daily: '100000',
      reserve: '10000',
      aiDaily: '0',
    };
    const a = await f.finance.propose(f.w.id, f.owner.principalId, edit);
    const b = await f.finance.propose(f.w.id, f.owner.principalId, {
      ...edit,
      reserve: '20000',
    });
    await f.approve(a);
    await f.approve(b);
    const settled = await Promise.allSettled([
      f.approve(a, f.coowner),
      f.approve(b, f.coowner),
    ]);
    expect(settled.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((v) => v.status === 'rejected')).toHaveLength(1);
    const applied = settled[0]!.status === 'fulfilled' ? a : b;
    await expect(
      pool.query('UPDATE synq_ws_finance_changes SET data=$2 WHERE hash=$1', [
        applied.hash,
        {},
      ]),
    ).rejects.toThrow('immutable');
  });
  it('enforces a 24-hour cooling floor on every changed destination, including changing back', async () => {
    const f = await fixture(),
      vendorId = randomUUID(),
      first = account().address;
    const change = async (address: string) => {
      const c = await f.finance.propose(f.w.id, f.owner.principalId, {
        kind: 'VENDOR',
        vendorId,
        name: 'Vendor',
        address,
        verification: 'OWNER_ATTESTATION',
      });
      await f.approve(c);
      await f.approve(c, f.coowner);
    };
    await change(first);
    await change(account().address);
    expect(
      (await f.finance.list(f.w.id, f.owner.principalId)).vendors[0]?.status,
    ).toBe('COOLING');
    f.advance(100);
    await change(first);
    f.advance(86399);
    expect(
      (await f.finance.list(f.w.id, f.owner.principalId)).vendors[0]?.status,
    ).toBe('COOLING');
    f.advance(1);
    expect(
      (await f.finance.list(f.w.id, f.owner.principalId)).vendors[0]?.status,
    ).toBe('VERIFIED');
    await expect(
      pool.query('DELETE FROM synq_ws_vendor_history WHERE workspace_id=$1', [
        f.w.id,
      ]),
    ).rejects.toThrow('append only');
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_vendor_history WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rowCount,
    ).toBe(3);
  });
  it('rolls back an edit after a storage failure and applies exactly once on retry', async () => {
    const f = await fixture();
    const c = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'VENDOR',
      vendorId: randomUUID(),
      name: 'Recovery',
      address: account().address,
      verification: 'OWNER_ATTESTATION',
    });
    await f.approve(c);
    await pool.query(
      "CREATE FUNCTION reject_finance_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage disconnected'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER reject_finance_test BEFORE INSERT ON synq_ws_vendors FOR EACH ROW EXECUTE FUNCTION reject_finance_test()',
    );
    try {
      await expect(f.approve(c, f.coowner)).rejects.toThrow(
        'storage disconnected',
      );
    } finally {
      await pool.query('DROP TRIGGER reject_finance_test ON synq_ws_vendors');
      await pool.query('DROP FUNCTION reject_finance_test()');
    }
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_vendor_history WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rowCount,
    ).toBe(0);
    await f.approve(c, f.coowner);
    await f.approve(c, f.coowner);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ws_vendor_history WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rowCount,
    ).toBe(1);
  });
});

async function payoutFixture(clear = true) {
  const f = await fixture(),
    vendorId = randomUUID(),
    payee = account();
  for (const edit of [
    {
      kind: 'VENDOR',
      vendorId,
      name: 'Verified supplier',
      address: payee.address,
      verification: 'OWNER_ATTESTATION',
    },
    {
      kind: 'BUDGET',
      perPayment: '50000',
      daily: '100000',
      reserve: '10000',
      aiDaily: '0',
    },
  ]) {
    const c = await f.finance.propose(f.w.id, f.owner.principalId, edit);
    await f.approve(c);
    await f.approve(c, f.coowner);
  }
  const operator = account();
  let signed = 0;
  const fake = fakeVaultChain({
    vault: f.authority.vault,
    policy: f.authority.policy,
    operator: operator.address,
    now: 2_000_000_000,
  });
  const chain = await connectChain('arc-testnet', undefined, fake.client);
  f.authority.policyCodeHash = keccak256(
    (await fake.client.getCode({ address: f.authority.policy }))!,
  );
  const screening: WalletScreeningPort = {
    providerId: 'FIXTURE_ONLY',
    status: () => ({
      providerId: 'FIXTURE_ONLY',
      status: 'AVAILABLE',
      missingCredentials: [],
      reason: 'LOCAL_FIXTURE',
    }),
    screen: async (q) => ({
      ...q,
      providerId: 'FIXTURE_ONLY',
      verdict: 'CLEAR',
      reference: randomUUID(),
      reason: 'LOCAL_FIXTURE',
      screenedAt: q.now,
    }),
  };
  const signer = {
    address: operator.address,
    signTransaction: async (
      tx: Parameters<typeof operator.signTransaction>[0],
    ) => {
      signed++;
      return operator.signTransaction(tx);
    },
  };
  const authority = {
    operator: 'workspace-test',
    grantKey: new Uint8Array(32).fill(7),
    grantTtlSeconds: 60,
    riskRequiredAbove: 0n,
  };
  const executor = new WorkspacePayoutExecutor(
    f.finance,
    chain,
    signer,
    authority,
    clear ? screening : undefined,
  );
  await executor.migrate();
  const payouts = new WorkspacePayouts(f.finance);
  const propose = (obligation = randomUUID(), idempotencyKey = randomUUID()) =>
    payouts.propose(f.w.id, f.owner.principalId, {
      vendorId,
      amount: '50000',
      purpose: 'Accepted delivery',
      obligation,
      idempotencyKey,
    });
  const approve = async (
    p: Awaited<ReturnType<typeof propose>>,
    actor = f.owner,
  ) =>
    payouts.approve(f.w.id, actor.principalId, p.data.id, {
      signature: await actor.a.signTypedData(
        intentApprovalTypedData(payoutIntent(p.data), p.data.approval),
      ),
      ...(actor === f.owner
        ? {
            mandateSignature: await actor.a.signTypedData(
              mandateTypedData(payoutMandate(p.data)),
            ),
          }
        : {}),
    });
  return {
    ...f,
    vendorId,
    payee,
    executor,
    payouts,
    propose,
    approvePayout: approve,
    fake,
    signed: () => signed,
    restart: () =>
      new WorkspacePayoutExecutor(
        f.finance,
        chain,
        signer,
        authority,
        clear ? screening : undefined,
      ),
  };
}
describe('G4/G11 durable workspace payout authority — LOCAL_FIXTURE', () => {
  it('G1/G4 API contracts enforce sessions, tenant membership, strict money inputs and CSRF', async () => {
    const f = await payoutFixture(),
      app = Fastify();
    registerWorkspaceRoutes(
      app,
      f.store,
      undefined,
      undefined,
      f.finance,
      { service: f.payouts, wake: () => {} },
      { service: new WorkspaceGovernance(f.finance), wake: () => {} },
    );
    const native = async (principal: string) =>
      f.store.redeemNativeCode((await f.store.nativeCode(principal)).code);
    const owner = await native(f.owner.principalId),
      outsider = await native(f.outsider.principalId);
    const headers = { authorization: `Bearer ${owner.token}` },
      foreign = { authorization: `Bearer ${outsider.token}` },
      base = `/v2/workspaces/${f.w.id}`;
    try {
      expect((await app.inject({ url: `${base}/finance` })).statusCode).toBe(
        401,
      );
      expect(
        (await app.inject({ url: `${base}/finance`, headers: foreign }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ url: `${base}/risk`, headers: foreign }))
          .statusCode,
      ).toBe(404);
      const view = await app.inject({ url: `${base}/finance`, headers });
      expect(view.statusCode).toBe(200);
      expect(view.json().vendors).toHaveLength(1);
      const malicious = await app.inject({
        method: 'POST',
        url: `${base}/finance/changes`,
        headers,
        payload: {
          kind: 'BUDGET',
          perPayment: '1',
          daily: '1',
          reserve: '0',
          aiDaily: '0',
          role: 'OWNER',
        },
      });
      expect(malicious.statusCode).toBe(400);
      const csrf = await app.inject({
        method: 'POST',
        url: `${base}/finance/changes`,
        headers: {
          cookie: `__Host-synq_workspace=${f.owner.token}`,
          origin: 'https://foreign.test',
        },
        payload: { kind: 'REVOKE_BUDGET', reason: 'test' },
      });
      expect(csrf.statusCode).toBe(403);
      const numeric = await app.inject({
        method: 'POST',
        url: `${base}/payouts`,
        headers,
        payload: {
          vendorId: f.vendorId,
          amount: 0.05,
          purpose: 'Delivery',
          obligation: randomUUID(),
          idempotencyKey: randomUUID(),
        },
      });
      expect(numeric.statusCode).toBe(400);
      const p = await f.propose();
      expect(
        (
          await app.inject({
            url: `${base}/payouts/${p.data.id}`,
            headers: foreign,
          })
        ).statusCode,
      ).toBe(404);
      const read = await app.inject({
        url: `${base}/payouts/${p.data.id}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      for (const field of [
        'raw',
        'grant',
        'mac',
        'signatures',
        'mandateSignature',
      ])
        expect(read.json()).not.toHaveProperty(field);
      const wrong = await f.outsider.a.signTypedData(
        intentApprovalTypedData(payoutIntent(p.data), p.data.approval),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/payouts/${p.data.id}/approve`,
            headers,
            payload: { signature: wrong },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await f.payouts.view(f.w.id, f.owner.principalId, p.data.id)).signedBy,
      ).toEqual([]);
      expect(
        (await app.inject({ url: '/v2/capabilities' })).json().payoutExecution
          .status,
      ).toBe('BLOCKED');
    } finally {
      await app.close();
    }
  });
  it('G5 revokes a budget with the owner quorum and stops previously approved unsigned payments', async () => {
    const f = await payoutFixture(),
      p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    const revoke = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'REVOKE_BUDGET',
      reason: 'Pause spending for review',
    });
    await f.approve(revoke);
    expect(
      (await f.finance.list(f.w.id, f.owner.principalId)).budget,
    ).not.toBeNull();
    await f.approve(revoke, f.coowner);
    expect(
      (await f.finance.list(f.w.id, f.owner.principalId)).budget,
    ).toBeNull();
    expect(await f.executor.execute(p.data.id)).toMatchObject({
      state: 'HOLD',
      reason: 'BUDGET_CHANGED',
    });
    expect(f.signed()).toBe(0);
  });
  it('G14 proposes through verified chat identity, reuses the event key, and never approves from yes', async () => {
    const f = await payoutFixture();
    let code = '';
    const links = new WorkspaceChannelLinks(
      f.store,
      '123456',
      {
        verifiers: { telegram: () => ({ channelUserId: '91001' }) },
        deliverCode: async (q) => {
          code = q.code;
        },
      },
      async () => true,
    );
    await links.migrate();
    const c = await links.request(f.w.id, f.owner.principalId, {
      channel: 'telegram',
      proof: { mode: 'LOCAL_FIXTURE', nonce: randomUUID() },
    });
    await links.complete(f.w.id, f.owner.principalId, {
      challengeId: c.challenge.challengeId,
      channelCode: code,
      signature: await f.owner.a.signTypedData(
        channelLinkTypedData(c.challenge),
      ),
    });
    await links.bind(f.w.id, f.owner.principalId, { kind: 'DIRECT' });
    const port = workspaceCommandPort({
      links,
      finance: f.finance,
      payouts: f.payouts,
      origin: f.store.origin,
      mode: 'LOCAL_FIXTURE',
    });
    const event = {
      channel: 'telegram' as const,
      chatId: '91001',
      chatKind: 'DIRECT' as const,
      userId: '91001',
      eventId: randomUUID(),
      origin: 'CHAT' as const,
      text: `pay Verified supplier 0.05 USDC for accepted delivery ref ${randomUUID()}`,
    };
    const reply = await port(event);
    expect(reply?.card).toMatchObject({
      type: 'CONTRACTOR_PAYMENT',
      status: 'AWAITING_APPROVAL',
      executionMode: 'LOCAL_FIXTURE',
    });
    const duplicate = await port(event);
    expect(duplicate?.card?.cardId).toBe(reply?.card?.cardId);
    expect(await f.payouts.list(f.w.id, f.owner.principalId)).toHaveLength(1);
    expect(f.signed()).toBe(0);
    expect(
      (await port({ ...event, text: 'yes', eventId: randomUUID() }))?.text,
    ).toContain('Chat never approves money');
    const unknown = await port({
      ...event,
      userId: '99999',
      eventId: randomUUID(),
    });
    expect(unknown?.card).toBeUndefined();
    expect(unknown?.text).toContain('Link your own wallet');
    expect(
      (await f.payouts.list(f.w.id, f.owner.principalId))[0]?.signedBy,
    ).toEqual([]);
  });
  it('cancels only before signed bytes exist and prevents a worker from using a stale READY read', async () => {
    const f = await payoutFixture(),
      obligation = randomUUID(),
      p = await f.propose(obligation);
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    const original = f.executor.payouts.record.bind(f.executor.payouts);
    vi.spyOn(f.executor.payouts, 'record').mockImplementationOnce(
      async (id) => {
        const stale = await original(id);
        await f.payouts.cancel(f.w.id, f.owner.principalId, id);
        return stale;
      },
    );
    await expect(f.executor.execute(p.data.id)).rejects.toMatchObject({
      code: 'PAYOUT_NOT_READY',
    });
    expect(f.signed()).toBe(0);
    expect(
      (await f.payouts.view(f.w.id, f.owner.principalId, p.data.id)).state,
    ).toBe('CANCELLED');
    const fresh = await f.propose(obligation);
    expect(fresh.data.id).not.toBe(p.data.id);
    await f.approvePayout(fresh);
    await f.approvePayout(fresh, f.coowner);
    await expect(
      f.executor.execute(fresh.data.id, async () => {
        throw new Error('crash after signed journal');
      }),
    ).rejects.toThrow('crash after signed journal');
    await expect(
      f.payouts.cancel(f.w.id, f.owner.principalId, fresh.data.id),
    ).rejects.toMatchObject({ code: 'SIGNED_PAYOUT_REQUIRES_RECONCILIATION' });
    expect(f.signed()).toBe(1);
  });
  it('G13 relays one themed receipt to a verified binding and never rolls money back on delivery failure', async () => {
    const f = await payoutFixture();
    let code = '';
    const links = new WorkspaceChannelLinks(
      f.store,
      '123456',
      {
        verifiers: { telegram: () => ({ channelUserId: '90001' }) },
        deliverCode: async (q) => {
          code = q.code;
        },
      },
      async () => true,
    );
    await links.migrate();
    const request = await links.request(f.w.id, f.owner.principalId, {
      channel: 'telegram',
      proof: { mode: 'LOCAL_FIXTURE' },
    });
    await links.complete(f.w.id, f.owner.principalId, {
      challengeId: request.challenge.challengeId,
      channelCode: code,
      signature: await f.owner.a.signTypedData(
        channelLinkTypedData(request.challenge),
      ),
    });
    await links.bind(f.w.id, f.owner.principalId, { kind: 'DIRECT' });
    const p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    await f.executor.execute(p.data.id);
    const notifications = new WorkspaceNotifications(
      links,
      f.payouts,
      'LOCAL_FIXTURE',
    );
    await notifications.queue.migrate();
    let attempts = 0;
    const adapter = {
      channel: 'telegram' as const,
      send: async (
        chatId: string,
        message: import('@synq/channels').OutboundMessage,
      ) => {
        attempts++;
        expect(chatId).toBe('90001');
        expect(message.card?.type).toBe('CONTRACTOR_PAYMENT');
        expect(message.text).toContain('0.05 USDC');
        throw new Error('ambiguous provider timeout');
      },
    };
    await notifications.pump(adapter);
    await notifications.pump(adapter);
    expect(attempts).toBe(1);
    expect((await notifications.queue.status(f.w.id))[0]?.state).toBe(
      'UNKNOWN',
    );
    expect(
      (await f.payouts.view(f.w.id, f.owner.principalId, p.data.id)).state,
    ).toBe('PAID');
    expect(
      (
        await pool.query(
          'SELECT 1 FROM synq_ledger_entries WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM synq_event_outbox WHERE payload->>'payoutId'=$1",
          [p.data.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('requires separate mandate and current owner quorum; repeated requests reserve one obligation', async () => {
    const f = await payoutFixture(),
      obligation = randomUUID(),
      key = randomUUID();
    const p = await f.propose(obligation, key);
    expect((await f.propose(obligation, key)).data.id).toBe(p.data.id);
    await expect(f.propose(obligation)).rejects.toMatchObject({
      code: 'OBLIGATION_ALREADY_PROPOSED',
    });
    await expect(f.executor.execute(p.data.id)).rejects.toMatchObject({
      code: 'PAYOUT_NOT_READY',
    });
    expect((await f.approvePayout(p)).state).toBe('REVIEW');
    expect((await f.approvePayout(p, f.coowner)).state).toBe('READY');
    const result = await f.executor.execute(p.data.id);
    expect(result).toHaveProperty('record.state', 'CONFIRMED');
    expect(f.signed()).toBe(1);
    expect(f.fake.paid).toHaveLength(1);
    expect(
      (await f.payouts.view(f.w.id, f.owner.principalId, p.data.id)).state,
    ).toBe('PAID');
  });
  it('atomically admits grant, approval nonce, obligation and signed bytes; crash recovers without signing again', async () => {
    const f = await payoutFixture(),
      p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    await expect(
      f.executor.execute(p.data.id, async () => {
        throw new Error('crash before broadcast');
      }),
    ).rejects.toThrow('crash before broadcast');
    expect(f.fake.broadcasts).toHaveLength(0);
    const recorded = await f.executor.outbox.get(
      `workspace-payout:${p.data.id}`,
    );
    expect(recorded?.state).toBe('SIGNED');
    for (const table of [
      'synq_consumed_grants',
      'synq_finance_approval_nonces',
      'synq_finance_obligations',
    ])
      expect(
        (await pool.query(`SELECT 1 FROM ${table}`)).rowCount,
      ).toBeGreaterThan(0);
    await f.restart().execute(p.data.id);
    expect(f.signed()).toBe(1);
    expect(f.fake.paid).toHaveLength(1);
    expect(
      (await f.executor.outbox.get(`workspace-payout:${p.data.id}`))?.hash,
    ).toBe(recorded?.hash);
  });
  it('fails closed on unavailable screening and persists a risk case and audit after restart', async () => {
    const f = await payoutFixture(false),
      p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    expect(await f.executor.execute(p.data.id)).toMatchObject({
      state: 'HOLD',
      reason: 'SCREENING_UNAVAILABLE',
    });
    expect(f.signed()).toBe(0);
    expect(f.fake.broadcasts).toHaveLength(0);
    expect(
      (await f.restart().risk.store.activeCase(f.w.id, `vendor:${f.vendorId}`))
        ?.status,
    ).toBe('HELD');
    expect((await f.executor.risk.store.audit(f.w.id)).length).toBeGreaterThan(
      0,
    );
  });
  it('refuses a previously approved payout after a signed address change', async () => {
    const f = await payoutFixture(),
      p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    const changed = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'VENDOR',
      vendorId: f.vendorId,
      name: 'Verified supplier',
      address: account().address,
      verification: 'OWNER_ATTESTATION',
    });
    await f.approve(changed);
    await f.approve(changed, f.coowner);
    expect(await f.executor.execute(p.data.id)).toMatchObject({
      state: 'HOLD',
      reason: 'PAYOUT_ADDRESS_CHANGED',
    });
    expect(f.signed()).toBe(0);
    expect(f.fake.paid).toHaveLength(0);
  });
  it('serializes two workers and recovers a mined receipt timeout with the original hash', async () => {
    const f = await payoutFixture(),
      p = await f.propose();
    await f.approvePayout(p);
    await f.approvePayout(p, f.coowner);
    f.fake.fail.wait = 1;
    const results = await Promise.allSettled([
      f.executor.execute(p.data.id),
      f.restart().execute(p.data.id),
    ]);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(f.signed()).toBe(1);
    expect(f.fake.paid).toHaveLength(1);
    expect(
      (await f.payouts.view(f.w.id, f.owner.principalId, p.data.id)).state,
    ).toBe('PAID');
  });
});

async function governanceFixture() {
  const f = await payoutFixture(),
    operator = account();
  let signed = 0;
  const fake = fakeGovernanceChain({
    safe: f.authority.vault,
    policy: f.authority.policy,
    owners: f.authority.owners.slice(),
    threshold: 2,
    now: f.store.now,
    delay: 3600,
  });
  const service = new WorkspaceGovernance(f.finance);
  const signer = {
    address: operator.address,
    signTransaction: async (
      tx: Parameters<typeof operator.signTransaction>[0],
    ) => {
      signed++;
      return operator.signTransaction(tx);
    },
  };
  const config = {
    operator: 'governance-test',
    grantKey: new Uint8Array(32).fill(9),
    grantTtlSeconds: 60,
    riskRequiredAbove: 0n,
  };
  const executor = new WorkspaceGovernanceExecutor(
    f.finance,
    fake.chain,
    signer,
    config,
  );
  const propose = (kind: 'QUEUE_VENDOR' | 'ALLOW_VENDOR' | 'REMOVE_VENDOR') =>
    service.propose(f.w.id, f.owner.principalId, {
      kind,
      vendorId: f.vendorId,
    });
  const approve = async (
    p: Awaited<ReturnType<typeof propose>>,
    actor = f.owner,
  ) =>
    service.approve(f.w.id, actor.principalId, p.action.id, {
      approvalSignature: await actor.a.signTypedData(
        safeActionApprovalTypedData(p.action),
      ),
      safeSignature: await actor.a.signTypedData(safeActionTypedData(p.action)),
    });
  return {
    ...f,
    gov: service,
    govExecutor: executor,
    govFake: fake,
    proposeAction: propose,
    approveAction: approve,
    govSigned: () => signed,
    restartGov: () =>
      new WorkspaceGovernanceExecutor(f.finance, fake.chain, signer, config),
  };
}
describe('G5 governed vendor allowlist — LOCAL_FIXTURE with Postgres and signed EVM bytes', () => {
  it('queues with the Safe quorum, refuses an early addition, then permits a fresh signed addition after the delay', async () => {
    const f = await governanceFixture(),
      q = await f.proposeAction('QUEUE_VENDOR');
    expect((await f.approveAction(q)).state).toBe('REVIEW');
    await expect(f.govExecutor.execute(q.action.id)).rejects.toMatchObject({
      code: 'ACTION_NOT_READY',
    });
    expect((await f.approveAction(q, f.coowner)).state).toBe('READY');
    const queued = await f.govExecutor.execute(q.action.id);
    expect(queued.state).toBe('CONFIRMED');
    expect(queued).toHaveProperty(
      'evidence.readyAt',
      String(f.store.now() + 3600),
    );
    expect(f.govFake.allowed.has(f.payee.address.toLowerCase())).toBe(false);
    f.authority.nonce = f.govFake.safeNonce;
    const early = await f.proposeAction('ALLOW_VENDOR');
    await f.approveAction(early);
    await f.approveAction(early, f.coowner);
    await expect(f.govExecutor.execute(early.action.id)).rejects.toMatchObject({
      code: 'KERNEL_ACTION_DENIED',
    });
    expect(f.govSigned()).toBe(1);
    expect(f.govFake.broadcasts).toHaveLength(1);
    f.advance(3600);
    const ready = await f.proposeAction('ALLOW_VENDOR');
    await f.approveAction(ready);
    await f.approveAction(ready, f.coowner);
    expect((await f.govExecutor.execute(ready.action.id)).state).toBe(
      'CONFIRMED',
    );
    expect(f.govFake.allowed.has(f.payee.address.toLowerCase())).toBe(true);
    f.authority.nonce = f.govFake.safeNonce;
    const remove = await f.proposeAction('REMOVE_VENDOR');
    await f.approveAction(remove);
    await f.approveAction(remove, f.coowner);
    expect((await f.govExecutor.execute(remove.action.id)).state).toBe(
      'CONFIRMED',
    );
    expect(f.govFake.allowed.has(f.payee.address.toLowerCase())).toBe(false);
  });
  it('recovers the recorded Safe transaction after a crash without another signature or queue operation', async () => {
    const f = await governanceFixture(),
      q = await f.proposeAction('QUEUE_VENDOR');
    await f.approveAction(q);
    await f.approveAction(q, f.coowner);
    await expect(
      f.govExecutor.execute(q.action.id, async () => {
        throw new Error('worker disconnected');
      }),
    ).rejects.toThrow('worker disconnected');
    const before = await f.govExecutor.outbox.get(
      `workspace-action:${q.action.id}`,
    );
    expect(before?.state).toBe('SIGNED');
    expect(f.govFake.broadcasts).toHaveLength(0);
    expect((await f.restartGov().execute(q.action.id)).state).toBe('CONFIRMED');
    expect((await f.restartGov().execute(q.action.id)).state).toBe('CONFIRMED');
    expect(f.govSigned()).toBe(1);
    expect(f.govFake.broadcasts).toHaveLength(1);
    expect(
      (await f.govExecutor.outbox.get(`workspace-action:${q.action.id}`))?.hash,
    ).toBe(before?.hash);
  });
});
