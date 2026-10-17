import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  createWalletClient,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { MandateSchema, type MembershipDirectory } from '@synq/schemas';
import { onchainMandateId } from '@synq/kernel';
import { registryAbi, safeAbi } from '@synq/execution-worker/abi';
import { safeTransactionTypedData } from '@synq/identity/server';
import {
  MandateProposalService,
  MemoryMandateProposalStore,
  kernelMandateCheck,
} from '../../apps/api/src/mandate-proposals.js';
import { mandateRoutes } from '../../apps/api/src/mandate-routes.js';
import { productionChannelPorts } from '../../apps/api/src/channel-runtime.js';
import { executeReadyMandates } from '../../apps/demo/src/governance-executor.js';
import { testDatabaseUrl } from '../durable/pg.js';

process.env.SYNQ_DEMO_DATABASE_URL ??= testDatabaseUrl(
  'SYNQ_UNUSED_TEST_DATABASE_URL',
  'synq_channels_mandate_demo',
);
type Local = Awaited<
  ReturnType<
    (typeof import('../../apps/demo/src/local.js'))['startLocalVertical']
  >
>;
let local: Local;
beforeAll(async () => {
  const { startLocalVertical } = await import('../../apps/demo/src/local.js');
  local = await startLocalVertical();
}, 180_000);
afterAll(async () => {
  await local?.close();
});

it('a Brain mandate proposal activates only after verified Safe-owner approvals and a relayed Safe transaction', async () => {
  const groupId = 'local_group';
  const revoked = new Set<string>();
  const base = local.identity.membershipDirectory;
  const directory: MembershipDirectory = {
    membershipEpoch: (g) => base.membershipEpoch(g),
    activeMember: async (g, m) =>
      revoked.has(m) ? null : base.activeMember(g, m),
  };
  const client = local.chain.client as unknown as PublicClient;
  const store = new MemoryMandateProposalStore();
  const service = new MandateProposalService({
    store,
    directory,
    group: async (g) => {
      const r = await local.identity.store.transaction((tx) => tx.getGroup(g));
      return r
        ? {
            account: r.account,
            owners: r.owners,
            threshold: r.threshold,
            chainId: r.chainId,
          }
        : null;
    },
    safe: {
      nonce: (safe) =>
        client.readContract({
          address: safe,
          abi: safeAbi,
          functionName: 'nonce',
        }),
      transactionHash: (tx) =>
        client.readContract({
          address: tx.safe,
          abi: safeAbi,
          functionName: 'getTransactionHash',
          args: [
            tx.to,
            0n,
            tx.data,
            0,
            0n,
            0n,
            0n,
            zeroAddress,
            zeroAddress,
            tx.nonce,
          ],
        }),
    },
    registry: local.chain.registry,
    chainId: local.asset.chainId,
    kernelCheck: kernelMandateCheck(() => local.kernel.listMandates()),
    now: () => local.clock.now(),
  });
  const proposed = MandateSchema.parse({
    ...local.mandate,
    mandateId: 'chat_mandate',
    perActionCap: '5000000',
  });

  await expect(
    service.propose({
      groupId,
      mandate: local.mandate,
      change: 'NEW',
      proposedBy: { memberId: 'member_0', source: 'BRAIN' },
    }),
  ).rejects.toMatchObject({ code: 'MANDATE_INVALID' });
  const p = await service.propose({
    groupId,
    mandate: proposed,
    change: 'NEW',
    proposedBy: { memberId: 'member_0', source: 'BRAIN' },
  });
  expect(p.state).toBe('PENDING');
  expect(p.required).toBe(2);

  const app = Fastify();
  await app.register(mandateRoutes, { service, adminToken: 'x'.repeat(32) });
  const tx = {
    safe: p.safeTx.safe as Address,
    chainId: p.safeTx.chainId,
    to: p.safeTx.to as Address,
    data: p.safeTx.data as `0x${string}`,
    nonce: BigInt(p.safeTx.nonce),
  };
  const [o0, o1, o2] = local.chain.owners;
  const sign = (o: typeof o0) => o!.signTypedData(safeTransactionTypedData(tx));
  const approve = (memberId: string, signature: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/mandate-proposals/${p.proposalId}/approvals`,
      payload: { memberId, signature },
    });

  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/mandate-proposals',
        payload: { groupId, mandate: proposed, change: 'NEW' },
      })
    ).statusCode,
  ).toBe(401);
  expect((await approve('member_1', await sign(o0))).json().error).toBe(
    'SIGNATURE_INVALID',
  );
  expect((await approve('member_9', await sign(o0))).json().error).toBe(
    'NOT_A_MEMBER',
  );
  const first = (await approve('member_0', await sign(o0))).json();
  expect(first.counted).toHaveLength(1);
  expect(
    (await approve('member_0', await sign(o0))).json().counted,
  ).toHaveLength(1);

  const ports = productionChannelPorts({
    send: {
      groups: { context: async () => null },
      treasury: { view: async () => null },
    },
    sends: { list: async () => [] },
    approvals: {
      drafts: async () => [],
      quorum: async () => {
        throw new Error('unused');
      },
    },
    executionMode: 'SIMULATION',
    mandateProposals: service,
  });
  expect((await ports.approvals(groupId))[0]).toMatchObject({
    kind: 'MANDATE',
    counted: 1,
    required: 2,
    status: 'PENDING',
    reviewPath: `/mandates/${p.proposalId}`,
  });

  await approve('member_1', await sign(o1));
  revoked.add('member_1');
  expect((await service.view(p.proposalId)).counted).toHaveLength(1);
  expect(await service.signatures(p.proposalId)).toBeNull();
  revoked.delete('member_1');
  await approve('member_2', await sign(o2));
  expect((await service.view(p.proposalId)).proposal.state).toBe('READY');
  expect((await ports.approvals(groupId))[0]!.status).toBe('SATISFIED');

  const wallet = createWalletClient({
    account: local.chain.executor,
    transport: http(local.node.url),
  });
  const executed = await executeReadyMandates({
    service,
    client,
    wallet,
    operator: local.chain.executor.address,
    onExecuted: async (proposal) =>
      void local.kernel.configureMandate(proposal.mandate),
  });
  expect(executed).toHaveLength(1);
  const state = await client.readContract({
    address: local.chain.registry,
    abi: registryAbi,
    functionName: 'mandateState',
    args: [local.chain.account, onchainMandateId(proposed)],
  });
  expect(state.currentVersion).toBe(1n);
  expect(
    local.kernel.listMandates().some((m) => m.mandateId === 'chat_mandate'),
  ).toBe(true);
  expect((await service.view(p.proposalId)).proposal).toMatchObject({
    state: 'EXECUTED',
    executionTx: executed[0]!.transactionHash,
  });
  expect(await ports.receipts(groupId)).toEqual([
    expect.objectContaining({
      transactionHash: executed[0]!.transactionHash,
      label: expect.stringContaining('activated by Safe owners'),
    }),
  ]);
  expect((await approve('member_0', await sign(o0))).json().error).toBe(
    'PROPOSAL_NOT_PENDING',
  );
  expect(
    await executeReadyMandates({
      service,
      client,
      wallet,
      operator: local.chain.executor.address,
    }),
  ).toEqual([]);
  await app.close();
}, 180_000);
