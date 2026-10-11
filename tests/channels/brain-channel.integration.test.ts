import { createHash } from 'node:crypto';
import { formatDecimal } from '@synq/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { LOCAL_CHAIN_ID } from '@synq/schemas';
import { ChainHeadObserver } from '@synq/read-model';
import { FixtureFileSchema } from '@synq/agent-runtime';
import { OpenAIStructuredReasoner } from '@synq/plugin-openai';
import {
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
} from '@synq/world-model';
import { ChannelGateway, MemoryChannelStore } from '@synq/channels';
import {
  DeclaredSimulation,
  StoreIdentityDirectoryReader,
} from '../../apps/api/src/brain-runtime.js';
import { channelBrain } from '../../apps/api/src/channel-brain.js';
import {
  MandateProposalService,
  MemoryMandateProposalStore,
  kernelMandateCheck,
  safeReader,
} from '../../apps/api/src/mandate-proposals.js';
import { FakeAdapter } from './harness.js';

process.env.SYNQ_DEMO_DATABASE_URL ??=
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_channels_brain_demo';
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

const completion = (id: string, content: unknown) => ({
  status: 200,
  body: {
    id,
    object: 'chat.completion',
    created: 1_791_700_000,
    model: 'gpt-5.6-luna',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(content) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  },
});

it('chat /propose → OpenAI Brain (replay) → Kernel gateway → mandate proposal page, with no authority granted', async () => {
  const CHAT = '-100900';
  const eventId = 'update:4242';
  const runId = `chan_telegram_${createHash('sha256').update(eventId).digest('hex').slice(0, 16)}`;
  const decimals = local.decimals;
  const amount = (base: bigint) => ({
    display: formatDecimal(base, decimals),
    baseUnits: String(base),
    decimals,
  });
  const fixtures = FixtureFileSchema.parse({
    schemaVersion: 1,
    label: 'HAND_AUTHORED_FIXTURE',
    provider: 'openai',
    description:
      'Hand-authored OpenAI replay for the chat Brain test; not a recorded or live model response.',
    recordedAt: null,
    interactions: [
      {
        fixtureKey: `${runId}:intent`,
        method: 'POST',
        path: '/v1/chat/completions',
        requestBodyHash: null,
        response: completion('fx-intent', {
          items: [
            {
              kind: 'MANDATE',
              requestedBy: ['member_0'],
              change: 'NEW',
              baseMandateId: 'local_mandate',
              newMandateId: 'chat_reserve',
              goal: 'Reserve 20 tokens for payments to the agreed counterparty',
              action: 'TRANSFER',
              providerId: 'LOCAL_TRANSFER',
              network: 'local/anvil',
              inputToken: local.asset.address,
              outputToken: null,
              perActionCap: amount(10_000_000n),
              cumulativeBudget: amount(20_000_000n),
              recipients: [local.chain.recipient],
              cadenceSeconds: null,
              maxSlippageBps: 0,
              durationDays: 30,
              rationale:
                'Member asked for a bounded payment mandate; it only takes effect after owner approval.',
              ambiguities: [],
              uncertainty: 0.1,
            },
          ],
        }),
      },
      {
        fixtureKey: `${runId}:funding`,
        method: 'POST',
        path: '/v1/chat/completions',
        requestBodyHash: null,
        response: completion('fx-funding', {
          reviews: [
            {
              itemIndex: 0,
              verdict: 'PROCEED',
              notes: 'deterministic checks remain authoritative',
            },
          ],
          uncertainty: 0.1,
        }),
      },
      {
        fixtureKey: `${runId}:critic`,
        method: 'POST',
        path: '/v1/chat/completions',
        requestBodyHash: null,
        response: completion('fx-critic', {
          verdict: 'SUPPORT',
          issues: [],
          disagreements: [],
          uncertainty: 0.1,
        }),
      },
    ],
  });
  const reasoner = new OpenAIStructuredReasoner({ mode: 'REPLAY', fixtures });
  expect(reasoner.availability()).toMatchObject({
    providerId: 'OPENAI',
    mode: 'REPLAY',
  });

  const { reader } = await local.project();
  await local.sync();
  await local.plugins.refreshHealth('local-transfer', {
    network: local.mandate.network,
    now: local.clock.now(),
  });
  const world = new WorldSnapshotBuilder({
    network: local.mandate.network,
    now: () => local.clock.now(),
    readModel: {
      snapshots: reader,
      head: new ChainHeadObserver(local.chain.client, LOCAL_CHAIN_ID, {
        ttlMs: 0,
      }),
      maxLagBlocks: 5,
    },
    kernel: local.kernel,
    identity: new StoreIdentityDirectoryReader(local.identity.store),
    plugins: local.plugins,
    mainnetBroadcastAllowed: false,
    workflows: new InMemoryWorkflowStatusReader([], local.clock.now()),
    localAssets: [local.asset],
  });
  const store = new MandateProposalService({
    store: new MemoryMandateProposalStore(),
    directory: local.identity.membershipDirectory,
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
    safe: safeReader(local.chain.client as unknown as PublicClient),
    registry: local.chain.registry,
    chainId: local.asset.chainId,
    kernelCheck: kernelMandateCheck(() => local.kernel.listMandates()),
    now: () => local.clock.now(),
  });
  const brain = channelBrain({
    reasoners: { structured: reasoner, critic: reasoner },
    world,
    kernel: local.kernel,
    market: { quotes: async () => [] },
    network: local.mandate.network,
    simulations: new DeclaredSimulation(local.clock, 'channel-brain-test'),
    now: () => local.clock.now(),
    registerDraft: async () => undefined,
    drafts: async () => [],
    proposeMandate: async ({ groupId, memberId, mandate, change }) =>
      (
        await store.propose({
          groupId,
          mandate,
          change,
          proposedBy: { memberId, source: 'BRAIN' },
        })
      ).proposalId,
  });
  const adapter = new FakeAdapter();
  const channelStore = new MemoryChannelStore();
  const gateway = new ChannelGateway({
    store: channelStore,
    adapters: [adapter],
    ports: {
      activeMember: async (g, p) => {
        const ms = await local.identity.store.transaction((tx) =>
          tx.listMemberships(g),
        );
        const m = ms.find((x) => x.principalId === p && x.status === 'ACTIVE');
        return m ? { memberId: m.memberId } : null;
      },
      treasury: async () => null,
      mandates: async () => [],
      approvals: async () => [],
      receipts: async () => [],
      brain,
    },
    webBaseUrl: 'https://synq.test',
    explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
    now: () => Math.floor(Date.now() / 1000),
    botUsernames: { telegram: 'asksynqbot' },
    chatLinkQuorum: 1,
  });
  const groupId = local.mandate.groupId;
  const memberships = await local.identity.store.transaction((tx) =>
    tx.listMemberships(groupId),
  );
  const now = Math.floor(Date.now() / 1000);
  channelStore.groups.set(`telegram\u0000${CHAT}`, {
    channel: 'telegram',
    externalGroupId: CHAT,
    groupId,
    linkedByPrincipalId: memberships[0]!.principalId,
    linkedAt: now,
    status: 'ACTIVE',
  });
  channelStore.users.set(`telegram\u0000${CHAT}\u0000111`, {
    channel: 'telegram',
    externalGroupId: CHAT,
    externalUserId: '111',
    principalId: memberships[0]!.principalId,
    linkedAt: now,
    status: 'ACTIVE',
    confirmTokenHash: null,
  });

  const before = local.kernel.listMandates().length;
  const outcome = await gateway.handle({
    type: 'MESSAGE_RECEIVED',
    envelope: {
      channel: 'telegram',
      eventId,
      externalGroupId: CHAT,
      chatKind: 'GROUP',
      externalUserId: '111',
      messageId: '7',
      body: '/propose keep 20 tokens for payments to our counterparty, max 10 each',
      timestamp: now,
      replyTo: null,
      interaction: {
        kind: 'COMMAND',
        addressedToBot: true,
        command: 'propose',
        args: '',
        callbackData: null,
      },
      attachments: [],
      verifiedSender: {
        transport: 'FIXTURE',
        providerUserId: '111',
        displayName: '@alice',
        isBot: false,
      },
    },
  });
  expect(outcome).toMatchObject({ status: 'HANDLED', code: 'BRAIN' });
  const reply = adapter.last()!;
  expect(reply.text).toContain('Kernel: MANDATE REQUIRES_HUMAN_APPROVAL');
  const [proposal] = await store.list(groupId);
  expect(proposal).toMatchObject({
    state: 'PENDING',
    proposedBy: { source: 'BRAIN', memberId: 'member_0' },
  });
  expect(proposal!.mandate.mandateId).toBe('chat_reserve');
  expect(reply.buttons?.[0]?.url).toBe(
    `https://synq.test/mandates/${proposal!.proposalId}`,
  );
  expect(local.kernel.listMandates()).toHaveLength(before);
  expect(local.kernel.stateView().grants).toHaveLength(0);
}, 180_000);
