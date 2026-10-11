import type { CriticReasoner, StructuredReasoner } from '@synq/agent-runtime';
import { SynqBrain } from '@synq/agent-runtime';
import type { ChannelPorts } from '@synq/channels';
import { KimiReasoner, kimiOptionsFromEnv } from '@synq/plugin-kimi';
import {
  OpenAIStructuredReasoner,
  openAIOptionsFromEnv,
} from '@synq/plugin-openai';
import { QwenStructuredReasoner, qwenOptionsFromEnv } from '@synq/plugin-qwen';
import type {
  GrantDraft,
  NetworkProfile,
  WorldModelSnapshot,
} from '@synq/schemas';
import type { MarketDataSource, RiskStateSource } from '@synq/world-model';
import {
  KernelProposalGateway,
  type KernelAuthorizer,
  type SimulationSource,
} from './brain-runtime.js';
import { brainChannelPort } from './channel-runtime.js';

export type BrainReasoners = {
  structured: StructuredReasoner;
  critic: CriticReasoner;
  /** Honest provider label for evidence, e.g. "openai:gpt-5.6-luna (LIVE)". */
  label: string;
};

/**
 * OpenAI when OPENAI_API_KEY is set (not a sponsor integration), otherwise
 * Qwen + Kimi when both keys are set, otherwise no live Brain.
 */
export function brainReasonersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): BrainReasoners | null {
  const openai = openAIOptionsFromEnv(env);
  if (openai.mode === 'LIVE') {
    const r = new OpenAIStructuredReasoner(openai);
    return { structured: r, critic: r, label: `openai:${r.model} (LIVE)` };
  }
  const qwen = qwenOptionsFromEnv(env);
  const kimi = kimiOptionsFromEnv(env);
  if (qwen.mode === 'LIVE' && kimi.mode === 'LIVE') {
    const structured = new QwenStructuredReasoner(qwen);
    const critic = new KimiReasoner(kimi);
    return {
      structured,
      critic,
      label: `qwen:${structured.model} + kimi:${critic.model} (LIVE)`,
    };
  }
  return null;
}

/**
 * Chat → Brain → KernelProposalGateway. Action drafts go to the Kernel with
 * no approvals; mandate drafts become owner-approved Safe proposals.
 */
export function channelBrain(input: {
  reasoners: Pick<BrainReasoners, 'structured' | 'critic'>;
  world: { build(target: { groupId: string }): Promise<WorldModelSnapshot> };
  kernel: KernelAuthorizer;
  market: MarketDataSource;
  risk?: RiskStateSource;
  network: NetworkProfile;
  simulations: SimulationSource;
  now: () => number;
  registerDraft(draft: GrantDraft): Promise<void>;
  drafts: Parameters<typeof brainChannelPort>[0]['drafts'];
  proposeMandate: NonNullable<
    Parameters<typeof brainChannelPort>[0]['proposeMandate']
  >;
}): NonNullable<ChannelPorts['brain']> {
  return brainChannelPort({
    drafts: input.drafts,
    proposeMandate: input.proposeMandate,
    run: async ({ runId, groupId, memberId, text }) => {
      const snapshot = await input.world.build({ groupId });
      const proposals = new KernelProposalGateway({
        kernel: input.kernel,
        market: input.market,
        ...(input.risk ? { risk: input.risk } : {}),
        network: input.network,
        mainnetBroadcastAllowed: false,
        simulations: input.simulations,
        clock: { now: input.now },
        onPendingDraft: input.registerDraft,
      });
      return new SynqBrain({
        structured: input.reasoners.structured,
        critic: input.reasoners.critic,
        proposals,
        executionMode: proposals.executionMode,
        authenticateMessage: async (m) => {
          const member = snapshot.members.value.find(
            (x) => x.memberId === m.memberId,
          );
          return m.groupId === groupId && member
            ? { memberId: member.memberId, principalId: member.principalId }
            : null;
        },
        nowSeconds: input.now,
      }).run({
        runId,
        groupId,
        world: snapshot,
        messages: [{ memberId, text }],
        fixtureKey: runId,
      });
    },
  });
}
