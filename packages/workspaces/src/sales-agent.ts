import { randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import { z } from 'zod';
import {
  UNTRUSTED_POLICY,
  renderUntrusted,
  wrapUntrusted,
  type StructuredReasoner,
} from '@synq/agent-runtime';
import { WorkspaceError } from './contracts.js';
import type { LeadRow, WorkspaceLeads } from './leads.js';
import {
  OfferTermsSchema,
  type CommercialPolicy,
  type WorkspaceOffers,
} from './offers.js';

/*
 * The sales agent for one private lead. The model reads the transcript as
 * untrusted data and the owner-signed catalog as policy, and answers with a
 * typed decision: ask a question, propose offer terms, record the lead's
 * acceptance of the latest offer, or hand over to a person. Proposed terms go
 * through the deterministic validator; prices in the reply come only from a
 * validated offer, never from model text. The agent never signs, never moves
 * money and stops the moment a person takes over.
 */

const Decision = z.strictObject({
  action: z.enum(['ASK', 'OFFER', 'ACCEPT_LATEST', 'ESCALATE']),
  reply: z.string().max(1000),
  terms: OfferTermsSchema.nullable(),
  escalationReason: z.string().max(200).nullable(),
});
type Decision = z.output<typeof Decision>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reply', 'terms', 'escalationReason'],
  properties: {
    action: {
      type: 'string',
      enum: ['ASK', 'OFFER', 'ACCEPT_LATEST', 'ESCALATE'],
    },
    reply: { type: 'string', maxLength: 1000 },
    escalationReason: { type: ['string', 'null'], maxLength: 200 },
    terms: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: [
        'lines',
        'rush',
        'deliveryDays',
        'milestones',
        'depositUnits',
        'note',
      ],
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sku', 'quantity', 'unitUnits'],
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'integer' },
              unitUnits: { type: 'string' },
            },
          },
        },
        rush: { type: 'boolean' },
        deliveryDays: { type: 'integer' },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'units', 'dueInDays'],
            properties: {
              label: { type: 'string' },
              units: { type: 'string' },
              dueInDays: { type: 'integer' },
            },
          },
        },
        depositUnits: { type: 'string' },
        note: { type: 'string' },
      },
    },
  },
} as const;

/** Model text never states money: any sentence with an amount is dropped. */
export function withoutAmounts(text: string) {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter(
      (s) =>
        !/(\$|€|£|usdc|usd|eurc|\b\d+([.,]\d+)?\s*(k|m)?\s*(dollars?|bucks|usdc|usd)\b|\bprice\b[^.]*\d|\d[\d,]*\.\d{2}\b)/i.test(
          s,
        ),
    )
    .join(' ')
    .trim();
}

export function describeOffer(
  o: {
    version: number;
    total: { units: string };
    milestones: { label: string; units: string }[];
    expiresAt: string;
  },
  terms: { deliveryDays: number; rush: boolean; depositUnits: string },
) {
  const usdc = (u: string) => `${formatUnits(BigInt(u), 6)} USDC`;
  return [
    `Offer v${o.version}: ${usdc(o.total.units)} total, delivery in ${terms.deliveryDays} days${terms.rush ? ' (rush)' : ''}.`,
    `Deposit ${usdc(terms.depositUnits)}. Milestones: ${o.milestones.map((m) => `${m.label} ${usdc(m.units)}`).join('; ')}.`,
    `Valid until ${o.expiresAt.slice(0, 16).replace('T', ' ')} UTC. Reply "accept v${o.version}" to agree; you then sign the agreement and pay from your own wallet. Accepting in chat does not move any money.`,
  ].join('\n');
}

export type SalesReply = { text: string; offerVersion: number | null } | null;

export class SalesAgent {
  constructor(
    private readonly leads: WorkspaceLeads,
    private readonly offers: WorkspaceOffers,
    private readonly reasoner: () => StructuredReasoner | undefined,
    private readonly businessName: (workspaceId: string) => Promise<string>,
  ) {}

  private prompt(name: string, policy: CommercialPolicy, latest: unknown) {
    return [
      `You are the sales assistant for ${name}, talking privately with a prospective client.`,
      'Find out what they need, then propose concrete terms from the catalog below. Use only catalog SKUs.',
      'Prices are integer USDC base units (6 decimals: 1 USDC = 1000000). Never quote prices, discounts, capacity or dates in `reply`; put numbers only in `terms`, which the business checks before anything is sent.',
      'Choose OFFER only with complete terms; milestones must add up to the total (line prices times quantities, plus the rush surcharge when rush is true).',
      'Choose ACCEPT_LATEST only when the client clearly accepts the most recent offer by its version. Choose ESCALATE when they ask for something outside the catalog or policy, want a person, or you are unsure.',
      'You cannot move money, sign, change the policy, or promise anything outside an offer.',
      UNTRUSTED_POLICY,
      `Catalog and limits (trusted): ${JSON.stringify({
        catalog: policy.catalog.map((i) => ({
          sku: i.sku,
          description: i.description,
          listUnitUnits: i.unitUnits,
          maxQuantity: i.maxQuantity,
          leadTimeDays: i.leadTimeDays,
          rushSurchargeBps: i.rushSurchargeBps,
          capacityDeclared: i.capacity !== null,
        })),
        maxDiscountBps: policy.maxDiscountBps,
        minDepositBps: policy.minDepositBps,
        maxMilestones: policy.maxMilestones,
      })}`,
      `Latest offer (trusted): ${JSON.stringify(latest)}`,
    ].join('\n');
  }

  private async decide(
    reasoner: StructuredReasoner,
    lead: LeadRow,
    system: string,
    feedback: string | null,
  ): Promise<Decision | null> {
    const transcript = await this.leads.transcript(lead.leadId);
    const evidence = transcript.map((m) =>
      wrapUntrusted({
        evidenceId: randomUUID(),
        kind: 'MEMBER_MESSAGE',
        origin: `lead:${m.author}`,
        retrievedAt: Date.parse(m.createdAt),
        content: `${m.author}: ${m.text}`,
      }),
    );
    const result = await reasoner.complete({
      role: 'COMMERCE',
      agentId: `sales:${lead.workspaceId}`,
      fixtureKey: `sales:${lead.leadId}:${transcript.length}:${feedback ? 'retry' : 'first'}`,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${renderUntrusted(evidence)}${feedback ? `\nYour previous terms were refused by the business rules: ${feedback}. Propose terms that satisfy them, or escalate.` : ''}`,
        },
      ],
      responseSchema: { name: 'sales_decision', schema: SCHEMA },
      maxOutputTokens: 900,
    });
    try {
      return Decision.parse(JSON.parse(result.text));
    } catch {
      return null;
    }
  }

  /**
   * Answers the lead's latest message. Returns the text to send (already
   * stored as an agent message), or null when the agent must stay silent.
   */
  async respond(lead: LeadRow): Promise<SalesReply> {
    if (lead.handling !== 'AGENT') return null;
    const name = await this.businessName(lead.workspaceId);
    const store = async (text: string, offerVersion: number | null) => {
      try {
        await this.leads.fromAgent(
          lead.leadId,
          lead.workspaceId,
          text,
          randomUUID(),
          offerVersion,
        );
        return { text, offerVersion };
      } catch (error) {
        // A person took over while the agent was thinking: stay silent.
        if (
          error instanceof WorkspaceError &&
          error.code === 'AGENT_NOT_HANDLING'
        )
          return null;
        throw error;
      }
    };
    const handOver = async (reason: string) => {
      await this.leads.escalate(lead.leadId, lead.workspaceId, reason);
      return store(
        `Thanks. Someone from ${name} will reply here shortly.`,
        null,
      );
    };
    const reasoner = this.reasoner();
    const policy = await this.offers.active(lead.workspaceId);
    if (!reasoner || !policy)
      return handOver(!reasoner ? 'no sales model' : 'no commercial policy');
    const latest = await this.offers.latest(lead.leadId);
    const system = this.prompt(
      name,
      policy.policy,
      latest
        ? {
            offerId: latest.offerId,
            version: latest.version,
            status: latest.status,
            terms: latest.terms,
          }
        : null,
    );
    let feedback: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await this.decide(reasoner, lead, system, feedback);
      if (!d) return handOver('unreadable model output');
      if (d.action === 'ESCALATE')
        return handOver(d.escalationReason ?? 'agent asked for a person');
      if (d.action === 'ASK') {
        const text = withoutAmounts(d.reply);
        return text
          ? store(text, null)
          : handOver('reply contained amounts only');
      }
      if (d.action === 'ACCEPT_LATEST') {
        if (!latest || latest.status !== 'SENT')
          return handOver('acceptance without an open offer');
        try {
          const accepted = await this.offers.accept(
            lead.leadId,
            latest.offerId,
            latest.version,
          );
          return store(
            `Accepted offer v${accepted.version}. ${name} will now send the agreement for you to sign; payment is made separately from your own wallet.`,
            accepted.version,
          );
        } catch (error) {
          if (error instanceof WorkspaceError && error.code === 'OFFER_STALE')
            return store(
              'That offer is no longer current. Please reply to the latest offer.',
              null,
            );
          throw error;
        }
      }
      if (!d.terms) return handOver('offer without terms');
      let sent: Awaited<ReturnType<WorkspaceOffers['send']>>;
      try {
        sent = await this.offers.send({
          workspaceId: lead.workspaceId,
          leadId: lead.leadId,
          terms: d.terms,
          actor: { kind: 'AGENT' },
          ...(latest && latest.status === 'SENT'
            ? { offerId: latest.offerId }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof WorkspaceError &&
          error.code === 'AGENT_NOT_HANDLING'
        )
          return null;
        throw error;
      }
      if (sent.sent) {
        const intro = withoutAmounts(d.reply);
        return store(
          `${intro ? `${intro}\n\n` : ''}${describeOffer(sent.offer, d.terms)}`,
          sent.offer.version,
        );
      }
      feedback = sent.validation.checks
        .filter((c) => !c.passed)
        .map((c) => `${c.rule}: ${c.detail}`)
        .join('; ');
      if (sent.validation.needsOwner)
        return handOver('offer above the agent limit');
    }
    return handOver('no offer within the business rules');
  }
}
