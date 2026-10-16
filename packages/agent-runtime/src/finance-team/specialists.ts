import type { Address, Hex } from 'viem';
import { token, type ChainName } from '@synq/chain-registry/arc';
import { moneyFromDecimal } from '@synq/domain';
import {
  amountDue,
  draftInvoice,
  issueTypedData,
  type Invoice,
} from '@synq/invoices';
import {
  intentApprovalTypedData,
  type ApprovalTerms,
  type Decision,
  type ExecutionGrant,
  type OwnerApproval,
  type PaymentIntent,
  type PaymentPurpose,
} from '@synq/kernel/arc';
import {
  assessPayable,
  documentHash,
  paymentTiming,
  verifiedAddress,
  type RiskFlag,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import { canonicalArtifactHash } from '@synq/schemas';
import {
  cashBeforeBuffer,
  cite,
  evaluateArcSnapshot,
  usdcDisplay,
  type ArcWorldSnapshot,
  type FieldCitation,
} from '@synq/world-model';
import {
  injectionSignals,
  renderUntrusted,
  wrapUntrusted,
} from '../untrusted.js';
import type { FinanceDesk, PayoutEvidence } from './desk.js';
import type { FinanceIntent } from './intent.js';
import {
  InvoiceDraftProposalSchema,
  InvoiceTermsSchema,
  IssuanceRequestSchema,
  LiquidityReportSchema,
  PaymentDraftSchema,
  PaymentProposalSchema,
  ReallocationProposalSchema,
  RiskRecommendationSchema,
  TimingRecommendationSchema,
  type InvoiceDraftProposal,
  type IssuanceRequest,
  type LiquidityReport,
  type PaymentDraft,
  type PaymentProposal,
  type ReallocationProposal,
  type RiskRecommendation,
  type TimingRecommendation,
} from './proposals.js';
import type { FinanceAgent, FinanceTeam } from './team.js';

const lower = (a: string) => a.toLowerCase();
const usdc = (b: string | bigint) => `${usdcDisplay(b)} USDC`;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
const age = (c: FieldCitation) =>
  `${c.path} from ${c.source}${c.ageSeconds === null ? ', time unknown' : `, observed ${c.ageSeconds}s ago`} (${c.freshness})`;

/** Citations aged at use time (`now`), never at snapshot build time. */
function citations(
  s: ArcWorldSnapshot,
  paths: string[],
  now: number,
): FieldCitation[] {
  return paths.map((p) => cite(s, p, now));
}

/** Untrusted text interpolated into typed outputs is bounded, never a crash. */
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/**
 * Snapshot read through the agent's own tool fence (charged, allowlisted),
 * with freshness re-evaluated at the desk's current time.
 */
function readWorld(
  team: FinanceTeam,
  agent: FinanceAgent,
  snapshot: ArcWorldSnapshot,
  now: number,
): ArcWorldSnapshot {
  return team.tool(agent, 'world.snapshot', () =>
    evaluateArcSnapshot(snapshot, now),
  );
}

function vendorOf(desk: FinanceDesk, vi: VendorInvoice): Vendor | null {
  return desk.vendors.find((v) => v.vendorId === vi.vendorId) ?? null;
}

function treasuryWallet(s: ArcWorldSnapshot): Address | null {
  const w = s.identity.wallets.value.find(
    (x) => x.role === 'TREASURY' && x.chain === s.primaryChain,
  );
  return (w?.address as Address | undefined) ?? null;
}

// ---------------------------------------------------------------- Invoice Agent

export type InvoiceOutcome = Readonly<{
  status: 'DRAFTED' | 'NEEDS_DETAILS' | 'REFUSED';
  reason: string;
  draft: Invoice | null;
  proposal: InvoiceDraftProposal | null;
  issuance: IssuanceRequest | null;
  /** EIP-712 payload the issuer's own wallet must sign; agents never sign it. */
  typedData: ReturnType<typeof issueTypedData> | null;
  termsSource: 'RULES' | 'MODEL' | null;
}>;

export async function invoiceAgentDraft(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  intent: FinanceIntent,
  message: string,
): Promise<InvoiceOutcome> {
  const s = readWorld(team, agent, snapshot, desk.now);
  const none = {
    draft: null,
    proposal: null,
    issuance: null,
    typedData: null,
  } as const;
  const user = s.identity.user.value;
  // Both the issuing wallet and the payout wallet must belong to the current
  // user and carry an independent verification.
  const mine = (w: (typeof s.identity.wallets.value)[number]) =>
    w.chain === s.primaryChain &&
    w.ownerPrincipalId === user?.principalId &&
    w.verifiedBy !== null;
  const owner = s.identity.wallets.value.find(
    (w) => w.kind === 'OWNER_EOA' && mine(w),
  );
  const payoutCandidate =
    s.identity.wallets.value.find(
      (w) => w.role === 'PAYOUT' && w.chain === s.primaryChain,
    ) ?? owner;
  const payout =
    payoutCandidate && mine(payoutCandidate) ? payoutCandidate : null;
  if (
    !user ||
    !owner ||
    !payout ||
    s.identity.wallets.meta.freshness !== 'FRESH' ||
    s.identity.user.meta.freshness !== 'FRESH'
  )
    return {
      status: 'REFUSED',
      reason:
        'issuer identity or a verified, user-owned issuing/payout wallet is not fresh in the WorldSnapshot',
      termsSource: null,
      ...none,
    };
  let terms: {
    payer: string;
    amount: string;
    asset: 'USDC' | 'EURC';
    description: string;
    dueInDays: number;
  } | null = null;
  let termsSource: InvoiceOutcome['termsSource'] = null;
  const netDays = desk.policy?.invoiceNetDays ?? 14;
  if (intent.counterparty && intent.amount) {
    terms = {
      payer: intent.counterparty,
      amount: intent.amount,
      asset: intent.asset ?? 'USDC',
      description: `Services for ${intent.counterparty.slice(0, 120)}`,
      dueInDays: netDays,
    };
    termsSource = 'RULES';
  } else if (desk.reasoner) {
    const request = wrapUntrusted({
      evidenceId: 'member_request',
      kind: 'MEMBER_MESSAGE',
      origin: 'chat',
      retrievedAt: desk.now,
      content: message,
    });
    const { parsed } = await team.model({
      agent,
      reasoner: desk.reasoner,
      fixtureKey: 'finance:invoice:terms',
      schemaName: 'invoice_terms',
      schema: InvoiceTermsSchema,
      userMessage: `Extract invoice terms from the member request. Default asset USDC, default due in ${netDays} days.\n${renderUntrusted([request])}`,
    });
    if (parsed?.ok) {
      terms = parsed.value;
      termsSource = 'MODEL';
    }
  }
  if (terms && (terms.payer.length > 120 || terms.description.length > 200))
    return {
      status: 'NEEDS_DETAILS',
      reason:
        'the payer name or description is too long; give a shorter legal name',
      termsSource,
      ...none,
    };
  if (!terms)
    return {
      status: 'NEEDS_DETAILS',
      reason: 'who should be invoiced, and for how much?',
      termsSource: null,
      ...none,
    };
  const asset = token(s.primaryChain, terms.asset);
  const t = terms;
  const draft = team.tool(agent, 'invoice.draft', () =>
    draftInvoice({
      workspaceId: desk.workspaceId,
      number: `INV-${String(desk.invoices.length + 1).padStart(4, '0')}`,
      issuer: {
        principalId: user.principalId,
        name: s.identity.workspace.value?.name ?? user.displayName,
        wallet: owner.address as Address,
        payoutAddress: payout.address as Address,
      },
      payer: { name: t.payer, contact: null },
      asset,
      lineItems: [
        {
          description: t.description,
          quantity: 1,
          unitPrice: moneyFromDecimal(asset, t.amount).baseUnits,
        },
      ],
      dueDate: addDays(desk.today, t.dueInDays),
      draftedBy: agent.handle.agentId,
      now: desk.now,
    }),
  );
  const { typedData, issuance } = team.tool(
    agent,
    'invoice.requestIssuance',
    () => ({
      typedData: issueTypedData(draft),
      issuance: IssuanceRequestSchema.parse({
        kind: 'ISSUANCE_REQUEST',
        invoiceId: draft.invoiceId,
        signer: draft.issuer.wallet,
        primaryType: 'IssueInvoice',
        chainId: draft.asset.chainId,
        note: 'Only the issuer wallet signature over these exact terms issues the invoice; the agent cannot sign.',
      }),
    }),
  );
  return {
    status: 'DRAFTED',
    reason: `drafted ${draft.number} for ${t.payer}: ${usdcDisplay(draft.total)} ${t.asset}, due ${draft.dueDate}`,
    draft,
    proposal: InvoiceDraftProposalSchema.parse({
      kind: 'INVOICE_DRAFT',
      invoiceId: draft.invoiceId,
      number: draft.number,
      payer: t.payer,
      asset: t.asset,
      totalBaseUnits: draft.total.toString(),
      dueDate: draft.dueDate,
      draftedBy: agent.handle.agentId,
      status: 'DRAFT',
    }),
    issuance,
    typedData,
    termsSource,
  };
}

export type ReceivablesReport = Readonly<{
  open: {
    invoiceId: string;
    number: string;
    payer: string;
    amountDueBaseUnits: string;
    dueDate: string;
    daysOverdue: number;
  }[];
  totalDueBaseUnits: string;
  overdueBaseUnits: string;
  explanation: string;
}>;

export function invoiceAgentReceivables(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
): ReceivablesReport {
  const open = team.tool(agent, 'receivables.aging', () =>
    desk.invoices
      .filter((i) => i.status !== 'DRAFT' && i.status !== 'VOID')
      .map((i) => ({ i, due: amountDue(i) }))
      .filter((x) => x.due > 0n)
      .map(({ i, due }) => ({
        invoiceId: i.invoiceId,
        number: i.number,
        payer: i.payer.name,
        amountDueBaseUnits: due.toString(),
        dueDate: i.dueDate,
        daysOverdue: Math.max(0, daysBetween(i.dueDate, desk.today)),
      })),
  );
  const total = open.reduce((a, r) => a + BigInt(r.amountDueBaseUnits), 0n);
  const overdue = open
    .filter((r) => r.daysOverdue > 0)
    .reduce((a, r) => a + BigInt(r.amountDueBaseUnits), 0n);
  return {
    open,
    totalDueBaseUnits: total.toString(),
    overdueBaseUnits: overdue.toString(),
    explanation: open.length
      ? `${open.length} open invoice(s), ${usdc(total)} outstanding, ${usdc(overdue)} overdue: ${open.map((r) => `${r.number} ${r.payer} ${usdc(r.amountDueBaseUnits)} due ${r.dueDate}`).join('; ')}.`
      : 'No open receivables.',
  };
}

// ---------------------------------------------------------------- CFO Agent

const CASH_PATHS = [
  'treasury.balances',
  'treasury.reserves',
  'treasury.availableToSpend',
];

export function cfoLiquidity(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
): LiquidityReport {
  const s = readWorld(team, agent, snapshot, desk.now);
  const position = team.tool(agent, 'treasury.position', () => ({
    free: s.treasury.availableToSpend.value,
    buffer: s.treasury.reserves.value?.minimumReserve ?? null,
    gateway: s.treasury.gatewayAvailable.value.reduce(
      (a, g) => a + BigInt(g.baseUnits),
      0n,
    ),
    cctp: s.treasury.cctpInFlight.value.reduce(
      (a, c) => a + BigInt(c.baseUnits),
      0n,
    ),
  }));
  const horizon = addDays(desk.today, 30);
  const payables = team.tool(agent, 'payables.list', () =>
    s.obligations.payables.value.filter(
      (p) => p.status !== 'PAID' && p.dueOn <= horizon,
    ),
  );
  const receivables = team.tool(agent, 'invoices.list', () =>
    s.obligations.receivables.value.filter((r) => r.dueDate <= horizon),
  );
  const out = payables.reduce((a, p) => a + BigInt(p.amount), 0n);
  const inflow = receivables.reduce((a, r) => a + BigInt(r.amountDue), 0n);
  const cites = citations(
    s,
    [
      ...CASH_PATHS,
      'obligations.payables',
      'obligations.receivables',
      'treasury.gatewayAvailable',
    ],
    desk.now,
  );
  const grade = s.decision.decisionGrade;
  const net = out - inflow;
  const runwayDays =
    position.free === null || net <= 0n
      ? null
      : Number((BigInt(position.free) * 30n) / net);
  const explanation = !grade
    ? `I can't give a reliable liquidity view: ${s.decision.reasons.join('; ')}. Refresh those sources first.`
    : [
        `Free Arc cash ${position.free === null ? 'unknown' : usdc(position.free)} after reservations, escrow and the ${position.buffer === null ? 'unknown' : usdc(position.buffer)} cash buffer.`,
        `Next 30 days: ${usdc(out)} payables due, ${usdc(inflow)} receivables expected.`,
        runwayDays === null
          ? 'No net outflow over the next 30 days, so runway is not constrained by known obligations.'
          : `At that net outflow (${usdc(net)} per 30 days) free cash lasts about ${runwayDays} days.`,
        `${usdc(position.gateway)} sits in Gateway and ${usdc(position.cctp)} is in flight over CCTP; neither counts as spendable on Arc.`,
        `Sources: ${cites
          .filter((c) => CASH_PATHS.includes(c.path))
          .map(age)
          .join('; ')}.`,
      ].join(' ');
  return LiquidityReportSchema.parse({
    kind: 'LIQUIDITY_REPORT',
    decisionGrade: grade,
    freeCashBaseUnits: grade ? position.free : null,
    cashBufferBaseUnits: position.buffer,
    payablesDue30dBaseUnits: out.toString(),
    receivablesDue30dBaseUnits: inflow.toString(),
    gatewayAvailableBaseUnits: position.gateway.toString(),
    cctpInFlightBaseUnits: position.cctp.toString(),
    runwayDays: grade ? runwayDays : null,
    explanation: clip(explanation, 1200),
    citations: cites,
  });
}

/**
 * Payment timing with due date, cash buffer and source freshness. Stale or
 * unknown cash data is a refusal, not a guess.
 */
export function cfoTiming(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  vi: VendorInvoice,
): { timing: TimingRecommendation; reallocation: ReallocationProposal | null } {
  const s = readWorld(team, agent, snapshot, desk.now);
  const vendor = vendorOf(desk, vi);
  const who = `${clip(vendor?.name ?? vi.vendorId, 60)} ${clip(vi.number, 30)}`;
  const cites = citations(s, [...CASH_PATHS, 'obligations.payables'], desk.now);
  const base = {
    kind: 'TIMING_RECOMMENDATION' as const,
    vendorInvoiceId: vi.vendorInvoiceId,
    dueOn: vi.dueOn,
    amountBaseUnits: vi.amount.toString(),
    citations: cites,
  };
  const free = s.treasury.availableToSpend.value;
  const buffer = s.treasury.reserves.value?.minimumReserve ?? null;
  // Cash before the buffer comes from the confirmed balance, not from the
  // clamped availableToSpend (which hides a balance already under the buffer).
  const before = cashBeforeBuffer(s);
  if (
    !s.decision.decisionGrade ||
    free === null ||
    buffer === null ||
    before === null
  ) {
    const stale = cites.filter((c) => c.freshness !== 'FRESH');
    return {
      timing: TimingRecommendationSchema.parse({
        ...base,
        action: 'REFUSE_STALE',
        payOn: null,
        freeCashBaseUnits: null,
        cashBufferBaseUnits: buffer,
        cashAfterBaseUnits: null,
        savingBaseUnits: '0',
        reason:
          'cash data is not decision-grade; refresh before any payment recommendation',
        explanation: `I won't recommend paying ${who} (${usdc(vi.amount)}, due ${vi.dueOn}) yet: ${stale.length ? stale.map(age).join('; ') : s.decision.reasons.join('; ')}. Stale balances fail closed; refresh the treasury read first.`,
      }),
      reallocation: null,
    };
  }
  const { timing, freeBefore } = team.tool(agent, 'payables.timing', () => {
    const freeBefore = before > 0n ? before : 0n;
    return {
      freeBefore,
      timing: paymentTiming({
        invoice: vi,
        today: desk.today,
        freeCash: freeBefore,
        reserveFloor: BigInt(buffer),
      }),
    };
  });
  const after = freeBefore - (vi.amount - timing.saving);
  let action = timing.action;
  let reason = timing.reason;
  if (action !== 'HOLD' && after < BigInt(buffer)) {
    action = 'HOLD';
    reason = 'paying now would take free cash below the cash buffer';
  }
  let reallocation: ReallocationProposal | null = null;
  if (action === 'HOLD') {
    const gateway = s.treasury.gatewayAvailable.value.reduce(
      (a, g) => a + BigInt(g.baseUnits),
      0n,
    );
    const shortfall = BigInt(buffer) - after;
    const cap = desk.policy?.maxReallocationBaseUnits ?? 0n;
    const amount = [shortfall, gateway, cap].reduce((a, b) => (a < b ? a : b));
    if (amount > 0n && s.treasury.gatewayAvailable.meta.freshness === 'FRESH')
      reallocation = team.tool(agent, 'reallocation.propose', () =>
        ReallocationProposalSchema.parse({
          kind: 'REALLOCATION',
          from: 'GATEWAY_UNIFIED_BALANCE',
          to: 'ARC_TREASURY',
          amountBaseUnits: amount.toString(),
          capBaseUnits: cap.toString(),
          reason: `restore the ${usdc(buffer)} cash buffer before paying ${who}`,
          requiresOwnerApproval: true,
        }),
      );
  }
  const verdict =
    action === 'PAY_EARLY'
      ? `pay today (${desk.today}) to save ${usdc(timing.saving)}`
      : action === 'PAY_ON_DUE_DATE'
        ? `pay on the due date ${vi.dueOn}`
        : 'hold';
  const explanation = [
    `${who}: ${usdc(vi.amount)} due ${vi.dueOn} (${daysBetween(desk.today, vi.dueOn)} days from today).`,
    `Free cash before the buffer is ${usdc(freeBefore)}; the cash buffer is ${usdc(buffer)}; after paying, ${usdc(after > 0n ? after : 0n)} remains${after < BigInt(buffer) ? ', below the buffer' : ', above the buffer'}.`,
    `Recommendation: ${verdict} (${reason}).`,
    reallocation
      ? `Proposed bounded reallocation of ${usdc(reallocation.amountBaseUnits)} from Gateway (needs owner approval).`
      : '',
    `Sources: ${cites
      .filter(
        (c) => CASH_PATHS.includes(c.path) || c.path === 'obligations.payables',
      )
      .map(age)
      .join('; ')}.`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    timing: TimingRecommendationSchema.parse({
      ...base,
      action,
      payOn: action === 'HOLD' ? null : timing.payOn,
      freeCashBaseUnits: freeBefore.toString(),
      cashBufferBaseUnits: buffer,
      cashAfterBaseUnits: after.toString(),
      savingBaseUnits: (action === 'PAY_EARLY' ? timing.saving : 0n).toString(),
      reason,
      explanation: clip(explanation, 1200),
    }),
    reallocation,
  };
}

// ---------------------------------------------------------------- Risk Agent

/** Injection signals that make a document an instruction channel: veto-grade. */
const HARD_SIGNALS = new Set([
  'IGNORE_INSTRUCTIONS',
  'SYSTEM_PROMPT',
  'TOOL_COERCION',
  'MARKUP_BREAKOUT',
  'SECRET_PROBE',
]);

export function riskAgentAssess(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  vi: VendorInvoice,
  intent: PaymentIntent | null,
): RiskRecommendation {
  const s = readWorld(team, agent, snapshot, desk.now);
  const vendor = team.tool(agent, 'vendors.verifiedPayout', () =>
    vendorOf(desk, vi),
  );
  const flags: RiskFlag[] = [];
  if (!vendor)
    flags.push({
      code: 'UNKNOWN_VENDOR',
      severity: 'HARD',
      detail: `${vi.vendorId} is not in the vendor master`,
    });
  else {
    const assessed = team.tool(agent, 'risk.assessPayable', () =>
      assessPayable({
        vendor,
        invoice: vi,
        history: desk.vendorInvoices,
        obligation:
          desk.obligations.find(
            (o) => o.reference === vi.reference && o.vendorId === vi.vendorId,
          ) ?? null,
        availableCash: BigInt(s.treasury.availableToSpend.value ?? '0'),
        today: desk.today,
      }),
    );
    flags.push(
      ...assessed.flags.map((f) => ({ ...f, detail: clip(f.detail, 400) })),
    );
    const verified = verifiedAddress(vendor, vi.chainId);
    if (intent && (!verified || lower(intent.recipient) !== lower(verified)))
      flags.push({
        code: 'RECIPIENT_NOT_VERIFIED',
        severity: 'HARD',
        detail: `proposed recipient ${intent.recipient} is not ${vendor.name}'s verified payout address`,
      });
    if (intent && intent.amount !== vi.amount)
      flags.push({
        code: 'AMOUNT_MISMATCH',
        severity: 'HARD',
        detail: `proposed ${intent.amount} but the invoice is for ${vi.amount}`,
      });
  }
  const signals = team.tool(agent, 'risk.scanDocument', () =>
    injectionSignals(vi.documentText),
  );
  const hardSignals = signals.filter((x) => HARD_SIGNALS.has(x));
  if (hardSignals.length)
    flags.push({
      code: 'DOCUMENT_CONTAINS_INSTRUCTIONS',
      severity: 'HARD',
      detail: `invoice text tries to instruct the agent (${hardSignals.join(', ')}); treat as hostile`,
    });
  else if (signals.length)
    flags.push({
      code: 'DOCUMENT_SIGNALS',
      severity: 'SOFT',
      detail: `invoice text has ${signals.join(', ')}`,
    });
  if (!s.decision.decisionGrade)
    flags.push({
      code: 'WORLD_NOT_DECISION_GRADE',
      severity: 'HARD',
      detail: s.decision.reasons.join('; ').slice(0, 380),
    });
  if (signals.length)
    team.manager.finding(
      'PROMPT_INJECTION_SUSPECTED',
      `${vi.vendorInvoiceId}: ${signals.join(', ')}`,
      agent.handle,
      'HIGH',
    );
  const hard = flags.some((f) => f.severity === 'HARD');
  return RiskRecommendationSchema.parse({
    kind: 'RISK_RECOMMENDATION',
    subject: vi.vendorInvoiceId,
    recommendation: hard ? 'VETO' : flags.length ? 'REVIEW' : 'CLEAR',
    flags: flags.map((f) => ({
      code: clip(f.code, 64),
      severity: f.severity,
      detail: clip(f.detail, 400),
    })),
    injectionSignals: signals,
  });
}

// ---------------------------------------------------------------- Payment Agent

export type PreparedPayment = Readonly<{
  status:
    | 'PREPARED'
    | 'REFUSED_STALE'
    | 'NO_MANDATE'
    | 'UNKNOWN_VENDOR'
    | 'NO_VERIFIED_PAYOUT';
  reason: string;
  proposal: PaymentProposal | null;
  intent: PaymentIntent | null;
  disagreements: string[];
  modelDraft: Readonly<{
    accepted: boolean;
    draft: PaymentDraft | null;
    rejectedBecause: string | null;
  }> | null;
}>;

function purposeFor(v: Vendor): PaymentPurpose {
  return v.kind === 'CONTRACTOR' ? 'CONTRACTOR_PAYOUT' : 'VENDOR_INVOICE';
}

export async function paymentAgentPrepare(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  vi: VendorInvoice,
): Promise<PreparedPayment> {
  const s = readWorld(team, agent, snapshot, desk.now);
  const empty = { proposal: null, intent: null, modelDraft: null };
  if (!s.decision.decisionGrade)
    return {
      status: 'REFUSED_STALE',
      reason: `not preparing a payout on stale data: ${s.decision.reasons.join('; ')}`,
      disagreements: [],
      ...empty,
    };
  const payable = team.tool(agent, 'payables.list', () =>
    s.obligations.payables.value.find(
      (p) => p.vendorInvoiceId === vi.vendorInvoiceId,
    ),
  );
  const vendor = vendorOf(desk, vi);
  if (!vendor || !payable)
    return {
      status: 'UNKNOWN_VENDOR',
      reason: `${vi.vendorInvoiceId} has no vendor master entry or open payable`,
      disagreements: [],
      ...empty,
    };
  const verified = team.tool(agent, 'vendors.verifiedPayout', () =>
    verifiedAddress(vendor, vi.chainId),
  );
  if (!verified)
    return {
      status: 'NO_VERIFIED_PAYOUT',
      reason: `${clip(vendor.name, 60)} has no verified payout address on this chain; verify one out of band before paying`,
      disagreements: [],
      ...empty,
    };
  const purpose = purposeFor(vendor);
  const mandate = s.obligations.mandates.value.find(
    (m) => !m.revoked && m.purposes.includes(purpose),
  );
  const payer = treasuryWallet(s);
  if (!mandate || !payer)
    return {
      status: 'NO_MANDATE',
      reason: `no active ${purpose} mandate or treasury wallet in the WorldSnapshot`,
      disagreements: [],
      ...empty,
    };
  const disagreements: string[] = [];
  // Default to the vendor master's verified address, never the invoice's payTo.
  let recipient = verified as Address;
  let modelDraft: PreparedPayment['modelDraft'] = null;
  if (desk.reasoner) {
    const doc = wrapUntrusted({
      evidenceId: `doc_${vi.vendorInvoiceId}`,
      kind: 'API_RESPONSE',
      origin: `vendor-invoice:${vi.vendorInvoiceId}`,
      retrievedAt: desk.now,
      content: vi.documentText,
    });
    const facts = {
      vendorInvoiceId: vi.vendorInvoiceId,
      vendor: vendor.name,
      number: vi.number,
      amountBaseUnits: vi.amount.toString(),
      dueOn: vi.dueOn,
      invoicePayTo: vi.payTo,
      verifiedPayout: verified,
      allowedPurposes: [purpose],
    };
    const { parsed } = await team.model({
      agent,
      reasoner: desk.reasoner,
      fixtureKey: `finance:payment:${vi.vendorInvoiceId}`,
      schemaName: 'payment_draft',
      schema: PaymentDraftSchema,
      userMessage: `PAYABLE (deterministic, from the vendor master and AP ledger):\n${JSON.stringify(facts)}\nDOCUMENT (untrusted vendor text):\n${renderUntrusted([doc])}\nDraft one PAYMENT proposal for this payable.`,
    });
    if (parsed?.ok) {
      const d = parsed.value;
      const allowed = [vi.payTo, verified]
        .filter(Boolean)
        .map((a) => lower(a!));
      const problem =
        d.vendorInvoiceId !== vi.vendorInvoiceId
          ? 'draft names another payable'
          : d.amountBaseUnits !== vi.amount.toString()
            ? `draft amount ${d.amountBaseUnits} differs from the invoice ${vi.amount}`
            : !allowed.includes(lower(d.recipient))
              ? `draft recipient ${d.recipient} appears in neither the invoice nor the vendor master`
              : d.purpose !== purpose
                ? `draft purpose ${d.purpose} is not ${purpose}`
                : null;
      if (problem) {
        team.manager.finding(
          'VALIDATION_REJECTED',
          problem,
          agent.handle,
          'HIGH',
        );
        modelDraft = { accepted: false, draft: d, rejectedBecause: problem };
      } else {
        recipient = d.recipient as Address;
        modelDraft = { accepted: true, draft: d, rejectedBecause: null };
      }
    } else
      modelDraft = {
        accepted: false,
        draft: null,
        rejectedBecause: parsed
          ? `${parsed.code}`
          : 'model call blocked or failed',
      };
  }
  const name = clip(vendor.name, 60);
  if (lower(vi.payTo) !== lower(verified))
    disagreements.push(
      `the invoice asks to pay ${vi.payTo}, but ${name}'s verified payout address is ${verified}`,
    );
  if (lower(recipient) !== lower(verified))
    disagreements.push(
      `the Payment Agent's model draft chose ${recipient} instead of the verified ${verified}`,
    );
  const asset = token(chainNameOf(s), 'USDC');
  const { proposal, intent } = team.tool(agent, 'payment.prepare', () => {
    // Deterministic per obligation, so an owner confirmation signed over
    // intentApprovalTypedData in one run matches the intent rebuilt in the next.
    const intentId = `int_${vi.vendorInvoiceId}`;
    const evidenceHash = canonicalArtifactHash({
      vendorInvoiceId: vi.vendorInvoiceId,
      document: documentHash(vi.documentText),
      payable,
      snapshotBuiltAt: s.builtAt,
    }) as Hex;
    const intent: PaymentIntent = {
      intentId,
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
      chainId: asset.chainId,
      token: asset.address,
      payer,
      recipient,
      amount: vi.amount,
      purpose,
      obligationRef: vi.reference ?? vi.vendorInvoiceId,
      evidenceHash,
      proposedBy: `agent:${agent.handle.agentId}`,
    };
    const proposal = PaymentProposalSchema.parse({
      kind: 'PAYMENT',
      intentId,
      vendorInvoiceId: vi.vendorInvoiceId,
      vendorId: vendor.vendorId,
      recipient,
      verifiedRecipient: verified,
      amountBaseUnits: vi.amount.toString(),
      purpose,
      obligationRef: intent.obligationRef,
      proposedBy: intent.proposedBy,
      draftSource: modelDraft?.accepted ? 'MODEL_DRAFT' : 'DETERMINISTIC',
    });
    return { proposal, intent };
  });
  return {
    status: 'PREPARED',
    reason: `prepared ${usdc(vi.amount)} to ${recipient} for ${vendor.name} ${vi.number}`,
    proposal,
    intent,
    disagreements,
    modelDraft,
  };
}

function chainNameOf(s: ArcWorldSnapshot): ChainName {
  return s.primaryChain;
}

/** What the owner signs (EIP-712) to confirm one exact payment intent. */
export type OwnerConfirmation = Readonly<{
  intent: PaymentIntent;
  /** One-use nonce and deadline issued by the Kernel; part of the signed data. */
  approval: ApprovalTerms;
  typedData: ReturnType<typeof intentApprovalTypedData>;
  /** The mandate owner must sign; a chat "yes" is never a confirmation. */
  note: string;
}>;

export type KernelSubmission = Readonly<{
  status:
    | 'GRANTED'
    | 'PROPOSED'
    | 'OWNER_APPROVAL_REQUIRED'
    | 'DENIED'
    | 'NO_KERNEL';
  /** Outcome and every reason; the grant itself is never repeated here. */
  decision: Readonly<{
    outcome: Decision['outcome'];
    reasons: string[];
  }> | null;
  /**
   * The MAC'd ExecutionGrant for the restricted executor. Non-enumerable, so
   * JSON serialisation and logs skip it. It must never reach a model prompt,
   * a log line or a chat message; hand it only to the executor.
   */
  grant: ExecutionGrant | null;
  confirmation: OwnerConfirmation | null;
}>;

function submission(
  status: KernelSubmission['status'],
  decision: KernelSubmission['decision'],
  grant: ExecutionGrant | null,
  confirmation: OwnerConfirmation | null,
): KernelSubmission {
  const out = { status, decision, confirmation } as {
    status: KernelSubmission['status'];
    decision: KernelSubmission['decision'];
    confirmation: OwnerConfirmation | null;
    grant: ExecutionGrant | null;
  };
  Object.defineProperty(out, 'grant', { value: grant, enumerable: false });
  return Object.freeze(out);
}

/**
 * Hands the intent and the Risk Agent's deterministic flags to the Kernel.
 * With `requireOwnerApproval` (questions and confirmation flows) the Kernel
 * evaluates everything but grants only with a valid owner EIP-712 signature
 * over `intentApprovalTypedData(intent)`; without one the result is PROPOSED
 * with the typed data to sign.
 */
export async function paymentAgentSubmit(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  intent: PaymentIntent,
  risk: RiskRecommendation,
  options: {
    requireOwnerApproval?: boolean;
    ownerApproval?: OwnerApproval;
    /**
     * False when a risk dependency (e.g. counterparty screening) could not
     * answer: the Kernel then fails closed for high-value payments.
     */
    riskAvailable?: boolean;
  } = {},
): Promise<KernelSubmission> {
  const kernel = desk.kernel;
  if (!kernel) return submission('NO_KERNEL', null, null, null);
  const decision = await team.tool(agent, 'payment.submitToKernel', () =>
    kernel.decide({
      intent,
      risk: { flags: risk.flags, available: options.riskAvailable ?? true },
      ...(options.requireOwnerApproval ? { requireOwnerApproval: true } : {}),
      ...(options.ownerApproval
        ? { ownerApproval: options.ownerApproval }
        : {}),
    }),
  );
  const summary = { outcome: decision.outcome, reasons: [...decision.reasons] };
  if (decision.outcome === 'ALLOW')
    return submission('GRANTED', summary, decision.grant, null);
  if (decision.outcome === 'DENY')
    return submission('DENIED', summary, null, null);
  const confirmation: OwnerConfirmation = {
    intent,
    approval: decision.approval,
    typedData: intentApprovalTypedData(intent, decision.approval),
    note: 'Sign with the mandate owner wallet and pass the signature as `confirm.ownerApproval` with `confirm.approval`; nothing is paid until then.',
  };
  return submission(
    options.requireOwnerApproval && !options.ownerApproval
      ? 'PROPOSED'
      : 'OWNER_APPROVAL_REQUIRED',
    summary,
    null,
    confirmation,
  );
}

// ---------------------------------------------------------------- Audit Agent

export type AuditExplanation = Readonly<{
  status: 'EXPLAINED' | 'NOT_FOUND';
  txHash: string | null;
  environment: string | null;
  explorer: string | null;
  amount: string | null;
  recipient: string | null;
  kernelDecision: string | null;
  kernelReasons: string[];
  grantId: string | null;
  ledger: Readonly<Record<string, string>>;
  ledgerBalanced: boolean | null;
  chainCheck: 'VERIFIED' | 'MISMATCH' | 'NOT_CHECKED';
  chainDetail: string | null;
  relatedRefusals: {
    requestedPayTo: string;
    decision: string;
    flags: string[];
  }[];
  explanation: string;
  sources: string[];
}>;

const units = (d: string) => {
  const neg = d.startsWith('-');
  const [w, f = ''] = d.replace('-', '').split('.');
  const v = BigInt(w!) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  return neg ? -v : v;
};

export function findEvidence(
  desk: FinanceDesk,
  txHash: string | null,
): PayoutEvidence | null {
  if (!desk.evidence.length) return null;
  if (!txHash) return desk.evidence[desk.evidence.length - 1]!;
  return (
    desk.evidence.find((e) => lower(e.payout.hash) === lower(txHash)) ?? null
  );
}

export async function auditAgentExplain(
  team: FinanceTeam,
  agent: FinanceAgent,
  desk: FinanceDesk,
  txHash: `0x${string}` | null,
): Promise<AuditExplanation> {
  const e = team.tool(agent, 'evidence.lookup', () =>
    findEvidence(desk, txHash),
  );
  if (!e)
    return {
      status: 'NOT_FOUND',
      txHash,
      environment: null,
      explorer: null,
      amount: null,
      recipient: null,
      kernelDecision: null,
      kernelReasons: [],
      grantId: null,
      ledger: {},
      ledgerBalanced: null,
      chainCheck: 'NOT_CHECKED',
      chainDetail: null,
      relatedRefusals: [],
      explanation: txHash
        ? `I have no recorded evidence for ${txHash}; I won't guess what it was.`
        : 'I have no recorded payouts to explain yet.',
      sources: [],
    };
  const ledger = team.tool(agent, 'ledger.entries', () => e.payout.apLedger);
  const debits = Object.entries(ledger)
    .filter(([k]) => k !== 'CASH_ARC_USDC')
    .reduce((a, [, v]) => a + units(v), 0n);
  const cash =
    ledger.CASH_ARC_USDC === undefined ? null : units(ledger.CASH_ARC_USDC);
  const ledgerBalanced = cash === null ? null : cash + debits === 0n;
  let chainCheck: AuditExplanation['chainCheck'] = 'NOT_CHECKED';
  let chainDetail: string | null = null;
  const readReceipt = desk.receipts;
  if (readReceipt) {
    // Chain reads go through the fenced, charged, deadline-raced tool.
    const r = await team.tool(agent, 'chain.receipt', () =>
      readReceipt(e.payout.hash as `0x${string}`),
    );
    const expected = units(e.payout.amount);
    const hit = r?.transfers.find(
      (t) => lower(t.to) === lower(e.sarahVerified) && t.baseUnits === expected,
    );
    chainCheck = r && r.status === 'success' && hit ? 'VERIFIED' : 'MISMATCH';
    chainDetail = !r
      ? 'transaction not found on chain'
      : r.status !== 'success'
        ? 'transaction reverted'
        : hit
          ? `block ${r.blockNumber}: USDC transfer of ${e.payout.amount} to ${e.sarahVerified} from ${r.from}`
          : 'no matching USDC transfer to the verified recipient in the receipt';
  }
  const fee = ledger.NETWORK_FEES;
  const refusals = e.fraud
    ? [
        {
          requestedPayTo: e.fraud.requestedPayTo,
          decision: e.fraud.decision,
          flags: e.fraud.riskFlags.map((f) => `${f.severity} ${f.code}`),
        },
      ]
    : [];
  const explanation = [
    `On ${e.environment}, the payout in ${e.payout.hash} sent ${e.payout.amount} USDC to the verified contractor address ${e.sarahVerified}.`,
    `The Kernel decided ${e.payout.decision} (${e.payout.reasons.join('; ')}) and issued grant ${e.payout.grantId}; the restricted executor signed only that exact call.`,
    `Ledger: ${Object.entries(ledger)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}${fee ? ` (network fee ${fee} USDC paid in Arc USDC gas)` : ''}; the entry ${ledgerBalanced ? 'balances' : ledgerBalanced === false ? 'does NOT balance' : 'has no cash line'}.`,
    chainCheck === 'NOT_CHECKED'
      ? 'I have not re-read this transaction from the chain in this run.'
      : `Chain check: ${chainCheck} (${chainDetail}).`,
    refusals.length
      ? `A separate request to pay ${refusals[0]!.requestedPayTo} was ${refusals[0]!.decision} (${refusals[0]!.flags.join(', ')}).`
      : '',
    `Explorer: ${e.payout.explorer}`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    status: 'EXPLAINED',
    txHash: e.payout.hash,
    environment: e.environment,
    explorer: e.payout.explorer,
    amount: e.payout.amount,
    recipient: e.sarahVerified,
    kernelDecision: e.payout.decision,
    kernelReasons: [...e.payout.reasons],
    grantId: e.payout.grantId,
    ledger,
    ledgerBalanced,
    chainCheck,
    chainDetail,
    relatedRefusals: refusals,
    explanation: clip(explanation, 1200),
    sources: [
      `evidence:payout:${e.payout.hash}`,
      e.payout.explorer,
      ...(chainCheck === 'NOT_CHECKED'
        ? []
        : [`chain:receipt:${e.payout.hash}`]),
    ],
  };
}
