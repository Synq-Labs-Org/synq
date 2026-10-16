import type { Hex } from 'viem';
import { assetByAddress } from '@synq/chain-registry/arc';
import type { PaymentIntent } from '@synq/kernel/arc';
import { riskHoldCard, type RiskCase } from '@synq/plugin-risk';
import {
  InteractiveCardSchema,
  arcCardBase,
  cardDecimal,
  cardLine,
  cardRef,
  type ArcCardContext,
  type CardMoney,
  type CardOf,
  type InteractiveCard,
} from '@synq/schemas';
import { teamReplyView, type TeamReply } from './council.js';

/*
 * Agent-team results → cards. The council card reports the Kernel's
 * decision from the structured verdict only (never a model's preference),
 * each role's stance, and how much of the evidence is verified fact versus
 * model inference. Nothing here can approve: card actions are links.
 */

function intentMoney(intent: PaymentIntent): CardMoney | null {
  try {
    const a = assetByAddress(intent.chainId, intent.token);
    return { amount: cardDecimal(intent.amount, a.decimals), symbol: a.symbol };
  } catch {
    return null;
  }
}

const OUTCOME = {
  ALLOW: 'ALLOW',
  REQUIRE_OWNER_APPROVAL: 'NEEDS_APPROVAL',
  DENY: 'DENY',
} as const;

/** The council's answer as an AGENT_RECOMMENDATION card; null when no role answered. */
export function teamCard(
  reply: TeamReply,
  ctx: ArcCardContext & {
    /** The member's question (shown in the caption). */
    question?: string;
    chainId?: number | null;
    /** Unix seconds of the run (defaults to the world snapshot time). */
    observedAt?: number;
  },
): CardOf<'AGENT_RECOMMENDATION'> | null {
  const roles = reply.sections
    .filter((s) => s.persona !== 'DECISION')
    .slice(0, 6)
    .map((s) => ({
      persona: s.persona as Exclude<typeof s.persona, 'DECISION'>,
      stance: s.stance,
      summary: cardLine(s.text, 280),
      citations: s.citations.length,
    }));
  if (!roles.length) return null;
  const facts = reply.citations.filter((c) => c.kind === 'VERIFIED_FACT');
  const ages = facts
    .map((c) => c.ageSeconds)
    .filter((a): a is number => a !== null && a >= 0);
  const amount = reply.intent
    ? intentMoney(reply.intent)
    : reply.request.amount &&
        /^\d{1,31}(\.\d{1,18})?$/.test(reply.request.amount)
      ? {
          amount: reply.request.amount.replace(/^0+(?=\d)/, ''),
          symbol: 'USDC',
        }
      : null;
  const outcome = reply.decision.outcome
    ? OUTCOME[reply.decision.outcome]
    : 'NOT_SUBMITTED';
  const observed = ctx.observedAt ?? reply.world?.builtAt ?? ctx.issuedAt ?? 0;
  return InteractiveCardSchema.parse({
    ...arcCardBase(ctx, observed, 'team', reply.runId, outcome, roles.length),
    type: 'AGENT_RECOMMENDATION',
    chainId: ctx.chainId ?? reply.intent?.chainId ?? null,
    runId: cardRef(reply.runId),
    question: cardLine(ctx.question ?? 'Ask the team', 280),
    roles,
    decision: {
      outcome,
      reasons: reply.decision.reasons.slice(0, 3).map((r) => cardLine(r, 200)),
    },
    counterparty: reply.request.counterparty
      ? cardLine(reply.request.counterparty, 120)
      : null,
    amount,
    evidence: {
      facts: facts.length,
      inferences: reply.citations.length - facts.length,
      oldestFactSeconds: ages.length ? Math.max(...ages) : null,
    },
    riskCaseId: reply.riskCase ? cardRef(reply.riskCase.caseId) : null,
    auditHash:
      reply.auditHash && /^(0x)?[0-9a-fA-F]{64}$/.test(reply.auditHash)
        ? reply.auditHash
        : null,
  }) as CardOf<'AGENT_RECOMMENDATION'>;
}

/** A payout to a vendor or contractor as a CONTRACTOR_PAYMENT card. */
export function contractorPaymentCard(
  input: {
    intent: PaymentIntent;
    recipientLabel: string;
    /** The recipient is the vendor master's verified payout address on this chain. */
    verified: boolean;
    route: 'VAULT_POLICY_PAY' | 'AGENT_WALLET';
    approvals: { counted: number; required: number };
    status: CardOf<'CONTRACTOR_PAYMENT'>['status'];
    transactionHash?: Hex | null;
    observedAt: number;
  },
  ctx: ArcCardContext,
): CardOf<'CONTRACTOR_PAYMENT'> {
  const i = input.intent;
  const amount = intentMoney(i);
  if (!amount)
    throw new Error(`unknown payment asset ${i.token} on ${i.chainId}`);
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      input.observedAt,
      'payout',
      i.intentId,
      input.status,
      input.approvals.counted,
      input.transactionHash ?? '',
    ),
    type: 'CONTRACTOR_PAYMENT',
    chainId: i.chainId,
    paymentId: cardRef(i.intentId),
    recipient: {
      label: cardLine(input.recipientLabel, 120),
      address: i.recipient,
      verified: input.verified,
    },
    amount,
    route: input.route,
    obligationRef: i.obligationRef ? cardRef(i.obligationRef) : null,
    approvals: input.approvals,
    status: input.status,
    transactionHash: input.transactionHash ?? null,
    evidenceHash: /^0x[0-9a-fA-F]{64}$/.test(i.evidenceHash)
      ? i.evidenceHash
      : null,
  }) as CardOf<'CONTRACTOR_PAYMENT'>;
}

/**
 * Cards for one council reply: the recommendation, then the risk hold when
 * the council opened or found one (pass the case read from the case store).
 */
export function teamReplyCards(
  reply: TeamReply,
  ctx: Parameters<typeof teamCard>[1] & { riskCase?: RiskCase | null },
): InteractiveCard[] {
  const cards: InteractiveCard[] = [];
  const team = teamCard(reply, ctx);
  if (team) cards.push(team);
  if (ctx.riskCase && reply.riskCase?.caseId === ctx.riskCase.caseId)
    cards.push(
      riskHoldCard(ctx.riskCase, {
        ...ctx,
        actions: [],
        amount: team?.amount ?? null,
        ...(reply.request.counterparty
          ? { subjectLabel: reply.request.counterparty }
          : {}),
        chainId: ctx.chainId ?? reply.intent?.chainId ?? null,
      }),
    );
  return cards;
}

/**
 * The channel view of a council reply with its cards: what a gateway `team`
 * port returns. Reads the full risk case (for the hold card) from the case
 * store when the reply references one.
 */
export async function teamChannelView(
  reply: TeamReply,
  ctx: Parameters<typeof teamCard>[1] & {
    cases?: { store: { getCase(caseId: string): Promise<RiskCase | null> } };
  },
) {
  const riskCase =
    reply.riskCase && ctx.cases
      ? await ctx.cases.store.getCase(reply.riskCase.caseId)
      : null;
  return {
    ...teamReplyView(reply),
    cards: teamReplyCards(reply, { ...ctx, riskCase }),
  };
}
