import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { monadTestnetProfile } from '@synq/chain-registry';
import {
  createIntentKernel,
  kernelStateFromReadModel,
} from '../../apps/api/src/kernel-runtime.js';
import {
  parseV1Environment,
  startV1Server,
} from '../../apps/api/src/v1-server.js';
import {
  artifactHash,
  onchainMandateId,
} from '../../packages/kernel/src/index.js';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  registerMandateArtifacts,
} from '../../packages/read-model/src/index.js';
import {
  account,
  address,
  chainId,
  config,
  creation,
  ev,
  funding,
  groupId,
  mandateTerms,
  owners,
} from '../read-model/fixtures.js';
import {
  AUSD,
  sandboxManifest,
  sandboxMandate,
  sandboxProposal,
  type SandboxGroup,
} from './kernel-fixture.js';

const NOW = 1_000_000;
const BASE_ENV = {
  SYNQ_DATABASE_URL: 'postgresql://127.0.0.1:1/unused',
  SYNQ_RP_ID: 'localhost',
  SYNQ_ORIGIN: 'http://localhost',
  SYNQ_API_ADMIN_TOKEN: 'a'.repeat(64),
};
const group: SandboxGroup = {
  groupId,
  chainGroupId: groupId,
  account,
  executor: address(0xe1),
  recipient: address(0xbb),
  members: owners.map((signer, i) => ({ memberId: `member_${i}`, signer })),
};

async function projected(register: 'canonical' | 'tampered' | 'none') {
  const mandate = sandboxMandate(group, NOW);
  const cfg = config();
  const store = new MemoryProjectionStore(chainId);
  await new Projector(store, cfg).applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 103,
    events: [
      ...creation(101),
      funding(102),
      ev('MandateConfigured', 103, {
        groupId,
        account,
        mandateId: onchainMandateId(mandate),
        version: '1',
        ...mandateTerms,
        mandateHash: artifactHash(mandate),
      }),
    ],
  });
  if (register === 'canonical')
    await registerMandateArtifacts(store, [
      { mandateHash: artifactHash(mandate), artifact: mandate },
    ]);
  if (register === 'tampered')
    await store.transaction((s) =>
      s.saveArtifact({
        mandateHash: artifactHash(mandate),
        artifact: { ...mandate, perActionCap: '1' },
      }),
    );
  return { mandate, cfg, reader: new ProjectionReader(store, cfg) };
}

describe('production v1 server Kernel wiring', () => {
  it('fails fast when a non-local profile lacks Kernel configuration', async () => {
    expect(() =>
      parseV1Environment({
        ...BASE_ENV,
        SYNQ_PROFILE: 'sandbox/monad-testnet',
      }),
    ).toThrow(
      /SYNQ_RM_DATABASE_URL.*SYNQ_RM_REDIS_URL.*SYNQ_KERNEL_AUDIT_KEY_FILE.*SYNQ_KERNEL_PLUGINS_FILE/,
    );
    await expect(
      startV1Server({ ...BASE_ENV, SYNQ_PROFILE: 'sandbox/monad-testnet' }),
    ).rejects.toThrow('Invalid API configuration');
    expect(
      parseV1Environment({ ...BASE_ENV, SYNQ_PROFILE: 'local/anvil' })
        .SYNQ_PROFILE,
    ).toBe('local/anvil');
  });

  it('loads mandates and balances from registered canonical artifacts and composes a Kernel that authorizes', async () => {
    const { mandate, cfg, reader } = await projected('canonical');
    const state = await kernelStateFromReadModel(reader);
    expect(state.mandates).toEqual([mandate]);
    expect(state.balances).toEqual([
      { account, asset: AUSD, balance: '1000000' },
    ]);
    expect(state.balanceBlock).toBe('103');
    const head = new ChainHeadObserver(
      {
        getBlockNumber: async () => 103n,
        getChainId: async () => chainId,
      },
      chainId,
      { ttlMs: 0 },
    );
    const kernel = createIntentKernel({
      network: monadTestnetProfile.network,
      executionModule: cfg.module,
      clock: { now: () => NOW },
      identity: {
        approvalLedger: { isConsumed: async () => false },
        membershipDirectory: {
          activeMember: async () => null,
          membershipEpoch: async () => null,
        },
      },
      client: {} as PublicClient,
      projection: cfg,
      snapshots: async () => reader,
      head,
      maxLagBlocks: 5,
      auditKey: new Uint8Array(32).fill(7),
      plugins: [sandboxManifest],
      state,
    });
    expect(kernel.mandate(mandate.groupId, mandate.mandateId)).toEqual(mandate);
    const decision = await kernel.authorize({
      ...sandboxProposal(kernel, group, {
        amount: 400_000n,
        nonce: '1',
        now: NOW,
      }),
      approvals: [],
    });
    expect(decision).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(kernel.auditLog().at(-1)?.payload).toMatchObject({
      status: 'PENDING_APPROVAL',
    });
  });

  it('refuses a tampered artifact and ignores mandates without a registered artifact', async () => {
    const tampered = await projected('tampered');
    await expect(kernelStateFromReadModel(tampered.reader)).rejects.toThrow(
      'MANDATE_ARTIFACT_MISMATCH',
    );
    const missing = await projected('none');
    expect((await kernelStateFromReadModel(missing.reader)).mandates).toEqual(
      [],
    );
  });
});
