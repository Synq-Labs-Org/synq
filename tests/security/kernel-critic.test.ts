import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { Kernel, artifactHash } from '../../packages/kernel/src/index.js';
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
  ACCOUNT,
  allPlugins,
  approve,
  asset,
  authorizeWith,
  evidence,
  executedObservation,
  expectDraft,
  grantFor,
  harness,
  hash,
  intent,
  mandate,
  manifest,
  network,
  now,
  owners,
  type Prepared,
} from '../kernel/fixtures.js';

const callHash = hash(0xca11);

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
      MandateSchema.safeParse({ ...mandate(), perActionCap: '1e18' }).success,
    ).toBe(false);
  });

  it('does not accept attacker-selected trust attestations in an authorization request', async () => {
    const input = evidence(intent());
    const h = harness([], [mandate()]);
    expect(
      await h.kernel.authorize({
        ...input,
        approvals: [],
        trustedEvidence: {
          riskPacketHashes: [artifactHash(input.risk)],
          simulationHashes: [artifactHash(input.simulation)],
        },
      }),
    ).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      { status: 'RISK_REJECTED', code: 'EVIDENCE_MISMATCH' },
    );
  });

  it('AUSD-003 rejects a symbol-only AUSD impersonation despite a valid canonical address', async () => {
    expect(() =>
      intent({ inputAsset: { ...asset, symbol: 'AUSD' } }),
    ).toThrow();
    const data = evidence(intent({ inputToken: `0x${'b'.repeat(40)}` }));
    expect(
      await harness(data).kernel.authorize({ ...data, approvals: [] }),
    ).toMatchObject({ status: 'POLICY_REJECTED', code: 'ASSET_FORBIDDEN' });
  });

  it('copies governance inputs and does not expose mutable stored mandate records', async () => {
    const input = evidence(intent());
    const policy = mandate();
    const h = harness(input, [policy]);
    policy.bindings.push({ ...policy.bindings[0]!, target: ACCOUNT });
    const resolved = h.kernel.mandate('group_1', 'mandate_1');
    resolved.members[0]!.signer = `0x${'9'.repeat(40)}`;
    resolved.perActionCap = '1000';
    expect(h.kernel.mandate('group_1', 'mandate_1').bindings).toHaveLength(1);
    expect(h.kernel.mandate('group_1', 'mandate_1').perActionCap).toBe('100');
    expect((await authorizeWith(h, input)).status).toBe('AUTHORIZED');
  });

  it('requires distinct signatures and rejects reused signatures under another member identity', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const [a, b] = await approve(h, draft);
    const reused = { ...b!, signature: a!.signature };
    h.ledger.consumed.set(reused.approvalId, artifactHash(reused));
    expect(
      await h.kernel.authorize({ ...input, approvals: [a, reused] }),
    ).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'APPROVAL_SIGNATURE_INVALID',
    });
  });

  it.each([
    { maxInputAmount: '61' },
    { calldataHash: `0x${'7'.repeat(64)}` },
    { nonce: '2' },
    { validUntil: 1499 },
    { pluginId: 'second-transfer' },
    { target: `0x${'b'.repeat(40)}`, inputToken: `0x${'b'.repeat(40)}` },
  ])(
    'rejects old signed approvals after an otherwise allowed economic mutation %j',
    async (patch) => {
      const original = evidence(intent());
      const changed = evidence(intent(patch));
      const policy = mandate({
        bindings: [
          mandate().bindings[0]!,
          { ...mandate().bindings[0]!, pluginId: 'second-transfer' },
        ],
      });
      const h = harness([original, changed], [policy]);
      const draft = expectDraft(
        await h.kernel.authorize({ ...original, approvals: [] }),
      );
      const result = await h.kernel.authorize({
        ...changed,
        approvals: await approve(h, draft),
      });
      expect(result.status).not.toBe('AUTHORIZED');
    },
  );

  it('reserves a shared treasury atomically across different mandates under concurrent issuance', async () => {
    const one = evidence(intent());
    const two = evidence(intent({ mandateId: 'second', nonce: '2' }));
    const h = harness(
      [one, two],
      [mandate(), mandate({ mandateId: 'second' })],
      {
        balances: [{ account: ACCOUNT, asset, balance: '100' }],
      },
    );
    const results = await Promise.all([
      authorizeWith(h, one),
      authorizeWith(h, two),
    ]);
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    expect(
      h.kernel
        .snapshot()
        .budgets.reduce((n, [, b]) => n + BigInt(b.reservedToken), 0n),
    ).toBe(60n);
  });

  it('SEC-011/SEC-023 concurrent duplicate nonces issue exactly one grant and remain locked after restart', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.kernel.authorize({ ...input, approvals }),
      ),
    );
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(h.kernel.snapshot())),
      {
        clock: h.clock,
        approvalLedger: h.ledger,
        membershipDirectory: h.directory,
        freshness: { probe: h.probe, maxLagBlocks: 0 },
        plugins: allPlugins(),
      },
    );
    expect(await restored.authorize({ ...input, approvals })).toMatchObject({
      status: 'POLICY_REJECTED',
      code: 'NONCE_REPLAY',
    });
  });

  it('consumed reservations survive expiry and restart until single reconciliation', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const claim = h.kernel.claimForExecution(grant, input.intent, 'worker');
    h.kernel.prepare(claim, callHash);
    h.clock.t = now + 100;
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(h.kernel.snapshot())),
      {
        clock: h.clock,
        approvalLedger: h.ledger,
        membershipDirectory: h.directory,
        freshness: { probe: h.probe, maxLagBlocks: 0 },
        plugins: [manifest],
      },
    );
    expect(await restored.releaseExpired()).toBe(0);
    expect(() =>
      restored.claimForExecution(grant, input.intent, 'other'),
    ).toThrow('GRANT_REPLAY');
    restored.reconcile(
      grant.grantId,
      executedObservation(grant, { tokenAmount: '55' }),
    );
    expect(restored.accounting('group_1', 'mandate_1')).toMatchObject({
      spentToken: '55',
      reservedToken: '0',
    });
    expect(() =>
      restored.reconcile(grant.grantId, executedObservation(grant)),
    ).toThrow('RECONCILIATION_INVALID');
  });

  it('does not grant execution authority beyond the signed draft validity', async () => {
    const input: Prepared = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    h.clock.t = Number(draft.grant.validUntil);
    expect(await h.kernel.authorize({ ...input, approvals })).toMatchObject({
      status: 'EXPIRED',
      code: 'DRAFT_EXPIRED',
      state: 'PENDING_APPROVAL',
    });
    const g = harness(input);
    const { grant } = await grantFor(g, input);
    g.clock.t = grant.validUntil;
    expect(() =>
      g.kernel.claimForExecution(grant, input.intent, 'late'),
    ).toThrow('GRANT_EXPIRED');
    expect(owners).toHaveLength(3);
    expect(network.chainId).toBe(31337);
  });

  it('enforces the intent slippage ceiling as well as the broader mandate ceiling', async () => {
    const data = evidence(intent({ maxInputAmount: '10', maxSlippageBps: 1 }), {
      slippageBps: 50,
    });
    expect(
      await harness(data).kernel.authorize({ ...data, approvals: [] }),
    ).toMatchObject({ status: 'RISK_REJECTED', code: 'RISK_REJECTED' });
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
  }, 30_000);

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
