import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, zeroAddress } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { vaultSetupTypedData } from '@synq/kernel/arc-vault-setup';
import { WorkspaceVaultExecutor } from '@synq/execution-worker/workspace-vault';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';
import { fakeVaultChain } from './fake-vault-chain.js';

let pool: Pool;
beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl(
      'SYNQ_WORKSPACE_VAULT_TEST_DATABASE_URL',
      'synq_m2_workspace_vault',
    ),
  );
  await new PostgresWorkspaceStore(pool, 'https://synq.test').migrate();
});
afterAll(async () => {
  await pool?.end();
});
async function fixture() {
  const now = 2_000_000_000 + randomInt(1, 100_000_000) * 86400;
  const store = new PostgresWorkspaceStore(
    pool,
    'https://synq.test',
    () => now,
  );
  const owner = privateKeyToAccount(generatePrivateKey());
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: owner.address });
  const auth = await store.login(
    c.id,
    await owner.signTypedData({
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    }),
  );
  const { workspace } = await store.create(auth.principalId, {
    displayName: 'Fresh workspace',
    kind: 'PERSONAL',
  });
  const setups = new WorkspaceVaultSetups(store, {
    factory: contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY').address,
    token: token('arc-testnet', 'USDC').address,
    sponsor: sponsor.address,
    operator: sponsor.address,
    guardian: zeroAddress,
    maxGasNativeWei: '200000000000000000',
  });
  const proposal = (await setups.propose(workspace.id, auth.principalId, {}))!;
  await setups.approve(
    workspace.id,
    auth.principalId,
    await owner.signTypedData(vaultSetupTypedData(proposal.setup)),
  );
  const safe = privateKeyToAccount(generatePrivateKey()).address;
  const policy = privateKeyToAccount(generatePrivateKey()).address;
  const fake = fakeVaultChain(proposal.setup, safe, policy);
  let signed = 0;
  const signer = {
    address: sponsor.address,
    signTransaction: async (
      ...args: Parameters<typeof sponsor.signTransaction>
    ) => {
      signed++;
      return sponsor.signTransaction(...args);
    },
  };
  const authority = {
    grantKey: new Uint8Array(32).fill(9),
    operator: 'fixture-worker',
    grantTtlSeconds: 60,
    riskRequiredAbove: 0n,
  };
  const executor = () =>
    new WorkspaceVaultExecutor(
      setups,
      fake.chain,
      signer,
      authority,
      10n ** 18n,
    );
  await executor().outbox.migrate();
  return {
    store,
    auth,
    workspace,
    setups,
    proposal,
    fake,
    executor,
    safe,
    policy,
    signed: () => signed,
  };
}
describe('G1 G2 durable factory execution — LOCAL_FIXTURE', () => {
  it('recovers a crash after recording bytes without signing or reserving gas again', async () => {
    const f = await fixture();
    await expect(
      f.executor().execute(f.workspace.id, async () => {
        throw new Error('simulated worker crash');
      }),
    ).rejects.toThrow('simulated worker crash');
    expect(f.signed()).toBe(1);
    expect(f.fake.broadcasts).toHaveLength(0);
    const before = await f.store.get(f.workspace.id, f.auth.principalId);
    expect(before.workspace.status).toBe('LAUNCHING');
    const used = await pool.query(
      'SELECT 1 FROM synq_consumed_grants WHERE intent_id=$1',
      [`vault-setup:${f.proposal.setupHash}`],
    );
    expect(used.rowCount).toBe(1);
    const recovered = await f.executor().execute(f.workspace.id);
    expect(recovered.state).toBe('ACTIVE');
    expect(f.signed()).toBe(1);
    expect(f.fake.broadcasts).toHaveLength(1);
    const active = await f.store.get(f.workspace.id, f.auth.principalId);
    expect(active.workspace).toMatchObject({
      status: 'ACTIVE',
      vault: f.safe,
      threshold: 1,
    });
    expect(
      (
        await pool.query(
          'SELECT state,actual_wei FROM synq_ws_sponsor_reservations WHERE workspace_id=$1',
          [f.workspace.id],
        )
      ).rows[0],
    ).toMatchObject({ state: 'SETTLED', actual_wei: '40000000000000000' });
    expect((await f.executor().execute(f.workspace.id)).state).toBe('ACTIVE');
    expect(f.signed()).toBe(1);
    expect(f.fake.broadcasts).toHaveLength(1);
  });
  it('reconciles a broadcast timeout from the original receipt', async () => {
    const f = await fixture();
    f.fake.failAfterBroadcast();
    await expect(f.executor().execute(f.workspace.id)).rejects.toThrow(
      'connection lost after broadcast',
    );
    expect(f.fake.broadcasts).toHaveLength(1);
    expect((await f.executor().execute(f.workspace.id)).state).toBe('ACTIVE');
    expect(f.signed()).toBe(1);
    expect(f.fake.broadcasts).toHaveLength(1);
  });
  it('serializes concurrent workers sharing a sponsor nonce', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.executor().execute(f.workspace.id),
      f.executor().execute(f.workspace.id),
    ]);
    expect(results.map((r) => r.state)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(f.signed()).toBe(1);
    expect(f.fake.broadcasts).toHaveLength(1);
  });
  it('refuses activation when live Safe owners differ from the signed setup', async () => {
    const f = await fixture();
    f.fake.changeOwners([privateKeyToAccount(generatePrivateKey()).address]);
    await expect(f.executor().execute(f.workspace.id)).rejects.toMatchObject({
      code: 'CUSTODY_MISMATCH',
    });
    expect(
      (await f.store.get(f.workspace.id, f.auth.principalId)).workspace.status,
    ).toBe('LAUNCHING');
  });
});
