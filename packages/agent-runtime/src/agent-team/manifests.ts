import type { ChainName } from '@synq/chain-registry/arc';
import {
  FINANCE_TOOLS,
  SPECIALIST_MANIFESTS,
  SUPERVISOR_MANIFEST,
  type FinanceTool,
} from '../finance-team/manifests.js';

/**
 * Typed capability manifests for the whole Synq agent team (ADR-007).
 *
 * Every agent, including the Supervisor, is a manifest: the tools it may
 * call, the network hosts it may reach, read and write scopes, the largest
 * amount it may propose or pay for data, the counterparties it may name,
 * the networks it may touch, time and token/tool/paid budgets, how deep it
 * may delegate, concurrency, per-call timeout, what it may delegate further,
 * which dynamic templates it may instantiate, and the audit evidence it must
 * leave. The manifests are data; `CapabilityGuard` (guard.ts) enforces them
 * outside the model.
 *
 * Role invariants hold structurally, because the vocabulary has no way to
 * express the forbidden power:
 *  - no tool signs, broadcasts, issues a grant or changes policy (SIGN effect
 *    does not exist; `assertNoSigningTools` checks it at load time);
 *  - Risk proposes no payment and pays for nothing (`spend: []`);
 *  - Audit is read-only (only READ tools, no write scopes);
 *  - Payment's only economic tool is `payment.submitToKernel`: money moves
 *    when the Kernel returns a grant the restricted executor admits;
 *  - Deal reads agreements and drafts notes; accepting a contested delivery
 *    is a human / arbiter action that no manifest lists;
 *  - Research may buy data over x402 up to a small per-call cap, through a
 *    Kernel EconomicGrant and the execution worker's signer.
 */

export const TEAM_ROLES = [
  'SUPERVISOR',
  'INVOICE',
  'CFO',
  'PAYMENT',
  'RISK',
  'DEAL',
  'COMMERCE',
  'TRAVEL',
  'RESEARCH',
  'AUDIT',
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** READ: no effect. PROPOSE: typed draft for the Kernel. HOLD: risk hold (blocks, never pays). PAID_READ: x402 data purchase behind a Kernel grant. */
export type ToolEffect = 'READ' | 'PROPOSE' | 'HOLD' | 'PAID_READ';
export type Scope =
  | 'world'
  | 'ledger'
  | 'invoices'
  | 'payables'
  | 'vendors'
  | 'evidence'
  | 'chain'
  | 'payments'
  | 'treasury'
  | 'risk.cases'
  | 'risk.screening'
  | 'audit.trail'
  | 'deals'
  | 'offers'
  | 'web'
  | 'paid-data';

export type TeamToolSpec = Readonly<{
  effect: ToolEffect;
  scope: Scope;
  /** Provider the tool depends on (health / credentials), or null for internal tools. */
  provider: string | null;
  /** A human must act (wallet signature, review) before the effect is real. */
  needsHuman: boolean;
  /** The tool's outcome concerns money (a pending outcome makes it unsafe to retry). */
  financial: boolean;
  /** Reaches arbitrary network hosts: every call must name its host. */
  network?: boolean;
}>;

const finance = (t: FinanceTool, scope: Scope): TeamToolSpec => ({
  effect: FINANCE_TOOLS[t].effect,
  scope,
  provider:
    t === 'chain.receipt'
      ? 'ARC_RPC'
      : t === 'treasury.position'
        ? 'ARC_RPC'
        : null,
  needsHuman: t === 'payment.submitToKernel' || t === 'invoice.requestIssuance',
  financial: t === 'payment.submitToKernel' || t === 'reallocation.propose',
});

export const TEAM_TOOLS = {
  'world.snapshot': finance('world.snapshot', 'world'),
  'treasury.position': finance('treasury.position', 'treasury'),
  'ledger.entries': finance('ledger.entries', 'ledger'),
  'invoices.list': finance('invoices.list', 'invoices'),
  'receivables.aging': finance('receivables.aging', 'invoices'),
  'invoice.draft': finance('invoice.draft', 'invoices'),
  'invoice.requestIssuance': finance('invoice.requestIssuance', 'invoices'),
  'payables.list': finance('payables.list', 'payables'),
  'vendors.verifiedPayout': finance('vendors.verifiedPayout', 'vendors'),
  'payables.timing': finance('payables.timing', 'payables'),
  'payment.prepare': finance('payment.prepare', 'payments'),
  'payment.submitToKernel': finance('payment.submitToKernel', 'payments'),
  'reallocation.propose': finance('reallocation.propose', 'treasury'),
  'risk.assessPayable': finance('risk.assessPayable', 'payables'),
  'risk.scanDocument': finance('risk.scanDocument', 'evidence'),
  'evidence.lookup': finance('evidence.lookup', 'evidence'),
  'chain.receipt': finance('chain.receipt', 'chain'),
  'risk.screenCounterparty': {
    effect: 'READ',
    scope: 'risk.screening',
    provider: 'WALLET_SCREENING',
    needsHuman: false,
    financial: false,
  },
  'case.hold': {
    effect: 'HOLD',
    scope: 'risk.cases',
    provider: null,
    needsHuman: false,
    financial: false,
  },
  'audit.verifyChain': {
    effect: 'READ',
    scope: 'audit.trail',
    provider: null,
    needsHuman: false,
    financial: false,
  },
  'deal.read': {
    effect: 'READ',
    scope: 'deals',
    provider: null,
    needsHuman: false,
    financial: false,
  },
  'deal.draftNote': {
    effect: 'PROPOSE',
    scope: 'deals',
    provider: null,
    needsHuman: false,
    financial: false,
  },
  'commerce.search': {
    effect: 'READ',
    scope: 'offers',
    provider: 'COMMERCE_SEARCH',
    needsHuman: false,
    financial: false,
  },
  'commerce.proposePurchase': {
    effect: 'PROPOSE',
    scope: 'offers',
    provider: 'COMMERCE_SEARCH',
    needsHuman: true,
    financial: true,
  },
  'travel.search': {
    effect: 'READ',
    scope: 'offers',
    provider: 'DUFFEL',
    needsHuman: false,
    financial: false,
  },
  'travel.proposeBooking': {
    effect: 'PROPOSE',
    scope: 'offers',
    provider: 'DUFFEL',
    needsHuman: true,
    financial: true,
  },
  'research.fetch': {
    effect: 'READ',
    scope: 'web',
    provider: null,
    needsHuman: false,
    financial: false,
    network: true,
  },
  'research.x402Purchase': {
    effect: 'PAID_READ',
    scope: 'paid-data',
    provider: 'X402_RESEARCH',
    needsHuman: false,
    financial: true,
    network: true,
  },
  'wallets.circleTransfer': {
    effect: 'PROPOSE',
    scope: 'payments',
    provider: 'CIRCLE_WALLETS',
    needsHuman: true,
    financial: true,
  },
} as const satisfies Record<string, TeamToolSpec>;
export type TeamTool = keyof typeof TEAM_TOOLS;

/**
 * Actions an injected text typically asks for. None is a tool: the guard
 * refuses them by name, and the human-only ones have their own paths
 * (wallet signature, case review, arbiter decision) outside the team.
 */
export const NEVER_TOOLS = [
  'signer.sign',
  'wallet.signTransaction',
  'wallet.sendTransaction',
  'executor.pay',
  'kernel.issueGrant',
  'policy.raiseLimit',
  'mandate.update',
  'vendor.changeRecipient',
  'vendor.verifyAddress',
  'case.release',
  'deal.acceptDelivery',
  'agent.spawnPrivileged',
] as const;

/** Economic paths an agent may use; empty = it can never cause spending. */
export type SpendMode = 'KERNEL_GRANT_ONLY' | 'X402_CAPPED';
/** Classes of counterparty an agent may name; empty = none. */
export type CounterpartyClass = 'VERIFIED_VENDORS' | 'DATA_SELLERS';

export type CapabilityManifest = Readonly<{
  role: TeamRole;
  title: string;
  tools: readonly TeamTool[];
  /** Hosts network tools may reach (exact match). */
  allowedDomains: readonly string[];
  scopes: Readonly<{ read: readonly Scope[]; write: readonly Scope[] }>;
  /** Largest amount (base units, USDC 6 dp) a proposal or paid read may carry. */
  maxAmountBaseUnits: bigint;
  counterparties: readonly CounterpartyClass[];
  networks: readonly ChainName[];
  /** Wall-clock budget for one instance. */
  timeLimitMs: number;
  budgets: Readonly<{
    tokens: number;
    toolCalls: number;
    paidMicroUsd: number;
  }>;
  /** How many levels below this agent it may delegate. */
  maxSubagentDepth: number;
  concurrency: number;
  /** Per tool call. */
  timeoutMs: number;
  /** Tools this agent may hand to a child (a child gets child.tools ∩ delegable). */
  delegable: readonly TeamTool[];
  /** Dynamic subagent templates this agent may instantiate. */
  templates: readonly TemplateId[];
  spend: readonly SpendMode[];
  /** Revocation applies to every instance immediately, including in-flight children. */
  revocable: true;
  auditEvidence: readonly string[];
  invariants: Readonly<{
    canSign: false;
    readOnly: boolean;
    decidesContestedDelivery: false;
  }>;
}>;

export type TemplateId =
  | 'research.web-lookup'
  | 'research.paid-quote'
  | 'risk.counterparty-check'
  | 'audit.receipt-check'
  | 'commerce.compare'
  | 'travel.compare';

const ARC: readonly ChainName[] = ['arc-testnet'];
const minutes = (n: number) => n * 60_000;
const specialistBudget = {
  tokens: 12_000,
  toolCalls: 12,
  paidMicroUsd: 60_000,
};
const ALL_SCOPES: readonly Scope[] = [
  'world',
  'ledger',
  'invoices',
  'payables',
  'vendors',
  'evidence',
  'chain',
  'payments',
  'treasury',
  'risk.cases',
  'risk.screening',
  'audit.trail',
  'deals',
  'offers',
  'web',
  'paid-data',
];
const ALL_TOOLS = Object.keys(TEAM_TOOLS) as TeamTool[];
/** 0.01 USDC: Research's per-call x402 cap. */
export const RESEARCH_X402_CAP = 10_000n;
/** Data sellers Research may pay (exact hosts). */
export const RESEARCH_DOMAINS = ['data.example.com'] as const;

const finTools = (role: keyof typeof SPECIALIST_MANIFESTS): TeamTool[] => [
  ...SPECIALIST_MANIFESTS[role].tools,
];

export const TEAM_MANIFESTS: Readonly<Record<TeamRole, CapabilityManifest>> = {
  SUPERVISOR: {
    role: 'SUPERVISOR',
    title: 'Synq Supervisor',
    tools: [...SUPERVISOR_MANIFEST.tools],
    // Its own tools only read; hosts and write scopes are bounds it delegates.
    allowedDomains: [...RESEARCH_DOMAINS],
    scopes: { read: ALL_SCOPES, write: ALL_SCOPES },
    maxAmountBaseUnits: 1_000_000_000n,
    counterparties: ['VERIFIED_VENDORS', 'DATA_SELLERS'],
    networks: ['arc-testnet', 'eth-sepolia', 'base-sepolia', 'arb-sepolia'],
    timeLimitMs: minutes(12),
    budgets: { tokens: 40_000, toolCalls: 50, paidMicroUsd: 250_000 },
    maxSubagentDepth: 3,
    concurrency: 5,
    timeoutMs: 60_000,
    // Everything except human-gated provider transfers it cannot use itself.
    delegable: ALL_TOOLS.filter((t) => t !== 'wallets.circleTransfer'),
    templates: [
      'research.web-lookup',
      'research.paid-quote',
      'risk.counterparty-check',
      'audit.receipt-check',
      'commerce.compare',
      'travel.compare',
    ],
    spend: ['KERNEL_GRANT_ONLY', 'X402_CAPPED'],
    revocable: true,
    auditEvidence: [
      'routing decision',
      'compiled recommendations',
      'Kernel outcome',
    ],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  INVOICE: {
    role: 'INVOICE',
    title: 'Invoice Agent',
    tools: finTools('INVOICE'),
    allowedDomains: [],
    scopes: { read: ['world', 'invoices'], write: ['invoices'] },
    maxAmountBaseUnits: 1_000_000_000n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 0,
    concurrency: 0,
    timeoutMs: 30_000,
    delegable: [],
    templates: [],
    spend: [],
    revocable: true,
    auditEvidence: ['invoice draft', 'issuer typed-data request'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  CFO: {
    role: 'CFO',
    title: 'CFO Agent',
    tools: finTools('CFO'),
    allowedDomains: [],
    scopes: {
      read: ['world', 'ledger', 'payables', 'invoices', 'treasury'],
      write: ['treasury'],
    },
    maxAmountBaseUnits: 250_000_000n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 1,
    concurrency: 1,
    timeoutMs: 30_000,
    delegable: ['world.snapshot', 'research.fetch'],
    templates: ['research.web-lookup'],
    spend: [],
    revocable: true,
    auditEvidence: ['due date', 'cash buffer', 'source freshness'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  PAYMENT: {
    role: 'PAYMENT',
    title: 'Payment Agent',
    tools: finTools('PAYMENT'),
    allowedDomains: [],
    scopes: {
      read: ['world', 'payables', 'vendors', 'ledger', 'treasury'],
      write: ['payments'],
    },
    maxAmountBaseUnits: 1_000_000_000n,
    counterparties: ['VERIFIED_VENDORS'],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 0,
    concurrency: 0,
    timeoutMs: 30_000,
    delegable: [],
    templates: [],
    spend: ['KERNEL_GRANT_ONLY'],
    revocable: true,
    auditEvidence: ['payment intent', 'Kernel decision', 'grant id'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  RISK: {
    role: 'RISK',
    title: 'Risk Agent',
    tools: [...finTools('RISK'), 'risk.screenCounterparty', 'case.hold'],
    allowedDomains: [],
    scopes: {
      read: [
        'world',
        'payables',
        'vendors',
        'invoices',
        'evidence',
        'risk.screening',
      ],
      write: ['risk.cases'],
    },
    maxAmountBaseUnits: 0n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 1,
    concurrency: 2,
    timeoutMs: 30_000,
    delegable: [
      'vendors.verifiedPayout',
      'risk.screenCounterparty',
      'world.snapshot',
    ],
    templates: ['risk.counterparty-check'],
    spend: [],
    revocable: true,
    auditEvidence: ['deterministic risk flags', 'screening verdict', 'case id'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  DEAL: {
    role: 'DEAL',
    title: 'Deal Agent',
    tools: ['world.snapshot', 'deal.read', 'deal.draftNote', 'evidence.lookup'],
    allowedDomains: [],
    scopes: { read: ['world', 'deals', 'evidence'], write: ['deals'] },
    maxAmountBaseUnits: 0n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 0,
    concurrency: 0,
    timeoutMs: 30_000,
    delegable: [],
    templates: [],
    spend: [],
    revocable: true,
    auditEvidence: ['agreement terms read', 'milestone state'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  COMMERCE: {
    role: 'COMMERCE',
    title: 'Commerce Agent',
    tools: ['world.snapshot', 'commerce.search', 'commerce.proposePurchase'],
    allowedDomains: [],
    scopes: { read: ['world', 'offers'], write: ['offers'] },
    maxAmountBaseUnits: 100_000_000n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 0,
    concurrency: 0,
    timeoutMs: 30_000,
    delegable: [],
    templates: [],
    spend: [],
    revocable: true,
    auditEvidence: ['offers compared', 'purchase draft for the Kernel'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  TRAVEL: {
    role: 'TRAVEL',
    title: 'Travel Agent',
    tools: ['world.snapshot', 'travel.search', 'travel.proposeBooking'],
    allowedDomains: [],
    scopes: { read: ['world', 'offers'], write: ['offers'] },
    maxAmountBaseUnits: 500_000_000n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 0,
    concurrency: 0,
    timeoutMs: 30_000,
    delegable: [],
    templates: [],
    spend: [],
    revocable: true,
    auditEvidence: ['offers compared', 'booking draft for the Kernel'],
    invariants: {
      canSign: false,
      readOnly: false,
      decidesContestedDelivery: false,
    },
  },
  RESEARCH: {
    role: 'RESEARCH',
    title: 'Research Agent',
    tools: ['world.snapshot', 'research.fetch', 'research.x402Purchase'],
    allowedDomains: [...RESEARCH_DOMAINS],
    scopes: { read: ['world', 'web', 'paid-data'], write: [] },
    maxAmountBaseUnits: RESEARCH_X402_CAP,
    counterparties: ['DATA_SELLERS'],
    networks: ARC,
    timeLimitMs: minutes(2),
    budgets: { tokens: 8_000, toolCalls: 8, paidMicroUsd: 30_000 },
    maxSubagentDepth: 1,
    concurrency: 2,
    timeoutMs: 15_000,
    delegable: ['research.fetch'],
    templates: ['research.web-lookup'],
    spend: ['X402_CAPPED'],
    revocable: true,
    auditEvidence: ['claims with evidence ids', 'x402 receipt'],
    invariants: {
      canSign: false,
      readOnly: true,
      decidesContestedDelivery: false,
    },
  },
  AUDIT: {
    role: 'AUDIT',
    title: 'Audit Agent',
    tools: [...finTools('AUDIT'), 'audit.verifyChain'],
    allowedDomains: [],
    scopes: {
      read: [
        'world',
        'ledger',
        'invoices',
        'payables',
        'evidence',
        'chain',
        'audit.trail',
      ],
      write: [],
    },
    maxAmountBaseUnits: 0n,
    counterparties: [],
    networks: ARC,
    timeLimitMs: minutes(3),
    budgets: specialistBudget,
    maxSubagentDepth: 1,
    concurrency: 1,
    timeoutMs: 30_000,
    delegable: ['chain.receipt', 'evidence.lookup'],
    templates: ['audit.receipt-check'],
    spend: [],
    revocable: true,
    auditEvidence: [
      'transaction explanation',
      'explorer link',
      'chain verification',
    ],
    invariants: {
      canSign: false,
      readOnly: true,
      decidesContestedDelivery: false,
    },
  },
};

export type SubagentTemplate = Readonly<{
  id: TemplateId;
  role: TeamRole;
  /** Narrower than the role manifest; the guard intersects again. */
  tools: readonly TeamTool[];
  maxAmountBaseUnits: bigint;
  timeLimitMs: number;
  budgets: CapabilityManifest['budgets'];
}>;

/** The only shapes a dynamic subagent may take. */
export const SUBAGENT_TEMPLATES: Readonly<
  Record<TemplateId, SubagentTemplate>
> = {
  'research.web-lookup': {
    id: 'research.web-lookup',
    role: 'RESEARCH',
    tools: ['research.fetch'],
    maxAmountBaseUnits: 0n,
    timeLimitMs: 60_000,
    budgets: { tokens: 4_000, toolCalls: 4, paidMicroUsd: 0 },
  },
  'research.paid-quote': {
    id: 'research.paid-quote',
    role: 'RESEARCH',
    tools: ['research.fetch', 'research.x402Purchase'],
    maxAmountBaseUnits: RESEARCH_X402_CAP,
    timeLimitMs: 60_000,
    budgets: { tokens: 4_000, toolCalls: 4, paidMicroUsd: 20_000 },
  },
  'risk.counterparty-check': {
    id: 'risk.counterparty-check',
    role: 'RISK',
    tools: ['vendors.verifiedPayout', 'risk.screenCounterparty'],
    maxAmountBaseUnits: 0n,
    timeLimitMs: 60_000,
    budgets: { tokens: 2_000, toolCalls: 4, paidMicroUsd: 0 },
  },
  'audit.receipt-check': {
    id: 'audit.receipt-check',
    role: 'AUDIT',
    tools: ['chain.receipt', 'evidence.lookup'],
    maxAmountBaseUnits: 0n,
    timeLimitMs: 60_000,
    budgets: { tokens: 0, toolCalls: 4, paidMicroUsd: 0 },
  },
  'commerce.compare': {
    id: 'commerce.compare',
    role: 'COMMERCE',
    tools: ['commerce.search'],
    maxAmountBaseUnits: 0n,
    timeLimitMs: 60_000,
    budgets: { tokens: 4_000, toolCalls: 4, paidMicroUsd: 0 },
  },
  'travel.compare': {
    id: 'travel.compare',
    role: 'TRAVEL',
    tools: ['travel.search'],
    maxAmountBaseUnits: 0n,
    timeLimitMs: 60_000,
    budgets: { tokens: 4_000, toolCalls: 4, paidMicroUsd: 0 },
  },
};

/** Static checks over every manifest; returns violations (empty when sound). */
export function teamManifestViolations(): string[] {
  const out: string[] = [];
  const effects = new Set<string>(['READ', 'PROPOSE', 'HOLD', 'PAID_READ']);
  for (const [tool, spec] of Object.entries(TEAM_TOOLS))
    if (!effects.has(spec.effect))
      out.push(`${tool} has effect ${spec.effect}`);
  for (const name of NEVER_TOOLS)
    if (name in TEAM_TOOLS) out.push(`${name} must never be a tool`);
  const sup = TEAM_MANIFESTS.SUPERVISOR;
  for (const m of Object.values(TEAM_MANIFESTS)) {
    const tools = m.tools.map((t) => [t, TEAM_TOOLS[t]] as const);
    if (m.invariants.readOnly)
      if (
        tools.some(
          ([, s]) => s.effect !== 'READ' && s.effect !== 'PAID_READ',
        ) ||
        m.scopes.write.length
      )
        out.push(`${m.role} is read-only but can write`);
    if (
      !m.spend.includes('X402_CAPPED') &&
      tools.some(([, s]) => s.effect === 'PAID_READ')
    )
      out.push(`${m.role} cannot spend but lists a paid tool`);
    if (
      !m.spend.includes('KERNEL_GRANT_ONLY') &&
      m.tools.includes('payment.submitToKernel')
    )
      out.push(`${m.role} submits payments without KERNEL_GRANT_ONLY`);
    for (const [t, s] of tools)
      if (!m.scopes.read.includes(s.scope) && !m.scopes.write.includes(s.scope))
        out.push(`${m.role} lists ${t} outside its scopes`);
    for (const [t, s] of tools)
      if (
        s.effect !== 'READ' &&
        s.effect !== 'PAID_READ' &&
        !m.scopes.write.includes(s.scope)
      )
        out.push(`${m.role} lists ${t} without write scope ${s.scope}`);
    if (m.role !== 'SUPERVISOR') {
      for (const t of m.tools)
        if (!sup.delegable.includes(t) && !sup.tools.includes(t))
          out.push(
            `${m.role} lists ${t}, which the Supervisor cannot delegate`,
          );
      if (m.maxAmountBaseUnits > sup.maxAmountBaseUnits)
        out.push(`${m.role} amount cap exceeds the Supervisor's`);
    }
    for (const t of m.templates) {
      const tpl = SUBAGENT_TEMPLATES[t];
      if (
        !tpl.tools.every(
          (x) => m.delegable.includes(x) || m.role === 'SUPERVISOR',
        )
      )
        out.push(`${m.role} may spawn ${t} but cannot delegate all its tools`);
    }
  }
  if (
    TEAM_MANIFESTS.RISK.spend.length ||
    TEAM_MANIFESTS.RISK.maxAmountBaseUnits !== 0n ||
    TEAM_MANIFESTS.RISK.tools.some((t) => TEAM_TOOLS[t].financial)
  )
    out.push('Risk must not spend');
  if (TEAM_MANIFESTS.AUDIT.tools.some((t) => TEAM_TOOLS[t].effect !== 'READ'))
    out.push('Audit must be read-only');
  if (TEAM_MANIFESTS.RESEARCH.maxAmountBaseUnits > RESEARCH_X402_CAP)
    out.push('Research x402 spend exceeds its cap');
  return out;
}

/** Load-time assertion: the team vocabulary has no signing or executing power. */
export function assertNoSigningTools(): void {
  const v = teamManifestViolations();
  if (v.length)
    throw new Error(`agent-team manifests unsound: ${v.join('; ')}`);
}
assertNoSigningTools();
