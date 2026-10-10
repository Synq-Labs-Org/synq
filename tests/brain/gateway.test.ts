import { describe, expect, it } from 'vitest';
import {
  EvidenceArtifactSchema,
  ProposalIdSchema,
  evidenceArtifactHash,
  type BrainActionProposal,
  type BrainMandateProposal,
} from '@synq/schemas';
import {
  DeclaredSimulation,
  KernelProposalGateway,
} from '../../apps/api/src/brain-runtime.js';
import { mandate } from '../kernel/fixtures.js';
import {
  GROUP,
  SUPPORT,
  action,
  brainFor,
  chatFixture,
  economicState,
  evalWorld,
} from './harness.js';

async function submitted() {
  const world = await evalWorld();
  const snapshot = await world.builder.build({ groupId: GROUP });
  const result = await brainFor(world, {
    qwen: chatFixture('qwen', [
      { key: 'gw:intent', content: { items: [action()] } },
    ]),
    kimi: chatFixture('kimi', [{ key: 'gw:critic', content: SUPPORT }]),
  }).run({
    runId: 'run_gw',
    groupId: GROUP,
    world: snapshot,
    messages: [{ memberId: 'member_0', text: 'Pay the counterparty.' }],
    fixtureKey: 'gw',
  });
  const item = result.items[0]!;
  if (item.normalized?.kind !== 'ACTION') throw new Error('expected an action');
  const proposal: BrainActionProposal = {
    kind: 'ACTION',
    proposalId: ProposalIdSchema.parse('gw_probe'),
    groupId: item.evidenceArtifact.groupId,
    snapshotId: snapshot.snapshotId,
    intent: item.normalized.intent,
    evidenceArtifact: {
      ...item.evidenceArtifact,
      proposalId: ProposalIdSchema.parse('gw_probe'),
    },
    evidenceArtifactHash: '0x',
    market: null,
  };
  proposal.evidenceArtifactHash = evidenceArtifactHash(
    EvidenceArtifactSchema.parse(proposal.evidenceArtifact),
  );
  return { world, proposal };
}

describe('Kernel proposal gateway', () => {
  it('refuses tampered evidence and non-transfer actions without touching the Kernel', async () => {
    const { world, proposal } = await submitted();
    const before = economicState(world.kernel);
    const audit = world.kernel.kernel.auditLog().length;
    const tampered = await world.gateway.proposeAction({
      ...proposal,
      evidenceArtifact: { ...proposal.evidenceArtifact, outcome: 'ESCALATED' },
    });
    expect(tampered).toMatchObject({
      status: 'REJECTED',
      code: 'EVIDENCE_MISMATCH',
    });
    const swap = await world.gateway.proposeAction({
      ...proposal,
      intent: { ...proposal.intent, action: 'SPOT_TRADE' },
    });
    expect(swap).toMatchObject({
      status: 'REJECTED',
      code: 'PREPARE_REQUIRED',
    });
    const garbage = await world.gateway.proposeAction({
      proposalId: 'x',
    } as never);
    expect(garbage.code).toBe('INVALID_PROPOSAL');
    expect(world.kernel.kernel.auditLog()).toHaveLength(audit);
    expect(economicState(world.kernel)).toBe(before);
  });

  it('never forwards approvals, so a Brain proposal cannot reach AUTHORIZED', async () => {
    const { world, proposal } = await submitted();
    const decision = await world.gateway.proposeAction(proposal);
    expect(decision.status).toBe('PENDING_APPROVAL');
    expect(world.kernel.kernel.stateView().grants).toEqual([]);
  });

  it('declared simulations are refused outside SIMULATION mode', async () => {
    const world = await evalWorld();
    expect(
      () =>
        new KernelProposalGateway({
          kernel: world.kernel.kernel,
          market: world.market,
          simulations: new DeclaredSimulation(world.kernel.clock, 'x'),
          clock: world.kernel.clock,
          executionMode: 'REAL_TESTNET',
        }),
    ).toThrow();
  });

  it('classifies mandate edits without changing the live Kernel', async () => {
    const world = await evalWorld();
    const before = economicState(world.kernel);
    const artifact = (proposalId: string) => {
      const base = {
        schemaVersion: 1,
        artifactId: `${proposalId}.evidence`,
        runId: 'run_m',
        proposalId,
        groupId: GROUP,
        snapshotId: `0x${'1'.repeat(64)}`,
        createdAt: 1000,
        executionMode: 'SIMULATION',
        sources: [],
        decisiveFreshness: 'FRESH',
        modelCalls: [],
        roles: ['SUPERVISOR'],
        claims: [],
        uncertainties: [],
        contradictions: [],
        critic: { verdict: 'NOT_RUN', issues: [], uncertainty: 1 },
        untrustedEvidence: [],
        costs: {
          inputTokens: 0,
          outputTokens: 0,
          modelCalls: 0,
          paidToolCalls: 0,
          paidToolMicroUsd: 0,
          externalCalls: 0,
          subagentsSpawned: 0,
          maxDepthReached: 0,
          toolCalls: 0,
          wallClockMs: 0,
        },
        findings: [],
        outcome: 'PROPOSED',
      };
      const parsed = EvidenceArtifactSchema.parse(base);
      return {
        evidenceArtifact: parsed,
        evidenceArtifactHash: evidenceArtifactHash(parsed),
      };
    };
    const propose = (id: string, change: 'NEW' | 'SUPERSEDE', next: unknown) =>
      world.gateway.proposeMandate({
        kind: 'MANDATE',
        proposalId: ProposalIdSchema.parse(id),
        groupId: GROUP,
        snapshotId: `0x${'1'.repeat(64)}`,
        change,
        mandate: next,
        ...artifact(id),
      } as BrainMandateProposal);
    expect(
      await propose(
        'm1',
        'SUPERSEDE',
        mandate({ version: 2, perActionCap: '150' }),
      ),
    ).toMatchObject({
      status: 'REQUIRES_HUMAN_APPROVAL',
      code: 'WIDENING_SUPERSEDE',
    });
    expect(
      await propose(
        'm2',
        'SUPERSEDE',
        mandate({ version: 2, perActionCap: '50' }),
      ),
    ).toMatchObject({
      status: 'REQUIRES_HUMAN_APPROVAL',
      code: 'SECURITY_SENSITIVE_SUPERSEDE',
      narrowedFields: ['perActionCap'],
    });
    expect(
      await propose('m3', 'SUPERSEDE', mandate({ version: 3 })),
    ).toMatchObject({
      status: 'REJECTED',
      code: 'MANDATE_VERSION',
    });
    expect(await propose('m4', 'NEW', mandate())).toMatchObject({
      status: 'REJECTED',
      code: 'MANDATE_CONFLICT',
    });
    expect(
      await propose('m5', 'NEW', mandate({ mandateId: 'mandate_2' })),
    ).toMatchObject({ status: 'REQUIRES_HUMAN_APPROVAL', code: 'NEW_MANDATE' });
    expect(world.kernel.kernel.listMandates()).toEqual([mandate()]);
    expect(economicState(world.kernel)).toBe(before);
  });
});
