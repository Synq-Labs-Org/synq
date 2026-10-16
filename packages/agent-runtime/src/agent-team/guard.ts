import type { ChainName } from '@synq/chain-registry/arc';
import type { RiskFlag } from '@synq/plugin-risk';
import { AgentRuntimeError } from '../subagents.js';
import {
  NEVER_TOOLS,
  SUBAGENT_TEMPLATES,
  TEAM_MANIFESTS,
  TEAM_TOOLS,
  type CapabilityManifest,
  type CounterpartyClass,
  type Scope,
  type SpendMode,
  type TeamRole,
  type TeamTool,
  type TeamToolSpec,
  type TemplateId,
} from './manifests.js';

/**
 * The external capability guard (ADR-007). It sits between every agent and
 * every tool and is the only thing that decides whether a call may run. It
 * is deterministic code outside the model process boundary of trust: model
 * output, chat text and Mastra's own subagent machinery never reach it as
 * authority. Each agent instance has an effective capability fixed at
 * delegation:
 *
 *   effective(child) = registered(child role or template)
 *                      ∩ delegable(parent)
 *
 * (tools, hosts, scopes, networks, counterparty classes and spend paths are
 * set-intersected; amount, budgets, time, depth and timeout take the
 * minimum). Revocation marks an instance and every descendant revoked and
 * aborts their signals, so an in-flight child's next call (and any result it
 * was awaiting) is refused immediately.
 */
export type EffectiveCapability = Readonly<{
  agentId: string;
  role: TeamRole;
  parentId: string | null;
  templateId: TemplateId | null;
  depth: number;
  tools: readonly TeamTool[];
  domains: readonly string[];
  read: readonly Scope[];
  write: readonly Scope[];
  maxAmountBaseUnits: bigint;
  counterparties: readonly CounterpartyClass[];
  networks: readonly ChainName[];
  spend: readonly SpendMode[];
  /** Absolute wall-clock deadline (ms). */
  deadline: number;
  budgets: CapabilityManifest['budgets'];
  maxDepthBelow: number;
  concurrency: number;
  timeoutMs: number;
  delegable: readonly TeamTool[];
  templates: readonly TemplateId[];
}>;

export type CallArgs = Readonly<{
  amountBaseUnits?: bigint;
  counterparty?: string;
  chain?: ChainName;
  host?: string;
}>;

export type GuardEvent = Readonly<{
  at: number;
  agentId: string;
  role: TeamRole | null;
  action: 'DELEGATED' | 'ALLOWED' | 'FLAGGED' | 'REFUSED' | 'REVOKED';
  subject: string;
  detail: string;
}>;

export type GuardContext = Readonly<{
  /** Verified vendor payout addresses (vendor master), read at call time. */
  verifiedCounterparties: () => readonly string[];
  /** Wall clock in ms. */
  clockMs?: () => number;
}>;

type Node = {
  cap: EffectiveCapability;
  controller: AbortController;
  revoked: string | null;
  used: { toolCalls: number; paidMicroUsd: number; tokens: number };
  /** Paid amounts reserved by in-flight paid reads (settled or released after). */
  reservedPaid: number;
  activeChildren: Set<string>;
  done: boolean;
};

const inter = <T>(a: readonly T[], b: readonly T[]): T[] =>
  a.filter((x) => b.includes(x));
const lower = (s: string) => s.toLowerCase();

export class CapabilityGuard {
  readonly log: GuardEvent[] = [];
  private readonly nodes = new Map<string, Node>();
  private readonly clock: () => number;

  constructor(private readonly ctx: GuardContext) {
    this.clock = ctx.clockMs ?? Date.now;
  }

  private event(
    agentId: string,
    action: GuardEvent['action'],
    subject: string,
    detail: string,
  ) {
    this.log.push({
      at: this.clock(),
      agentId,
      role: this.nodes.get(agentId)?.cap.role ?? null,
      action,
      subject,
      detail: detail.slice(0, 300),
    });
  }

  private refuse(
    agentId: string,
    kind:
      | 'FORBIDDEN_TOOL_CALL'
      | 'CAPABILITY_ESCALATION'
      | 'CANCELLED'
      | 'BUDGET_EXCEEDED'
      | 'SPAWN_DEPTH_EXCEEDED'
      | 'CONCURRENCY_EXCEEDED',
    subject: string,
    detail: string,
  ): never {
    this.event(agentId, 'REFUSED', subject, `${kind}: ${detail}`);
    throw new AgentRuntimeError(kind, detail);
  }

  capability(agentId: string): EffectiveCapability | null {
    return this.nodes.get(agentId)?.cap ?? null;
  }

  signal(agentId: string): AbortSignal {
    const n = this.nodes.get(agentId);
    if (!n)
      throw new AgentRuntimeError('CANCELLED', `unknown agent ${agentId}`);
    return n.controller.signal;
  }

  /** The root instance: exactly the Supervisor manifest. */
  root(agentId: string): EffectiveCapability {
    if (this.nodes.size)
      throw new AgentRuntimeError('CAPABILITY_ESCALATION', 'root already set');
    const m = TEAM_MANIFESTS.SUPERVISOR;
    const cap: EffectiveCapability = Object.freeze({
      agentId,
      role: 'SUPERVISOR',
      parentId: null,
      templateId: null,
      depth: 0,
      tools: [...m.tools],
      domains: [...m.allowedDomains],
      read: [...m.scopes.read],
      write: [...m.scopes.write],
      maxAmountBaseUnits: m.maxAmountBaseUnits,
      counterparties: [...m.counterparties],
      networks: [...m.networks],
      spend: [...m.spend],
      deadline: this.clock() + m.timeLimitMs,
      budgets: { ...m.budgets },
      maxDepthBelow: m.maxSubagentDepth,
      concurrency: m.concurrency,
      timeoutMs: m.timeoutMs,
      delegable: [...m.delegable],
      templates: [...m.templates],
    });
    this.nodes.set(agentId, {
      cap,
      controller: new AbortController(),
      revoked: null,
      used: { toolCalls: 0, paidMicroUsd: 0, tokens: 0 },
      reservedPaid: 0,
      activeChildren: new Set(),
      done: false,
    });
    this.event(agentId, 'DELEGATED', 'SUPERVISOR', 'root capability');
    return cap;
  }

  private chain(agentId: string): Node[] {
    const out: Node[] = [];
    for (
      let n = this.nodes.get(agentId);
      n;
      n = n.cap.parentId ? this.nodes.get(n.cap.parentId) : undefined
    )
      out.push(n);
    return out;
  }

  private live(agentId: string, subject: string): Node {
    const n = this.nodes.get(agentId);
    if (!n) return this.refuse(agentId, 'CANCELLED', subject, 'unknown agent');
    const revoked = this.chain(agentId).find((x) => x.revoked !== null);
    if (revoked)
      this.refuse(
        agentId,
        'CANCELLED',
        subject,
        `capability revoked (${revoked.cap.agentId}: ${revoked.revoked})`,
      );
    if (this.clock() > n.cap.deadline)
      this.refuse(agentId, 'BUDGET_EXCEEDED', subject, 'time limit reached');
    return n;
  }

  /**
   * Delegates to a registered role (Supervisor only) or a dynamic template
   * (any agent whose manifest lists it). `requested` names tools the caller
   * explicitly wants; any outside the intersection is an escalation and is
   * refused rather than silently dropped.
   */
  delegate(input: {
    parentId: string;
    childId: string;
    role?: TeamRole;
    template?: TemplateId;
    requested?: readonly string[];
  }): EffectiveCapability {
    const parent = this.live(input.parentId, 'delegate');
    const p = parent.cap;
    const tpl =
      input.template && Object.hasOwn(SUBAGENT_TEMPLATES, input.template)
        ? SUBAGENT_TEMPLATES[input.template]
        : null;
    if (input.template && !tpl)
      this.refuse(
        input.parentId,
        'CAPABILITY_ESCALATION',
        String(input.template),
        'unknown subagent template',
      );
    const role = tpl?.role ?? input.role;
    if (!role || role === 'SUPERVISOR' || !Object.hasOwn(TEAM_MANIFESTS, role))
      this.refuse(
        input.parentId,
        'CAPABILITY_ESCALATION',
        String(role),
        'not a delegable role',
      );
    if (tpl && !p.templates.includes(tpl.id))
      this.refuse(
        input.parentId,
        'CAPABILITY_ESCALATION',
        tpl.id,
        `${p.role} may not instantiate ${tpl.id}`,
      );
    if (!tpl && p.role !== 'SUPERVISOR')
      this.refuse(
        input.parentId,
        'CAPABILITY_ESCALATION',
        role,
        'only the Supervisor spawns registered roles; others use approved templates',
      );
    if (p.maxDepthBelow < 1)
      this.refuse(
        input.parentId,
        'SPAWN_DEPTH_EXCEEDED',
        role,
        `${p.role} may not delegate further`,
      );
    if (this.nodes.has(input.childId))
      this.refuse(
        input.parentId,
        'CAPABILITY_ESCALATION',
        input.childId,
        'agent id reused',
      );
    const m = TEAM_MANIFESTS[role];
    const registered = tpl ? inter(tpl.tools, m.tools) : [...m.tools];
    const tools = inter(registered, p.delegable);
    for (const r of input.requested ?? [])
      if (!(tools as readonly string[]).includes(r))
        this.refuse(
          input.parentId,
          'CAPABILITY_ESCALATION',
          r,
          `${role} requested ${r}, outside ${p.role}'s delegable ∩ ${role}'s policy`,
        );
    const active = [...parent.activeChildren].filter(
      (id) => !this.nodes.get(id)?.done,
    ).length;
    if (active >= p.concurrency)
      this.refuse(
        input.parentId,
        'CONCURRENCY_EXCEEDED',
        role,
        `${active} active children (limit ${p.concurrency})`,
      );
    const rem = {
      toolCalls: p.budgets.toolCalls - parent.used.toolCalls,
      paidMicroUsd: p.budgets.paidMicroUsd - parent.used.paidMicroUsd,
      tokens: p.budgets.tokens - parent.used.tokens,
    };
    const min = (...xs: number[]) => Math.max(0, Math.min(...xs));
    const minB = (...xs: bigint[]) => xs.reduce((a, b) => (a < b ? a : b));
    const cap: EffectiveCapability = Object.freeze({
      agentId: input.childId,
      role,
      parentId: p.agentId,
      templateId: tpl?.id ?? null,
      depth: p.depth + 1,
      tools,
      domains: inter(m.allowedDomains, p.domains),
      read: inter(m.scopes.read, p.read),
      write: inter(m.scopes.write, p.write),
      maxAmountBaseUnits: minB(
        m.maxAmountBaseUnits,
        p.maxAmountBaseUnits,
        tpl?.maxAmountBaseUnits ?? m.maxAmountBaseUnits,
      ),
      counterparties: inter(m.counterparties, p.counterparties),
      networks: inter(m.networks, p.networks),
      spend: inter(m.spend, p.spend),
      deadline: Math.min(
        p.deadline,
        this.clock() +
          Math.min(m.timeLimitMs, tpl?.timeLimitMs ?? m.timeLimitMs),
      ),
      budgets: {
        toolCalls: min(
          m.budgets.toolCalls,
          tpl?.budgets.toolCalls ?? Infinity,
          rem.toolCalls,
        ),
        paidMicroUsd: min(
          m.budgets.paidMicroUsd,
          tpl?.budgets.paidMicroUsd ?? Infinity,
          rem.paidMicroUsd,
        ),
        tokens: min(
          m.budgets.tokens,
          tpl?.budgets.tokens ?? Infinity,
          rem.tokens,
        ),
      },
      maxDepthBelow: Math.max(
        0,
        Math.min(p.maxDepthBelow - 1, m.maxSubagentDepth),
      ),
      concurrency: m.concurrency,
      timeoutMs: Math.min(m.timeoutMs, p.timeoutMs),
      // A template instance is a leaf: it delegates nothing further.
      delegable: tpl ? [] : inter(m.delegable, p.delegable),
      templates: tpl ? [] : inter(m.templates, p.templates),
    });
    const controller = new AbortController();
    const up = parent.controller.signal;
    if (up.aborted) controller.abort(up.reason);
    else
      up.addEventListener('abort', () => controller.abort(up.reason), {
        once: true,
      });
    this.nodes.set(input.childId, {
      cap,
      controller,
      revoked: null,
      used: { toolCalls: 0, paidMicroUsd: 0, tokens: 0 },
      reservedPaid: 0,
      activeChildren: new Set(),
      done: false,
    });
    parent.activeChildren.add(input.childId);
    this.event(
      input.childId,
      'DELEGATED',
      tpl?.id ?? role,
      `from ${p.agentId}: ${tools.join(',')}`,
    );
    return cap;
  }

  /**
   * Authorizes one tool call. Throws for anything outside the effective
   * capability. Returns deterministic flags for calls that may proceed only
   * to the Kernel for decision (a proposal naming an unapproved
   * counterparty): the Kernel then denies on the HARD flag.
   */
  authorize(
    agentId: string,
    tool: string,
    args: CallArgs = {},
  ): { flags: RiskFlag[]; reservedMicroUsd: number } {
    const n = this.live(agentId, tool);
    const c = n.cap;
    if (
      (NEVER_TOOLS as readonly string[]).includes(tool) ||
      !Object.hasOwn(TEAM_TOOLS, tool)
    )
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${tool} is not a tool any agent holds`,
      );
    const t = tool as TeamTool;
    const spec: TeamToolSpec = TEAM_TOOLS[t];
    if (!c.tools.includes(t))
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${c.role} has no ${tool} (capability intersection)`,
      );
    const scopes =
      spec.effect === 'READ' || spec.effect === 'PAID_READ' ? c.read : c.write;
    if (!scopes.includes(spec.scope))
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${c.role} lacks ${spec.effect === 'READ' ? 'read' : 'write'} scope ${spec.scope}`,
      );
    // Budgets are additive: a call counts against the instance and every ancestor.
    for (const x of this.chain(agentId))
      if (x.used.toolCalls + 1 > x.cap.budgets.toolCalls)
        this.refuse(
          agentId,
          'BUDGET_EXCEEDED',
          tool,
          `${x.cap.role} tool budget ${x.cap.budgets.toolCalls} spent`,
        );
    if (spec.network && args.host === undefined)
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${tool} reaches the network and must name its host`,
      );
    if (args.chain !== undefined && !c.networks.includes(args.chain))
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${c.role} may not touch ${args.chain}`,
      );
    if (args.host !== undefined && !c.domains.includes(lower(args.host)))
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${c.role} may not reach ${args.host}`,
      );
    if (args.amountBaseUnits !== undefined) {
      if (args.amountBaseUnits < 0n)
        this.refuse(agentId, 'CAPABILITY_ESCALATION', tool, 'negative amount');
      if (args.amountBaseUnits > c.maxAmountBaseUnits)
        this.refuse(
          agentId,
          'CAPABILITY_ESCALATION',
          tool,
          `${args.amountBaseUnits} exceeds ${c.role}'s cap ${c.maxAmountBaseUnits}`,
        );
    }
    if (spec.effect === 'PAID_READ') {
      if (
        !c.spend.includes('X402_CAPPED') ||
        !c.counterparties.includes('DATA_SELLERS')
      )
        this.refuse(
          agentId,
          'FORBIDDEN_TOOL_CALL',
          tool,
          `${c.role} cannot pay for data`,
        );
      if (args.amountBaseUnits === undefined || args.host === undefined)
        this.refuse(
          agentId,
          'FORBIDDEN_TOOL_CALL',
          tool,
          'a paid read must name its amount and host',
        );
    }
    if (
      t === 'payment.submitToKernel' &&
      !c.spend.includes('KERNEL_GRANT_ONLY')
    )
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        `${c.role} has no Kernel payment path`,
      );
    // A paid read reserves its amount up front against the instance and
    // every ancestor; it is settled (or released) after the call.
    let reservedMicroUsd = 0;
    if (spec.effect === 'PAID_READ') {
      const amount = Number(args.amountBaseUnits!);
      for (const x of this.chain(agentId))
        if (
          x.used.paidMicroUsd + x.reservedPaid + amount >
          x.cap.budgets.paidMicroUsd
        )
          this.refuse(
            agentId,
            'BUDGET_EXCEEDED',
            tool,
            `${x.cap.role} paid budget ${x.cap.budgets.paidMicroUsd} would be exceeded`,
          );
      for (const x of this.chain(agentId)) x.reservedPaid += amount;
      reservedMicroUsd = amount;
    }
    const flags: RiskFlag[] = [];
    if (spec.effect === 'PROPOSE' && args.counterparty !== undefined) {
      const verified = this.ctx.verifiedCounterparties().map(lower);
      if (
        !c.counterparties.includes('VERIFIED_VENDORS') ||
        !verified.includes(lower(args.counterparty))
      )
        flags.push({
          code: 'GUARD_COUNTERPARTY_NOT_APPROVED',
          severity: 'HARD',
          detail: `${args.counterparty} is not an approved counterparty for ${c.role}`,
        });
    }
    for (const x of this.chain(agentId)) x.used.toolCalls += 1;
    this.event(
      agentId,
      flags.length ? 'FLAGGED' : 'ALLOWED',
      tool,
      flags.map((f) => f.code).join(',') || 'within capability',
    );
    return { flags, reservedMicroUsd };
  }

  /** Throws unless the instance and all its ancestors are live (not revoked, in time). */
  assertLive(agentId: string, subject: string): void {
    this.live(agentId, subject);
  }

  /** Converts a paid reservation into usage (actual may be lower; never refused after paying). */
  settlePaid(agentId: string, reserved: number, actual: number): void {
    const paid = Math.max(0, Math.ceil(actual));
    for (const x of this.chain(agentId)) {
      x.reservedPaid = Math.max(0, x.reservedPaid - reserved);
      x.used.paidMicroUsd += paid;
    }
    if (paid > reserved)
      this.event(
        agentId,
        'FLAGGED',
        'paid-read',
        `paid ${paid} above the reserved ${reserved}`,
      );
  }

  releasePaid(agentId: string, reserved: number): void {
    for (const x of this.chain(agentId))
      x.reservedPaid = Math.max(0, x.reservedPaid - reserved);
  }

  /**
   * A paid read: reserve, pay through `work` with `maxPerRequest` equal to the
   * reservation, then settle. An ambiguous failure charges the full cap; a receipt
   * is always returned once paid.
   */
  async runPaid<T>(
    agentId: string,
    tool: string,
    args: CallArgs,
    work: (
      signal: AbortSignal,
      maxPerRequest: bigint,
    ) => Promise<{ value: T; paidBaseUnits: bigint }>,
  ): Promise<{ value: T; flags: RiskFlag[] }> {
    const { flags, reservedMicroUsd } = this.authorize(agentId, tool, args);
    let settled = false;
    try {
      const { value } = await this.race(agentId, tool, (signal) =>
        work(signal, BigInt(reservedMicroUsd)).then((r) => {
          if (!settled) {
            this.settlePaid(agentId, reservedMicroUsd, Number(r.paidBaseUnits));
            settled = true;
          }
          return r;
        }),
      );
      return { value: value.value, flags };
    } finally {
      if (!settled)
        this.settlePaid(agentId, reservedMicroUsd, reservedMicroUsd);
    }
  }

  /** Records paid usage (x402 micro-USD, tokens) against the instance and ancestors. */
  charge(agentId: string, used: { paidMicroUsd?: number; tokens?: number }) {
    const n = this.live(agentId, 'charge');
    const paid = Math.max(0, Math.ceil(used.paidMicroUsd ?? 0));
    const tokens = Math.max(0, Math.ceil(used.tokens ?? 0));
    for (const x of this.chain(agentId)) {
      if (x.used.paidMicroUsd + paid > x.cap.budgets.paidMicroUsd)
        this.refuse(
          agentId,
          'BUDGET_EXCEEDED',
          'charge',
          `${x.cap.role} paid budget ${x.cap.budgets.paidMicroUsd} exceeded`,
        );
      if (x.used.tokens + tokens > x.cap.budgets.tokens)
        this.refuse(
          agentId,
          'BUDGET_EXCEEDED',
          'charge',
          `${x.cap.role} token budget exceeded`,
        );
    }
    for (const x of this.chain(agentId)) {
      x.used.paidMicroUsd += paid;
      x.used.tokens += tokens;
    }
    void n;
  }

  /**
   * Runs `work` under the guard: authorizes, then races it against the
   * instance's signal (revocation, parent cancellation) and its timeout. A
   * result that arrives after revocation is discarded.
   */
  async run<T>(
    agentId: string,
    tool: string,
    args: CallArgs,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T; flags: RiskFlag[] }> {
    const { flags, reservedMicroUsd } = this.authorize(agentId, tool, args);
    if (reservedMicroUsd) {
      this.releasePaid(agentId, reservedMicroUsd);
      this.refuse(
        agentId,
        'FORBIDDEN_TOOL_CALL',
        tool,
        'paid reads go through runPaid',
      );
    }
    const { value } = await this.race(agentId, tool, work);
    return { value, flags };
  }

  /** Races `work` against revocation and the timeout; re-checks liveness after. */
  private async race<T>(
    agentId: string,
    tool: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T }> {
    const n = this.nodes.get(agentId)!;
    const signal = n.controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        work(signal),
        new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              new AgentRuntimeError(
                'CANCELLED',
                `${tool}: capability revoked or cancelled`,
              ),
            );
          if (signal.aborted) onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(
            () =>
              reject(
                new AgentRuntimeError(
                  'BUDGET_EXCEEDED',
                  `${tool} timed out after ${n.cap.timeoutMs}ms`,
                ),
              ),
            Math.max(
              0,
              Math.min(n.cap.timeoutMs, n.cap.deadline - this.clock()),
            ),
          );
        }),
      ]);
      // Re-check after the await: revocation wins over a late result.
      this.live(agentId, tool);
      return { value };
    } catch (error) {
      if (error instanceof AgentRuntimeError)
        this.event(agentId, 'REFUSED', tool, `${error.kind}: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Immediate revocation of an instance and all its descendants. */
  revoke(agentId: string, reason: string): void {
    const n = this.nodes.get(agentId);
    if (!n) return;
    if (n.revoked === null) {
      n.revoked = reason.slice(0, 200);
      this.event(agentId, 'REVOKED', n.cap.role, n.revoked);
    }
    if (!n.controller.signal.aborted)
      n.controller.abort(
        new AgentRuntimeError('CANCELLED', `revoked: ${reason}`),
      );
    for (const child of n.activeChildren)
      this.revoke(child, `parent revoked: ${reason}`);
  }

  /** Revokes every instance of a role (e.g. after a manifest change). */
  revokeRole(role: TeamRole, reason: string): void {
    for (const n of this.nodes.values())
      if (n.cap.role === role) this.revoke(n.cap.agentId, reason);
  }

  complete(agentId: string): void {
    const n = this.nodes.get(agentId);
    if (n) n.done = true;
  }

  usage(agentId: string) {
    const n = this.nodes.get(agentId);
    return n ? { ...n.used } : null;
  }
}

/** Adapts the guard to the FinanceTeam's `ToolGate` hook. */
export function gateOf(guard: CapabilityGuard) {
  return {
    delegate: (i: { parentId: string; childId: string; role: string }) =>
      guard.delegate({
        parentId: i.parentId,
        childId: i.childId,
        role: i.role as TeamRole,
      }),
    authorize: (agentId: string, tool: string) =>
      guard.authorize(agentId, tool),
    complete: (agentId: string) => guard.complete(agentId),
    signal: (agentId: string) => guard.signal(agentId),
    assertLive: (agentId: string, tool: string) =>
      guard.assertLive(agentId, tool),
  };
}
