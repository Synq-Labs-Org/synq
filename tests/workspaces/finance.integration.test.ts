import { WorkspaceTeamReplySchema } from '@synq/workspaces/team-contracts';
import { WorkspaceTeam } from '@synq/workspaces/team';
import { dealRoutes } from '../../apps/api/src/deal-routes.js';
import { WorkspaceDeals } from '@synq/workspaces/deals';
import { DealRoomService, PostgresDealRoomStore } from '@synq/dealroom';
import { readFileSync } from 'node:fs';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  toHex,
  type Address,
  type PublicClient,
} from 'viem';
import { contract } from '@synq/chain-registry/arc';
import {
  InvoiceService,
  PostgresInvoiceStore,
  payCall,
  MEMO_ABI,
} from '@synq/invoices';
import { issueTypedData } from '@synq/invoices/invoice-data';
import { WorkspaceInvoices } from '@synq/workspaces/invoices';
import { WorkspaceReceipts } from '@synq/workspaces/receipts';
import { WorkspaceSplitWorker } from '@synq/execution-worker/workspace-splits';
import {
  viemIndexerChain,
  Ledger,
  PostgresLedgerStore,
  walletTag,
} from '@synq/ledger';
import { allocationCard } from '@synq/allocations';
import { renderTelegramCard } from '@synq/channels';
import { WorkspaceRevenue } from '@synq/workspaces/revenue';
import {
  RevenuePolicyWireSchema,
  revenueRevocationTypedData,
} from '@synq/workspaces/revenue-contracts';
import {
  policyTypedData,
  mandateFromPolicy,
} from '@synq/allocations/policy-data';
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
import {
  OfacSdnScreening,
  sdnSnapshotFromText,
  type SdnSnapshot,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
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

async function payoutFixture(
  clear = true,
  aiDaily = '0',
  screeningFor?: (payee: Address) => WalletScreeningPort,
) {
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
      aiDaily,
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
  const port = screeningFor
    ? screeningFor(payee.address)
    : clear
      ? screening
      : undefined;
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
    port,
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
    chain,
    signer,
    screening,
    kernelAuthority: authority,
    vendorId,
    payee,
    executor,
    payouts,
    propose,
    approvePayout: approve,
    fake,
    signed: () => signed,
    restart: () =>
      new WorkspacePayoutExecutor(f.finance, chain, signer, authority, port),
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
  it('G11 refuses a payout to an OFAC SDN-listed vendor before signing, and pays an unlisted one', async () => {
    const now = 2_000_000_000;
    const sdn = (listed: Address) => {
      const filler = Array.from(
        { length: 24 },
        (_, i) =>
          `Digital Currency Address - ETH 0x${(i + 1).toString(16).padStart(40, '0')};`,
      );
      const snap = sdnSnapshotFromText(
        [...filler, `Digital Currency Address - USDC ${listed};`].join('\n'),
        { fetchedAt: now - 60, publishedOn: '2026-10-15', source: 'test' },
      );
      let saved: SdnSnapshot | null = snap;
      const port = new OfacSdnScreening(
        { latest: async () => saved, save: async (x) => void (saved = x) },
        () => now,
        async () => {
          throw new Error('offline');
        },
      );
      ports.push(port);
      return port;
    };
    const ports: OfacSdnScreening[] = [];
    const hit = await payoutFixture(true, '0', (payee) => sdn(payee));
    await ports[0]!.load();
    expect(ports[0]!.status().status).toBe('AVAILABLE');
    const p = await hit.propose();
    await hit.approvePayout(p);
    await hit.approvePayout(p, hit.coowner);
    expect(await hit.executor.execute(p.data.id)).toMatchObject({
      state: 'HOLD',
      reason: 'SCREENING_HIT',
    });
    expect(hit.signed()).toBe(0);
    expect(hit.fake.broadcasts).toHaveLength(0);
    const clear = await payoutFixture(true, '0', () =>
      sdn('0x00000000000000000000000000000000000000ff'),
    );
    await ports[1]!.load();
    const q = await clear.propose();
    await clear.approvePayout(q);
    await clear.approvePayout(q, clear.coowner);
    expect(await clear.executor.execute(q.data.id)).toHaveProperty(
      'record.state',
      'CONFIRMED',
    );
    expect(clear.signed()).toBe(1);
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
  it('G5 changes exact on-chain caps only after queue, delay and a fresh current Safe quorum', async () => {
    const f = await governanceFixture();
    const propose = (
      kind: 'QUEUE_CAPS' | 'SET_CAPS',
      perPaymentCap = '60000',
    ) =>
      f.gov.propose(f.w.id, f.owner.principalId, {
        kind,
        perPaymentCap,
        windowCap: '200000',
      });
    const queue = await propose('QUEUE_CAPS');
    expect((await propose('QUEUE_CAPS')).action.id).toBe(queue.action.id);
    await f.approveAction(queue);
    await expect(f.govExecutor.execute(queue.action.id)).rejects.toMatchObject({
      code: 'ACTION_NOT_READY',
    });
    await f.approveAction(queue, f.coowner);
    expect((await f.govExecutor.execute(queue.action.id)).state).toBe(
      'CONFIRMED',
    );
    expect(f.govFake.caps.perPaymentCap).toBe(5000000n);
    f.authority.nonce = f.govFake.safeNonce;
    const early = await propose('SET_CAPS');
    await f.approveAction(early);
    await f.approveAction(early, f.coowner);
    await expect(f.govExecutor.execute(early.action.id)).rejects.toMatchObject({
      code: 'KERNEL_ACTION_DENIED',
    });
    expect(f.govSigned()).toBe(1);
    f.advance(3600);
    const changed = await propose('SET_CAPS', '70000');
    await f.approveAction(changed);
    await f.approveAction(changed, f.coowner);
    await expect(
      f.govExecutor.execute(changed.action.id),
    ).rejects.toMatchObject({ code: 'KERNEL_ACTION_DENIED' });
    const ready = await propose('SET_CAPS');
    await f.approveAction(ready);
    await f.approveAction(ready, f.coowner);
    expect((await f.govExecutor.execute(ready.action.id)).state).toBe(
      'CONFIRMED',
    );
    expect(f.govFake.caps).toEqual({
      perPaymentCap: 60000n,
      windowCap: 200000n,
    });
    expect(f.govSigned()).toBe(2);
    await expect(
      f.gov.propose(f.w.id, f.outsider.principalId, {
        kind: 'QUEUE_CAPS',
        perPaymentCap: '1',
        windowCap: '2',
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    await expect(propose('QUEUE_CAPS', '200001')).rejects.toThrow();
  });

  it('G5 recovers an already recorded cap queue after authority drift without resigning', async () => {
    const f = await governanceFixture();
    const q = await f.gov.propose(f.w.id, f.owner.principalId, {
      kind: 'QUEUE_CAPS',
      perPaymentCap: '0',
      windowCap: '0',
    });
    await f.approveAction(q);
    await f.approveAction(q, f.coowner);
    await expect(
      f.govExecutor.execute(q.action.id, async () => {
        throw new Error('disconnected after record');
      }),
    ).rejects.toThrow('disconnected after record');
    const before = await f.govExecutor.outbox.get(
      `workspace-action:${q.action.id}`,
    );
    f.setAuthority({ ...f.authority, owners: [f.outsider.a.address] });
    expect((await f.restartGov().execute(q.action.id)).state).toBe('CONFIRMED');
    expect((await f.restartGov().execute(q.action.id)).state).toBe('CONFIRMED');
    expect(f.govSigned()).toBe(1);
    expect(f.govFake.broadcasts).toHaveLength(1);
    expect(
      (await f.govExecutor.outbox.get(`workspace-action:${q.action.id}`))?.hash,
    ).toBe(before?.hash);
  });
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

describe('G5/G6 workspace revenue policies — LOCAL_FIXTURE with Postgres', () => {
  it('requires the current Safe quorum on both the policy and its exact mandate, persists and revokes', async () => {
    const f = await fixture(),
      revenue = new WorkspaceRevenue(f.finance);
    const budget = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'BUDGET',
      perPayment: '50000',
      daily: '200000',
      aiDaily: '100000',
      reserve: '10000',
    });
    await f.approve(budget);
    await f.approve(budget, f.coowner);
    const vendorId = randomUUID();
    const vendor = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'VENDOR',
      vendorId,
      name: 'Policy supplier',
      address: account().address,
      verification: 'OWNER_ATTESTATION',
    });
    await f.approve(vendor);
    await f.approve(vendor, f.coowner);
    const draft = await revenue.propose(f.w.id, f.owner.principalId, {
      taxReserveBps: 1000,
      operatingFloor: '10000',
      obligationHorizonDays: 7,
      vendorIds: [vendorId],
      distributions: [],
      validForSeconds: 3600,
      limits: {
        maxAutonomousPerLeg: '50000',
        maxAutonomousPerWindow: '100000',
        windowSeconds: 86400,
        maxSplitsPerWindow: 10,
      },
    });
    const policy = RevenuePolicyWireSchema.parse(draft.policy);
    const pair = async (who: typeof f.owner) => ({
      policy: await who.a.signTypedData(policyTypedData(policy)),
      mandate: await who.a.signTypedData(
        mandateTypedData(mandateFromPolicy(policy)),
      ),
    });
    await expect(
      revenue.approve(
        f.w.id,
        f.outsider.principalId,
        draft.id,
        await pair(f.outsider),
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    expect(
      (
        await revenue.approve(
          f.w.id,
          f.owner.principalId,
          draft.id,
          await pair(f.owner),
        )
      ).state,
    ).toBe('REVIEW');
    expect(await revenue.active(f.w.id)).toBeNull();
    expect(
      (
        await revenue.approve(
          f.w.id,
          f.coowner.principalId,
          draft.id,
          await pair(f.coowner),
        )
      ).state,
    ).toBe('ACTIVE');
    expect(
      (await new WorkspaceRevenue(f.finance).active(f.w.id))?.signed.policy
        .version,
    ).toBe(1);
    await expect(
      revenue.revoke(
        f.w.id,
        f.owner.principalId,
        draft.id,
        await f.outsider.a.signTypedData(revenueRevocationTypedData(policy)),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REVENUE_SIGNATURE' });
    expect(
      (
        await revenue.revoke(
          f.w.id,
          f.owner.principalId,
          draft.id,
          await f.owner.a.signTypedData(revenueRevocationTypedData(policy)),
        )
      ).state,
    ).toBe('ACTIVE');
    expect(
      (
        await revenue.revoke(
          f.w.id,
          f.coowner.principalId,
          draft.id,
          await f.coowner.a.signTypedData(revenueRevocationTypedData(policy)),
        )
      ).state,
    ).toBe('REVOKED');
    expect(await revenue.active(f.w.id)).toBeNull();
  });
  it('refuses an unsigned policy outside the workspace AI budget', async () => {
    const f = await fixture(),
      revenue = new WorkspaceRevenue(f.finance);
    const vendorId = randomUUID();
    const vendor = await f.finance.propose(f.w.id, f.owner.principalId, {
      kind: 'VENDOR',
      vendorId,
      name: 'Policy supplier',
      address: account().address,
      verification: 'OWNER_ATTESTATION',
    });
    await f.approve(vendor);
    await f.approve(vendor, f.coowner);
    await expect(
      revenue.propose(f.w.id, f.owner.principalId, {
        taxReserveBps: 0,
        operatingFloor: '0',
        obligationHorizonDays: 7,
        vendorIds: [vendorId],
        distributions: [],
        validForSeconds: 3600,
        limits: {
          maxAutonomousPerLeg: '50000',
          maxAutonomousPerWindow: '100000',
          windowSeconds: 86400,
          maxSplitsPerWindow: 10,
        },
      }),
    ).rejects.toMatchObject({ code: 'REVENUE_OUTSIDE_WORKSPACE_BUDGET' });
  });
});

async function splitFixture(clear = true, booksAvailable = true) {
  const f = await payoutFixture(true, '100000');
  const revenue = new WorkspaceRevenue(f.finance),
    usdc = token('arc-testnet', 'USDC');
  const draft = await revenue.propose(f.w.id, f.owner.principalId, {
    taxReserveBps: 0,
    operatingFloor: '10000',
    obligationHorizonDays: 7,
    vendorIds: [f.vendorId],
    distributions: [
      {
        kind: 'PERCENT_OF_SURPLUS',
        label: 'Supplier share',
        beneficiaryId: f.vendorId,
        bps: 10000,
      },
    ],
    validForSeconds: 3600,
    limits: {
      maxAutonomousPerLeg: '50000',
      maxAutonomousPerWindow: '100000',
      windowSeconds: 86400,
      maxSplitsPerWindow: 10,
    },
  });
  const policy = RevenuePolicyWireSchema.parse(draft.policy);
  for (const actor of [f.owner, f.coowner])
    await revenue.approve(f.w.id, actor.principalId, draft.id, {
      policy: await actor.a.signTypedData(policyTypedData(policy)),
      mandate: await actor.a.signTypedData(
        mandateTypedData(mandateFromPolicy(policy)),
      ),
    });
  const ledger = new Ledger(new PostgresLedgerStore(pool)),
    service = new InvoiceService(
      new PostgresInvoiceStore(pool),
      ledger,
      f.store.now,
    );
  const invoices = new WorkspaceInvoices(f.finance, service, () => null);
  const invoiceDraft = await invoices.create(f.w.id, f.owner.principalId, {
    number: randomUUID(),
    payerName: 'Outside payer',
    dueDate: '2033-05-20',
    lineItems: [
      { description: 'Accepted work', quantity: 1, unitPrice: '50000' },
    ],
  });
  const invoice = (await service.store.get(invoiceDraft.invoiceId))!.invoice;
  await invoices.issue(
    f.w.id,
    f.owner.principalId,
    invoice.invoiceId,
    await f.owner.a.signTypedData(issueTypedData(invoice)),
  );
  const issued = (await service.store.get(invoice.invoiceId))!.invoice,
    call = payCall(issued, 50000n);
  const hash = keccak256(toHex(randomUUID())),
    blockHash = keccak256(toHex('incoming-final-block'));
  const memo = contract('arc-testnet', 'MEMO');
  const base = {
    blockNumber: 1000n,
    blockHash,
    transactionHash: hash,
    transactionIndex: 0,
    removed: false,
  };
  const logs = [
    {
      ...base,
      address: usdc.address,
      logIndex: 0,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: f.outsider.a.address, to: f.authority.vault },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [50000n]),
    },
    {
      ...base,
      address: memo.address,
      logIndex: 1,
      topics: encodeEventTopics({
        abi: MEMO_ABI,
        eventName: 'Memo',
        args: {
          sender: f.outsider.a.address,
          target: usdc.address,
          memoId: issued.paymentRef!,
        },
      }),
      data: encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'uint256' }],
        [keccak256(call.data), call.memoData, 0n],
      ),
    },
  ];
  const memoCode = (
    JSON.parse(
      readFileSync(
        new URL('./fixtures/memo-code.json', import.meta.url),
        'utf8',
      ),
    ) as string[]
  ).join('') as Hex;
  const client = {
    ...f.chain.client,
    getCode: async (q: { address: Hex }) =>
      q.address.toLowerCase() === memo.address.toLowerCase()
        ? memoCode
        : f.chain.client.getCode(q),
    getBlock: async (q: { blockNumber?: bigint }) => ({
      number: q.blockNumber ?? 3000n,
      hash: q.blockNumber === 1000n ? blockHash : `0x${'bb'.repeat(32)}`,
      timestamp: BigInt(f.store.now()),
    }),
    getTransactionReceipt: async (q: { hash: Hex }) =>
      q.hash === hash
        ? {
            status: 'success',
            blockNumber: 1000n,
            blockHash,
            logs,
            from: f.outsider.a.address,
            gasUsed: 1n,
            effectiveGasPrice: 1n,
          }
        : f.chain.client.getTransactionReceipt(q),
    readContract: async (q: { functionName: string }) =>
      q.functionName === 'balanceOf'
        ? 50000n - f.fake.paid.reduce((a, p) => a + p.amount, 0n)
        : f.chain.client.readContract(q as never),
  } as unknown as PublicClient;
  const chain = { ...f.chain, client };
  const receipts = new WorkspaceReceipts(f.finance, service, ledger);
  const receiptId = `chain:5042002:${hash}:0`;
  await receipts.apply(f.w.id, viemIndexerChain(client), {
    chainId: 5042002,
    kind: 'TRANSFER',
    emitter: usdc.address,
    blockNumber: 1000n,
    blockHash,
    txHash: hash,
    logIndex: 0,
    removed: false,
    data: { from: f.outsider.a.address, to: f.authority.vault, value: '50000' },
  });
  const worker = new WorkspaceSplitWorker(
    f.finance,
    chain,
    f.signer,
    f.kernelAuthority,
    clear ? f.screening : undefined,
    booksAvailable
      ? () => ({
          payables: async () => [],
          payableHistory: async () => [],
          obligations: async () => [],
          bills: async () => [],
        })
      : undefined,
  );
  await worker.migrate();
  return {
    ...f,
    revenue,
    policy,
    policyId: draft.id,
    worker,
    receiptId,
    ledger,
  };
}
describe('G6 indexer-driven workspace waterfall — LOCAL_FIXTURE with durable Postgres', () => {
  it('refuses to treat missing payable/bill sources as empty books before planning any distribution', async () => {
    const f = await splitFixture(true, false);
    await expect(f.worker.process(f.w.id, f.receiptId)).rejects.toMatchObject({
      code: 'WORKSPACE_OBLIGATION_BOOKS_UNAVAILABLE',
    });
    expect(f.signed()).toBe(0);
    expect(f.fake.paid).toHaveLength(0);
    const pending = await f.worker.store.byReceipt(f.receiptId);
    expect(pending).toMatchObject({ state: 'RECEIPT_FINAL', plan: null });
    expect(await f.worker.store.legs(pending!.splitId)).toHaveLength(0);
  });
  it('executes a quorum-signed distribution once and retains the workspace floor', async () => {
    const f = await splitFixture();
    await f.worker.pump();
    expect((await f.worker.store.byReceipt(f.receiptId))?.state).toBe(
      'COMPLETED',
    );
    expect(f.fake.paid.map((p) => p.amount)).toEqual([40000n]);
    const vaultCash = (await f.ledger.store.entries(f.w.id))
      .flatMap((e) => e.postings)
      .filter(
        (p) =>
          p.account === 'CASH_ARC_USDC' &&
          p.counterpartyId === walletTag(f.authority.vault),
      )
      .reduce((sum, p) => sum + p.amount, 0n);
    expect(vaultCash).toBe(10000n);
    const split = (await f.worker.store.byReceipt(f.receiptId))!;
    const card = allocationCard(
      {
        split,
        legs: await f.worker.store.legs(split.splitId),
        reservations: await f.worker.store.reservations(
          `5042002:${f.policy.token.toLowerCase()}:${f.policy.treasury.toLowerCase()}`,
        ),
        receiptReview: false,
      },
      {
        groupId: f.w.id,
        groupLabel: 'Workspace',
        issuedAt: f.store.now(),
        executionMode: 'LOCAL_FIXTURE',
      },
    );
    expect(card).toMatchObject({
      status: 'COMPLETED',
      paid: { amount: '0.04' },
      held: { amount: '0.01' },
    });
    expect(renderTelegramCard(card).text).toContain('0.04 USDC');
    expect(
      await f.revenue.allocations(f.w.id, f.owner.principalId),
    ).toHaveLength(1);
    await expect(
      f.revenue.allocations(f.w.id, f.outsider.principalId),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    await f.worker.process(f.w.id, f.receiptId);
    expect(f.signed()).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT state FROM synq_ws_split_admissions WHERE workspace_id=$1',
          [f.w.id],
        )
      ).rows,
    ).toEqual([{ state: 'CONFIRMED' }]);
  });
  it('fails closed before signing when live screening is unavailable', async () => {
    const f = await splitFixture(false);
    const split = await f.worker.process(f.w.id, f.receiptId);
    expect(split?.state).toBe('NEEDS_REVIEW');
    expect(f.signed()).toBe(0);
    expect(f.fake.paid).toHaveLength(0);
  });
  it('recovers and books the same signed distribution after timeout without obligation readers even if policy and owners changed', async () => {
    const f = await splitFixture();
    f.fake.fail.wait = 1;
    expect((await f.worker.process(f.w.id, f.receiptId))?.state).toBe('FAILED');
    for (const actor of [f.owner, f.coowner])
      await f.revenue.revoke(
        f.w.id,
        actor.principalId,
        f.policyId,
        await actor.a.signTypedData(revenueRevocationTypedData(f.policy)),
      );
    f.setAuthority({ ...f.authority, owners: [f.outsider.a.address] });
    const restarted = new WorkspaceSplitWorker(
      f.finance,
      f.worker.chain,
      f.signer,
      f.kernelAuthority,
      f.screening,
    );
    expect((await restarted.process(f.w.id, f.receiptId))?.state).toBe(
      'COMPLETED',
    );
    expect(f.signed()).toBe(1);
    expect(f.fake.paid).toHaveLength(1);
    const entries = await f.ledger.store.entries(f.w.id);
    expect(
      entries
        .flatMap((e) => e.postings)
        .filter(
          (p) =>
            p.account === 'CASH_ARC_USDC' &&
            p.counterpartyId === walletTag(f.authority.vault),
        )
        .reduce((sum, p) => sum + p.amount, 0n),
    ).toBe(10000n);
    await restarted.process(f.w.id, f.receiptId);
    expect(await f.ledger.store.entries(f.w.id)).toHaveLength(entries.length);
    expect(f.signed()).toBe(1);
  });
  it('G6/G11 rechecks a persistent vendor hold after grant issuance and before any signature', async () => {
    const f = await splitFixture();
    expect(
      (
        await f.worker.process(f.w.id, f.receiptId, {
          stopAt: 'SPLIT_AUTHORIZED',
        })
      )?.state,
    ).toBe('SPLIT_AUTHORIZED');
    await f.worker.risk.raise({
      workspaceId: f.w.id,
      alertKey: 'fresh-vendor-hold',
      subjectRef: `vendor:${f.vendorId}`,
      counterparty: `vendor:${f.vendorId}`,
      flags: [
        {
          code: 'PAYOUT_ADDRESS_CHANGED',
          severity: 'HARD',
          detail: 'Fixture independent hold after grant',
        },
      ],
      raisedBy: 'fixture',
      at: f.store.now(),
    });
    expect((await f.worker.process(f.w.id, f.receiptId))?.state).toBe('FAILED');
    expect(f.signed()).toBe(0);
    expect(f.fake.paid).toHaveLength(0);
  });
  it('G4/G6 shares daily budget and reservations between manual payouts and automatic transfers', async () => {
    const f = await payoutFixture();
    const draft = await f.propose();
    await f.approvePayout(draft);
    await f.approvePayout(draft, f.coowner);
    await pool.query(
      "INSERT INTO synq_ws_split_admissions(leg_key,workspace_id,amount,admitted_at,state) VALUES($1,$2,60000,$3,'SIGNED')",
      [randomUUID(), f.w.id, f.store.now()],
    );
    expect(await f.executor.execute(draft.data.id)).toMatchObject({
      state: 'HOLD',
      reason: 'DAILY_BUDGET_EXHAUSTED',
    });
    expect(f.signed()).toBe(0);
  });
});

describe('G7 workspace-selected deal parties — LOCAL_FIXTURE with Postgres', () => {
  it('selects distinct linked members and arbiter, isolates reads and requires each contracting wallet signature', async () => {
    const f = await fixture(),
      usdc = token('arc-testnet', 'USDC');
    const invite = await f.store.invite(f.w.id, f.owner.principalId, {
      role: 'MEMBER',
    });
    await f.store.accept(f.outsider.principalId, invite.token);
    const store = new PostgresDealRoomStore(pool);
    await store.migrate();
    const service = new DealRoomService(store, {
      now: f.store.now,
      chainName: 'arc-testnet',
      asset: {
        chainId: usdc.chainId,
        network: usdc.network,
        token: usdc.address,
        symbol: 'USDC',
        decimals: 6,
      },
      books: null,
      escrow: contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address,
      settings: {
        disputePeriodSeconds: 86400,
        refundGraceSeconds: 7 * 86400,
        offerTtlSeconds: 3 * 86400,
      },
    });
    const deals = new WorkspaceDeals(
      f.store,
      service,
      new Uint8Array(32).fill(9),
    );
    const input = {
      clientId: f.outsider.principalId,
      freelancerId: f.coowner.principalId,
      arbiterId: f.owner.principalId,
      request:
        'Build a project. 0.05 USDC total. 0.05 USDC when accepted delivery within 7 days.',
      idempotencyKey: randomUUID(),
    };
    const draft = await deals.draft(f.w.id, f.outsider.principalId, input);
    expect(draft.parties.find((p) => p.role === 'CLIENT')?.wallet).toBe(
      f.outsider.a.address,
    );
    expect(draft.parties.find((p) => p.role === 'ARBITER')?.wallet).toBe(
      f.owner.a.address,
    );
    expect(draft.execution).toBe('BLOCKED_WORKSPACE_ESCROW_EXECUTOR');
    const raceKey = randomUUID();
    const race = await Promise.allSettled([
      deals.draft(f.w.id, f.outsider.principalId, {
        ...input,
        idempotencyKey: raceKey,
      }),
      deals.draft(f.w.id, f.outsider.principalId, {
        ...input,
        request: input.request.replace('project', 'different project'),
        idempotencyKey: raceKey,
      }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const publicApp = Fastify();
    await publicApp.register(dealRoutes, {
      service,
      linkKey: new Uint8Array(32).fill(9),
      now: f.store.now,
    });
    try {
      expect(
        (
          await publicApp.inject({
            url: `/v1/deals/${draft.id}?${draft.reviewPath.split('?')[1]}`,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await publicApp.close();
    }

    expect((await deals.draft(f.w.id, f.outsider.principalId, input)).id).toBe(
      draft.id,
    );
    await expect(
      deals.draft(f.w.id, f.owner.principalId, {
        ...input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONTRACTING_PARTY_REQUIRED' });
    await expect(
      deals.draft(f.w.id, f.outsider.principalId, {
        ...input,
        arbiterId: f.coowner.principalId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INDEPENDENT_ARBITER_REQUIRED' });
    const view = await service.view(draft.id),
      typed = service.typedData(view.current);
    await expect(
      deals.sign(
        f.w.id,
        f.outsider.principalId,
        draft.id,
        1,
        await f.owner.a.signTypedData(typed),
      ),
    ).rejects.toMatchObject({ code: 'WRONG_SIGNER' });
    await deals.sign(
      f.w.id,
      f.outsider.principalId,
      draft.id,
      1,
      await f.outsider.a.signTypedData(typed),
    );
    expect(
      (
        await deals.sign(
          f.w.id,
          f.coowner.principalId,
          draft.id,
          1,
          await f.coowner.a.signTypedData(typed),
        )
      ).status,
    ).toBe('ACCEPTED');
    const other = await fixture();
    await expect(
      deals.get(other.w.id, other.owner.principalId, draft.id),
    ).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
  });
});

describe('G10/G14 scoped workspace team — LOCAL_FIXTURE with Postgres', () => {
  it('isolates snapshots, refuses stale/missing balance proof and never reports missing AP as empty', async () => {
    const f = await payoutFixture(),
      other = await payoutFixture();
    const team = new WorkspaceTeam(
      f.finance,
      async () => ({
        amount: '100000',
        blockNumber: '1',
        observedAt: f.store.now(),
      }),
      [],
      undefined,
      f.payouts,
    );
    await team.migrate();
    await new PostgresDealRoomStore(pool).migrate();
    const privateDeal = `deal_${randomUUID()}`;
    const terms = {
      client: { principalId: f.coowner.principalId },
      freelancer: { principalId: f.outsider.principalId },
      arbiter: { principalId: other.owner.principalId },
    };
    await pool.query(
      "INSERT INTO synq_dealroom_deals(deal_id,workspace_id,status,current_version,rev,data,created_at,updated_at) VALUES($1,$2,'DRAFT',1,1,$3,0,0)",
      [privateDeal, f.w.id, {}],
    );
    await pool.query(
      'INSERT INTO synq_dealroom_versions(deal_id,version,terms_hash,proposed_by,data,created_at) VALUES($1,1,$2,$3,$4,0)',
      [privateDeal, randomUUID(), f.coowner.principalId, { terms }],
    );
    const data = await team.snapshot(f.w.id, f.owner.principalId);
    expect(data.deals).not.toContainEqual({ id: privateDeal, state: 'DRAFT' });
    expect(
      (await team.snapshot(f.w.id, f.coowner.principalId)).deals,
    ).toContainEqual({ id: privateDeal, state: 'DRAFT' });
    expect(data.world.identity.workspace.value?.workspaceId).toBe(f.w.id);
    expect(data.world.treasury.balances.meta.freshness).toBe('UNKNOWN');
    expect(data.world.obligations.payables.meta.freshness).toBe('UNKNOWN');
    expect(data.world.decision.decisionGrade).toBe(false);
    await expect(
      team.snapshot(f.w.id, other.owner.principalId),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    const reply = await team.ask(f.w.id, f.owner.principalId, {
      idempotencyKey: randomUUID(),
      message: 'What can the finance team do right now?',
    });
    expect(WorkspaceTeamReplySchema.parse(reply).answer.length).toBeGreaterThan(
      0,
    );
    expect(JSON.stringify(reply)).not.toMatch(
      /grantKey|mandateSignature|"mac"/,
    );
  });
  it('turns explicit team instructions into an immutable payout proposal that still needs owner signatures', async () => {
    const f = await payoutFixture();
    const team = new WorkspaceTeam(
      f.finance,
      async () => ({
        amount: '0',
        blockNumber: '1',
        observedAt: f.store.now(),
      }),
      [],
      undefined,
      f.payouts,
    );
    await team.migrate();
    const request = {
      idempotencyKey: randomUUID(),
      message: `pay Verified supplier 0.05 USDC for Accepted work ref ${randomUUID()}`,
    };
    const reply = await team.ask(f.w.id, f.owner.principalId, request);
    const retry = await team.ask(f.w.id, f.owner.principalId, request);
    expect('payoutId' in retry && retry.payoutId).toBe(
      'payoutId' in reply && reply.payoutId,
    );
    expect(WorkspaceTeamReplySchema.parse(reply).proposals).toBe(
      'PENDING_OWNER_SIGNATURE',
    );
    expect('payoutId' in reply && reply.payoutId).toBeTruthy();
    const proposals = await f.payouts.list(f.w.id, f.owner.principalId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.state).toBe('REVIEW');
    expect(f.signed()).toBe(0);
    await expect(
      team.ask(f.w.id, f.outsider.principalId, {
        idempotencyKey: randomUUID(),
        message:
          'pay Verified supplier 0.05 USDC for Accepted work ref private',
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
  });
});
