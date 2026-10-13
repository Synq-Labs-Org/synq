import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';
import { Kernel } from '../../packages/kernel/src/index.js';
import {
  ActionIntentSchema,
  MandateSchema,
  RiskPacketSchema,
  SimulationSchema,
} from '../../packages/schemas/src/index.js';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  ReadModelAuthorizationAdapter,
  RedisSnapshotCache,
} from '../../packages/read-model/src/index.js';
import { decodeRow } from '../../packages/read-model/src/storage.js';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  JournalEntrySchema,
} from '../../workers/execution/src/journal.js';
import {
  chainGrant,
  prepareModuleCall,
} from '../../workers/execution/src/index.js';
import { tokenAbi } from '../../workers/execution/src/abi.js';
import {
  RECIPIENT,
  allPlugins,
  approve,
  asset,
  evidence,
  expectDraft,
  grantFor,
  harness,
  intent,
  mandate,
  type Harness,
  AUDIT_KEY,
} from '../kernel/fixtures.js';
import {
  chainId,
  config as readModelConfig,
  groupId,
  lifecycle,
} from '../read-model/fixtures.js';

describe('independent foundation release review', () => {
  it('strict financial ingress rejects extra fields at every authorization boundary', async () => {
    const input = evidence(intent());
    expect(
      ActionIntentSchema.safeParse({ ...input.intent, bypassPolicy: true })
        .success,
    ).toBe(false);
    expect(
      ActionIntentSchema.safeParse({
        ...input.intent,
        inputAsset: { ...asset, privileged: true },
      }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({
        ...mandate(),
        members: [{ ...mandate().members[0], ownerOverride: true }],
      }).success,
    ).toBe(false);
    expect(
      RiskPacketSchema.safeParse({ ...input.risk, trustOverride: true })
        .success,
    ).toBe(false);
    expect(
      SimulationSchema.safeParse({ ...input.simulation, bypass: true }).success,
    ).toBe(false);
    const h = harness(input);
    expect(
      await h.kernel.authorize({ ...input, approvals: [], bypass: true }),
    ).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('authorization remains bound to the copied request across signature recovery awaits', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const request = {
      ...structuredClone(input),
      approvals: await approve(h, draft),
    };
    const pending = h.kernel.authorize(request);
    request.intent.maxInputAmount = '100';
    request.intent.target = `0x${'9'.repeat(40)}`;
    request.intent.inputToken = `0x${'8'.repeat(40)}`;
    request.risk.slippageBps = 10000;
    request.simulation.succeeded = false;
    request.approvals[1]!.signature = request.approvals[0]!.signature;
    const result = await pending;
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.grant).toMatchObject({
      maxInputAmount: '60',
      target: input.intent.target,
      validAfter: 900,
      inputAsset: { decimals: 6 },
    });
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe(
      '60',
    );
  });

  it('governance revocation during signature recovery invalidates pending authorization', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    const pending = h.kernel.authorize({ ...input, approvals });
    h.kernel.revokeMandate('group_1', 'mandate_1');
    expect(await pending).toMatchObject({
      status: 'POLICY_REJECTED',
      code: 'MANDATE_REVOKED',
    });
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });

  it.each([
    'reservedToken',
    'spentToken',
    'issued',
    'lastIssued',
    'nonces',
    'grantKey',
  ] as const)(
    'restore rejects inconsistent %s rather than reconstructing spend authority',
    async (field) => {
      const input = evidence(intent());
      const h: Harness = harness(input);
      await grantFor(h, input);
      const snapshot = h.kernel.snapshot();
      if (field === 'nonces') snapshot.nonces = [];
      else if (field === 'grantKey')
        snapshot.grants[0]!.grant.grantId = `0x${'f'.repeat(64)}`;
      else if (field === 'reservedToken' || field === 'spentToken')
        snapshot.budgets[0]![1][field] = '1';
      else snapshot.budgets[0]![1][field] = 2;
      expect(() =>
        Kernel.restore(snapshot, {
          clock: h.clock,
          auditKey: AUDIT_KEY,
          approvalLedger: h.ledger,
          membershipDirectory: h.directory,
          freshness: { probe: h.probe, maxLagBlocks: 0 },
          plugins: allPlugins(),
        }),
      ).toThrow('SNAPSHOT_INVALID');
    },
  );

  it('SEC-007/SEC-019 signer preparation rejects substituted calldata and explicitly disables mainnet', async () => {
    const data = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'transfer',
      args: [RECIPIENT, 60n],
    });
    const input = evidence(intent({ calldataHash: keccak256(data) }));
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const claim = h.kernel.claimForExecution(grant, input.intent, 'worker');
    const substituted = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'transfer',
      args: [`0x${'6'.repeat(40)}`, 60n],
    });
    expect(() =>
      prepareModuleCall(h.kernel, claim, substituted, [asset]),
    ).toThrow('PREPARED_CALL_MISMATCH');
    expect(prepareModuleCall(h.kernel, claim, data, [asset]).chainId).toBe(
      31337,
    );
    expect(() => prepareModuleCall(h.kernel, claim, data, [asset])).toThrow(
      'GRANT_NOT_PREPARABLE',
    );
    expect(() => chainGrant({ ...grant, chainId: 143 })).toThrow();
  });

  it('journal rejects terminal confirmation without a canonical block', () => {
    const rawTransaction = '0x1234' as const;
    const entry = {
      schemaVersion: 1,
      grantId: `0x${'1'.repeat(64)}`,
      transactionHash: keccak256(rawTransaction),
      rawTransaction,
      chainId: 31337,
      state: 'CONFIRMED',
      blockNumber: null,
    };
    expect(JournalEntrySchema.safeParse(entry).success).toBe(false);
    expect(
      JournalEntrySchema.safeParse({ ...entry, blockNumber: '01' }).success,
    ).toBe(false);
  });

  it('durable fingerprint exists before broadcast and RPC hash mismatch requires reconciliation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'synq-release-'));
    try {
      const journal = new ExecutionJournal(directory);
      const rawTransaction = '0x1234' as const;
      const entry = JournalEntrySchema.parse({
        schemaVersion: 1,
        grantId: `0x${'1'.repeat(64)}`,
        transactionHash: keccak256(rawTransaction),
        rawTransaction,
        chainId: 31337,
        state: 'SIGNED',
        blockNumber: null,
      });
      let broadcasts = 0;
      const port = {
        sendRawTransaction: async () => {
          broadcasts++;
          expect(journal.get(entry.grantId)).toEqual(entry);
          return `0x${'f'.repeat(64)}` as `0x${string}`;
        },
        receipt: async () => null,
      };
      expect(
        (await new JournaledBroadcaster(journal, port).submit(entry)).state,
      ).toBe('RECONCILIATION_REQUIRED');
      expect(
        (
          await new JournaledBroadcaster(
            new ExecutionJournal(directory),
            port,
          ).submit(entry)
        ).state,
      ).toBe('RECONCILIATION_REQUIRED');
      expect(broadcasts).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persisted projection rows are schema-checked on read instead of trusted', () => {
    const row = {
      account: `0x${'1'.repeat(40)}`,
      asset: `0x${'2'.repeat(40)}`,
      balance: '900000',
      baseline_block: '1',
      baseline_balance: '0',
      last_block: '3',
    };
    expect(decodeRow('balance', row)).toMatchObject({
      balance: '900000',
      last_block: 3,
    });
    expect(() => decodeRow('balance', { ...row, balance: '-1' })).toThrow(
      'INCONSISTENT_PROOF',
    );
    expect(() => decodeRow('balance', { ...row, last_block: 'x' })).toThrow(
      'INCONSISTENT_PROOF',
    );
  });

  it('corrupt cache cannot replace current durable state and stale proof requires successful direct verification', async () => {
    const store = new MemoryProjectionStore(chainId);
    const cfg = readModelConfig();
    await new Projector(store, cfg).applyWindow({
      fromBlockExclusive: 99,
      toBlockInclusive: 110,
      events: lifecycle(),
    });
    const reader = new ProjectionReader(store, cfg);
    const current = await reader.groupSnapshot(groupId);
    let replacement = '';
    const cache = new RedisSnapshotCache(
      {
        get: async (key) =>
          key.endsWith(':progress')
            ? null
            : JSON.stringify({
                ...current,
                group: {
                  ...current!.group,
                  treasury: [{ ...current!.group.treasury[0], balance: 'x' }],
                },
              }),
        set: async (key, value) => {
          if (!key.endsWith(':progress')) replacement = value;
        },
      },
      reader,
    );
    expect(await cache.groupSnapshot(groupId)).toEqual(current);
    expect(JSON.parse(replacement).group.treasury[0].balance).toBe('750000');
    const stale = new ReadModelAuthorizationAdapter({
      source: reader,
      head: new ChainHeadObserver(
        { getBlockNumber: async () => 200n, getChainId: async () => chainId },
        chainId,
      ),
      verifier: null,
      maxLagBlocks: 2,
    });
    await expect(stale.readForAuthorization(groupId)).rejects.toThrow(
      'STALE_INDEX',
    );
  });

  it(
    'the actual foundation dependency graph passes deterministic authority and signer separation checks',
    { timeout: 30_000 },
    () => {
      expect(checkArchitecture(process.cwd())).toEqual([]);
    },
  );

  it.each(['directSDK', 'transitiveWorker'] as const)(
    'architecture prevents planner signing access through %s',
    (path) => {
      const directory = mkdtempSync(join(tmpdir(), 'synq-release-boundary-'));
      try {
        mkdirSync(join(directory, 'packages/brain'), { recursive: true });
        if (path === 'directSDK') {
          writeFileSync(
            join(directory, 'packages/brain/index.ts'),
            "import { privateKeyToAccount } from 'viem/accounts';\nexport const sign = privateKeyToAccount;\n",
          );
        } else {
          mkdirSync(join(directory, 'packages/adapter'), { recursive: true });
          mkdirSync(join(directory, 'workers/execution'), { recursive: true });
          writeFileSync(
            join(directory, 'packages/brain/index.ts'),
            "import '../../packages/adapter/index.js';\n",
          );
          writeFileSync(
            join(directory, 'packages/adapter/index.ts'),
            "export { sign } from '../../workers/execution/index.js';\n",
          );
          writeFileSync(
            join(directory, 'workers/execution/index.ts'),
            'export const sign = () => {};\n',
          );
        }
        expect(
          checkArchitecture(directory).some((message) =>
            message.includes('signing authority'),
          ),
        ).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
