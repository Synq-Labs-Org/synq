import type { Hex } from 'viem';
import { z } from 'zod';
import { AmountError } from '@synq/domain';
import { InvoiceError } from '@synq/invoices';
import { normalizeNumber, type VendorInvoice } from '@synq/payables';
import type { AgentFinding } from '@synq/schemas';
import {
  cite,
  evaluateArcSnapshot,
  usdcDisplay,
  type ArcWorldSnapshot,
  type FieldCitation,
} from '@synq/world-model';
import { AgentRuntimeError, type BudgetLimits } from '../subagents.js';
import { renderUntrusted, wrapUntrusted } from '../untrusted.js';
import {
  findEvidence,
  type AuditExplanation,
  type InvoiceOutcome,
  type KernelSubmission,
  type PreparedPayment,
  type ReceivablesReport,
  auditAgentExplain,
  cfoLiquidity,
  cfoTiming,
  invoiceAgentDraft,
  invoiceAgentReceivables,
  paymentAgentPrepare,
  paymentAgentSubmit,
  riskAgentAssess,
} from './specialists.js';
import type { FinanceDesk } from './desk.js';
import {
  ModelIntentSchema,
  classifyIntent,
  fromModelIntent,
  type FinanceIntent,
} from './intent.js';
import { effectiveLimits } from './budget.js';
import type { FinanceRole } from './manifests.js';
import type {
  LiquidityReport,
  ReallocationProposal,
  RiskRecommendation,
  TimingRecommendation,
} from './proposals.js';
import { FinanceTeam, type ModelCallRecord } from './team.js';
import { auditSettlementExplain, findSettlement } from './settlement-audit.js';

export type BalanceView = Readonly<{
  freeCashBaseUnits: string | null;
  balances: { chain: string; asset: string; baseUnits: string }[];
  gatewayAvailableBaseUnits: string;
  cctpInFlightBaseUnits: string;
  cashBufferBaseUnits: string | null;
  decisionGrade: boolean;
}>;

export type PaymentOutcome = Readonly<{
  status: KernelSubmission['status'] | PreparedPayment['status'] | 'NOT_FOUND';
  vendorInvoiceId: string | null;
  prepared: PreparedPayment | null;
  risk: RiskRecommendation | null;
  timing: TimingRecommendation | null;
  reallocation: ReallocationProposal | null;
  kernel: KernelSubmission | null;
  /** Where specialists (or the model draft) disagree; the Kernel decides. */
  disagreements: string[];
}>;

export type SupervisorReply = Readonly<{
  runId: string;
  intent: FinanceIntent;
  status: 'ANSWERED' | 'NEEDS_CLARIFICATION' | 'STOPPED';
  handledBy: FinanceRole[];
  answer: string;
  world: Readonly<{
    builtAt: number;
    decisionGrade: boolean;
    staleCritical: string[];
    refreshed: boolean;
  }> | null;
  citations: FieldCitation[];
  balance?: BalanceView;
  receipt?: AuditExplanation;
  invoice?: InvoiceOutcome;
  receivables?: ReceivablesReport;
  liquidity?: LiquidityReport;
  timing?: TimingRecommendation;
  risk?: RiskRecommendation;
  payment?: PaymentOutcome;
  audit?: AuditExplanation;
  modelCalls: ModelCallRecord[];
  toolCalls: number;
  /** Limits this run actually ran under (defaults ∩ caller ∩ session ledger). */
  limits: BudgetLimits;
  findings: AgentFinding[];
}>;

const usdc = (b: string | bigint) => `${usdcDisplay(b)} USDC`;
const sum = (xs: readonly { baseUnits: string }[]) =>
  xs.reduce((a, x) => a + BigInt(x.baseUnits), 0n).toString();

const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The open payable for a counterparty. The vendor must match exactly one
 * vendor master entry by id or by normalised full name (no substrings). With
 * `requireUnique` (payment paths) a counterparty is mandatory and exactly one
 * open payable must remain after an optional invoice-number filter; reads
 * fall back to the earliest due.
 */
export function findPayable(
  desk: FinanceDesk,
  snapshot: ArcWorldSnapshot,
  counterparty: string | null,
  options: { invoiceNumber?: string | null; requireUnique?: boolean } = {},
): VendorInvoice | null {
  const open = new Set(
    snapshot.obligations.payables.value
      .filter((p) => p.status !== 'PAID')
      .map((p) => p.vendorInvoiceId),
  );
  let candidates = desk.vendorInvoices.filter((i) =>
    open.has(i.vendorInvoiceId),
  );
  if (counterparty === null) {
    if (options.requireUnique) return null;
  } else {
    const who = normName(counterparty);
    const id = counterparty.trim().toLowerCase();
    if (!who) return null;
    const vendors = desk.vendors.filter(
      (v) => v.vendorId.toLowerCase() === id || normName(v.name) === who,
    );
    if (vendors.length !== 1) return null;
    candidates = candidates.filter((i) => i.vendorId === vendors[0]!.vendorId);
  }
  const number = options.invoiceNumber;
  if (number)
    candidates = candidates.filter(
      (i) => normalizeNumber(i.number) === normalizeNumber(number),
    );
  if (options.requireUnique && candidates.length !== 1) return null;
  return (
    [...candidates].sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0] ?? null
  );
}

/**
 * The Synq Supervisor: classify, request the WorldSnapshot, delegate to
 * narrowly-scoped specialists, let the Kernel decide, explain. It cannot sign
 * or authorize; it never touches the grant key or an executor.
 */
export async function superviseFinance(
  message: string,
  desk: FinanceDesk,
  options: {
    runId?: string;
    /** Can only tighten FINANCE_TEAM_BUDGET; never loosen it. */
    limits?: Partial<BudgetLimits>;
    /**
     * The mandate owner's EIP-712 signature over the `PaymentApproval` typed
     * data returned by an earlier PROPOSED reply. Required to turn a payment
     * question into a grant; a chat "yes" is never a confirmation.
     */
    confirm?: { ownerApproval: Hex };
  } = {},
): Promise<SupervisorReply> {
  const runId = options.runId ?? `fin_${desk.now}`;
  const limits = effectiveLimits(
    options.limits,
    desk.budget?.remaining(desk.workspaceId) ?? null,
  );
  const team = new FinanceTeam(runId, limits);
  const sup = team.supervisor;
  const handledBy: FinanceRole[] = ['SUPERVISOR'];
  let intent = classifyIntent(message);
  let world: ArcWorldSnapshot | null = null;
  let refreshed = false;
  let recorded = false;
  const reply = (
    status: SupervisorReply['status'],
    answer: string,
    extra: Partial<SupervisorReply> = {},
    paths: string[] = [],
  ): SupervisorReply => {
    team.close();
    if (!recorded) {
      recorded = true;
      const u = team.manager.usage();
      desk.budget?.record(desk.workspaceId, {
        toolCalls: u.toolCalls,
        tokens: u.tokens,
        paidMicroUsd: u.paidMicroUsd,
      });
    }
    return {
      runId,
      intent,
      status,
      handledBy,
      answer,
      world: world
        ? {
            builtAt: world.builtAt,
            decisionGrade: world.decision.decisionGrade,
            staleCritical: world.decision.staleCritical,
            refreshed,
          }
        : null,
      citations: world ? paths.map((p) => cite(world!, p, desk.now)) : [],
      modelCalls: [...team.modelCalls],
      toolCalls: team.manager.usage().toolCalls,
      limits,
      findings: [...team.findings],
      ...extra,
    };
  };
  try {
    if (intent.kind === 'UNKNOWN' && desk.reasoner) {
      const request = wrapUntrusted({
        evidenceId: 'member_request',
        kind: 'MEMBER_MESSAGE',
        origin: 'chat',
        retrievedAt: desk.now,
        content: message,
      });
      const { parsed } = await team.model({
        agent: sup,
        reasoner: desk.reasoner,
        fixtureKey: 'finance:supervisor:intent',
        schemaName: 'finance_intent',
        schema: ModelIntentSchema,
        userMessage: `Classify the member request into one finance intent.\n${renderUntrusted([request])}`,
      });
      if (parsed?.ok) intent = fromModelIntent(parsed.value);
    }
    if (intent.kind === 'UNKNOWN')
      return reply(
        'NEEDS_CLARIFICATION',
        'I can check balances and receipts, draft invoices, review or pay a bill, explain payment timing and runway, and explain past payments. Which do you need?',
      );

    const moving = intent.kind === 'PAY_INVOICE' || intent.kind === 'PAY_CHECK';
    if (moving && intent.classifiedBy !== 'RULES')
      return reply(
        'NEEDS_CLARIFICATION',
        'I will not start a payment from a guessed intent. Say exactly which invoice to pay, for example "Pay Sarah\'s invoice INV-0042".',
      );

    // Freshness is judged at use time (desk.now), not when the snapshot was built.
    world = evaluateArcSnapshot(
      await team.tool(sup, 'world.snapshot', () => desk.world()),
      desk.now,
    );
    if (moving && !world.decision.decisionGrade && desk.refreshWorld) {
      // Stale critical data is refreshed before any payment path.
      world = evaluateArcSnapshot(
        await team.tool(sup, 'world.snapshot', () => desk.refreshWorld!()),
        desk.now,
      );
      refreshed = true;
    }
    const s = world;

    switch (intent.kind) {
      case 'BALANCE': {
        const balance = team.tool(sup, 'treasury.position', () => ({
          freeCashBaseUnits: s.treasury.availableToSpend.value,
          balances: s.treasury.balances.value.map((b) => ({
            chain: b.chain,
            asset: b.asset,
            baseUnits: b.baseUnits,
          })),
          gatewayAvailableBaseUnits: sum(s.treasury.gatewayAvailable.value),
          cctpInFlightBaseUnits: sum(s.treasury.cctpInFlight.value),
          cashBufferBaseUnits:
            s.treasury.reserves.value?.minimumReserve ?? null,
          decisionGrade: s.decision.decisionGrade,
        }));
        const c = cite(s, 'treasury.balances', desk.now);
        const answer = [
          balance.balances
            .map((b) => `${b.chain} ${b.asset}: ${usdcDisplay(b.baseUnits)}`)
            .join('; ') || 'No balances read.',
          `Free to spend on Arc: ${balance.freeCashBaseUnits === null ? 'unknown' : usdc(balance.freeCashBaseUnits)} (after reservations, escrow and the ${balance.cashBufferBaseUnits === null ? 'unknown' : usdc(balance.cashBufferBaseUnits)} buffer).`,
          `Gateway available ${usdc(balance.gatewayAvailableBaseUnits)}; CCTP in flight ${usdc(balance.cctpInFlightBaseUnits)}.`,
          `Balance read from ${c.source}${c.ageSeconds === null ? '' : ` ${c.ageSeconds}s ago`} (${c.freshness}).`,
        ].join(' ');
        return reply('ANSWERED', answer, { balance }, [
          'treasury.balances',
          'treasury.reserves',
          'treasury.availableToSpend',
          'treasury.gatewayAvailable',
          'treasury.cctpInFlight',
        ]);
      }
      case 'RECEIPT': {
        const e = team.tool(sup, 'evidence.lookup', () =>
          findEvidence(desk, intent.txHash),
        );
        const answer = e
          ? `${e.payout.amount} USDC to ${e.sarahVerified} on ${e.environment}, Kernel ${e.payout.decision}, grant ${e.payout.grantId}. Receipt: ${e.payout.explorer}`
          : `No recorded receipt for ${intent.txHash ?? 'that payment'}.`;
        return reply('ANSWERED', answer);
      }
      case 'CREATE_INVOICE': {
        const a = team.spawn(sup, 'INVOICE');
        handledBy.push('INVOICE');
        const invoice = await invoiceAgentDraft(
          team,
          a,
          desk,
          s,
          intent,
          message,
        );
        team.complete(a);
        const answer =
          invoice.status === 'DRAFTED'
            ? `Drafted ${invoice.draft!.number} for ${invoice.proposal!.payer}: ${usdcDisplay(invoice.draft!.total)} ${invoice.proposal!.asset}, due ${invoice.draft!.dueDate}. It is a draft until you sign the issuance request with ${invoice.issuance!.signer}.`
            : invoice.reason;
        return reply(
          invoice.status === 'NEEDS_DETAILS'
            ? 'NEEDS_CLARIFICATION'
            : 'ANSWERED',
          answer,
          { invoice },
          ['identity.user', 'identity.wallets'],
        );
      }
      case 'RECEIVABLES': {
        const a = team.spawn(sup, 'INVOICE');
        handledBy.push('INVOICE');
        const receivables = invoiceAgentReceivables(team, a, desk);
        team.complete(a);
        return reply('ANSWERED', receivables.explanation, { receivables }, [
          'obligations.receivables',
        ]);
      }
      case 'RUNWAY': {
        const a = team.spawn(sup, 'CFO');
        handledBy.push('CFO');
        const liquidity = cfoLiquidity(team, a, desk, s);
        team.complete(a);
        return reply('ANSWERED', liquidity.explanation, { liquidity });
      }
      case 'PAYMENT_TIMING': {
        const vi = findPayable(desk, s, intent.counterparty);
        if (!vi)
          return reply(
            'NEEDS_CLARIFICATION',
            `I found no open payable${intent.counterparty ? ` for ${intent.counterparty}` : ''}.`,
          );
        const a = team.spawn(sup, 'CFO');
        handledBy.push('CFO');
        const { timing, reallocation } = cfoTiming(team, a, desk, s, vi);
        team.complete(a);
        return reply('ANSWERED', timing.explanation, {
          timing,
          ...(reallocation
            ? {
                payment: {
                  status: 'PREPARED',
                  vendorInvoiceId: vi.vendorInvoiceId,
                  prepared: null,
                  risk: null,
                  timing,
                  reallocation,
                  kernel: null,
                  disagreements: [],
                },
              }
            : {}),
        });
      }
      case 'RISK_REVIEW': {
        const vi = findPayable(desk, s, intent.counterparty);
        if (!vi)
          return reply('NEEDS_CLARIFICATION', 'Which invoice should I review?');
        const a = team.spawn(sup, 'RISK');
        handledBy.push('RISK');
        const risk = riskAgentAssess(team, a, desk, s, vi, null);
        team.complete(a);
        return reply(
          'ANSWERED',
          `${risk.recommendation}: ${risk.flags.map((f) => `${f.severity} ${f.code}: ${f.detail}`).join(' | ') || 'no flags'}`,
          { risk },
        );
      }
      case 'EXPLAIN_TRANSACTION': {
        const a = team.spawn(sup, 'AUDIT');
        handledBy.push('AUDIT');
        const settlement = team.tool(a, 'evidence.lookup', () =>
          findSettlement(desk, intent.txHash),
        );
        const audit = settlement
          ? await auditSettlementExplain(team, a, desk, s, settlement)
          : await auditAgentExplain(team, a, desk, intent.txHash);
        team.complete(a);
        return reply('ANSWERED', audit.explanation, { audit });
      }
      case 'PAY_CHECK':
      case 'PAY_INVOICE': {
        const vi = findPayable(desk, s, intent.counterparty, {
          invoiceNumber: intent.invoiceNumber,
          requireUnique: true,
        });
        if (!vi)
          return reply(
            'NEEDS_CLARIFICATION',
            intent.counterparty
              ? `I could not find exactly one open payable for ${intent.counterparty.slice(0, 60)}; name the vendor and invoice number.`
              : 'Which vendor and invoice should I pay?',
            {
              payment: {
                status: 'NOT_FOUND',
                vendorInvoiceId: null,
                prepared: null,
                risk: null,
                timing: null,
                reallocation: null,
                kernel: null,
                disagreements: [],
              },
            },
          );
        const pay = team.spawn(sup, 'PAYMENT');
        const riskAgent = team.spawn(sup, 'RISK');
        const cfo = team.spawn(sup, 'CFO');
        handledBy.push('PAYMENT', 'RISK', 'CFO');
        const prepared = await paymentAgentPrepare(team, pay, desk, s, vi);
        const risk = riskAgentAssess(
          team,
          riskAgent,
          desk,
          s,
          vi,
          prepared.intent,
        );
        const { timing, reallocation } = cfoTiming(team, cfo, desk, s, vi);
        team.complete(riskAgent);
        team.complete(cfo);
        const disagreements = [...prepared.disagreements];
        if (prepared.modelDraft?.accepted && risk.recommendation === 'VETO')
          disagreements.push(
            `the Payment Agent's model draft called this payout fine ("${prepared.modelDraft.draft!.riskAssessment.slice(0, 120)}") but the Risk Agent vetoes it`,
          );
        if (risk.recommendation === 'CLEAR' && timing.action === 'HOLD')
          disagreements.push(
            'Risk is clear but the CFO advises holding for cash',
          );
        let kernel: KernelSubmission | null = null;
        if (prepared.status === 'PREPARED' && prepared.intent)
          kernel = await paymentAgentSubmit(
            team,
            pay,
            desk,
            prepared.intent,
            risk,
            {
              // Questions (and any confirmation) need the owner's signature;
              // only an explicit imperative may use the mandate's standing
              // pre-approval within its limits.
              requireOwnerApproval:
                intent.kind === 'PAY_CHECK' || Boolean(options.confirm),
              ...(options.confirm
                ? { ownerApproval: options.confirm.ownerApproval }
                : {}),
            },
          );
        team.complete(pay);
        const status = kernel?.status ?? prepared.status;
        const payment: PaymentOutcome = {
          status,
          vendorInvoiceId: vi.vendorInvoiceId,
          prepared,
          risk,
          timing,
          reallocation,
          kernel,
          disagreements,
        };
        const vendor = desk.vendors.find((v) => v.vendorId === vi.vendorId);
        const head =
          status === 'PROPOSED'
            ? `I can prepare this: ${usdc(vi.amount)} to ${vendor?.name.slice(0, 60) ?? vi.vendorId}'s verified address ${prepared.intent!.recipient}. Nothing is paid until the mandate owner signs the PaymentApproval confirmation.`
            : status === 'GRANTED'
              ? `Yes. The Kernel allowed ${usdc(vi.amount)} to ${vendor?.name.slice(0, 60) ?? vi.vendorId}'s verified address and issued grant ${kernel!.grant!.grantId} (expires at ${kernel!.grant!.expiresAt}); only the restricted executor can use it, once, for that exact transfer.`
              : status === 'DENIED'
                ? `No. The Kernel denied this payout: ${kernel!.decision!.reasons.join('; ')}.`
                : status === 'OWNER_APPROVAL_REQUIRED'
                  ? `This needs the owner's signature: ${kernel!.decision!.reasons.join('; ')}.`
                  : status === 'NO_KERNEL'
                    ? 'I prepared the payout but no Kernel is connected, so nothing can be authorized.'
                    : `I did not prepare a payout: ${prepared.reason}.`;
        const answer = [
          head,
          risk.flags.length
            ? `Risk: ${risk.recommendation} (${risk.flags.map((f) => `${f.severity} ${f.code}`).join(', ')}).`
            : 'Risk: no flags.',
          `Timing: ${timing.explanation}`,
          disagreements.length
            ? `Disagreements: ${disagreements.join(' | ')}.`
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        return reply('ANSWERED', answer, { payment, risk, timing }, [
          'treasury.balances',
          'treasury.reserves',
          'obligations.payables',
          'obligations.mandates',
        ]);
      }
    }
    return reply('NEEDS_CLARIFICATION', 'Unsupported request.');
  } catch (error) {
    if (error instanceof AgentRuntimeError)
      return reply(
        'STOPPED',
        `I stopped safely: ${error.kind} (${error.message}). Nothing was signed or sent.`,
      );
    if (
      error instanceof z.ZodError ||
      error instanceof InvoiceError ||
      error instanceof AmountError
    )
      return reply(
        'STOPPED',
        `I stopped safely: an output failed validation (${error.name}). Nothing was signed or sent.`,
      );
    team.close();
    throw error;
  }
}
