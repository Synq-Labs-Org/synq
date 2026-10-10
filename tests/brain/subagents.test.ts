import { describe, expect, it } from 'vitest';
import { delegateCapabilities } from '@synq/domain';
import {
  AgentRuntimeError,
  DEFAULT_BUDGET,
  ROOT_CAPABILITIES,
  ROLE_SPECS,
  SubagentManager,
  redactAttributes,
  SpanRecorder,
} from '@synq/agent-runtime';

const manager = (limits = {}) =>
  new SubagentManager('run', ROOT_CAPABILITIES, {
    ...DEFAULT_BUDGET,
    ...limits,
  });
const kind = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AgentRuntimeError) return error.kind;
    throw error;
  }
  return null;
};

describe('subagent capability inheritance and budgets (Bible §9)', () => {
  it('defaults match the Bible budget block', () => {
    expect(DEFAULT_BUDGET).toMatchObject({
      maxSpawnDepth: 3,
      maxConcurrentChildren: 6,
      maxLlmTokens: 120_000,
      maxPaidMicroUsd: 2_000_000,
      maxWallClockMs: 900_000,
      maxToolCalls: 80,
    });
    for (const spec of Object.values(ROLE_SPECS))
      expect(
        spec.capabilities.every((c) => ROOT_CAPABILITIES.includes(c)),
        spec.role,
      ).toBe(true);
  });

  it('Capabilities(child) ⊆ Delegable(parent); non-delegables are never inherited', () => {
    const m = manager();
    const root = m.rootHandle.agentId;
    const intent = m.spawn(root, 'INTENT', ['PROPOSE_ACTION']);
    expect(intent.capabilities).toEqual(['PROPOSE_ACTION']);
    expect(kind(() => m.spawn(intent.agentId, 'CRITIC', ['READ_MARKET']))).toBe(
      'CAPABILITY_ESCALATION',
    );
    expect(kind(() => m.spawn(root, 'RESEARCH', ['SIGN']))).toBe(
      'CAPABILITY_ESCALATION',
    );
    expect(
      kind(() => m.spawn(root, 'RESEARCH', ['ISSUE_GRANT', 'READ_MARKET'])),
    ).toBe('CAPABILITY_ESCALATION');
    expect(() => new SubagentManager('r', ['READ_MARKET', 'SIGN'])).toThrow(
      AgentRuntimeError,
    );
    expect(() =>
      delegateCapabilities(['SIGN', 'READ_MARKET'], ['SIGN']),
    ).toThrow();
    expect(
      m.findings.filter((f) => f.kind === 'CAPABILITY_ESCALATION'),
    ).toHaveLength(3);
  });

  it('recursive delegation is a spawn loop with a typed finding', () => {
    const m = manager();
    const research = m.spawn(m.rootHandle.agentId, 'RESEARCH', ['READ_MARKET']);
    const critic = m.spawn(research.agentId, 'CRITIC', ['READ_MARKET']);
    expect(
      kind(() => m.spawn(critic.agentId, 'RESEARCH', ['READ_MARKET'])),
    ).toBe('SPAWN_LOOP');
    const finding = m.findings.at(-1)!;
    expect(finding).toMatchObject({
      kind: 'SPAWN_LOOP',
      severity: 'HIGH',
      role: 'CRITIC',
    });
    expect(finding.detail).toContain(
      'SUPERVISOR -> RESEARCH -> CRITIC -> RESEARCH',
    );
    expect(kind(() => m.spawn(critic.agentId, 'SUPERVISOR', []))).toBe(
      'SPAWN_LOOP',
    );
  });

  it('spawn depth is capped at 3 and total spawns are bounded', () => {
    const m = manager();
    const a = m.spawn(m.rootHandle.agentId, 'RESEARCH', ['READ_MARKET']);
    const b = m.spawn(a.agentId, 'CRITIC', ['READ_MARKET']);
    const c = m.spawn(b.agentId, 'RISK', ['READ_MARKET']);
    expect(c.depth).toBe(3);
    expect(kind(() => m.spawn(c.agentId, 'FUNDING', ['READ_MARKET']))).toBe(
      'SPAWN_DEPTH_EXCEEDED',
    );
    const small = manager({ maxTotalSpawns: 2 });
    const root = small.rootHandle.agentId;
    small.complete(small.spawn(root, 'RESEARCH', ['READ_MARKET']).agentId);
    small.complete(small.spawn(root, 'CRITIC', ['READ_MARKET']).agentId);
    expect(kind(() => small.spawn(root, 'RISK', ['READ_MARKET']))).toBe(
      'SPAWN_LOOP',
    );
  });

  it('at most 6 concurrent children; completing one frees a slot', () => {
    const m = manager();
    const root = m.rootHandle.agentId;
    const roles = [
      'INTENT',
      'RESEARCH',
      'CRITIC',
      'RISK',
      'FUNDING',
      'TRADING',
    ] as const;
    const kids = roles.map((r) =>
      m.spawn(root, r, r === 'INTENT' ? [] : ['READ_MARKET']),
    );
    expect(kind(() => m.spawn(root, 'COMMERCE', ['READ_MARKET']))).toBe(
      'CONCURRENCY_EXCEEDED',
    );
    m.complete(kids[0]!.agentId);
    expect(m.spawn(root, 'COMMERCE', ['READ_MARKET']).role).toBe('COMMERCE');
  });

  it('token, paid-tool and tool-call budgets are enforced up the chain', () => {
    const m = manager({
      maxLlmTokens: 1_000,
      maxPaidMicroUsd: 3_000,
      maxToolCalls: 2,
    });
    const child = m.spawn(m.rootHandle.agentId, 'RESEARCH', ['READ_MARKET'], {
      maxLlmTokens: 5_000,
    });
    m.charge(
      child.agentId,
      { tokens: 900, paidMicroUsd: 2_000, toolCalls: 1 },
      'first',
    );
    expect(m.usage()).toMatchObject({
      tokens: 900,
      paidMicroUsd: 2_000,
      toolCalls: 1,
    });
    expect(kind(() => m.charge(child.agentId, { tokens: 200 }, 'second'))).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(
      kind(() => m.charge(child.agentId, { paidMicroUsd: 2_000 }, 'paid')),
    ).toBe('BUDGET_EXCEEDED');
    expect(kind(() => m.charge(child.agentId, { toolCalls: 2 }, 'tools'))).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(m.canCharge(child.agentId, { paidMicroUsd: 1_000 })).toBe(true);
    expect(kind(() => m.record(child.agentId, { tokens: 500 }))).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(child.signal.aborted).toBe(true);
  });

  it('wall-clock budgets abort the agent and cancellation cascades to children', async () => {
    const m = manager({ maxWallClockMs: 20 });
    const child = m.spawn(m.rootHandle.agentId, 'RESEARCH', ['READ_MARKET']);
    await new Promise((r) => setTimeout(r, 60));
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as AgentRuntimeError).kind).toBe(
      'BUDGET_EXCEEDED',
    );
    m.close();
    const n = manager();
    const a = n.spawn(n.rootHandle.agentId, 'RESEARCH', ['READ_MARKET']);
    const b = n.spawn(a.agentId, 'CRITIC', ['READ_MARKET']);
    n.cancel(a.agentId, 'member cancelled');
    expect(b.signal.aborted).toBe(true);
    expect(kind(() => n.charge(b.agentId, { tokens: 1 }, 'late'))).toBe(
      'CANCELLED',
    );
    const parent = new AbortController();
    const linked = new SubagentManager(
      'l',
      ROOT_CAPABILITIES,
      DEFAULT_BUDGET,
      Date.now,
      () => 0,
      parent.signal,
    );
    parent.abort();
    expect(linked.rootHandle.signal.aborted).toBe(true);
    expect(
      kind(() =>
        linked.spawn(linked.rootHandle.agentId, 'RISK', ['READ_MARKET']),
      ),
    ).toBe('CANCELLED');
    n.close();
    linked.close();
  });
});

describe('structured span records', () => {
  it('never carry secrets or signatures', async () => {
    expect(
      redactAttributes({
        apiKey: 'sk-abc',
        authorization: 'Bearer x',
        note: 'Bearer sk-abcdefghijk',
        sig: `0x${'ab'.repeat(65)}`,
        tokens: 12,
        ok: true,
      }),
    ).toEqual({ note: '[REDACTED]', sig: '[REDACTED]', tokens: 12, ok: true });
    const spans = new SpanRecorder('run');
    await expect(
      spans.span('x', { role: 'INTENT' }, { privateKey: '0x01' }, async () => {
        throw new AgentRuntimeError('BUDGET_EXCEEDED', 'boom');
      }),
    ).rejects.toThrow('boom');
    expect(spans.spans[0]).toMatchObject({
      status: 'ERROR',
      attributes: { error: 'BUDGET_EXCEEDED' },
    });
    expect(JSON.stringify(spans.spans)).not.toContain('privateKey');
  });
});
