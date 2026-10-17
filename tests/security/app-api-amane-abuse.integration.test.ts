import { randomBytes } from 'node:crypto';
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
import token from '../../contracts/out/LocalSixDecimalToken.sol/LocalSixDecimalToken.json' with { type: 'json' };
import { startAnvil } from '../../apps/demo/src/anvil.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { WorkspaceAmane } from '../../packages/workspaces/src/amane.js';
import { AgentEvents } from '../../packages/workspaces/src/agent-events.js';
import { AmanePayExecutor } from '../../workers/execution/src/amane-pay.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from '../workspaces/pg.js';

/*
 * Abuse of agent payments against the pinned Amane contracts on a local Anvil
 * chain (LOCAL_FIXTURE proof only): racing executors pay once, a job over the
 * remaining budget pays nothing, a revoked lease pays nothing, and every
 * intent that deviates from the root policy reverts on chain, even when the
 * database itself is tampered with.
 */

const A = AMANE_ARTIFACTS;
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

const makeExecutor = () =>
  new AmanePayExecutor(
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
  executor = makeExecutor();
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

async function jobFor(amount: string, ref: string, trigger = 'OWNER_REQUEST') {
  return amane.createJob(o.workspaceId, o.principalId, {
    leaseId,
    triggerKind: trigger as 'OWNER_REQUEST',
    triggerRef: ref,
    amount,
    purpose: ref,
  });
}
let o: { principalId: string; workspaceId: string };
const operatorTxs = () =>
  client.getTransactionCount({ address: operator.address });

describe('Amane abuse', () => {
  beforeAll(async () => {
    o = await owned(owner);
    const acct = await amane.registerAccount(o.workspaceId, o.principalId, {
      account,
    });
    await amane.registerLease(o.workspaceId, o.principalId, {
      accountId: acct.id,
      leaseId,
    });
  });

  it('pays once when the same job is executed concurrently, by one or several workers', async () => {
    const job = await jobFor('5000', 'race');
    const before = await balanceOf(vendor);
    const txBefore = await operatorTxs();
    const other = makeExecutor();
    const results = await Promise.all([
      executor.execute(job.id),
      executor.execute(job.id),
      other.execute(job.id),
      other.execute(job.id),
    ]);
    expect(results.every((r) => r.state === 'PAID')).toBe(true);
    expect((await balanceOf(vendor)) - before).toBe(5000n);
    expect((await operatorTxs()) - txBefore).toBe(1);
    const ledger = await pool.query(
      'SELECT count(*)::int AS n FROM synq_ledger_entries WHERE entry_id=$1',
      [`amane-job:${job.id}:settled`],
    );
    expect(ledger.rows[0].n).toBe(1);
    // One nonce, one transaction hash.
    // (A worker that finds the job already paid reports no hash.)
    expect(
      new Set(
        results.flatMap((r) =>
          'txHash' in r && r.txHash ? [String(r.txHash)] : [],
        ),
      ).size,
    ).toBe(1);
  });

  it('pays two different jobs of one lease with distinct nonces, never a repeat', async () => {
    const a = await jobFor('1000', 'seq-a');
    const b = await jobFor('1000', 'seq-b');
    const before = await balanceOf(vendor);
    const [ra, rb] = await Promise.all([
      executor.execute(a.id),
      executor.execute(b.id),
    ]);
    expect([ra.state, rb.state]).toEqual(['PAID', 'PAID']);
    expect((await balanceOf(vendor)) - before).toBe(2000n);
    const nonces = await pool.query(
      'SELECT nonce::text FROM synq_amane_jobs WHERE id = ANY($1::uuid[])',
      [[a.id, b.id]],
    );
    expect(new Set(nonces.rows.map((r) => r.nonce)).size).toBe(2);
  });

  it('refuses a job above the remaining budget and moves nothing', async () => {
    // Already paid this period: 5000 + 2000. The lease allows 30000 per period.
    const ids = [];
    for (const ref of ['b1', 'b2', 'b3'])
      ids.push((await jobFor('10000', ref)).id);
    expect((await executor.execute(ids[0]!)).state).toBe('PAID');
    expect((await executor.execute(ids[1]!)).state).toBe('PAID');
    const before = await balanceOf(vendor);
    const txs = await operatorTxs();
    const last = await executor.execute(ids[2]!);
    expect(last.state).toBe('REFUSED');
    expect(await balanceOf(vendor)).toBe(before);
    expect(await operatorTxs()).toBe(txs);
    // A refusal is final: asking again, even concurrently, still pays nothing.
    const again = await Promise.all([
      executor.execute(ids[2]!),
      executor.execute(ids[2]!),
    ]);
    expect(again.every((r) => r.state === 'REFUSED')).toBe(true);
    expect(await balanceOf(vendor)).toBe(before);
    // Above the lease's per-action limit never becomes a job at all.
    await expect(jobFor('10001', 'too-big')).rejects.toMatchObject({
      code: 'ABOVE_LEASE_PER_ACTION',
    });
  });

  it('does not let a tampered database redirect the payment', async () => {
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const job = await jobFor('100', 'tamper');
    const original = (
      await pool.query(
        'SELECT recipient FROM synq_amane_accounts WHERE id=$1',
        [job.accountId],
      )
    ).rows[0].recipient as string;
    await pool.query(
      'UPDATE synq_amane_accounts SET recipient=$2 WHERE id=$1',
      [job.accountId, attacker],
    );
    try {
      const before = await balanceOf(vendor);
      const r = await executor.execute(job.id);
      expect(['REFUSED', 'NEEDS_REVIEW']).toContain(r.state);
      expect(await balanceOf(attacker)).toBe(0n);
      expect(await balanceOf(vendor)).toBe(before);
    } finally {
      await pool.query(
        'UPDATE synq_amane_accounts SET recipient=$2 WHERE id=$1',
        [job.accountId, original],
      );
    }
    // Same for an inflated amount written straight into the job row.
    const big = await jobFor('100', 'tamper-amount');
    await pool.query('UPDATE synq_amane_jobs SET amount=$2 WHERE id=$1', [
      big.id,
      '19000',
    ]);
    const before = await balanceOf(vendor);
    const r = await executor.execute(big.id);
    expect(['REFUSED', 'NEEDS_REVIEW']).toContain(r.state);
    expect(await balanceOf(vendor)).toBe(before);
  });

  it('reverts every agent-signed intent that deviates from the policy, and a replayed one', async () => {
    const view = await readAccountView(client, account);
    const now = (await client.getBlock()).timestamp;
    const attacker = privateKeyToAccount(generatePrivateKey()).address;
    const base = {
      leaseId,
      token: tokenAddress,
      recipient: vendor,
      adapterId: view.root.adapterId,
      amount: 100n,
      deadline: now + 600n,
      planHash: keccak256(toHex('abuse')),
    };
    const w = createWalletClient({
      chain: anvil,
      transport: http(node.url),
      account: operator,
    });
    const relay = async (
      intent: ReturnType<typeof payIntent>,
      signer = agent,
    ) => {
      const sig = await signer.signTypedData(
        intentTypedData(31337, account, intent),
      );
      const hash = await w.sendTransaction({
        to: account,
        data: executeCalldata(intent, sig),
        gas: 1_000_000n,
      });
      return (await client.waitForTransactionReceipt({ hash })).status;
    };
    const before = {
      vendor: await balanceOf(vendor),
      attacker: await balanceOf(attacker),
    };
    const otherToken = await deploy(token.abi, token.bytecode.object as Hex);
    const cases: [string, ReturnType<typeof payIntent>, typeof agent?][] = [
      [
        'another recipient',
        payIntent({ ...base, nonce: 5001n, recipient: attacker }),
      ],
      [
        'another token',
        payIntent({ ...base, nonce: 5002n, token: otherToken }),
      ],
      [
        'above the lease per-action limit',
        payIntent({ ...base, nonce: 5003n, amount: 10001n }),
      ],
      [
        'above the root per-action limit',
        payIntent({ ...base, nonce: 5004n, amount: 20001n }),
      ],
      [
        'an expired deadline',
        payIntent({ ...base, nonce: 5005n, deadline: now - 1n }),
      ],
      [
        'another adapter',
        payIntent({
          ...base,
          nonce: 5006n,
          adapterId: keccak256(toHex('adapter')),
        }),
      ],
      [
        'an unknown lease',
        payIntent({ ...base, nonce: 5007n, leaseId: keccak256(toHex('nope')) }),
      ],
      [
        'a signature by the operator, not the agent',
        payIntent({ ...base, nonce: 5008n }),
        operator as unknown as typeof agent,
      ],
      [
        'a signature by a stranger',
        payIntent({ ...base, nonce: 5009n }),
        privateKeyToAccount(generatePrivateKey()) as unknown as typeof agent,
      ],
    ];
    for (const [name, intent, signer] of cases)
      expect(await relay(intent, signer), name).toBe('reverted');
    // A good intent succeeds once; the identical one then reverts (nonce used).
    const good = payIntent({ ...base, nonce: 5010n });
    expect(await relay(good)).toBe('success');
    expect(await relay(good)).toBe('reverted');
    expect(await balanceOf(attacker)).toBe(before.attacker);
    expect((await balanceOf(vendor)) - before.vendor).toBe(100n);
  });

  it('pays nothing after the owner revokes the lease, including jobs made before and after', async () => {
    const early = await jobFor('100', 'rev-early');
    await send(account, A.ArcAccount.abi, 'revoke', [leaseId]);
    const late = await jobFor('100', 'rev-late');
    const before = await balanceOf(vendor);
    const txs = await operatorTxs();
    for (const j of [early, late])
      expect((await executor.execute(j.id)).state).toBe('REFUSED');
    expect(await balanceOf(vendor)).toBe(before);
    expect(await operatorTxs()).toBe(txs);
    // The chain, not the database row, decides: a revoked lease cannot be registered again.
    await expect(
      service().registerLease(o.workspaceId, o.principalId, {
        accountId: late.accountId,
        leaseId,
      }),
    ).rejects.toMatchObject({ code: 'LEASE_NOT_LIVE' });
    const mandates = await amane.mandates(o.workspaceId, o.principalId);
    expect(mandates[0]!.availableUnits).toBe('0');
    // Another workspace cannot run, list or create against this lease.
    const stranger = await owned();
    await expect(
      amane.createJob(stranger.workspaceId, stranger.principalId, {
        leaseId,
        triggerKind: 'OWNER_REQUEST',
        triggerRef: 'steal',
        amount: '100',
        purpose: 'steal',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      amane.jobs(stranger.workspaceId, stranger.principalId),
    ).resolves.toEqual([]);
  });
});
