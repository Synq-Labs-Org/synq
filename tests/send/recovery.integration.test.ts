import { encodeFunctionData, erc20Abi } from 'viem';
import pg from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  Kernel,
  type AuthorizationDecision,
  type KernelSnapshot,
} from '@synq/kernel';
import {
  PostgresSendStore,
  type SendPreview,
  advanceSend,
  newSendRecord,
} from '@synq/funding';
import {
  sendConfirmationTypedData,
  sendAccessTypedData,
} from '@synq/identity/server';
import { PostgresSendAccessStore } from '../../apps/api/src/send-access-store.js';
import { createSendMemberAccess } from '../../apps/api/src/send-access.js';
import {
  sendRoutes,
  confirmationOf,
  type SendRouteDeps,
} from '../../apps/api/src/send-routes.js';
import {
  sandboxKernel,
  sandboxMandate,
  sandboxProposal,
  configureSandboxGroup,
  sandboxManifest,
  type SandboxGroup,
} from '../api/kernel-fixture.js';

const url =
  process.env.SYNQ_P08_RECOVERY_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_recovery_builder';
const pool = new pg.Pool({ connectionString: url, max: 4 });
const NOW = 1_800_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const owners = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
const group: SandboxGroup = {
  groupId: hash(701),
  chainGroupId: hash(701),
  account: address(702),
  executor: address(703),
  recipient: address(705),
  members: owners.map((o, i) => ({
    memberId: `member_${i}`,
    signer: o.address.toLowerCase() as `0x${string}`,
  })),
};
const ADMIN = 'testonly'.repeat(8);
const directory = {
  membershipEpoch: async () => 1,
  activeMember: async (_g: string, m: string) => {
    const member = group.members.find((x) => x.memberId === m);
    return member
      ? {
          ...member,
          groupId: group.groupId,
          principalId: `mera:${member.signer}`,
          principalKind: 'MERA_HUMAN' as const,
          role: 'APPROVER' as const,
          membershipEpoch: 1,
          ownerOfAccount: true,
        }
      : null;
  },
};
const approvalLedger = { isConsumed: async () => false };
const fresh = {
  probe: {
    observe: async () => ({
      chainId: 10143,
      headBlock: 100,
      indexedThroughBlock: 100,
      accountPaused: false,
      mandate: { active: true, version: 1, minValidVersion: 1 },
      owners: group.members.map((m) => m.signer),
      threshold: 2,
    }),
  },
  maxLagBlocks: 0,
};
function restore(snapshot: KernelSnapshot) {
  return Kernel.restore(snapshot, {
    clock: { now: () => NOW },
    approvalLedger,
    membershipDirectory: directory,
    freshness: fresh,
    plugins: [sandboxManifest],
    auditKey: new Uint8Array(32).fill(5),
  });
}
beforeAll(async () => {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_p08[a-z]?_[a-z0-9_]+$/.test(name))
    throw new Error('isolated P08 DB required');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  if (
    !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rows.length
  )
    await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await new PostgresSendStore(pool).migrate();
  await new PostgresSendAccessStore(pool).migrate();
  await pool.query('TRUNCATE synq_sends,synq_send_previews');
  await pool.query(
    'TRUNCATE synq_send_access_challenges,synq_send_access_sessions',
  );
});
afterAll(() => pool.end());

it('P08 access challenges and sessions survive restart, resist replacement, and issue only once', async () => {
  let clock = NOW;
  const context = async () => ({
    groupId: group.groupId,
    mandate: sandboxMandate(group, NOW),
    members: group.members.map((m) => ({
      ...m,
      principalId: `mera:${m.signer}`,
    })),
    contacts: [],
  });
  const access = () =>
    createSendMemberAccess({
      directory,
      context,
      now: () => clock,
      store: new PostgresSendAccessStore(pool),
    });
  const c = await access().challenge(
    group.groupId,
    `mera:${group.members[0]!.signer}`,
  );
  if (!c) throw new Error('challenge missing');
  expect(await access().challenge(group.groupId, c.principalId)).toEqual(c);
  const signature = await owners[0]!.signTypedData(sendAccessTypedData(c));
  const results = await Promise.all([
    access().issue(c.challengeId, signature),
    access().issue(c.challengeId, signature),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const session = results.find(Boolean)!;
  expect(await access().verify(session.token, group.groupId)).toBe(true);
  expect(await access().verify(session.token, hash(799))).toBe(false);
  expect(await access().issue(c.challengeId, signature)).toBeNull();
  const rows = await pool.query(
    'SELECT token_hash,data FROM synq_send_access_sessions',
  );
  expect(rows.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(rows.rows)).not.toContain(session.token);
  clock = session.expiresAt;
  expect(await access().verify(session.token, group.groupId)).toBe(false);
});

async function open(
  kernel: Kernel,
  store: PostgresSendStore,
  authorize: (r: unknown) => Promise<AuthorizationDecision>,
  registered: string[],
  extra: Partial<SendRouteDeps> = {},
) {
  const api = Fastify();
  const mandate = sandboxMandate(group, NOW);
  const deps: SendRouteDeps = {
    store,
    adminToken: ADMIN,
    now: () => NOW,
    groups: {
      context: async () => ({
        groupId: group.groupId,
        mandate,
        members: group.members.map((m) => ({
          ...m,
          principalId: `mera:${m.signer}`,
        })),
        contacts: [{ label: 'contact', address: group.recipient }],
      }),
    },
    members: {
      activeSigner: async (_g, m) =>
        group.members.find((x) => x.memberId === m)?.signer ?? null,
    },
    treasury: { view: async () => ({ core: { free: '1000000000' } }) as never },
    guard: {
      check: async ({ recipient, amount }) => ({
        status: 'PASS',
        chainId: 10143,
        token: mandate.inputAsset.address,
        account: mandate.account,
        recipient,
        amount: String(amount),
        blockNumber: '100',
        checks: [],
        reasons: [],
      }),
    },
    proposer: {
      propose: async ({ amount, nonce }) => ({
        ...sandboxProposal(kernel, group, { amount, nonce, now: NOW }),
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [group.recipient, amount],
        }),
      }),
    },
    kernel: {
      authorize,
      recover: async (proposal) => kernel.recoverAuthorization(proposal),
    },
    drafts: {
      register: async (draft) => {
        registered.push(draft.digest);
        return {};
      },
      verifiedApprovals: async () => ({ satisfied: false, counted: [] }),
    },
    index: {
      executed: async () => ({
        indexedThroughBlock: 0,
        transactionHash: null,
        tokenAmount: null,
        recipient: null,
      }),
    },
  };
  await api.register(sendRoutes, { ...deps, ...extra });
  await api.ready();
  return api;
}
async function makePreview(
  api: Awaited<ReturnType<typeof open>>,
  amount: string,
) {
  const p = await api.inject({
    method: 'POST',
    url: '/v1/send/previews',
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: {
      groupId: group.groupId,
      recipientId: `contact:${group.recipient}`,
      amount,
    },
  });
  expect(p.statusCode).toBe(201);
  return p.json() as SendPreview;
}
async function body(p: SendPreview) {
  return {
    previewId: p.previewId,
    digest: p.digest,
    recipientAddress: p.recipient.address,
    amount: p.amount,
    chainId: p.chainId,
    sender: {
      memberId: 'member_0',
      signature: await owners[0]!.signTypedData(
        sendConfirmationTypedData(confirmationOf({ preview: p }, 'member_0')),
      ),
    },
  };
}
function freshKernel() {
  const kernel = sandboxKernel({
    executionModule: address(704),
    now: () => NOW,
    approvalLedger,
    membershipDirectory: directory,
  });
  configureSandboxGroup(kernel, group, NOW);
  return kernel;
}

describe('Send confirmation recovery across API and database-store restart (SIMULATION)', () => {
  it('persists sender/proposal before lost Kernel response and recovers the same pending draft without reauthorization', async () => {
    const kernel = freshKernel();
    const a = new PostgresSendStore(pool);
    const registered: string[] = [];
    let calls = 0;
    let saved: KernelSnapshot | null = null;
    const api = await open(
      kernel,
      a,
      async (request) => {
        calls++;
        const records = await a.list(group.groupId);
        expect(records.at(-1)?.sender).not.toBeNull();
        expect(records.at(-1)?.proposal).not.toBeNull();
        const decision = await kernel.authorize(request);
        saved = kernel.snapshot();
        expect(decision.status).toBe('PENDING_APPROVAL');
        throw new Error('RESPONSE_LOST_AFTER_DURABLE_KERNEL');
      },
      registered,
    );
    const p = await makePreview(api, '1');
    expect(
      (
        await api.inject({
          method: 'POST',
          url: '/v1/send',
          payload: await body(p),
        })
      ).statusCode,
    ).toBe(500);
    const record = newSendRecord(p, NOW * 1000);
    expect((await a.get(record.sendId))?.state).toBe('CONFIRMING');
    expect(registered).toEqual([]);
    await api.close();
    if (!saved) throw new Error('missing durable Kernel snapshot');
    const restarted = restore(saved);
    const b = new PostgresSendStore(pool);
    let newAuthorizations = 0;
    const recoveredApi = await open(
      restarted,
      b,
      async (r) => {
        newAuthorizations++;
        return restarted.authorize(r);
      },
      registered,
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recoveredApi.inject({
          method: 'POST',
          url: `/v1/send/${record.sendId}/recover`,
          headers: { authorization: `Bearer ${ADMIN}` },
        }),
      ),
    );
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.json().state).toBe('PENDING_APPROVAL');
    }
    expect(calls).toBe(1);
    expect(newAuthorizations).toBe(0);
    expect(new Set(registered).size).toBe(1);
    expect((await b.get(record.sendId))?.draftDigest).toBe(registered[0]);
    expect(restarted.snapshot().grants).toHaveLength(0);
    await recoveredApi.close();
  });
  it('recovers a versioned pre-proposal crash but leaves legacy ambiguous claims fail-closed', async () => {
    const kernel = freshKernel();
    const store = new PostgresSendStore(pool);
    const registered: string[] = [];
    let calls = 0;
    const api = await open(
      kernel,
      store,
      async (r) => {
        calls++;
        return kernel.authorize(r);
      },
      registered,
    );
    const p = await makePreview(api, '0.1');
    const r = newSendRecord(p, NOW * 1000);
    await store.createOnce(r);
    await store.claimConfirmation(r.sendId, NOW * 1000);
    const result = await api.inject({
      method: 'POST',
      url: '/v1/send',
      payload: await body(p),
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().state).toBe('PENDING_APPROVAL');
    expect(calls).toBe(1);
    const legacy = await makePreview(api, '0.2');
    const l = newSendRecord(legacy, NOW * 1000);
    await store.createOnce(l);
    await store.save(
      advanceSend(l, 'CONFIRMING', NOW * 1000, 'legacy interrupted call', {
        confirmationProtocol: null,
      }),
    );
    const blocked = await api.inject({
      method: 'POST',
      url: '/v1/send',
      payload: await body(legacy),
    });
    expect(blocked.json()).toMatchObject({
      state: 'CONFIRMING',
      kernelCode: 'CONFIRMATION_RECONCILIATION_REQUIRED',
    });
    expect(calls).toBe(1);
    await api.close();
  });
  it('restart sweep resolves every interrupted confirmation without a client retry and never authorizes twice', async () => {
    await pool.query('TRUNCATE synq_sends,synq_send_previews');
    const kernel = freshKernel();
    const store = new PostgresSendStore(pool);
    const registered: string[] = [];
    let kernelCalls = 0;
    let mode: 'lost-response' | 'crash-before-kernel' = 'lost-response';
    const api = await open(
      kernel,
      store,
      async (request) => {
        if (mode === 'crash-before-kernel')
          throw new Error('PROCESS_EXIT_BEFORE_KERNEL');
        kernelCalls++;
        await kernel.authorize(request);
        throw new Error('PROCESS_EXIT_AFTER_KERNEL');
      },
      registered,
    );
    const confirmInterrupted = async (amount: string) => {
      const p = await makePreview(api, amount);
      const r = await api.inject({
        method: 'POST',
        url: '/v1/send',
        payload: await body(p),
      });
      expect(r.statusCode).toBe(500);
      const record = newSendRecord(p, NOW * 1000);
      expect((await store.get(record.sendId))?.state).toBe('CONFIRMING');
      return record.sendId;
    };
    // Kernel holds the draft, response lost.
    const afterKernel = await confirmInterrupted('0.11');
    // Proposal durable, Kernel never called.
    mode = 'crash-before-kernel';
    const beforeKernel = await confirmInterrupted('0.12');
    // Claimed, nothing else persisted (crash before proposal).
    const unproposed = newSendRecord(
      await makePreview(api, '0.13'),
      NOW * 1000,
    );
    await store.createOnce(unproposed);
    await store.claimConfirmation(unproposed.sendId, NOW * 1000);
    expect(kernelCalls).toBe(1);
    expect(registered).toEqual([]);
    await api.close();

    let resumedAuthorizations = 0;
    const restart = () =>
      open(
        kernel,
        new PostgresSendStore(pool),
        async (r) => {
          resumedAuthorizations++;
          return kernel.authorize(r);
        },
        registered,
        { recoverOnReady: true },
      );
    const first = await restart();
    expect((await store.get(afterKernel))?.state).toBe('PENDING_APPROVAL');
    expect((await store.get(beforeKernel))?.state).toBe('PENDING_APPROVAL');
    expect((await store.get(unproposed.sendId))?.state).toBe('PREVIEWED');
    // Only the never-seen intent is authorized, exactly once.
    expect(resumedAuthorizations).toBe(1);
    expect(new Set(registered)).toEqual(
      new Set([
        (await store.get(afterKernel))!.draftDigest,
        (await store.get(beforeKernel))!.draftDigest,
      ]),
    );
    await first.close();
    // A second restart is a no-op for Kernel authorization.
    const second = await restart();
    expect(resumedAuthorizations).toBe(1);
    expect(kernel.snapshot().grants).toHaveLength(0);
    // The released claim confirms normally afterwards.
    const resumed = await second.inject({
      method: 'POST',
      url: '/v1/send',
      payload: await body(unproposed.preview),
    });
    expect(resumed.statusCode).toBe(201);
    expect(resumed.json().state).toBe('PENDING_APPROVAL');
    expect(resumedAuthorizations).toBe(2);
    await second.close();
  });
  it('restart sweep rejects an expired never-authorized claim and leaves an UNKNOWN Kernel outcome for reconciliation', async () => {
    await pool.query('TRUNCATE synq_sends,synq_send_previews');
    const kernel = freshKernel();
    const store = new PostgresSendStore(pool);
    const api = await open(
      kernel,
      store,
      async () => {
        throw new Error('PROCESS_EXIT_BEFORE_KERNEL');
      },
      [],
    );
    const ids: string[] = [];
    for (const amount of ['0.21', '0.22']) {
      const p = await makePreview(api, amount);
      await api.inject({
        method: 'POST',
        url: '/v1/send',
        payload: await body(p),
      });
      ids.push(newSendRecord(p, NOW * 1000).sendId);
    }
    await api.close();
    let authorizations = 0;
    const unknown = await open(
      kernel,
      store,
      async () => {
        authorizations++;
        throw new Error('must not authorize');
      },
      [],
      {
        recoverOnReady: true,
        kernel: {
          authorize: async () => {
            authorizations++;
            throw new Error('must not authorize');
          },
          recover: async () => ({ status: 'UNKNOWN' }),
        },
      },
    );
    for (const id of ids)
      expect((await store.get(id))?.state).toBe('CONFIRMING');
    const reconcile = await unknown.inject({
      method: 'POST',
      url: `/v1/send/${ids[0]}/recover`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(reconcile.json()).toMatchObject({
      state: 'CONFIRMING',
      kernelCode: 'CONFIRMATION_RECONCILIATION_REQUIRED',
    });
    await unknown.close();
    const expired = await open(
      kernel,
      store,
      async () => {
        authorizations++;
        throw new Error('must not authorize');
      },
      [],
      { recoverOnReady: true, now: () => NOW + 3600 },
    );
    for (const id of ids) {
      const r = await store.get(id);
      expect(r?.state).toBe('REJECTED');
      expect(r?.kernelCode).toBe('PREVIEW_EXPIRED');
    }
    expect(authorizations).toBe(0);
    await expired.close();
  });
});
