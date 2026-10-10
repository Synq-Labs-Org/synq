import { describe, expect, it } from 'vitest';
import { EvidenceArtifactSchema, evidenceArtifactHash } from '@synq/schemas';
import { artifactHash } from '../../packages/kernel/src/index.js';
import {
  GROUP,
  SUPPORT,
  action,
  brainFor,
  chatFixture,
  economicState,
  evalWorld,
} from './harness.js';

const conversation = [
  {
    memberId: 'member_0',
    text: 'Please pay our counterparty 0.00006 of the group token today.',
  },
  { memberId: 'member_1', text: 'Agreed, pay them.' },
];

describe('SynqBrain end to end through Mastra, replay adapters and the real Kernel', () => {
  it('turns group text into a validated intent that the Kernel holds for human approval', async () => {
    const world = await evalWorld();
    const snapshot = await world.builder.build({ groupId: GROUP });
    const before = economicState(world.kernel);
    const brain = brainFor(world, {
      qwen: chatFixture('qwen', [
        { key: 'ok:intent', content: { items: [action()] } },
      ]),
      kimi: chatFixture('kimi', [{ key: 'ok:critic', content: SUPPORT }]),
    });
    const result = await brain.run({
      runId: 'run_ok',
      groupId: GROUP,
      world: snapshot,
      messages: conversation,
      fixtureKey: 'ok',
    });
    expect(result.findings).toEqual([]);
    expect(result.status).toBe('COMPLETED');
    const [item] = result.items;
    expect(item?.status).toBe('SUBMITTED');
    expect(item?.decision?.status).toBe('PENDING_APPROVAL');
    expect(item?.decision?.draftDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(item?.decision?.evidenceHash).toMatch(/^0x/);
    expect(world.kernel.kernel.stateView().grants).toEqual([]);
    expect(economicState(world.kernel)).toBe(before);
    const artifact = EvidenceArtifactSchema.parse(item!.evidenceArtifact);
    expect(evidenceArtifactHash(artifact)).toBe(artifactHash(artifact));
    expect(
      artifact.modelCalls.map((c) => [
        c.role,
        c.provider,
        c.mode,
        c.fixtureLabel,
      ]),
    ).toEqual([
      ['INTENT', 'qwen', 'REPLAY', 'HAND_AUTHORED_FIXTURE'],
      ['CRITIC', 'kimi', 'REPLAY', 'HAND_AUTHORED_FIXTURE'],
      ['FUNDING', 'qwen', 'REPLAY', 'HAND_AUTHORED_FIXTURE'],
    ]);
    expect(artifact.costs.inputTokens).toBe(3_600);
    expect(artifact.costs.subagentsSpawned).toBe(3);
    expect(artifact.untrustedEvidence.every((e) => e.untrusted)).toBe(true);
    expect(result.spans.map((s) => s.name)).toContain('brain.propose_action');
  });
});
