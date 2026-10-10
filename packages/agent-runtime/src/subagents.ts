import { CapabilityError, delegateCapabilities } from '@synq/domain';
import {
  CapabilitySchema,
  isNonDelegable,
  type AgentFinding,
  type Capability,
  type FindingKind,
  type ModelRole,
} from '@synq/schemas';

export type BudgetLimits = {
  maxSpawnDepth: number;
  maxConcurrentChildren: number;
  maxLlmTokens: number;
  maxPaidMicroUsd: number;
  maxWallClockMs: number;
  maxToolCalls: number;
  maxTotalSpawns: number;
};
export const DEFAULT_BUDGET: Readonly<BudgetLimits> = Object.freeze({
  maxSpawnDepth: 3,
  maxConcurrentChildren: 6,
  maxLlmTokens: 120_000,
  maxPaidMicroUsd: 2_000_000,
  maxWallClockMs: 15 * 60_000,
  maxToolCalls: 80,
  maxTotalSpawns: 24,
});

export class AgentRuntimeError extends Error {
  constructor(
    readonly kind: FindingKind,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

type Usage = { tokens: number; paidMicroUsd: number; toolCalls: number };
export type AgentHandle = Readonly<{
  agentId: string;
  role: ModelRole;
  depth: number;
  parentId: string | null;
  capabilities: readonly Capability[];
  signal: AbortSignal;
  deadline: number;
}>;
type AgentNode = {
  handle: AgentHandle;
  controller: AbortController;
  limits: BudgetLimits;
  used: Usage;
  active: boolean;
  children: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
};

export class SubagentManager {
  readonly findings: AgentFinding[] = [];
  private readonly nodes = new Map<string, AgentNode>();
  private sequence = 0;
  private spawned = 0;
  private maxDepth = 0;
  private readonly root: AgentNode;

  constructor(
    readonly runId: string,
    rootCapabilities: readonly Capability[],
    readonly limits: BudgetLimits = DEFAULT_BUDGET,
    private readonly clock: () => number = Date.now,
    private readonly nowSeconds: () => number = () =>
      Math.floor(Date.now() / 1000),
    parentSignal?: AbortSignal,
  ) {
    const caps = rootCapabilities.map((c) => CapabilitySchema.parse(c));
    if (caps.some(isNonDelegable) || new Set(caps).size !== caps.length)
      throw new AgentRuntimeError(
        'CAPABILITY_ESCALATION',
        'the Brain root never holds non-delegable capabilities',
      );
    this.root = this.createNode({
      role: 'SUPERVISOR',
      parent: null,
      capabilities: caps,
      limits: { ...limits },
      ...(parentSignal ? { parentSignal } : {}),
    });
  }

  get rootHandle(): AgentHandle {
    return this.root.handle;
  }
  get spawnCount(): number {
    return this.spawned;
  }
  get depthReached(): number {
    return this.maxDepth;
  }
  usage(agentId: string = this.root.handle.agentId): Usage {
    return { ...this.node(agentId).used };
  }

  private node(agentId: string): AgentNode {
    const node = this.nodes.get(agentId);
    if (!node) throw new AgentRuntimeError('CANCELLED', 'unknown agent');
    return node;
  }
  private createNode(input: {
    role: ModelRole;
    parent: AgentNode | null;
    capabilities: Capability[];
    limits: BudgetLimits;
    parentSignal?: AbortSignal;
  }): AgentNode {
    const agentId = `${this.runId}.${input.role.toLowerCase()}.${this.sequence++}`;
    const controller = new AbortController();
    const upstream = input.parent?.controller.signal ?? input.parentSignal;
    if (upstream) {
      if (upstream.aborted) controller.abort(upstream.reason);
      else
        upstream.addEventListener(
          'abort',
          () => controller.abort(upstream.reason),
          { once: true },
        );
    }
    const parentDeadline = input.parent?.handle.deadline ?? Infinity;
    const deadline = Math.min(
      parentDeadline,
      this.clock() + input.limits.maxWallClockMs,
    );
    const timer = Number.isFinite(deadline)
      ? setTimeout(
          () =>
            controller.abort(
              new AgentRuntimeError('BUDGET_EXCEEDED', 'wall-clock budget'),
            ),
          Math.max(0, deadline - this.clock()),
        )
      : null;
    timer?.unref?.();
    const node: AgentNode = {
      handle: Object.freeze({
        agentId,
        role: input.role,
        depth: input.parent ? input.parent.handle.depth + 1 : 0,
        parentId: input.parent?.handle.agentId ?? null,
        capabilities: Object.freeze([...input.capabilities]),
        signal: controller.signal,
        deadline,
      }),
      controller,
      limits: input.limits,
      used: { tokens: 0, paidMicroUsd: 0, toolCalls: 0 },
      active: true,
      children: new Set(),
      timer,
    };
    this.nodes.set(agentId, node);
    return node;
  }

  finding(
    kind: FindingKind,
    detail: string,
    agent: AgentHandle | null,
    severity: AgentFinding['severity'] = 'MEDIUM',
  ): AgentFinding {
    const finding: AgentFinding = {
      findingId: `${this.runId}.finding.${this.findings.length}`,
      kind,
      severity,
      role: agent?.role ?? null,
      agentId: agent?.agentId ?? null,
      detail: detail.slice(0, 500),
      at: this.nowSeconds(),
    };
    this.findings.push(finding);
    return finding;
  }
  private refuse(
    kind: FindingKind,
    detail: string,
    agent: AgentHandle | null,
  ): never {
    this.finding(kind, detail, agent, 'HIGH');
    throw new AgentRuntimeError(kind, detail);
  }

  spawn(
    parentId: string,
    role: ModelRole,
    requested: readonly Capability[],
    limits: Partial<BudgetLimits> = {},
  ): AgentHandle {
    const parent = this.node(parentId);
    if (!parent.active || parent.handle.signal.aborted)
      this.refuse('CANCELLED', 'parent is not active', parent.handle);
    const ancestry: ModelRole[] = [];
    for (
      let at: AgentNode | undefined = parent;
      at;
      at = at.handle.parentId ? this.nodes.get(at.handle.parentId) : undefined
    )
      ancestry.push(at.handle.role);
    if (role !== 'SUPERVISOR' && ancestry.includes(role))
      this.refuse(
        'SPAWN_LOOP',
        `recursive delegation ${[...ancestry].reverse().join(' -> ')} -> ${role}`,
        parent.handle,
      );
    if (role === 'SUPERVISOR')
      this.refuse(
        'SPAWN_LOOP',
        'a supervisor cannot be spawned',
        parent.handle,
      );
    const depth = parent.handle.depth + 1;
    if (depth > this.limits.maxSpawnDepth)
      this.refuse(
        'SPAWN_DEPTH_EXCEEDED',
        `depth ${depth} exceeds ${this.limits.maxSpawnDepth}`,
        parent.handle,
      );
    if (this.spawned >= this.limits.maxTotalSpawns)
      this.refuse(
        'SPAWN_LOOP',
        `run spawned ${this.spawned} agents (limit ${this.limits.maxTotalSpawns})`,
        parent.handle,
      );
    const activeChildren = [...parent.children].filter(
      (id) => this.nodes.get(id)?.active,
    ).length;
    if (activeChildren >= this.limits.maxConcurrentChildren)
      this.refuse(
        'CONCURRENCY_EXCEEDED',
        `${activeChildren} active children (limit ${this.limits.maxConcurrentChildren})`,
        parent.handle,
      );
    let capabilities: Capability[];
    try {
      capabilities = delegateCapabilities(
        parent.handle.capabilities.filter((c) => !isNonDelegable(c)),
        requested.map((c) => CapabilitySchema.parse(c)),
      );
    } catch (error) {
      if (error instanceof CapabilityError || error instanceof Error)
        this.refuse(
          'CAPABILITY_ESCALATION',
          `${role} requested ${requested.join(',')} but ${parent.handle.role} delegates ${parent.handle.capabilities.join(',')}`,
          parent.handle,
        );
      throw error;
    }
    const remaining = this.remaining(parent);
    const child = this.createNode({
      role,
      parent,
      capabilities,
      limits: {
        ...this.limits,
        ...limits,
        maxLlmTokens: Math.min(
          limits.maxLlmTokens ?? remaining.tokens,
          remaining.tokens,
        ),
        maxPaidMicroUsd: Math.min(
          limits.maxPaidMicroUsd ?? remaining.paidMicroUsd,
          remaining.paidMicroUsd,
        ),
        maxToolCalls: Math.min(
          limits.maxToolCalls ?? remaining.toolCalls,
          remaining.toolCalls,
        ),
        maxWallClockMs: Math.min(
          limits.maxWallClockMs ?? this.limits.maxWallClockMs,
          Math.max(0, parent.handle.deadline - this.clock()),
        ),
      },
    });
    parent.children.add(child.handle.agentId);
    this.spawned++;
    this.maxDepth = Math.max(this.maxDepth, child.handle.depth);
    return child.handle;
  }

  private remaining(node: AgentNode): Usage {
    return {
      tokens: node.limits.maxLlmTokens - node.used.tokens,
      paidMicroUsd: node.limits.maxPaidMicroUsd - node.used.paidMicroUsd,
      toolCalls: node.limits.maxToolCalls - node.used.toolCalls,
    };
  }
  private chain(agentId: string): AgentNode[] {
    const nodes: AgentNode[] = [];
    for (
      let at: AgentNode | undefined = this.node(agentId);
      at;
      at = at.handle.parentId ? this.nodes.get(at.handle.parentId) : undefined
    )
      nodes.push(at);
    return nodes;
  }
  canCharge(agentId: string, cost: Partial<Usage>): boolean {
    return this.chain(agentId).every((n) => {
      const r = this.remaining(n);
      return (
        (cost.tokens ?? 0) <= r.tokens &&
        (cost.paidMicroUsd ?? 0) <= r.paidMicroUsd &&
        (cost.toolCalls ?? 0) <= r.toolCalls
      );
    });
  }
  charge(agentId: string, cost: Partial<Usage>, label: string): void {
    const handle = this.node(agentId).handle;
    if (handle.signal.aborted)
      this.refuse('CANCELLED', `${label} after cancellation`, handle);
    if (!this.canCharge(agentId, cost))
      this.refuse(
        'BUDGET_EXCEEDED',
        `${label} would exceed the budget (${JSON.stringify(cost)})`,
        handle,
      );
    for (const n of this.chain(agentId)) {
      n.used.tokens += cost.tokens ?? 0;
      n.used.paidMicroUsd += cost.paidMicroUsd ?? 0;
      n.used.toolCalls += cost.toolCalls ?? 0;
    }
  }
  record(agentId: string, cost: Partial<Usage>): void {
    for (const n of this.chain(agentId)) {
      n.used.tokens += cost.tokens ?? 0;
      n.used.paidMicroUsd += cost.paidMicroUsd ?? 0;
      n.used.toolCalls += cost.toolCalls ?? 0;
    }
    const over = this.chain(agentId).find(
      (n) =>
        n.used.tokens > n.limits.maxLlmTokens ||
        n.used.paidMicroUsd > n.limits.maxPaidMicroUsd ||
        n.used.toolCalls > n.limits.maxToolCalls,
    );
    if (over) {
      const handle = this.node(agentId).handle;
      this.cancel(agentId, 'budget exceeded');
      this.refuse(
        'BUDGET_EXCEEDED',
        `${over.handle.agentId} exceeded its budget`,
        handle,
      );
    }
  }
  complete(agentId: string): void {
    const node = this.node(agentId);
    node.active = false;
    if (node.timer) clearTimeout(node.timer);
  }
  cancel(agentId: string, reason: string): void {
    const node = this.node(agentId);
    if (!node.controller.signal.aborted)
      node.controller.abort(new AgentRuntimeError('CANCELLED', reason));
    for (const child of node.children) this.cancel(child, reason);
    this.complete(agentId);
  }
  close(): void {
    for (const node of this.nodes.values())
      if (node.timer) clearTimeout(node.timer);
  }
}
