import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  Kernel,
  approvalTypedData,
  artifactHash,
  type AuthorizationRequest,
} from '../../packages/kernel/src/index.js';
import {
  ActionIntentSchema,
  AmountSchema,
  MandateSchema,
  UINT256_MAX,
} from '../../packages/schemas/src/index.js';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  type JournalEntry,
} from '../../workers/execution/src/journal.js';
import {
  address,
  asset,
  evidence,
  intent,
  mandate,
  network,
  now,
  owners,
  request,
} from '../kernel/fixtures.js';

function trustedKernel(
  requests: AuthorizationRequest[],
  policies = [mandate()],
  balance = '10000',
) {
  return new Kernel({
    network,
    mandates: policies,
    balances: [{ account: address(20), asset, balance }],
    trustedEvidence: {
      riskPacketHashes: requests.map((r) => artifactHash(r.risk)),
      simulationHashes: requests.map((r) => artifactHash(r.simulation)),
    },
  });
}

describe('independent kernel security critic', () => {
  it.each([
    '-1',
    '01',
    '1.0',
    '1e18',
    ' 1',
    '+1',
    (UINT256_MAX + 1n).toString(),
    9007199254740992,
  ])('rejects unsafe financial amount %s', (value) => {
    expect(AmountSchema.safeParse(value).success).toBe(false);
  });

  it('preserves the complete uint256 amount range losslessly', () => {
    expect(BigInt(AmountSchema.parse(UINT256_MAX.toString()))).toBe(
      UINT256_MAX,
    );
  });

  it('nested malformed action and mandate amounts return validation failures without throwing', () => {
    expect(
      ActionIntentSchema.safeParse({ ...intent(), maxInputAmount: '1.0' })
        .success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({ ...mandate(), autoCap: '1e18' }).success,
    ).toBe(false);
  });

  it('does not accept attacker-selected trust attestations in an authorization request', async () => {
    const input = await request();
    const kernel = new Kernel({
      network,
      mandates: [mandate()],
      balances: [{ account: address(20), asset, balance: '1000' }],
    });
    const forged = {
      ...input,
      trustedEvidence: {
        riskPacketHashes: [artifactHash(input.risk)],
        simulationHashes: [artifactHash(input.simulation)],
      },
    };
    expect(await kernel.authorize(forged)).toMatchObject({
      status: 'REJECTED',
      code: 'EVIDENCE_MISMATCH',
    });
  });

  it('rejects a symbol-only AUSD impersonation despite a valid canonical address', async () => {
    expect(() =>
      intent({ inputAsset: { ...asset, symbol: 'AUSD' } }),
    ).toThrow();
    const data = evidence(intent({ inputToken: address(11) }));
    const input = { ...data, approvals: [], now };
    expect(await trustedKernel([input]).authorize(input)).toMatchObject({
      status: 'REJECTED',
      code: 'ASSET_FORBIDDEN',
    });
  });

  it('copies governance inputs and does not expose mutable stored mandate records', async () => {
    const input = await request();
    const policy = mandate();
    const kernel = trustedKernel([input], [policy]);
    policy.targets.push(address(99));
    const resolved = kernel.mandates.resolve(input.intent);
    resolved.members[0]!.signer = address(99);
    resolved.perActionCap = '1000';
    expect(kernel.mandates.resolve(input.intent).targets).not.toContain(
      address(99),
    );
    expect(kernel.mandates.resolve(input.intent).perActionCap).toBe('100');
    expect(await kernel.authorize(input)).toMatchObject({
      status: 'AUTHORIZED',
    });
  });

  it('requires distinct signatures and rejects reused signatures under another member identity', async () => {
    const input = await request();
    const approvals = [
      input.approvals[0]!,
      { ...input.approvals[1]!, signature: input.approvals[0]!.signature },
    ];
    expect(
      await trustedKernel([input]).authorize({ ...input, approvals }),
    ).toMatchObject({ status: 'REJECTED', code: 'INVALID_APPROVAL' });
  });

  it.each([
    { maxInputAmount: '61' },
    { calldataHash: `0x${'7'.repeat(64)}` },
    { nonce: '2' },
    { validUntil: 1499 },
    { pluginId: 'second-transfer' },
    { target: address(11) },
  ])(
    'rejects old signed approvals after an otherwise allowed economic mutation %j',
    async (patch) => {
      const original = await request();
      const input = {
        ...evidence(intent(patch)),
        approvals: original.approvals,
        now,
      };
      const policy = mandate({
        plugins: ['local-transfer', 'second-transfer'],
        targets: [address(10), address(11)],
      });
      expect(
        await trustedKernel([input], [policy]).authorize(input),
      ).toMatchObject({ status: 'REJECTED', code: 'INVALID_APPROVAL' });
    },
  );

  it('reserves a shared treasury atomically across different mandates under concurrent issuance', async () => {
    const one = await request();
    const two = await request({ mandateId: 'second', nonce: '2' });
    const kernel = trustedKernel(
      [one, two],
      [mandate(), mandate({ mandateId: 'second' })],
      '100',
    );
    const results = await Promise.all([
      kernel.authorize(one),
      kernel.authorize(two),
    ]);
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(1);
    expect(
      kernel
        .snapshot()
        .ledger.reduce((n, [, ledger]) => n + BigInt(ledger.reserved), 0n),
    ).toBe(60n);
  });

  it('concurrent duplicate nonces issue exactly one grant and remain locked after restart', async () => {
    const input = await request();
    const kernel = trustedKernel([input]);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => kernel.authorize(input)),
    );
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(kernel.snapshot())),
    );
    expect(await restored.authorize(input)).toMatchObject({
      status: 'REJECTED',
      code: 'NONCE_REPLAY',
    });
  });

  it('consumed reservations survive expiry and restart until single reconciliation', async () => {
    const input = await request();
    const kernel = trustedKernel([input]);
    const result = await kernel.authorize(input);
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    kernel.consume(result.grant, input.intent, now);
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(kernel.snapshot())),
    );
    expect(restored.releaseExpired(now + 100)).toBe(0);
    expect(() => restored.consume(result.grant, input.intent, now)).toThrow(
      'GRANT_REPLAY',
    );
    restored.reconcile(result.grant.grantId, '55');
    expect(restored.accounting('group_1', 'mandate_1')).toMatchObject({
      spent: '55',
      reserved: '0',
    });
    expect(() => restored.reconcile(result.grant.grantId, '55')).toThrow(
      'RECONCILIATION_INVALID',
    );
  });

  it('does not grant execution authority beyond the signed quorum expiry', async () => {
    const input = await request();
    input.approvals = await Promise.all(
      input.approvals.map(async (approval, i) => {
        const unsigned = { ...approval, expiresAt: now + 1 };
        return {
          ...unsigned,
          signature: await owners[i]!.signTypedData(
            approvalTypedData(input.intent, unsigned),
          ),
        };
      }),
    );
    const kernel = trustedKernel([input]);
    const result = await kernel.authorize(input);
    expect(result.status).toBe('AUTHORIZED');
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.grant.validUntil).toBeLessThanOrEqual(now + 1);
    expect(() => kernel.consume(result.grant, input.intent, now + 2)).toThrow(
      'GRANT_EXPIRED',
    );
  });

  it('enforces the intent slippage ceiling as well as the broader mandate ceiling', async () => {
    const data = evidence(intent({ maxInputAmount: '10', maxSlippageBps: 1 }), {
      slippageBps: 50,
    });
    const input = { ...data, approvals: [], now };
    expect(await trustedKernel([input]).authorize(input)).toMatchObject({
      status: 'REJECTED',
      code: 'RISK_REJECTED',
    });
  });
});

function journalEntry(): JournalEntry {
  const rawTransaction = '0x1234';
  return {
    schemaVersion: 1,
    grantId: `0x${'1'.repeat(64)}`,
    transactionHash: keccak256(rawTransaction),
    rawTransaction,
    state: 'SIGNED',
    chainId: 31337,
    blockNumber: null,
  };
}

describe('independent execution restart critic', () => {
  it('can recover after process exit immediately following accepted broadcast without resubmission', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'synq-critic-crash-'));
    const entry = journalEntry();
    let broadcasts = 0;
    try {
      const source = `import(${JSON.stringify(resolve('workers/execution/src/journal.ts'))}).then(async ({ ExecutionJournal, JournaledBroadcaster }) => {
        const worker = new JournaledBroadcaster(new ExecutionJournal(${JSON.stringify(directory)}), {
          sendRawTransaction: async () => process.exit(0), receipt: async () => null,
        });
        await worker.submit(${JSON.stringify(entry)});
      });`;
      execFileSync(process.execPath, [
        '--import',
        resolve('node_modules/tsx/dist/loader.mjs'),
        '-e',
        source,
      ]);
      const restarted = new JournaledBroadcaster(
        new ExecutionJournal(directory),
        {
          sendRawTransaction: async () => {
            broadcasts++;
            return entry.transactionHash;
          },
          receipt: async () => ({ status: 'success', blockNumber: 10n }),
        },
      );
      expect(restarted.journal.get(entry.grantId)?.state).toBe('SIGNED');
      await expect(restarted.submit(entry)).resolves.toMatchObject({
        state: 'CONFIRMED',
        blockNumber: '10',
      });
      expect(broadcasts).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('a timeout without receipt conservatively blocks raw-transaction replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'synq-critic-timeout-'));
    let broadcasts = 0;
    try {
      const entry = journalEntry();
      const worker = new JournaledBroadcaster(new ExecutionJournal(directory), {
        sendRawTransaction: async () => {
          broadcasts++;
          throw new Error('accepted then timeout');
        },
        receipt: async () => null,
      });
      expect((await worker.submit(entry)).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      expect((await worker.submit(entry)).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      await expect(
        worker.submit({
          ...entry,
          rawTransaction: '0x5678',
          transactionHash: keccak256('0x5678'),
        }),
      ).rejects.toThrow('GRANT_REPREPARATION_FORBIDDEN');
      expect(broadcasts).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
