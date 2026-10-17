import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { anvil } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  AMANE_ARTIFACTS,
  compilePolicy,
  controlTypedData,
  executeCalldata,
  intentTypedData,
  isController,
  leaseTypedData,
  payIntent,
  readAccountView,
  readLeaseView,
} from '@synq/plugin-amane';
import { startAnvil } from '../../apps/demo/src/anvil.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { WorkspaceAmane } from '../../packages/workspaces/src/amane.js';
import { AgentEvents } from '../../packages/workspaces/src/agent-events.js';
import { AmanePayExecutor } from '../../workers/execution/src/amane-pay.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

/*
 * Real Amane contracts (the pinned release's own bytecode) on a local Anvil
 * chain, driven by Synq's executor: a lease-bound payment with no human
 * signature, a redirected intent the contract refuses, budgets, revocation
 * and restart without paying twice. LOCAL_FIXTURE proof only.
 */

const A = AMANE_ARTIFACTS;
// Compiled by `forge build` before the integration run (CI typechecks earlier).
const token = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/out/LocalSixDecimalToken.sol/LocalSixDecimalToken.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { abi: unknown[]; bytecode: { object: string } };
let node: Awaited<ReturnType<typeof startAnvil>>;
let client: PublicClient;
let pool: Pool;
let store: PostgresWorkspaceStore;
let amane: WorkspaceAmane;
let events: AgentEvents;
let executor: AmanePayExecutor;
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const operator = privateKeyToAccount(generatePrivateKey());
const vendor = privateKeyToAccount(generatePrivateKey()).address;
let account: Address;
let tokenAddress: Address;
let leaseId: Hex;
let codeHash: Hex;

async function deploy(abi: unknown, bytecode: Hex, args: unknown[] = []) {
  const w = createWalletClient({
    chain: anvil,
    transport: http(node.url),
    account: owner,
  });
  const hash = await w.deployContract({
    abi: abi as never,
    bytecode,
    args: args as never,
  });
  const r = await client.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r.contractAddress!;
}
async function send(
  address: Address,
  abi: unknown,
  functionName: string,
  args: unknown[] = [],
) {
  const w = createWalletClient({
    chain: anvil,
    transport: http(node.url),
    account: owner,
  });
  const hash = await w.writeContract({
    address,
    abi: abi as never,
    functionName,
    args: args as never,
  } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r;
}
const balanceOf = (a: Address) =>
  client.readContract({
    address: tokenAddress,
    abi: token.abi,
    functionName: 'balanceOf',
    args: [a],
  }) as Promise<bigint>;

beforeAll(async () => {
  node = await startAnvil();
  client = createPublicClient({
    chain: anvil,
    transport: http(node.url),
  }) as PublicClient;
  for (const a of [owner.address, operator.address])
    await client.request({
      method: 'anvil_setBalance' as never,
      params: [a, '0x56BC75E2D63100000'] as never,
    });
  const registry = await deploy(
    A.AdapterRegistry.abi,
    A.AdapterRegistry.bytecode as Hex,
  );
  const adapter = await deploy(
    A.TransferPayAdapter.abi,
    A.TransferPayAdapter.bytecode as Hex,
  );
  const reg = await send(registry, A.AdapterRegistry.abi, 'register', [
    adapter,
  ]);
  const adapterId = reg.logs
    .flatMap((l) => {
      try {
        return [
          decodeEventLog({
            abi: A.AdapterRegistry.abi,
            data: l.data,
            topics: l.topics,
          }),
        ];
      } catch {
        return [];
      }
    })
    .find((e) => e.eventName === 'AdapterRegistered')!.args as unknown as {
    adapterId: Hex;
  };
  const factory = await deploy(A.ArcFactory.abi, A.ArcFactory.bytecode as Hex, [
    registry,
  ]);
  const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
  account = (await client.readContract({
    address: factory,
    abi: A.ArcFactory.abi,
    functionName: 'predict',
    args: [[owner.address], 1, salt],
  })) as Address;
  await send(factory, A.ArcFactory.abi, 'create', [[owner.address], 1, salt]);
  tokenAddress = await deploy(token.abi, token.bytecode.object as Hex);
  const now = (await client.getBlock()).timestamp;
  const root = {
    version: 1n,
    token: tokenAddress,
    recipient: vendor,
    adapterId: adapterId.adapterId,
    recovery: owner.address,
    perAction: 20000n,
    perPeriod: 40000n,
    total: 100000n,
    periodSeconds: 86400n,
    maxLeaseLifetime: 7200n,
  };
  const compiled = compilePolicy(root, 31337, account);
  const deadline = now + 3600n;
  const control = await owner.signTypedData(
    controlTypedData(31337, account, compiled.rootHash, 0n, deadline),
  );
  await send(account, A.ArcAccount.abi, 'installPolicy', [
    root,
    deadline,
    [control],
  ]);
  leaseId = keccak256(toHex('synq-test-lease'));
  const lease = {
    leaseId,
    rootHash: compiled.rootHash,
    agent: agent.address,
    validAfter: now,
    expiresAt: now + 7000n,
    perAction: 10000n,
    perPeriod: 30000n,
    total: 80000n,
  };
  await send(account, A.ArcAccount.abi, 'activateLease', [
    lease,
    [await owner.signTypedData(leaseTypedData(31337, account, lease))],
  ]);
  await send(tokenAddress, token.abi, 'mint', [account, 100000n]);
  codeHash = keccak256((await client.getCode({ address: account }))!);

  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, 'https://synq.test');
  await store.migrate();
  events = new AgentEvents(store);
  await events.migrate();
  amane = service();
  await amane.migrate();
  executor = new AmanePayExecutor(
    amane,
    {
      client,
      chainId: 31337,
      mutationEnabled: true,
      minMaxFeePerGasWei: 0n,
      explorer: 'http://local',
    },
    {
      address: operator.address,
      signTransaction: (tx) => operator.signTransaction(tx),
    },
    {
      address: agent.address,
      signIntent: (typed) => agent.signTypedData(typed),
    },
    {
      grantKey: new Uint8Array(randomBytes(32)),
      operator: 'amane-test',
      grantTtlSeconds: 300,
      riskRequiredAbove: 0n,
    },
    {
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
        reference: 'fixture',
        reason: 'LOCAL_FIXTURE',
        screenedAt: q.now,
      }),
    },
    events,
  );
  await executor.migrate();
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await node?.close();
});

async function owned(wallet = privateKeyToAccount(generatePrivateKey())) {
  const c = await store.challenge({
    wallet: wallet.address,
    audience: 'native',
  });
  const { loginTypedData } =
    await import('../../packages/workspaces/src/contracts.js');
  const signature = await wallet.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  const s = await store.login(c.id, signature);
  const { workspace } = await store.create(s.principalId, {
    displayName: 'Amane Co',
    kind: 'BUSINESS',
  });
  return { principalId: s.principalId, workspaceId: workspace.id };
}
const service = (over: { agent?: Address; codeHash?: Hex } = {}) =>
  new WorkspaceAmane(store, {
    agent: over.agent ?? agent.address,
    accountCodeHash: over.codeHash ?? codeHash,
    readAccount: (a) => readAccountView(client, a as Address),
    readLease: (a, id) =>
      readLeaseView(client, a as Address, codeHash, id as Hex),
    isController: (a, w) => isController(client, a as Address, w as Address),
  });

describe('Amane lease-bound agent payments', () => {
  let o: { principalId: string; workspaceId: string };
  let accountId: string;

  it('records only what the chain enforces: pinned code, a real controller, one workspace, Synq’s agent', async () => {
    const stranger = await owned();
    await expect(
      service().registerAccount(stranger.workspaceId, stranger.principalId, {
        account,
      }),
    ).rejects.toMatchObject({
      code: 'AMANE_NOT_CONTROLLER',
    });
    o = await owned(owner);
    await expect(
      service({
        codeHash: keccak256(toHex('another release')),
      }).registerAccount(o.workspaceId, o.principalId, { account }),
    ).rejects.toMatchObject({ code: 'AMANE_CODE_MISMATCH' });
    const acct = await amane.registerAccount(o.workspaceId, o.principalId, {
      account,
    });
    accountId = acct.id;
    expect(getAddress(acct.recipient)).toBe(getAddress(vendor));
    await expect(
      amane.registerAccount(o.workspaceId, o.principalId, { account }),
    ).rejects.toMatchObject({
      code: 'AMANE_ACCOUNT_REGISTERED',
    });
    await expect(
      service({ agent: operator.address }).registerLease(
        o.workspaceId,
        o.principalId,
        { accountId, leaseId },
      ),
    ).rejects.toMatchObject({ code: 'LEASE_AGENT_MISMATCH' });
    await amane.registerLease(o.workspaceId, o.principalId, {
      accountId,
      leaseId,
    });
  });

  it('pays the contractor after the invoice settles, with no owner signature, and books it once', async () => {
    await expect(
      amane.createJob(o.workspaceId, o.principalId, {
        leaseId,
        triggerKind: 'INVOICE_PAID',
        triggerRef: 'inv_big',
        amount: '10001',
        purpose: 'too much',
      }),
    ).rejects.toMatchObject({ code: 'ABOVE_LEASE_PER_ACTION' });
    const job = await amane.createJob(o.workspaceId, o.principalId, {
      leaseId,
      triggerKind: 'INVOICE_PAID',
      triggerRef: 'inv_1',
      amount: '7000',
      purpose: 'Logo design delivery',
    });
    await expect(executor.execute(job.id)).rejects.toMatchObject({
      code: 'JOB_NOT_READY',
    });
    expect(await amane.triggerInvoicePaid(o.workspaceId, 'inv_1')).toEqual([
      job.id,
    ]);
    const before = await balanceOf(vendor);
    const result = await executor.execute(job.id);
    expect(result.state).toBe('PAID');
    expect((await balanceOf(vendor)) - before).toBe(7000n);
    const nonceAfter = await client.getTransactionCount({
      address: operator.address,
    });
    // Running again (or after a restart) never signs or pays a second time.
    expect((await executor.execute(job.id)).state).toBe('PAID');
    expect(
      await client.getTransactionCount({ address: operator.address }),
    ).toBe(nonceAfter);
    expect((await balanceOf(vendor)) - before).toBe(7000n);
    const ledger = await pool.query(
      'SELECT count(*)::int AS n FROM synq_ledger_entries WHERE entry_id=$1',
      [`amane-job:${job.id}:settled`],
    );
    expect(ledger.rows[0].n).toBe(1);
    const runs = await events.runs(o.workspaceId, o.principalId);
    const detail = await events.detail(
      o.workspaceId,
      o.principalId,
      runs.items[0]!.runId,
    );
    expect(detail.events.map((e) => `${e.kind}:${e.actor}`)).toEqual([
      'DECISION:DETERMINISTIC',
      'GRANT:DETERMINISTIC',
      'BROADCAST:DETERMINISTIC',
      'FINALIZED:CHAIN',
      'RECONCILED:DETERMINISTIC',
    ]);
    expect(detail.receipts[0]!.finality).toBe('FINALIZED');
  });

  it('cannot redirect money: the contract reverts an agent-signed intent to another recipient', async () => {
    const before = await balanceOf(vendor);
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const intent = payIntent({
      leaseId,
      nonce: 999n,
      token: tokenAddress,
      recipient: attacker,
      adapterId: (await readAccountView(client, account)).root.adapterId,
      amount: 5000n,
      deadline: (await client.getBlock()).timestamp + 600n,
      planHash: keccak256(toHex('attack')),
    });
    const sig = await agent.signTypedData(
      intentTypedData(31337, account, intent),
    );
    const w = createWalletClient({
      chain: anvil,
      transport: http(node.url),
      account: operator,
    });
    const hash = await w.sendTransaction({
      to: account,
      data: executeCalldata(intent, sig),
      gas: 1_000_000n,
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe(
      'reverted',
    );
    expect(await balanceOf(attacker)).toBe(0n);
    expect(await balanceOf(vendor)).toBe(before);
  });

  it('refuses a payment above the remaining period budget without moving money', async () => {
    // 7000 already spent this period of the 30000 lease budget; two 10000 jobs fit, a third does not.
    const ids: string[] = [];
    for (const ref of ['p1', 'p2', 'p3']) {
      const j = await amane.createJob(o.workspaceId, o.principalId, {
        leaseId,
        triggerKind: 'OWNER_REQUEST',
        triggerRef: ref,
        amount: '10000',
        purpose: ref,
      });
      ids.push(j.id);
    }
    expect((await executor.execute(ids[0]!)).state).toBe('PAID');
    expect((await executor.execute(ids[1]!)).state).toBe('PAID');
    const before = await balanceOf(vendor);
    expect((await executor.execute(ids[2]!)).state).toBe('REFUSED');
    expect(await balanceOf(vendor)).toBe(before);
    expect((await amane.job(ids[2]!)).reason).toMatch(/REJECTED_BUDGET|budget/);
  });

  it('stops all agent payments once the owner revokes the lease on chain', async () => {
    const j = await amane.createJob(o.workspaceId, o.principalId, {
      leaseId,
      triggerKind: 'OWNER_REQUEST',
      triggerRef: 'after-revoke',
      amount: '100',
      purpose: 'late',
    });
    await send(account, A.ArcAccount.abi, 'revoke', [leaseId]);
    const before = await balanceOf(vendor);
    expect((await executor.execute(j.id)).state).toBe('REFUSED');
    expect(await balanceOf(vendor)).toBe(before);
    const mandates = await amane.mandates(o.workspaceId, o.principalId);
    expect(mandates[0]!.availableUnits).toBe('0');
    expect(mandates[0]!.revokedAt).not.toBeNull();
  });
});
