import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestClient, http, keccak256 } from 'viem';
import { anvil } from 'viem/chains';
import { RpcNonceStatusReader } from '../../packages/read-model/src/kernel-adapter.js';

it('RpcNonceStatusReader reads nonceUsed/intentUsed from the deployed module at confirmation depth, echoes the query and binds the deployment', async () => {
  process.env.SYNQ_DEMO_DATABASE_URL =
    'postgresql://postgres:synq_local@127.0.0.1:55432/synq_nonce_demo';
  const { startLocalVertical } = await import('../../apps/demo/src/local.js');
  const local = await startLocalVertical();
  const journal = mkdtempSync(join(tmpdir(), 'synq-nonce-'));
  try {
    const { chain, kernel } = local;
    const authorized = await local.authorize(1_000_000n, '41');
    if (authorized.decision.status !== 'AUTHORIZED')
      throw new Error(authorized.decision.status);
    const grant = authorized.decision.grant;
    const query = {
      chainId: 31337,
      module: chain.module.toLowerCase() as `0x${string}`,
      account: grant.account,
      nonce: grant.nonce,
      intentHash: grant.intentHash,
    };
    const config = local.readModelConfig;
    const tip = new RpcNonceStatusReader(chain.client, {
      ...config,
      confirmationDepth: 1,
    });
    const deep = new RpcNonceStatusReader(chain.client, {
      ...config,
      confirmationDepth: 2,
    });
    const before = await tip.status(query);
    expect(before).toMatchObject({
      ...query,
      nonceUsed: false,
      intentUsed: false,
    });

    const executed = await local.execute(
      grant,
      authorized.intent,
      authorized.data,
      join(journal, 'journal'),
    );
    expect(kernel.grantState(grant.grantId).submissions).toEqual([
      executed.transactionHash,
    ]);
    expect(executed.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(kernel.grantState(grant.grantId).state).toBe('RECONCILED');

    const head = await chain.client.getBlockNumber({ cacheTime: 0 });
    const atTip = await tip.status(query);
    expect(atTip).toMatchObject({
      ...query,
      nonceUsed: true,
      intentUsed: true,
      blockNumber: Number(head),
    });
    expect(atTip.blockTimestamp).toBeLessThan(grant.validUntil);
    const unconfirmed = await deep.status(query);
    expect(unconfirmed).toMatchObject({
      nonceUsed: false,
      intentUsed: false,
      blockNumber: Number(head) - 1,
    });

    const test = createTestClient({
      chain: anvil,
      mode: 'anvil',
      transport: http(chain.url),
    });
    await test.increaseTime({
      seconds: grant.validUntil - atTip.blockTimestamp + 5,
    });
    await test.mine({ blocks: 2 });
    expect(await deep.status(query)).toMatchObject({
      nonceUsed: true,
      intentUsed: true,
    });
    const unexecuted = await deep.status({
      ...query,
      nonce: '999',
      intentHash: keccak256('0x99'),
    });
    expect(unexecuted).toMatchObject({
      nonce: '999',
      nonceUsed: false,
      intentUsed: false,
    });
    expect(unexecuted.blockTimestamp).toBeGreaterThanOrEqual(grant.validUntil);

    await expect(
      tip.status({ ...query, module: `0x${'9'.repeat(40)}` }),
    ).rejects.toThrow('CONFIG_MISMATCH');
    await expect(tip.status({ ...query, chainId: 10143 })).rejects.toThrow(
      'CONFIG_MISMATCH',
    );
    await expect(
      new RpcNonceStatusReader(chain.client, {
        ...config,
        registry: `0x${'7'.repeat(40)}`,
      }).status(query),
    ).rejects.toThrow('CONFIG_MISMATCH');
    await expect(
      new RpcNonceStatusReader(chain.client, {
        ...config,
        chainId: 10143,
      }).status({ ...query, chainId: 10143 }),
    ).rejects.toThrow('CONFIG_MISMATCH');
    await expect(
      new RpcNonceStatusReader(chain.client, {
        ...config,
        module: chain.token.toLowerCase() as `0x${string}`,
      }).status({
        ...query,
        module: chain.token.toLowerCase() as `0x${string}`,
      }),
    ).rejects.toThrow();
    expect(
      () =>
        new RpcNonceStatusReader(chain.client, {
          ...config,
          confirmationDepth: 0,
        }),
    ).toThrow('CONFIG_MISMATCH');
  } finally {
    await local.node.close();
    rmSync(journal, { recursive: true, force: true });
    rmSync(`${join(journal, 'journal')}.integrity-key`, { force: true });
  }
}, 120_000);
