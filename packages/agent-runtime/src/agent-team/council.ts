import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { token } from '@synq/chain-registry/arc';
import { AmountError, moneyFromDecimal } from '@synq/domain';
import type {
  ApprovalTerms,
  PaymentIntent,
  PaymentPurpose,
} from '@synq/kernel/arc';
import {
  verifiedAddress,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import {
  alertKeyOf,
  coolingSecondsFor,
  type WorkspaceRiskPolicy,
  citeFact,
  citeInference,
  destinationRule,
  ownerChangeRule,
  provenanceRule,
  renderCitation,
  screenSafely,
  screeningFlags,
  staleDataRule,
  vendorAnomalyRule,
  velocityRule,
  type Citation,
  type RiskCaseService,
  type RiskFlag,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { canonicalArtifactHash } from '@synq/schemas';
import {
  ARC_FIELD_POLICY,
  evaluateArcSnapshot,
  usdcDisplay,
  type ArcWorldSnapshot,
  type ToolAvailability,
} from '@synq/world-model';
import { AgentRuntimeError, type BudgetLimits } from '../subagents.js';
import { renderUntrusted, wrapUntrusted } from '../untrusted.js';
import { effectiveLimits, usageOf } from '../finance-team/budget.js';
import type { FinanceDesk } from '../finance-team/desk.js';
import {
  RiskRecommendationSchema,
  type RiskRecommendation,
  type TimingRecommendation,
} from '../finance-team/proposals.js';
import {
  cfoTiming,
  clip,
  paymentAgentSubmit,
  riskAgentAssess,
  type KernelSubmission,
} from '../finance-team/specialists.js';
import { FinanceTeam, type FinanceAgent } from '../finance-team/team.js';
import { CapabilityGuard, gateOf, type CallArgs } from './guard.js';
import type { TeamRole, TeamTool } from './manifests.js';
import { runMetrics, type RunMetrics } from './metrics.js';

/**
 * The agent-team council: one chat message in, one coherent answer out, with
 * labelled role sections ("CFO:", "Risk:", "Decision (Kernel):") and
 * evidence. Specialists form independent recommendations through the
 * external capability guard; the Supervisor compiles them into the Kernel's
 * deterministic inputs; the Kernel decides; the answer reports what the
 * Kernel decided, never what a model preferred. A chat request is never an
 * approval: any payout needs the owner's EIP-712 signature.
 */

export const PERSONAS = [
  'CFO',
  'RISK',
  'PAYMENT',
  'AUDIT',
  'INVOICE',
  'DEAL',
  'COMMERCE',
  'TRAVEL',
  'RESEARCH',
] as const;
export type Persona = (typeof PERSONAS)[number];
export const PERSONA_LABEL: Readonly<Record<Persona, string>> = {
  CFO: 'CFO',
  RISK: 'Risk',
  PAYMENT: 'Payment',
  AUDIT: 'Audit',
  INVOICE: 'Invoice',
  DEAL: 'Deal',
  COMMERCE: 'Commerce',
  TRAVEL: 'Travel',
  RESEARCH: 'Research',
};
const PERSONA_WORDS: readonly [Persona, RegExp][] = [
  ['CFO', /\bcfo\b/i],
  ['RISK', /\brisk(\s+agent)?\b/i],
  ['PAYMENT', /\bpayments?\s+agent\b/i],
  ['AUDIT', /\baudit(or|\s+agent)?\b/i],
  ['INVOICE', /\binvoice\s+agent\b/i],
  ['DEAL', /\bdeal\s+agent\b/i],
  ['COMMERCE', /\bcommerce\s+agent\b/i],
  ['TRAVEL', /\btravel\s+agent\b/i],
  ['RESEARCH', /\bresearch(er|\s+agent)\b/i],
];

export type TeamRequestKind =
  | 'TEAM_QUESTION'
  | 'PAY_REQUEST'
  | 'CAPABILITIES'
  | 'OTHER';
export type TeamRequest = Readonly<{
  kind: TeamRequestKind;
  personas: Persona[];
  counterparty: string | null;
  /** Display decimal (USDC). */
  amount: string | null;
  requestedRecipient: Address | null;
  classifiedBy: 'RULES' | 'MODEL';
  /** Why a model reading was rejected, if it was. */
  modelRejected: string | null;
}>;

const AMOUNT =
  /\$\s?(\d{1,12}(?:\.\d{1,6})?)|\b(\d{1,12}(?:\.\d{1,6})?)\s*(?:usdc|usd|dollars?)\b/i;

/** Deterministic reading of a team request (the model may refine it, never widen it). */
export function parseTeamRequest(message: string): TeamRequest {
  const text = message.replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase();
  const personas = PERSONA_WORDS.filter(([, re]) => re.test(text)).map(
    ([p]) => p,
  );
  const addresses = [
    ...text.matchAll(
      /(?:pay\s+to|send\s+to|to|at|destination|recipient|wallet|address)\s*[:=]?\s*(0x[0-9a-fA-F]{40})\b/gi,
    ),
  ].map((m) => m[1]!);
  const amount = AMOUNT.exec(text);
  const capabilities =
    /\b(what can you do|which tools|tools? (are )?(available|unavailable)|are you able|can you (use|reach)|capabilit)/i.test(
      t,
    );
  const pay = /\b(pay|paying|payout|settle)\b/.test(t);
  const asks =
    /\b(should|can|could|would|whether|is it (ok|safe))\b|\?\s*$/.test(t);
  const counterparty =
    (
      /\b(?:[Pp]ay|[Pp]aying|[Ss]ettle)\s+([A-Z][\w-]*)/.exec(text)?.[1] ??
      /\b([A-Z][\w-]*)'s\b/.exec(text)?.[1] ??
      null
    )?.replace(/'s$/, '') ?? null;
  const kind: TeamRequestKind = capabilities
    ? 'CAPABILITIES'
    : pay && (asks || personas.length)
      ? 'TEAM_QUESTION'
      : pay
        ? 'PAY_REQUEST'
        : personas.length
          ? 'TEAM_QUESTION'
          : 'OTHER';
  return {
    kind,
    personas,
    counterparty:
      counterparty && !/^(this|the|our|my|we|i)$/i.test(counterparty)
        ? counterparty
        : null,
    amount: amount ? (amount[1] ?? amount[2] ?? null) : null,
    requestedRecipient:
      addresses.length === 1 ? (addresses[0] as Address) : null,
    classifiedBy: 'RULES',
    modelRejected: null,
  };
}

export const TeamRequestModelSchema = z.strictObject({
  kind: z.enum(['TEAM_QUESTION', 'PAY_REQUEST', 'CAPABILITIES', 'OTHER']),
  counterparty: z.string().min(1).max(80).nullable(),
  amount: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,6})?$/)
    .nullable(),
  recipientAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .nullable(),
  personas: z.array(z.enum(PERSONAS)).max(PERSONAS.length),
});

/**
 * Accepts a model reading only where it is anchored in the text: an address
 * or amount the model reports must appear verbatim in the message, and the
 * model can never turn a question into a payment request.
 */
export function anchorModelReading(
  message: string,
  rules: TeamRequest,
  m: z.output<typeof TeamRequestModelSchema>,
): TeamRequest {
  const lowerMsg = message.toLowerCase();
  const nonAddressText = message.replace(/0x[0-9a-fA-F]+/g, ' ');
  const reject = (why: string): TeamRequest => ({
    ...rules,
    modelRejected: why,
  });
  if (
    m.recipientAddress &&
    !lowerMsg.includes(m.recipientAddress.toLowerCase())
  )
    return reject(`model address ${m.recipientAddress} is not in the message`);
  if (
    m.amount &&
    !new RegExp(`(^|[^\\d.])${m.amount.replace('.', '\\.')}([^\\d.]|$)`).test(
      nonAddressText,
    )
  )
    return reject(`model amount ${m.amount} is not in the message`);
  if (m.amount && rules.amount && Number(m.amount) !== Number(rules.amount))
    return reject('model amount disagrees with the explicit amount');
  if (m.kind === 'PAY_REQUEST' && rules.kind !== 'PAY_REQUEST')
    return reject(
      'model widened a non-imperative message into a payment request',
    );
  if (rules.kind === 'PAY_REQUEST' && m.kind !== 'PAY_REQUEST')
    return reject('model disagrees that this is a payment request');
  // "this contractor", "our vendor": a reference, not a name.
  const named =
    m.counterparty &&
    !/^(this|that|the|our|my|your|a|an)\b/i.test(m.counterparty.trim())
      ? m.counterparty.trim()
      : null;
  if (
    named &&
    !new RegExp(
      `(^|[^a-z0-9])${named
        .toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+')}([^a-z0-9]|$)`,
    ).test(lowerMsg)
  )
    return reject(`model counterparty ${named} is not in the message`);
  return {
    kind: m.kind === 'OTHER' ? rules.kind : m.kind,
    personas: [
      ...new Set([
        ...rules.personas,
        ...m.personas.filter(
          (p) =>
            rules.personas.includes(p) ||
            PERSONA_WORDS.find(([q]) => q === p)![1].test(message),
        ),
      ]),
    ],
    counterparty: named ?? rules.counterparty,
    amount: m.amount ?? rules.amount,
    requestedRecipient:
      (m.recipientAddress as Address | null) ?? rules.requestedRecipient,
    classifiedBy: 'MODEL',
    modelRejected: null,
  };
}

/** What the council may read beyond the finance desk. */
export type TeamDesk = FinanceDesk &
  Readonly<{
    screening: WalletScreeningPort;
    cases: RiskCaseService;
    /** Mirrors the Kernel's `riskRequiredAbove`. */
    highValueAt: bigint;
    /** Paid payouts (vendor master history) for anomaly and velocity rules. */
    payoutHistory?: readonly { vendorId: string; amount: bigint; at: number }[];
    /** Owner / approver / quorum changes (identity log). */
    controlChanges?: readonly {
      kind: 'OWNER' | 'APPROVER' | 'QUORUM';
      at: number;
    }[];
    /** Wall clock (unix seconds) at mutation time; defaults to `now`. */
    clock?: () => number;
    /** Explorer base for tx links (e.g. https://testnet.arcscan.app/tx/). */
    explorerTxUrl?: string;
    velocity?: { windowSeconds: number; maxInWindow: bigint; maxCount: number };
    /** Workspace policy: wait after a destination verification (default 24h). */
    destinationCoolingSeconds?: number;
    riskPolicy?: WorkspaceRiskPolicy;
    riskPolicyOwners?: readonly Address[];
    vendorProvenance?: string;
  }>;

export type TeamSection = Readonly<{
  persona: Persona | 'DECISION';
  label: string;
  stance: 'PAY' | 'HOLD' | 'VETO' | 'REVIEW' | 'CLEAR' | 'INFO' | 'UNAVAILABLE';
  text: string;
  citations: Citation[];
}>;

export type Conflict = Readonly<{
  between: [Persona, Persona];
  positions: [string, string];
  resolvedBy: 'KERNEL';
  outcome: string;
  rule: string;
}>;

export type KernelVerdict = Readonly<{
  status: KernelSubmission['status'] | 'NOT_SUBMITTED' | 'REFUSED_STALE';
  outcome: 'ALLOW' | 'REQUIRE_OWNER_APPROVAL' | 'DENY' | null;
  reasons: string[];
}>;

export type TeamReply = Readonly<{
  runId: string;
  status: 'ANSWERED' | 'NEEDS_CLARIFICATION' | 'STOPPED';
  request: TeamRequest;
  sections: TeamSection[];
  conflicts: Conflict[];
  decision: KernelVerdict;
  /** Deterministic inputs the Supervisor handed the Kernel. */
  compiled: Readonly<{ flags: RiskFlag[]; available: boolean }> | null;
  riskCase: Readonly<{
    caseId: string;
    status: string;
    outcome: 'OPENED' | 'ATTACHED' | 'DUPLICATE_ALERT' | 'EXISTING_HOLD';
    froze: boolean;
  }> | null;
  intent: PaymentIntent | null;
  /** Non-enumerable grant inside; hand only to the executor. */
  kernel: KernelSubmission | null;
  world: Readonly<{
    builtAt: number;
    decisionGrade: boolean;
    refreshed: boolean;
  }> | null;
  tools: ToolAvailability[];
  citations: Citation[];
  answer: string;
  metrics: RunMetrics;
  auditHash: string | null;
}>;

const usdc = (b: bigint | string) => `${usdcDisplay(b)} USDC`;
const lower = (s: string) => s.toLowerCase();
const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const FRAUD_CODES = new Set([
  'DESTINATION_CHANGED',
  'DESTINATION_RECENTLY_CHANGED',
  'PAYOUT_ADDRESS_CHANGED',
  'RECIPIENT_NOT_VERIFIED',
  'SCREENING_HIT',
  'DUPLICATE_INVOICE',
  'AMOUNT_ANOMALY',
  'SPEND_VELOCITY',
  'PAYOUT_BURST',
  'GUARD_COUNTERPARTY_NOT_APPROVED',
  'CONTROL_RECENTLY_CHANGED',
]);

function vendorFor(
  desk: TeamDesk,
  s: ArcWorldSnapshot,
  who: string | null,
): Vendor | null {
  if (who) {
    const n = normName(who);
    const hits = desk.vendors.filter(
      (v) =>
        normName(v.name) === n ||
        normName(v.name).split(' ')[0] === n ||
        lower(v.vendorId) === lower(who),
    );
    return hits.length === 1 ? hits[0]! : null;
  }
  // "this contractor": the single contractor with an open payable.
  const open = new Set(
    s.obligations.payables.value
      .filter((p) => p.status !== 'PAID')
      .map((p) => p.vendorId),
  );
  const hits = desk.vendors.filter(
    (v) => v.kind === 'CONTRACTOR' && open.has(v.vendorId),
  );
  return hits.length === 1 ? hits[0]! : null;
}

function openPayable(
  desk: TeamDesk,
  s: ArcWorldSnapshot,
  vendor: Vendor,
  amount: bigint | null,
): VendorInvoice | null {
  const open = new Set(
    s.obligations.payables.value
      .filter((p) => p.status !== 'PAID')
      .map((p) => p.vendorInvoiceId),
  );
  const mine = desk.vendorInvoices.filter(
    (i) => i.vendorId === vendor.vendorId && open.has(i.vendorInvoiceId),
  );
  const matching =
    amount === null ? mine : mine.filter((i) => i.amount === amount);
  return matching.length === 1 ? matching[0]! : null;
}

/**
 * One council turn. `confirm` carries the owner's EIP-712 approval of an
 * earlier PROPOSED intent (from the wallet, never from chat).
 */
export async function askTeam(
  message: string,
  desk: TeamDesk,
  options: Parameters<typeof askTeamRun>[2] = {},
): Promise<TeamReply> {
  const budget: { finish: (() => Promise<void>) | null } = { finish: null };
  try {
    return await askTeamRun(message, desk, options, budget);
  } finally {
    await budget.finish?.();
  }
}

async function askTeamRun(
  message: string,
  desk: TeamDesk,
  options: {
    runId?: string;
    origin?: 'CHAT' | 'SYSTEM';
    limits?: Partial<BudgetLimits>;
    confirm?: { ownerApproval: Hex; approval: ApprovalTerms };
    /** Wall clock in ms for latency and guard deadlines. */
    clockMs?: () => number;
    onControl?: (control: {
      runId: string;
      revoke: (reason: string) => void;
    }) => void;
  },
  budget: { finish: (() => Promise<void>) | null },
): Promise<TeamReply> {
  const clockMs = options.clockMs ?? Date.now;
  const started = clockMs();
  const runId = options.runId ?? `team_${desk.now}`;
  const reservation = desk.budget?.reserve
    ? await desk.budget.reserve(
        desk.workspaceId,
        usageOf(effectiveLimits(options.limits, null)),
        runId,
      )
    : null;
  const limits = effectiveLimits(
    options.limits,
    reservation?.granted ??
      (desk.budget ? await desk.budget.remaining(desk.workspaceId) : null),
  );
  let meteredTeam: FinanceTeam | null = null;
  let recorded = false;
  budget.finish = async () => {
    if (recorded || !desk.budget) return;
    recorded = true;
    const u = meteredTeam?.manager.usage() ?? {
      toolCalls: 0,
      tokens: 0,
      paidMicroUsd: 0,
    };
    const used = {
      toolCalls: u.toolCalls,
      tokens: u.tokens,
      paidMicroUsd: u.paidMicroUsd,
    };
    if (reservation && desk.budget.settle)
      await desk.budget.settle(
        desk.workspaceId,
        reservation.reservationId,
        used,
      );
    else await desk.budget.record(desk.workspaceId, used);
  };
  const team = new FinanceTeam(runId, limits);
  meteredTeam = team;
  const guard = new CapabilityGuard({
    verifiedCounterparties: () =>
      desk.vendors.flatMap((v) =>
        v.addresses
          .filter((a) => a.status === 'VERIFIED')
          .map((a) => a.address),
      ),
    clockMs,
  });
  guard.root(team.supervisor.handle.agentId);
  team.attachGate(gateOf(guard));
  options.onControl?.({
    runId,
    revoke: (reason) => guard.revoke(team.supervisor.handle.agentId, reason),
  });
  const sup = team.supervisor;
  const origin = options.origin ?? 'CHAT';
  let request = parseTeamRequest(message);
  let world: ArcWorldSnapshot | null = null;
  let refreshed = false;
  const sections: TeamSection[] = [];
  const conflicts: Conflict[] = [];
  const citations: Citation[] = [];
  let decision: KernelVerdict = {
    status: 'NOT_SUBMITTED',
    outcome: null,
    reasons: [],
  };
  let compiled: TeamReply['compiled'] = null;
  let riskCase: TeamReply['riskCase'] = null;
  let intent: PaymentIntent | null = null;
  let kernel: KernelSubmission | null = null;
  const at = () => desk.clock?.() ?? desk.now;

  const finish = async (
    status: TeamReply['status'],
    answerHead: string | null,
  ): Promise<TeamReply> => {
    team.close();
    await budget.finish?.();
    const tools = world
      ? world.capabilities.tools.filter((t) => t.status !== 'AVAILABLE')
      : [];
    const answer = composeAnswer(answerHead, sections, tools);
    const metrics = runMetrics({
      runId,
      team,
      guard,
      startedMs: started,
      endedMs: clockMs(),
    });
    let auditHash: string | null = null;
    try {
      const rec = await desk.cases.record(
        desk.workspaceId,
        'SUPERVISOR',
        'TEAM_RUN',
        {
          runId,
          origin,
          request,
          status,
          decision,
          compiled,
          riskCase,
          intent,
          conflicts,
          sections: sections.map((s) => ({
            persona: s.persona,
            stance: s.stance,
            text: s.text,
          })),
          metrics,
        },
        citations.slice(0, 20),
      );
      auditHash = rec.hash;
      await desk.cases.anchor(desk.workspaceId);
    } catch (error) {
      auditHash = null;
      if (intent)
        throw new AgentRuntimeError(
          'CANCELLED',
          `money-path audit failed: ${(error as Error).name}`,
        );
    }
    return {
      runId,
      status,
      request,
      sections,
      conflicts,
      decision,
      compiled,
      riskCase,
      intent,
      kernel,
      world: world
        ? {
            builtAt: world.builtAt,
            decisionGrade: world.decision.decisionGrade,
            refreshed,
          }
        : null,
      tools,
      citations,
      answer,
      metrics,
      auditHash,
    };
  };

  /** A council tool outside the finance registry: guard first, then the shared budget. */
  const teamTool = async <T>(
    agent: FinanceAgent,
    tool: TeamTool,
    args: CallArgs,
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    team.manager.charge(agent.handle.agentId, { toolCalls: 1 }, tool);
    return guard.run(agent.handle.agentId, tool, args, work);
  };
  const factOf = (
    path: keyof typeof ARC_FIELD_POLICY,
    claim: string,
    s: ArcWorldSnapshot,
  ): Citation | null => {
    const [group, name] = path.split('.') as [string, string];
    const o = (
      s as unknown as Record<
        string,
        Record<
          string,
          {
            meta: {
              provenance: string;
              source: string;
              observedAt: number | null;
            };
          }
        >
      >
    )[group]?.[name];
    if (!o) return null;
    try {
      return citeFact({
        claim,
        source: `snapshot:${path} <- ${o.meta.source}`,
        ref: path,
        provenance: o.meta.provenance,
        observedAt: o.meta.observedAt,
        now: at(),
      });
    } catch {
      return null;
    }
  };

  try {
    // ---- understand the request: rules first, the model may only refine.
    if (desk.reasoner && request.kind !== 'OTHER') {
      const evidence = wrapUntrusted({
        evidenceId: 'member_request',
        kind: 'MEMBER_MESSAGE',
        origin: 'chat',
        retrievedAt: desk.now,
        content: message,
      });
      const { parsed, record } = await team.model({
        agent: sup,
        reasoner: desk.reasoner,
        fixtureKey: 'team:supervisor:request',
        schemaName: 'team_request',
        schema: TeamRequestModelSchema,
        userMessage: `Read the member's request. Report the request kind, the counterparty name, the amount and the recipient address exactly as written (null when absent), and which specialists (personas) the member asked for. Never invent an address or amount.\n${renderUntrusted([evidence])}`,
      });
      if (parsed?.ok) {
        request = anchorModelReading(message, request, parsed.value);
        citations.push(
          citeInference({
            claim: `request read as ${request.kind}${request.counterparty ? ` for ${request.counterparty}` : ''}${request.amount ? `, ${request.amount} USDC` : ''}${request.requestedRecipient ? ` to ${request.requestedRecipient}` : ''}${request.modelRejected ? ` (model reading rejected: ${request.modelRejected})` : ''}`,
            model: record.model,
            at: desk.now,
          }),
        );
      }
    }
    if (request.kind === 'OTHER')
      return finish(
        'NEEDS_CLARIFICATION',
        'Ask me (or name a specialist: CFO, Risk, Payment, Audit) about paying a contractor, cash, or what I can do right now.',
      );

    world = evaluateArcSnapshot(
      await team.tool(sup, 'world.snapshot', () => desk.world()),
      at(),
    );
    if (
      !world.decision.decisionGrade &&
      desk.refreshWorld &&
      request.kind !== 'CAPABILITIES'
    ) {
      // Stale critical data is refreshed before specialists reason on it.
      world = evaluateArcSnapshot(
        await team.tool(sup, 'world.snapshot', () => desk.refreshWorld!()),
        at(),
      );
      refreshed = true;
    }
    const s0 = world;

    if (request.kind === 'CAPABILITIES') {
      const rows = s0.capabilities.tools;
      sections.push({
        persona: 'DECISION',
        label: 'Tools',
        stance: 'INFO',
        text:
          rows
            .map(
              (t) =>
                `${t.tool}: ${t.status}${t.status === 'AVAILABLE' ? '' : ` (${t.reason})`}`,
            )
            .join('; ') || 'No tools are bound in this deployment.',
        citations: [],
      });
      return finish('ANSWERED', 'Here is what I can and cannot do right now.');
    }

    const vendor = vendorFor(desk, s0, request.counterparty);
    if (!vendor)
      return finish(
        'NEEDS_CLARIFICATION',
        request.counterparty
          ? `I could not match "${clip(request.counterparty, 40)}" to exactly one vendor in your vendor master.`
          : 'Which contractor do you mean? I found no single contractor with an open payable.',
      );
    const asset = token(s0.primaryChain, 'USDC');
    let amount: bigint | null = null;
    if (request.amount)
      try {
        amount = moneyFromDecimal(asset, request.amount).baseUnits;
      } catch (e) {
        if (e instanceof AmountError)
          return finish(
            'NEEDS_CLARIFICATION',
            `I could not read the amount "${request.amount}".`,
          );
        throw e;
      }
    const verified = verifiedAddress(vendor, asset.chainId);
    const payable = openPayable(desk, s0, vendor, amount);
    const recipient = request.requestedRecipient ?? verified;
    if (!recipient)
      return finish(
        'NEEDS_CLARIFICATION',
        `${clip(vendor.name, 40)} has no verified payout address on ${s0.primaryChain}, and you named none.`,
      );
    const fromBooks =
      payable !== null &&
      (!request.requestedRecipient ||
        lower(request.requestedRecipient) === lower(payable.payTo)) &&
      (amount === null || amount === payable.amount);
    // The subject the specialists assess: the open payable as booked, or exactly what the chat asked for.
    const vi: VendorInvoice = fromBooks
      ? payable!
      : {
          vendorInvoiceId: `chat_${canonicalArtifactHash({ v: vendor.vendorId, r: lower(recipient), a: String(amount ?? payable?.amount ?? 0n), m: message }).slice(2, 14)}`,
          vendorId: vendor.vendorId,
          number: payable?.number ?? 'CHAT-REQUEST',
          payTo: recipient,
          chainId: asset.chainId,
          amount: amount ?? payable?.amount ?? 0n,
          issuedOn: desk.today,
          dueOn: payable?.dueOn ?? desk.today,
          reference: payable?.reference ?? null,
          documentText: message,
          earlyPayDiscountBps: 0,
          earlyPayByDays: 0,
        };
    if (vi.amount <= 0n)
      return finish(
        'NEEDS_CLARIFICATION',
        `How much should ${clip(vendor.name, 40)} be paid? I found no single open payable to use.`,
      );

    // ---- independent specialist recommendations
    const cfo = team.spawn(sup, 'CFO');
    const riskAgent = team.spawn(sup, 'RISK');
    const pay = team.spawn(sup, 'PAYMENT');
    let { timing } = cfoTiming(team, cfo, desk, s0, vi);
    team.complete(cfo);

    // Payment Agent drafts exactly what was asked (never a silent substitute).
    const mandate = s0.obligations.mandates.value.find(
      (m) => !m.revoked && m.purposes.includes(purposeFor(vendor)),
    );
    const treasury = s0.identity.wallets.value.find(
      (w) => w.role === 'TREASURY' && w.chain === s0.primaryChain,
    );
    if (mandate && treasury)
      intent = team.tool(pay, 'payment.prepare', () => ({
        intentId: `int_${vi.vendorInvoiceId}`,
        mandateId: mandate.mandateId,
        mandateVersion: mandate.version,
        chainId: asset.chainId,
        token: asset.address,
        payer: treasury.address as Address,
        recipient: vi.payTo,
        amount: vi.amount,
        purpose: purposeFor(vendor),
        obligationRef: vi.reference ?? vi.vendorInvoiceId,
        evidenceHash: canonicalArtifactHash({
          vendorInvoiceId: vi.vendorInvoiceId,
          recipient: lower(vi.payTo),
          amount: String(vi.amount),
          message: fromBooks ? null : message,
        }) as Hex,
        proposedBy: `agent:${pay.handle.agentId}`,
      }));

    let assessed = riskAgentAssess(team, riskAgent, desk, s0, vi, intent);
    const now = at();
    const cooling = await coolingSecondsFor({
      workspaceId: desk.workspaceId,
      policy: desk.riskPolicy,
      owners: desk.riskPolicyOwners ?? [],
      chainId: asset.chainId,
    });
    const ruleFlags: RiskFlag[] = [
      ...destinationRule({
        vendorName: clip(vendor.name, 60),
        requested: vi.payTo,
        chainId: asset.chainId,
        addresses: vendor.addresses,
        now,
        coolingSeconds: cooling.seconds,
      }),
      // Anomaly rules need the paid history; without it they say nothing rather than guess.
      ...(desk.payoutHistory
        ? vendorAnomalyRule({
            vendorName: clip(vendor.name, 60),
            amount: vi.amount,
            history: desk.payoutHistory
              .filter((p) => p.vendorId === vendor.vendorId)
              .map((p) => p.amount),
            firstPayoutHardAt: desk.highValueAt,
          })
        : []),
      ...(desk.velocity
        ? velocityRule({
            amount: vi.amount,
            recent: desk.payoutHistory ?? [],
            now,
            windowSeconds: desk.velocity.windowSeconds,
            maxInWindow: desk.velocity.maxInWindow,
            maxCountInWindow: desk.velocity.maxCount,
          })
        : []),
      ...ownerChangeRule({
        changes: desk.controlChanges ?? [],
        now,
        holdSeconds: 24 * 3600,
      }),
      ...provenanceRule([
        {
          field: 'recipient',
          provenance:
            fromBooks || (verified && lower(vi.payTo) === lower(verified))
              ? 'POSTGRES'
              : 'CHAT',
          source: fromBooks ? 'vendor master / AP ledger' : 'chat message',
        },
        {
          field: 'amount',
          provenance:
            payable && vi.amount === payable.amount ? 'POSTGRES' : 'CHAT',
          source:
            payable && vi.amount === payable.amount
              ? `payable ${payable.vendorInvoiceId}`
              : 'chat message',
        },
      ]),
    ];
    const screen = await teamTool(
      riskAgent,
      'risk.screenCounterparty',
      { chain: s0.primaryChain },
      () =>
        screenSafely(desk.screening, {
          address: vi.payTo,
          chainId: asset.chainId,
          now,
        }),
    );
    const screening = screeningFlags({
      result: screen.value,
      amount: vi.amount,
      highValueAt: desk.highValueAt,
      counterpartyVerified: Boolean(
        verified && lower(verified) === lower(vi.payTo),
      ),
    });
    const riskFlags = dedupe([
      ...assessed.flags,
      ...ruleFlags,
      ...screening.flags,
    ]);
    const subjectRef = `payout:${vendor.vendorId}:${lower(vi.payTo)}`;
    const fraud = riskFlags.filter(
      (f) => f.severity === 'HARD' && FRAUD_CODES.has(f.code),
    );
    if (fraud.length) {
      guard.authorize(riskAgent.handle.agentId, 'case.hold');
      team.manager.charge(
        riskAgent.handle.agentId,
        { toolCalls: 1 },
        'case.hold',
      );
      const raised = await desk.cases.raise({
        workspaceId: desk.workspaceId,
        alertKey: alertKeyOf({
          subjectRef,
          codes: fraud.map((f) => f.code),
          evidence: `${vi.amount}:${lower(vi.payTo)}`,
        }),
        subjectRef,
        counterparty: vi.payTo,
        flags: fraud,
        raisedBy: `RISK:${riskAgent.handle.agentId}`,
        at: now,
      });
      riskCase = raised.case
        ? {
            caseId: raised.case.caseId,
            status: raised.case.status,
            outcome: raised.status,
            froze: raised.froze,
          }
        : null;
    } else {
      const held = await desk.cases.store.activeCase(
        desk.workspaceId,
        subjectRef,
      );
      if (held)
        riskCase = {
          caseId: held.caseId,
          status: held.status,
          outcome: 'EXISTING_HOLD',
          froze: false,
        };
    }
    const holds = await desk.cases.holdFlags(desk.workspaceId, subjectRef);
    team.complete(riskAgent);
    let risk: RiskRecommendation = RiskRecommendationSchema.parse({
      kind: 'RISK_RECOMMENDATION',
      subject: vi.vendorInvoiceId,
      recommendation:
        riskFlags.some((f) => f.severity === 'HARD') || holds.length
          ? 'VETO'
          : riskFlags.length
            ? 'REVIEW'
            : 'CLEAR',
      flags: [...riskFlags, ...holds].map((f) => ({
        code: clip(f.code, 64),
        severity: f.severity,
        detail: clip(f.detail, 400),
      })),
      injectionSignals: assessed.injectionSignals,
    });

    // ---- sections
    let cfoStance: TeamSection['stance'] =
      timing.action === 'HOLD' || timing.action === 'REFUSE_STALE'
        ? 'HOLD'
        : 'PAY';
    const cfoCites = [
      factOf('treasury.balances', 'treasury balance', s0),
      factOf('treasury.reserves', 'cash buffer', s0),
      fromBooks
        ? factOf(
            'obligations.payables',
            `payable ${vi.vendorInvoiceId} (${vi.number}) due ${vi.dueOn}`,
            s0,
          )
        : null,
    ].filter((c): c is Citation => c !== null);
    sections.push({
      persona: 'CFO',
      label: 'CFO',
      stance: cfoStance,
      text: cfoText(timing, vi, fromBooks),
      citations: cfoCites,
    });
    const riskCites: Citation[] = [];
    if (
      verified &&
      ['CHAIN', 'ENVIO', 'POSTGRES', 'PLUGIN', 'KERNEL', 'CONFIG'].includes(
        desk.vendorProvenance ?? '',
      )
    )
      riskCites.push(
        citeFact({
          claim: `${vendor.name} verified payout address`,
          source: 'vendor master',
          ref: verified,
          provenance: desk.vendorProvenance ?? 'UNVERIFIED',
          observedAt:
            vendor.addresses.find((a) => lower(a.address) === lower(verified))
              ?.at ?? null,
          now,
        }),
      );
    sections.push({
      persona: 'RISK',
      label: 'Risk',
      stance:
        risk.recommendation === 'VETO'
          ? 'VETO'
          : risk.recommendation === 'REVIEW'
            ? 'REVIEW'
            : 'CLEAR',
      text: riskText(risk, screen.value.verdict, screen.value.reason, riskCase),
      citations: riskCites,
    });

    // ---- compile for the Kernel
    // Mutation gate: decide on fresh balances, refreshing once if needed.
    let s = evaluateArcSnapshot(s0, at());
    if (!s.decision.decisionGrade && desk.refreshWorld) {
      s = evaluateArcSnapshot(
        await team.tool(sup, 'world.snapshot', () => desk.refreshWorld!()),
        at(),
      );
      refreshed = true;
      world = s;
      const freshCfo = team.spawn(sup, 'CFO');
      const freshRisk = team.spawn(sup, 'RISK');
      timing = cfoTiming(team, freshCfo, { ...desk, now: at() }, s, vi).timing;
      const oldCodes = new Set(assessed.flags.map((f) => f.code));
      assessed = riskAgentAssess(
        team,
        freshRisk,
        { ...desk, now: at() },
        s,
        vi,
        intent,
      );
      team.complete(freshCfo);
      team.complete(freshRisk);
      const flags = dedupe([
        ...risk.flags.filter((f) => !oldCodes.has(f.code)),
        ...assessed.flags,
      ]);
      risk = RiskRecommendationSchema.parse({
        ...risk,
        flags,
        recommendation: flags.some((f) => f.severity === 'HARD')
          ? 'VETO'
          : flags.length
            ? 'REVIEW'
            : 'CLEAR',
      });
      cfoStance =
        timing.action === 'HOLD' || timing.action === 'REFUSE_STALE'
          ? 'HOLD'
          : 'PAY';
      const ci = sections.findIndex((x) => x.persona === 'CFO');
      if (ci >= 0)
        sections[ci] = {
          ...sections[ci]!,
          stance: cfoStance,
          text: cfoText(timing, vi, fromBooks),
          citations: [
            factOf('treasury.balances', 'treasury balance', s),
            factOf('treasury.reserves', 'cash buffer', s),
          ].filter((c): c is Citation => c !== null),
        };
      const ri = sections.findIndex((x) => x.persona === 'RISK');
      if (ri >= 0)
        sections[ri] = {
          ...sections[ri]!,
          stance:
            risk.recommendation === 'VETO'
              ? 'VETO'
              : risk.recommendation === 'REVIEW'
                ? 'REVIEW'
                : 'CLEAR',
          text: riskText(
            risk,
            screen.value.verdict,
            screen.value.reason,
            riskCase,
          ),
        };
    }
    const cfoFlags: RiskFlag[] =
      timing.action === 'REFUSE_STALE'
        ? [
            {
              code: 'CFO_DATA_STALE',
              severity: 'HARD',
              detail: clip(timing.reason, 300),
            },
          ]
        : timing.action === 'HOLD'
          ? [
              {
                code: 'CFO_ADVISES_HOLD',
                severity: 'SOFT',
                detail: clip(timing.reason, 300),
              },
            ]
          : [];
    const pending = s.capabilities.tools.find(
      (t) => t.tool === 'payment.submitToKernel',
    );
    if (pending && ['PENDING_OUTCOME', 'UNVERIFIED'].includes(pending.status))
      risk = {
        ...risk,
        recommendation: 'VETO',
        flags: [
          ...risk.flags,
          { code: 'PENDING_OUTCOME', severity: 'HARD', detail: pending.reason },
        ],
      };
    const stale = staleDataRule(
      [
        {
          path: 'treasury.balances',
          observedAt: s.treasury.balances.meta.observedAt,
          maxAgeSeconds: ARC_FIELD_POLICY['treasury.balances'].maxAgeSeconds,
        },
        {
          path: 'obligations.mandates',
          observedAt: s.obligations.mandates.meta.observedAt,
          maxAgeSeconds: ARC_FIELD_POLICY['obligations.mandates'].maxAgeSeconds,
        },
      ],
      at(),
    );
    let guardFlags: RiskFlag[] = [];
    if (intent)
      guardFlags = guard.authorize(
        pay.handle.agentId,
        'payment.submitToKernel',
        {
          amountBaseUnits: intent.amount,
          counterparty: intent.recipient,
          chain: s.primaryChain,
        },
      ).flags;
    compiled = {
      flags: dedupe([...risk.flags, ...cfoFlags, ...stale, ...guardFlags]),
      available: screening.available,
    };
    if (!s.decision.decisionGrade || stale.length) {
      decision = {
        status: 'REFUSED_STALE',
        outcome: null,
        reasons: [...s.decision.reasons, ...stale.map((f) => f.detail)],
      };
    } else if (!intent) {
      decision = {
        status: 'NOT_SUBMITTED',
        outcome: null,
        reasons: ['no active mandate or treasury wallet in the WorldSnapshot'],
      };
    } else {
      kernel = await paymentAgentSubmit(
        team,
        pay,
        desk,
        intent,
        {
          ...risk,
          flags: compiled.flags.map((f) => ({
            code: clip(f.code, 64),
            severity: f.severity,
            detail: clip(f.detail, 400),
          })),
        },
        {
          // Chat requests and questions never use the standing pre-approval.
          requireOwnerApproval:
            origin === 'CHAT' ||
            request.kind === 'TEAM_QUESTION' ||
            Boolean(options.confirm),
          riskAvailable: compiled.available,
          ...(options.confirm
            ? {
                ownerApproval: {
                  ...options.confirm.approval,
                  signature: options.confirm.ownerApproval,
                },
              }
            : {}),
        },
      );
      decision = {
        status: kernel.status,
        outcome: kernel.decision?.outcome ?? null,
        reasons: kernel.decision?.reasons ?? [],
      };
    }
    team.complete(pay);

    const outcome = decision.outcome ?? decision.status;
    if (cfoStance === 'PAY' && risk.recommendation === 'VETO')
      conflicts.push({
        between: ['CFO', 'RISK'],
        positions: [
          `pay (${timing.action})`,
          `${risk.recommendation === 'VETO' ? 'hold' : 'review'} (${
            risk.flags
              .filter((f) => f.severity === 'HARD')
              .map((f) => f.code)
              .join(', ') || risk.flags.map((f) => f.code).join(', ')
          })`,
        ],
        resolvedBy: 'KERNEL',
        outcome,
        rule: 'any HARD flag denies; SOFT flags are disclosed and need the owner signature',
      });
    if (cfoStance === 'HOLD' && risk.recommendation === 'CLEAR')
      conflicts.push({
        between: ['CFO', 'RISK'],
        positions: [`hold (${timing.reason})`, 'clear'],
        resolvedBy: 'KERNEL',
        outcome,
        rule: 'cash advice is a SOFT flag: disclosed, the owner decides by signing',
      });

    sections.push({
      persona: 'DECISION',
      label: 'Decision (Kernel)',
      stance:
        decision.outcome === 'ALLOW'
          ? 'PAY'
          : decision.outcome === 'DENY' || decision.status === 'REFUSED_STALE'
            ? 'VETO'
            : 'REVIEW',
      text: decisionText(decision, intent, vendor, kernel, conflicts),
      citations: [],
    });
    for (const e of desk.evidence
      .filter((x) => lower(x.verifiedRecipient) === lower(verified ?? ''))
      .slice(-2))
      citations.push(
        citeFact({
          claim: `earlier payout ${e.payout.amount} USDC to ${vendor.name}`,
          source: 'chain:arc-testnet',
          ref: e.payout.hash,
          provenance: 'CHAIN',
          observedAt: null,
          now,
          verifyUrl: e.payout.explorer,
        }),
      );
    citations.push(...sections.flatMap((x) => x.citations));
    if (fromBooks)
      citations.push(
        citeFact({
          claim: `invoice ${vi.number}`,
          source: 'AP ledger',
          ref: vi.vendorInvoiceId,
          provenance: s.obligations.payables.meta.provenance,
          observedAt: s.obligations.payables.meta.observedAt,
          now,
        }),
      );
    const shown = request.personas.length
      ? request.personas
      : (['CFO', 'RISK'] as Persona[]);
    for (let i = sections.length - 1; i >= 0; i--) {
      const p = sections[i]!.persona;
      if (p !== 'DECISION' && !shown.includes(p)) sections.splice(i, 1);
    }
    return finish('ANSWERED', null);
  } catch (error) {
    kernel = null;
    if (error instanceof AgentRuntimeError) {
      decision = {
        status: 'NOT_SUBMITTED',
        outcome: null,
        reasons: [`${error.kind}: ${error.message}`],
      };
      return finish(
        'STOPPED',
        `I stopped safely: ${error.kind} (${clip(error.message, 160)}). Nothing was signed or sent.`,
      );
    }
    if (error instanceof z.ZodError)
      return finish(
        'STOPPED',
        'I stopped safely: an output failed validation. Nothing was signed or sent.',
      );
    team.close();
    throw error;
  }
}

function purposeFor(v: Vendor): PaymentPurpose {
  return v.kind === 'CONTRACTOR' ? 'CONTRACTOR_PAYOUT' : 'VENDOR_INVOICE';
}

function dedupe(flags: readonly RiskFlag[]): RiskFlag[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const k = `${f.code}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cfoText(
  t: TimingRecommendation,
  vi: VendorInvoice,
  fromBooks: boolean,
): string {
  const subject = fromBooks
    ? `${vi.number} (${usdc(vi.amount)}, due ${vi.dueOn})`
    : `the requested ${usdc(vi.amount)}`;
  const verdict =
    t.action === 'PAY_EARLY'
      ? `pay early to save ${usdc(t.savingBaseUnits)}`
      : t.action === 'PAY_ON_DUE_DATE'
        ? `cash is available: pay on ${t.payOn}`
        : t.action === 'HOLD'
          ? `hold: ${t.reason}`
          : `no recommendation: ${t.reason}`;
  const cash =
    t.freeCashBaseUnits === null
      ? 'cash position unknown'
      : `free cash ${usdc(t.freeCashBaseUnits)}, buffer ${usdc(t.cashBufferBaseUnits ?? '0')}, ${usdc(t.cashAfterBaseUnits && !t.cashAfterBaseUnits.startsWith('-') ? t.cashAfterBaseUnits : '0')} left after paying`;
  const ages = t.citations
    .filter(
      (c) => c.path === 'treasury.balances' || c.path === 'treasury.reserves',
    )
    .map(
      (c) =>
        `${c.path} ${c.ageSeconds === null ? 'age unknown' : `${c.ageSeconds}s old`} (${c.freshness})`,
    )
    .join(', ');
  return `On ${subject}: ${verdict}. ${cash}. Sources: ${ages}.`;
}

function riskText(
  r: RiskRecommendation,
  verdict: string,
  reason: string,
  c: TeamReply['riskCase'],
): string {
  const hard = r.flags.filter((f) => f.severity === 'HARD');
  const soft = r.flags.filter((f) => f.severity === 'SOFT');
  const head =
    r.recommendation === 'VETO'
      ? `hold. ${hard
          .map((f) => `${f.code}: ${clip(f.detail, 160)}`)
          .slice(0, 4)
          .join(' | ')}`
      : r.recommendation === 'REVIEW'
        ? `no hard flags; review ${soft.map((f) => f.code).join(', ')}`
        : 'clear: no risk flags';
  const screening =
    verdict === 'UNAVAILABLE'
      ? `Counterparty screening UNAVAILABLE (${clip(reason, 120)}): not a pass.`
      : `Counterparty screening ${verdict}.`;
  const caseLine = c
    ? c.outcome === 'DUPLICATE_ALERT'
      ? ` Same alert as case ${c.caseId}: no second freeze.`
      : c.outcome === 'EXISTING_HOLD'
        ? ` Case ${c.caseId} already holds this destination.`
        : c.outcome === 'ATTACHED'
          ? ` Added to case ${c.caseId}, which already froze this destination (no second freeze).`
          : ` Opened case ${c.caseId}: payouts to this destination are frozen until a human reviews them.`
    : '';
  return `${head}. ${screening}${caseLine}`;
}

function decisionText(
  d: KernelVerdict,
  intent: PaymentIntent | null,
  vendor: Vendor,
  k: KernelSubmission | null,
  conflicts: readonly Conflict[],
): string {
  const what = intent
    ? `${usdc(intent.amount)} to ${intent.recipient}`
    : 'this payout';
  const resolved = conflicts.length
    ? ` The CFO and Risk disagreed; the Kernel's deterministic rules decided (${conflicts[0]!.rule}).`
    : '';
  switch (d.status) {
    case 'DENIED':
      return `DENY ${what}: ${d.reasons.slice(0, 5).join('; ')}. Nothing was signed or sent.${resolved}`;
    case 'PROPOSED':
      return `allowed only with your signature: ${what} for ${clip(vendor.name, 60)}. Sign the PaymentApproval in your wallet (intent ${k?.confirmation?.intent.intentId}); a chat reply is never an approval.${resolved}`;
    case 'OWNER_APPROVAL_REQUIRED':
      return `needs your wallet signature: ${d.reasons.join('; ')}.${resolved}`;
    case 'GRANTED':
      return `ALLOW ${what}: owner-approved grant ${k?.grant?.grantId} (expires ${k?.grant?.expiresAt}); only the restricted executor can use it, once.${resolved}`;
    case 'REFUSED_STALE':
      return `not decided: data is stale (${d.reasons.slice(0, 3).join('; ')}). Refresh before any payout.`;
    case 'NO_KERNEL':
      return 'no Kernel is connected, so nothing can be authorized.';
    default:
      return `not submitted: ${d.reasons.join('; ') || 'no payout was prepared'}.`;
  }
}

/** The single message posted to chat: labelled sections, evidence, unavailable tools. */
export function composeAnswer(
  head: string | null,
  sections: readonly TeamSection[],
  tools: readonly ToolAvailability[],
): string {
  const lines: string[] = [];
  if (head) lines.push(safeLine(head));
  for (const s of sections) {
    lines.push(
      `${s.persona === 'DECISION' ? 'Decision (Kernel)' : PERSONA_LABEL[s.persona]}: ${safeLine(s.text)}`,
    );
    if (s.citations.length)
      lines.push(
        `  Evidence: ${s.citations.map((c) => safeLine(renderCitation(c))).join(' ')}`,
      );
  }
  const down = unavailableSummary(tools);
  if (down.length && sections.length)
    lines.push(`Unavailable now: ${down.join('; ')}.`);
  return lines.join('\n');
}

export type { TeamRole };

/** The channel view of a reply (structurally `TeamReplyView` in @synq/channels). */
export function teamReplyView(r: TeamReply): {
  sections: { label: string; text: string; evidence: string[] }[];
  unavailable: string[];
  approval: { label: string; reviewPath: string } | null;
  footer: string | null;
} {
  return {
    sections: r.sections.map((s) => ({
      label: s.label,
      text: s.text,
      evidence: s.citations.map(renderCitation),
    })),
    unavailable: unavailableSummary(r.tools),
    approval:
      r.decision.status === 'PROPOSED' && r.intent
        ? {
            label: 'Review and sign in your wallet',
            reviewPath: `/intents/${encodeURIComponent(r.intent.intentId)}`,
          }
        : null,
    footer:
      r.status === 'ANSWERED' ? null : r.answer.split('\n')[0]!.slice(0, 300),
  };
}

/** Unavailable tools grouped by provider: "WALLET_SCREENING NEEDS_CREDENTIALS (risk.screenCounterparty)". */
export function unavailableSummary(
  tools: readonly ToolAvailability[],
): string[] {
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    if (t.status === 'AVAILABLE' || t.status === 'NEEDS_HUMAN') continue;
    const key = `${t.providerId ?? 'internal'} ${t.status}`;
    groups.set(key, [...(groups.get(key) ?? []), t.tool]);
  }
  return [...groups.entries()].map(([k, v]) => `${k} (${v.join(', ')})`);
}

function safeLine(text: string): string {
  return text
    .replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/Decision\s*\(Kernel\)\s*:/gi, '[quoted decision text]')
    .replace(/\s+/g, ' ')
    .trim();
}
