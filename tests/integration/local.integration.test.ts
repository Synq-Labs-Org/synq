import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  runLocalDemo,
  runNegativeScenarios,
} from '../../apps/demo/src/local.js';
import {
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
} from '../../packages/read-model/src/index.js';
import { KernelSnapshotSchema } from '../../packages/kernel/src/index.js';

it('Safe 2-of-3 approvals over the EIP-712 grant authorize a real module transfer reconciled from GrantExecuted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'synq-e2e-'));
  try {
    const result = await runLocalDemo(directory);
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.onchainDigest).toBe(result.draftDigest);
    expect(result.grantId).toBe(result.draftDigest);
    expect(result.approvals).toHaveLength(2);
    expect(
      result.approvals.every((a) => a.principalKind === 'LOCAL_FIXTURE'),
    ).toBe(true);
    expect(result.recipientBalance).toBe('60000000');
    expect(result.transferAmount).toBe('0.000000000060000000');
    expect(result.accountBalance).toBe('140000000');
    expect(result.snapshot.group.treasury[0]?.balance).toBe(
      result.accountBalance,
    );
    expect(result.snapshot.group.grantsExecuted).toHaveLength(1);
    expect(result.observation).toMatchObject({
      receiptStatus: 'success',
      event: { grantHash: result.grantId, tokenAmount: '60000000' },
    });
    expect(result.accounting).toMatchObject({
      spentToken: '60000000',
      reservedToken: '0',
    });
    expect(result.lifecycle.map((t) => t.to)).toEqual([
      'RISKED',
      'SIMULATED',
      'PENDING_APPROVAL',
      'AUTHORIZED',
      'PREPARED',
    ]);
    expect(KernelSnapshotSchema.safeParse(result.kernel).success).toBe(true);
    const store = new MemoryProjectionStore(31337);
    const config = result.readModelConfig;
    await new Projector(store, config).applyWindow({
      fromBlockExclusive: config.startBlock - 1,
      toBlockInclusive: result.checkpoint,
      events: [...result.events].reverse(),
    });
    const rebuilt = await new ProjectionReader(store, config).groupSnapshot(
      result.chainGroupId,
    );
    expect(rebuilt?.stateHash).toBe(result.snapshot.stateHash);
    expect(rebuilt?.group.treasury[0]?.balance).toBe('140000000');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);

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
}, 120000);

it('E2E-007: pause blocks, and supersession or revocation make old grants fail in the Kernel and on chain', async () => {
  const outcome = await runNegativeScenarios();
  expect(outcome).toEqual({
    pause: { kernel: 'ACCOUNT_PAUSED', onchain: 'ExecutionPaused' },
    supersede: {
      kernel: 'MANDATE_VERSION',
      onchain: 'MandateVersionNotValid',
    },
    revoke: {
      kernel: 'MANDATE_REVOKED',
      onchain: 'MandateNotActive',
      newIntent: 'MANDATE_REVOKED',
    },
    recipientBalance: '0',
  });
}, 120000);
