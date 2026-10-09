import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { runLocalDemo } from '../../apps/demo/src/local.js';
import { DeterministicReadModel } from '../../packages/read-model/src/index.js';
import { Kernel } from '../../packages/kernel/src/index.js';
it('distinct approvals authorize a real onchain transfer that can be rebuilt solely from proof', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'synq-e2e-'));
  try {
    const result = await runLocalDemo(directory);
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.recipientBalance).toBe('60000000');
    expect(result.transferAmount).toBe('0.000000000060000000');
    expect(result.accountBalance).toBe('140000000');
    expect(result.snapshot.treasuryBalance).toBe(result.accountBalance);
    expect(Object.values(result.snapshot.executed)).toHaveLength(1);
    const projection = new DeterministicReadModel(
      31337,
      result.localTestToken,
      result.bindings,
    );
    projection.rebuild([...result.events].reverse(), result.checkpoint);
    expect(
      projection.snapshot(
        result.bindings[0]!.groupId,
        result.checkpoint,
        result.snapshot.generatedAt,
      ),
    ).toMatchObject({
      treasuryBalance: '140000000',
      executed: result.snapshot.executed,
      mandates: result.snapshot.mandates,
    });
    projection.ingest(result.events, result.checkpoint);
    expect(
      Object.values(
        projection.snapshot(
          result.bindings[0]!.groupId,
          result.checkpoint,
          result.snapshot.generatedAt,
        ).executed,
      ),
    ).toHaveLength(1);
    const restored = Kernel.restore(result.kernel);
    expect(restored.accounting('local_group', 'local_mandate')).toMatchObject({
      spent: '60000000',
      reserved: '0',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
it('a human decimal amount is parsed exactly against the on-chain token decimals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'synq-e2e-amount-'));
  try {
    const result = await runLocalDemo(directory, false, '0.000000000045');
    expect(result.recipientBalance).toBe('45000000');
    expect(result.transferAmount).toBe('0.000000000045000000');
    await expect(
      runLocalDemo(directory, false, '0.0000000000000000001'),
    ).rejects.toThrow('DECIMAL_PRECISION');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
