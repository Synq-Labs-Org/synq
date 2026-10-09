import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';
import {
  Kernel,
  approvalTypedData,
  artifactHash,
  type AuthorizationRequest,
} from '../../packages/kernel/src/index.js';
import {
  ActionIntentSchema,
  MandateSchema,
  RiskPacketSchema,
  SimulationSchema,
} from '../../packages/schemas/src/index.js';
import {
  ApprovalService,
  MemoryChallengeStore,
} from '../../packages/identity/src/index.js';
import {
  DeterministicReadModel,
  verifyFresh,
} from '../../packages/read-model/src/index.js';
import {
  PostgresReadModel,
  RedisSnapshotCache,
  type SqlConnection,
} from '../../packages/read-model/src/storage.js';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  JournalEntrySchema,
} from '../../workers/execution/src/journal.js';
import {
  chainGrant,
  prepareModuleCall,
} from '../../workers/execution/src/index.js';
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
import {
  binding,
  chainId,
  proof,
  treasuryToken,
} from '../read-model/fixtures.js';

function kernelFor(inputs: AuthorizationRequest[]) {
  return new Kernel({
    network,
    mandates: [mandate()],
    balances: [{ account: address(20), asset, balance: '1000' }],
    trustedEvidence: {
      riskPacketHashes: inputs.map((x) => artifactHash(x.risk)),
      simulationHashes: inputs.map((x) => artifactHash(x.simulation)),
    },
  });
}

describe('independent foundation release review', () => {
  it('strict financial ingress rejects extra fields at every authorization boundary', async () => {
    const input = await request();
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
  });

  it('authorization remains bound to the copied request across signature recovery awaits', async () => {
    const input = await request();
    const kernel = kernelFor([input]);
    const pending = kernel.authorize(input);
    input.intent.maxInputAmount = '100';
    input.intent.target = address(99);
    input.intent.inputAsset.decimals = 18;
    input.risk.slippageBps = 10000;
    input.simulation.succeeded = false;
    input.approvals[1]!.signature = input.approvals[0]!.signature;
    input.now = 5000;
    const result = await pending;
    expect(result.status).toBe('AUTHORIZED');
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.grant).toMatchObject({
      maxInputAmount: '60',
      target: address(10),
      validAfter: now,
      inputAsset: { decimals: 6 },
    });
    expect(kernel.accounting('group_1', 'mandate_1').reserved).toBe('60');
  });

  it('governance revocation during signature recovery invalidates pending authorization', async () => {
    const input = await request();
    const kernel = kernelFor([input]);
    const pending = kernel.authorize(input);
    kernel.mandates.update(mandate({ status: 'REVOKED' }));
    expect(await pending).toMatchObject({
      status: 'REJECTED',
      code: 'MANDATE_VERSION',
    });
    expect(kernel.accounting('group_1', 'mandate_1').reserved).toBe('0');
  });

  it.each([
    'reserved',
    'spent',
    'issued',
    'lastIssued',
    'nonces',
    'grantKey',
  ] as const)(
    'restore rejects inconsistent %s rather than reconstructing spend authority',
    async (field) => {
      const input = await request();
      const kernel = kernelFor([input]);
      expect((await kernel.authorize(input)).status).toBe('AUTHORIZED');
      const snapshot = kernel.snapshot();
      if (field === 'nonces') snapshot.nonces = [];
      else if (field === 'grantKey')
        snapshot.grants[0]![0] = `0x${'f'.repeat(64)}`;
      else if (field === 'reserved' || field === 'spent')
        snapshot.ledger[0]![1][field] = '1';
      else snapshot.ledger[0]![1][field] = 2;
      expect(() => Kernel.restore(snapshot)).toThrow('INVALID_INPUT');
    },
  );

  it('signer preparation rejects substituted calldata and explicitly disables mainnet', async () => {
    const data = '0xa9059cbb' as const;
    const input = {
      ...evidence(
        intent({ maxInputAmount: '10', calldataHash: keccak256(data) }),
      ),
      approvals: [],
      now,
    };
    const kernel = kernelFor([input]);
    const result = await kernel.authorize(input);
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(() =>
      prepareModuleCall(
        kernel,
        result.grant,
        input.intent,
        address(40),
        '0xa9059cbb00',
        '0x',
        now,
      ),
    ).toThrow('PREPARED_CALL_MISMATCH');
    expect(
      prepareModuleCall(
        kernel,
        result.grant,
        input.intent,
        address(40),
        data,
        '0x',
        now,
      ).chainId,
    ).toBe(31337);
    expect(() => chainGrant({ ...result.grant, chainId: 143 })).toThrow(
      'MAINNET_DISABLED',
    );
  });

  it('identity submission snapshots caller inputs before asynchronous challenge lookup', async () => {
    class DelayedStore extends MemoryChallengeStore {
      release: (() => void) | undefined;
      override async get(id: string) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
        return super.get(id);
      }
    }
    const store = new DelayedStore();
    const service = new ApprovalService(store, 'local');
    service.register({
      principalId: 'owner',
      kind: 'HUMAN',
      provider: 'fixture',
      signer: owners[0]!.address,
    });
    service.bindMembership('group_1', 'member_0', 'owner');
    const original = intent();
    const policy = mandate();
    const challenge = await service.issue(original, policy, 'member_0', now);
    const signed = {
      ...challenge.approval,
      signature: await owners[0]!.signTypedData(
        approvalTypedData(original, challenge.approval),
      ),
    };
    const substituted = intent({ maxInputAmount: '61' });
    const pending = service.submit(
      challenge.challengeId,
      signed,
      substituted,
      policy,
      now,
    );
    const rejection = expect(pending).rejects.toThrow('binding');
    substituted.maxInputAmount = original.maxInputAmount;
    store.release!();
    await rejection;
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

  it('persisted projection corruption is rejected against canonical event proof', async () => {
    const replay = new DeterministicReadModel(chainId, treasuryToken, [
      binding,
    ]);
    replay.ingest(proof(), 3);
    const snapshot = replay.snapshot(binding.groupId, 3, now);
    let state = snapshot;
    const db: SqlConnection = {
      query: async () => {
        return {
          rows: [
            {
              state_json: state,
              indexed_through_block: '3',
              revision: 1,
              proof_json: proof(),
              binding_json: {
                treasuryToken: treasuryToken.toLowerCase(),
                bindings: [binding],
              },
            },
          ],
        };
      },
    };
    const stored = new PostgresReadModel(db, chainId, treasuryToken, [binding]);
    await expect(stored.snapshot(binding.groupId, 3, now)).resolves.toEqual(
      snapshot,
    );
    state = { ...snapshot, treasuryBalance: '999999999' };
    await expect(stored.snapshot(binding.groupId, 3, now)).rejects.toThrow();
  });

  it('corrupt cache cannot replace current durable state and stale proof requires successful direct verification', async () => {
    const replay = new DeterministicReadModel(chainId, treasuryToken, [
      binding,
    ]);
    replay.ingest(proof(), 3);
    const current = replay.snapshot(binding.groupId, 10, now);
    let replacement = '';
    const cache = new RedisSnapshotCache(
      {
        get: async () =>
          JSON.stringify({ ...current, treasuryBalance: '999999' }),
        set: async (_key, value) => {
          replacement = value;
        },
      },
      { snapshot: async () => current },
    );
    expect(await cache.snapshot(binding.groupId, 10, now)).toEqual(current);
    expect(JSON.parse(replacement).treasuryBalance).toBe('900000');
    await expect(verifyFresh(current, 10, 2)).rejects.toThrow('Stale');
    await expect(
      verifyFresh(current, 10, 2, async () => false),
    ).rejects.toThrow('Stale');
    await expect(verifyFresh(current, 10, 2, async () => true)).resolves.toBe(
      'direct',
    );
  });

  it('the actual foundation dependency graph passes deterministic authority and signer separation checks', () => {
    expect(checkArchitecture(process.cwd())).toEqual([]);
  });

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
