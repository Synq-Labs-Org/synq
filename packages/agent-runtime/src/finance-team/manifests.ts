import type { ChainName } from '@synq/chain-registry/arc';
import type { Capability } from '@synq/schemas';
import { ROOT_CAPABILITIES } from '../roles.js';
import type { BudgetLimits } from '../subagents.js';
import { UNTRUSTED_POLICY } from '../untrusted.js';

/**
 * The minimal Arc finance team: a Supervisor and five specialists, each a
 * manifest (capabilities, tool allowlist, proposal types, budget, model tier,
 * environment) over a deterministic tool layer.
 *
 * Finance capabilities are fine-grained tool rights. None of them can sign,
 * execute a transfer, withdraw, issue a grant or change policy: those powers
 * are not in the vocabulary at all. Money moves only when the deterministic
 * Kernel turns a typed PAYMENT proposal into an ExecutionGrant that the
 * restricted executor (workers/execution) admits.
 */

export const FINANCE_CAPABILITIES = [
  'WORLD_READ',
  'LEDGER_READ',
  'INVOICE_READ',
  'PAYABLE_READ',
  'EVIDENCE_READ',
  'CHAIN_READ',
  'RECEIVABLE_TRACK',
  'INVOICE_DRAFT',
  'INVOICE_ISSUANCE_REQUEST',
  'PAYMENT_PROPOSE',
  'REALLOCATION_PROPOSE',
  'RISK_FLAG',
] as const;
export type FinanceCapability = (typeof FINANCE_CAPABILITIES)[number];

/** Powers no agent manifest may name; listed so tests can prove their absence. */
export const NEVER_DELEGATED = [
  'SIGN',
  'TRANSFER_EXECUTE',
  'WITHDRAW',
  'ISSUE_GRANT',
  'AUTHORIZE',
  'CHANGE_POLICY',
  'CHANGE_OWNER',
] as const;

export const FINANCE_TOOLS = {
  'world.snapshot': { capability: 'WORLD_READ', effect: 'READ' },
  'treasury.position': { capability: 'LEDGER_READ', effect: 'READ' },
  'ledger.entries': { capability: 'LEDGER_READ', effect: 'READ' },
  'invoices.list': { capability: 'INVOICE_READ', effect: 'READ' },
  'receivables.aging': { capability: 'RECEIVABLE_TRACK', effect: 'READ' },
  'invoice.draft': { capability: 'INVOICE_DRAFT', effect: 'PROPOSE' },
  'invoice.requestIssuance': {
    capability: 'INVOICE_ISSUANCE_REQUEST',
    effect: 'PROPOSE',
  },
  'payables.list': { capability: 'PAYABLE_READ', effect: 'READ' },
  'vendors.verifiedPayout': { capability: 'PAYABLE_READ', effect: 'READ' },
  'payables.timing': { capability: 'PAYABLE_READ', effect: 'READ' },
  'payment.prepare': { capability: 'PAYMENT_PROPOSE', effect: 'PROPOSE' },
  'payment.submitToKernel': {
    capability: 'PAYMENT_PROPOSE',
    effect: 'PROPOSE',
  },
  'reallocation.propose': {
    capability: 'REALLOCATION_PROPOSE',
    effect: 'PROPOSE',
  },
  'risk.assessPayable': { capability: 'RISK_FLAG', effect: 'READ' },
  'risk.scanDocument': { capability: 'RISK_FLAG', effect: 'READ' },
  'evidence.lookup': { capability: 'EVIDENCE_READ', effect: 'READ' },
  'chain.receipt': { capability: 'CHAIN_READ', effect: 'READ' },
} as const satisfies Record<
  string,
  { capability: FinanceCapability; effect: 'READ' | 'PROPOSE' }
>;
export type FinanceTool = keyof typeof FINANCE_TOOLS;

export const PROPOSAL_KINDS = [
  'INVOICE_DRAFT',
  'ISSUANCE_REQUEST',
  'PAYMENT',
  'REALLOCATION',
  'TIMING_RECOMMENDATION',
  'LIQUIDITY_REPORT',
  'RISK_RECOMMENDATION',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type FinanceRole =
  | 'SUPERVISOR'
  | 'INVOICE'
  | 'CFO'
  | 'PAYMENT'
  | 'RISK'
  | 'AUDIT';
export type SpecialistRole = Exclude<FinanceRole, 'SUPERVISOR'>;

/**
 * Model routing tier: deterministic handlers for reads and explanations,
 * a low-cost structured model + schema for extraction/drafting, never a
 * model for authorization.
 */
export type ModelTier = 'DETERMINISTIC' | 'LOW_COST_STRUCTURED';

export type AgentManifest = Readonly<{
  role: FinanceRole;
  title: string;
  capabilities: readonly FinanceCapability[];
  /** Coarse runtime capabilities enforced by the SubagentManager. */
  runtimeCapabilities: readonly Capability[];
  tools: readonly FinanceTool[];
  proposals: readonly ProposalKind[];
  readOnly: boolean;
  modelTier: ModelTier;
  budget: Readonly<
    Pick<
      BudgetLimits,
      'maxToolCalls' | 'maxLlmTokens' | 'maxPaidMicroUsd' | 'maxWallClockMs'
    >
  >;
  environment: Readonly<{
    chains: readonly ChainName[];
    signing: 'NONE';
    secrets: 'NONE';
    network: 'MODEL_PORT_ONLY' | 'NONE';
  }>;
  evidenceOutputs: readonly string[];
  instructions: string;
}>;

const AUTHORITY =
  'You cannot sign, authorize, execute transfers, withdraw, issue grants or change policy. You return typed JSON proposals only; the deterministic Kernel decides and model reasoning never overrides financial limits.';

/** Run-wide limits from the Arc v3 runtime contract. */
export const FINANCE_TEAM_BUDGET: Readonly<BudgetLimits> = Object.freeze({
  maxSpawnDepth: 3,
  maxConcurrentChildren: 5,
  maxToolCalls: 50,
  maxWallClockMs: 12 * 60_000,
  maxLlmTokens: 40_000,
  maxPaidMicroUsd: 250_000,
  maxTotalSpawns: 12,
});

const specialistBudget = {
  maxToolCalls: 12,
  maxLlmTokens: 12_000,
  maxPaidMicroUsd: 60_000,
  maxWallClockMs: 3 * 60_000,
} as const;
const ARC_ONLY: AgentManifest['environment'] = {
  chains: ['arc-testnet'],
  signing: 'NONE',
  secrets: 'NONE',
  network: 'NONE',
};

export const SUPERVISOR_MANIFEST: AgentManifest = {
  role: 'SUPERVISOR',
  title: 'Synq Supervisor',
  capabilities: FINANCE_CAPABILITIES,
  runtimeCapabilities: ROOT_CAPABILITIES,
  tools: ['world.snapshot', 'treasury.position', 'evidence.lookup'],
  proposals: [],
  readOnly: true,
  modelTier: 'LOW_COST_STRUCTURED',
  budget: {
    maxToolCalls: FINANCE_TEAM_BUDGET.maxToolCalls,
    maxLlmTokens: FINANCE_TEAM_BUDGET.maxLlmTokens,
    maxPaidMicroUsd: FINANCE_TEAM_BUDGET.maxPaidMicroUsd,
    maxWallClockMs: FINANCE_TEAM_BUDGET.maxWallClockMs,
  },
  environment: { ...ARC_ONLY, network: 'MODEL_PORT_ONLY' },
  evidenceOutputs: ['routing decision', 'explanation with citations'],
  instructions: `You are the Synq Supervisor. Classify the member's request into one of the typed finance intents and coordinate specialists. ${AUTHORITY} ${UNTRUSTED_POLICY}`,
};

export const SPECIALIST_MANIFESTS: Readonly<
  Record<SpecialistRole, AgentManifest>
> = {
  INVOICE: {
    role: 'INVOICE',
    title: 'Invoice Agent',
    capabilities: [
      'WORLD_READ',
      'INVOICE_READ',
      'RECEIVABLE_TRACK',
      'INVOICE_DRAFT',
      'INVOICE_ISSUANCE_REQUEST',
    ],
    runtimeCapabilities: ['READ_MARKET', 'PROPOSE_ACTION'],
    tools: [
      'world.snapshot',
      'invoices.list',
      'receivables.aging',
      'invoice.draft',
      'invoice.requestIssuance',
    ],
    proposals: ['INVOICE_DRAFT', 'ISSUANCE_REQUEST'],
    readOnly: false,
    modelTier: 'LOW_COST_STRUCTURED',
    budget: specialistBudget,
    environment: { ...ARC_ONLY, network: 'MODEL_PORT_ONLY' },
    evidenceOutputs: ['invoice draft', 'issuer typed-data request'],
    instructions: `You are the Synq Invoice Agent. Extract invoice terms (payer, amount, asset, due date, line items) from the request into the response schema. Issuance needs the issuer's own wallet signature. ${AUTHORITY} ${UNTRUSTED_POLICY}`,
  },
  CFO: {
    role: 'CFO',
    title: 'CFO Agent',
    capabilities: [
      'WORLD_READ',
      'LEDGER_READ',
      'PAYABLE_READ',
      'INVOICE_READ',
      'REALLOCATION_PROPOSE',
    ],
    runtimeCapabilities: ['READ_MARKET', 'PROPOSE_ACTION'],
    tools: [
      'world.snapshot',
      'treasury.position',
      'payables.list',
      'payables.timing',
      'invoices.list',
      'reallocation.propose',
    ],
    proposals: ['TIMING_RECOMMENDATION', 'LIQUIDITY_REPORT', 'REALLOCATION'],
    readOnly: false,
    modelTier: 'DETERMINISTIC',
    budget: specialistBudget,
    environment: ARC_ONLY,
    evidenceOutputs: ['due date', 'cash buffer', 'source freshness'],
    instructions: `You are the Synq CFO Agent. Explain liquidity and payment timing from cited WorldSnapshot fields only. ${AUTHORITY}`,
  },
  PAYMENT: {
    role: 'PAYMENT',
    title: 'Payment Agent',
    capabilities: [
      'WORLD_READ',
      'PAYABLE_READ',
      'LEDGER_READ',
      'PAYMENT_PROPOSE',
    ],
    runtimeCapabilities: ['READ_MARKET', 'PROPOSE_ACTION'],
    tools: [
      'world.snapshot',
      'payables.list',
      'vendors.verifiedPayout',
      'treasury.position',
      'payment.prepare',
      'payment.submitToKernel',
    ],
    proposals: ['PAYMENT'],
    readOnly: false,
    modelTier: 'LOW_COST_STRUCTURED',
    budget: specialistBudget,
    environment: { ...ARC_ONLY, network: 'MODEL_PORT_ONLY' },
    evidenceOutputs: ['payment intent', 'kernel decision', 'grant id'],
    instructions: `You are the Synq Payment Agent. Draft a PAYMENT proposal for the referenced payable in the response schema. Use only addresses and amounts present in the PAYABLE block. ${AUTHORITY} ${UNTRUSTED_POLICY}`,
  },
  RISK: {
    role: 'RISK',
    title: 'Risk Agent',
    capabilities: [
      'WORLD_READ',
      'PAYABLE_READ',
      'INVOICE_READ',
      'EVIDENCE_READ',
      'RISK_FLAG',
    ],
    runtimeCapabilities: ['READ_MARKET'],
    tools: [
      'world.snapshot',
      'payables.list',
      'vendors.verifiedPayout',
      'risk.assessPayable',
      'risk.scanDocument',
      'evidence.lookup',
    ],
    proposals: ['RISK_RECOMMENDATION'],
    readOnly: true,
    modelTier: 'DETERMINISTIC',
    budget: specialistBudget,
    environment: ARC_ONLY,
    evidenceOutputs: ['deterministic risk flags', 'veto recommendation'],
    instructions: `You are the Synq Risk Agent. Report deterministic risk flags; you may recommend a veto but never transfer funds. ${AUTHORITY} ${UNTRUSTED_POLICY}`,
  },
  AUDIT: {
    role: 'AUDIT',
    title: 'Audit Agent',
    capabilities: [
      'WORLD_READ',
      'LEDGER_READ',
      'INVOICE_READ',
      'PAYABLE_READ',
      'EVIDENCE_READ',
      'CHAIN_READ',
    ],
    runtimeCapabilities: ['READ_MARKET'],
    tools: [
      'world.snapshot',
      'ledger.entries',
      'invoices.list',
      'payables.list',
      'evidence.lookup',
      'chain.receipt',
    ],
    proposals: [],
    readOnly: true,
    modelTier: 'DETERMINISTIC',
    budget: specialistBudget,
    environment: ARC_ONLY,
    evidenceOutputs: [
      'transaction explanation',
      'explorer link',
      'ledger lines',
    ],
    instructions: `You are the Synq Audit Agent. Strictly read-only: reconcile receipts and explain actual transactions with evidence. ${AUTHORITY}`,
  },
};

export function manifestOf(role: FinanceRole): AgentManifest {
  return role === 'SUPERVISOR'
    ? SUPERVISOR_MANIFEST
    : SPECIALIST_MANIFESTS[role];
}

/** Child = parent ∩ manifest. A child can never mint a capability its parent lacks. */
export function intersectCapabilities<T extends string>(
  parent: readonly T[],
  child: readonly T[],
): T[] {
  return child.filter((c) => parent.includes(c));
}

/** Static check over every manifest; returns violations (empty when sound). */
export function manifestViolations(): string[] {
  const out: string[] = [];
  const sup = new Set<string>(SUPERVISOR_MANIFEST.capabilities);
  for (const m of Object.values(SPECIALIST_MANIFESTS)) {
    const caps = new Set<string>(m.capabilities);
    if (![...caps].every((c) => sup.has(c)) || caps.size >= sup.size)
      out.push(`${m.role} is not strictly narrower than the Supervisor`);
    for (const t of m.tools)
      if (!caps.has(FINANCE_TOOLS[t].capability))
        out.push(`${m.role} lists ${t} without ${FINANCE_TOOLS[t].capability}`);
    if (m.readOnly && m.tools.some((t) => FINANCE_TOOLS[t].effect !== 'READ'))
      out.push(`${m.role} is read-only but lists a proposing tool`);
    if (
      [...caps].some((c) => (NEVER_DELEGATED as readonly string[]).includes(c))
    )
      out.push(`${m.role} names a never-delegated power`);
    if (
      !m.runtimeCapabilities.every((c) =>
        SUPERVISOR_MANIFEST.runtimeCapabilities.includes(c),
      )
    )
      out.push(`${m.role} runtime capabilities exceed the Supervisor`);
  }
  return out;
}
