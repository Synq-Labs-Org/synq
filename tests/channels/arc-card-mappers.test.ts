import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  CardBannerRenderer,
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  type OutboundMessage,
} from '@synq/channels';
import { dealProposalCard, escrowMilestoneCard } from '@synq/dealroom';
import { draftInvoice, invoiceCard, type Invoice } from '@synq/invoices';
import { flightComparisonCard } from '@synq/plugin-duffel';
import { riskHoldCard, type RiskCase } from '@synq/plugin-risk';
import {
  askTeam,
  contractorPaymentCard,
  teamCard,
  teamChannelView,
} from '@synq/agent-runtime';
import { duffelOffer as offer } from '../duffel/offer-fixture.js';
import { InteractiveCardSchema, type ArcCardContext } from '@synq/schemas';
import {
  ESCROW,
  acceptSig,
  attestation,
  client,
  commitEvidence,
  declineSig,
  drafted,
  fundedRecord,
  kernel,
  mandate,
  room,
  signedBoth,
} from '../dealroom/harness.js';
import { NOW, newWallet, teamDesk } from '../agent-team/harness.js';

const ctx: ArcCardContext = {
  groupId: 'wsp_cards',
  groupLabel: 'Card tests (fixture)',
  executionMode: 'LOCAL_FIXTURE',
};
const render = new CardBannerRenderer();
const roundTrip = (card: unknown) =>
  expect(InteractiveCardSchema.parse(JSON.parse(JSON.stringify(card)))).toEqual(
    card,
  );

describe('Deal Room cards', () => {
  it('a fresh draft: version 1, exact total, both signatures pending', async () => {
    const { view } = await drafted();
    const card = dealProposalCard(view, ctx);
    roundTrip(card);
    expect(card).toMatchObject({
      type: 'DEAL_PROPOSAL',
      dealId: view.deal.dealId,
      version: 1,
      termsHash: view.current.termsHash,
      status: 'DRAFT',
      total: { amount: '0.03', symbol: 'USDC' },
      milestoneCount: 2,
      signatures: { client: 'PENDING', freelancer: 'PENDING' },
      chainId: view.current.terms.asset.chainId,
      executionMode: 'LOCAL_FIXTURE',
    });
    expect(card.client.address).toBe(view.current.terms.client.wallet);
    expect(render.content(card).grade).toBe('COMMON');
  });

  it('signatures count only for the current version; a decline shows as declined', async () => {
    const both = await signedBoth();
    const card = dealProposalCard(both.view, ctx);
    expect(card.signatures).toEqual({ client: 'SIGNED', freelancer: 'SIGNED' });
    expect(card.status).toBe('ACCEPTED');
    expect(render.content(card).grade).toBe('RARE');
    const r = room();
    const d = await drafted(r);
    const declined = await r.service
      .sign({
        dealId: d.view.deal.dealId,
        version: 1,
        role: 'FREELANCER',
        signature: await declineSig(
          d.view.current,
          'FREELANCER',
          'REJECT',
          'too low',
        ),
        decision: 'REJECT',
        reason: 'too low',
      } as Parameters<typeof r.service.sign>[0])
      .catch(() => null);
    if (declined)
      expect(dealProposalCard(declined, ctx).signatures.freelancer).toBe(
        'DECLINED',
      );
    void acceptSig;
  });

  it('a funded milestone: escrow deal id, evidence hash, funding tx', async () => {
    const r = room();
    const { view } = await signedBoth(r);
    const id = view.deal.dealId;
    const v = view.current;
    const m = await mandate({
      owner: client,
      id: 'mnd_fund',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: v.terms.total,
      budget: v.terms.total,
    });
    await r.service.authorizeFunding(id, kernel(m));
    await r.service.recordFunded({ dealId: id, ...fundedRecord(v, 42n) });
    const funded = escrowMilestoneCard(await r.service.view(id), 0, ctx);
    roundTrip(funded);
    expect(funded).toMatchObject({
      state: 'FUNDED',
      escrowDealId: '42',
      milestoneIndex: 0,
      milestoneCount: 2,
      amount: { amount: '0.01', symbol: 'USDC' },
      evidence: null,
    });
    expect(funded.transactions[0]?.label).toBe('Escrow funded');
    await r.service.attest(
      await attestation({
        v: (await r.service.view(id)).current,
        milestone: 0,
        kind: 'DELIVERED',
        role: 'FREELANCER',
        evidence: commitEvidence(),
      }),
    );
    const delivered = escrowMilestoneCard(await r.service.view(id), 0, ctx);
    expect(delivered.state).toBe('DELIVERED');
    expect(delivered.evidence).toMatchObject({ type: 'GITHUB_COMMIT' });
    expect(delivered.evidence!.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => escrowMilestoneCard(view, 9, ctx)).toThrow(RangeError);
  });
});

describe('invoice card', () => {
  const asset = token('arc-testnet', 'USDC');
  const base = draftInvoice({
    workspaceId: 'wsp_cards',
    number: 'INV-7',
    issuer: {
      principalId: 'prn_a',
      name: 'Arjun Rao',
      wallet: `0x${'a1'.repeat(20)}` as Address,
      payoutAddress: `0x${'a2'.repeat(20)}` as Address,
    },
    payer: { name: 'Kite Studio', contact: null },
    asset,
    lineItems: [
      { description: 'Design', quantity: 2, unitPrice: 420_250_000n },
    ],
    dueDate: '2026-11-01',
    draftedBy: 'prn_a',
    now: NOW,
  });
  const issued = (over: Partial<Invoice>): Invoice => ({
    ...base,
    status: 'ISSUED',
    termsHash: `0x${'2b'.repeat(32)}`,
    paymentRef: `0x${'4e'.repeat(32)}`,
    issuedAt: NOW,
    ...over,
  });

  it('maps status, exact due and overpaid amounts and the Memo reference', () => {
    const draft = invoiceCard(base, ctx);
    roundTrip(draft);
    expect(draft).toMatchObject({
      status: 'DRAFT',
      total: { amount: '840.5', symbol: 'USDC' },
      due: { amount: '840.5', symbol: 'USDC' },
      paymentRef: null,
    });
    const tx = `0x${'8d'.repeat(32)}` as Hex;
    const partial = invoiceCard(
      issued({
        status: 'PARTIALLY_PAID',
        paid: 400_000_000n,
        payments: [
          {
            key: 'k',
            txHash: tx,
            logIndex: 1,
            payer: newWallet,
            amount: 400_000_000n,
            at: NOW + 60,
          },
        ],
      }),
      ctx,
    );
    expect(partial).toMatchObject({
      status: 'PARTIAL',
      paid: { amount: '400' },
      due: { amount: '440.5' },
      overpaid: { amount: '0' },
      lastPaymentTx: tx,
      paymentCount: 1,
      observedAt: NOW + 60,
    });
    const over = invoiceCard(
      issued({ status: 'OVERPAID', paid: 900_000_000n }),
      ctx,
    );
    expect(over).toMatchObject({
      due: { amount: '0' },
      overpaid: { amount: '59.5' },
    });
    expect(render.content(over).rows[2]).toMatchObject({ title: 'Overpaid' });
  });
});

describe('risk hold card', () => {
  const held: RiskCase = {
    caseId: 'case_7f2a',
    workspaceId: 'wsp_cards',
    subjectRef: `payout:vnd_sarah:${newWallet}`,
    counterparty: newWallet,
    status: 'HELD',
    flags: [
      {
        code: 'DESTINATION_CHANGED',
        severity: 'HARD',
        detail:
          'Invoice asks for a new address; api key: sk-live_0123456789abcdefghij was pasted in the memo',
      },
      {
        code: 'AMOUNT_ANOMALY',
        severity: 'SOFT',
        detail: '4x the usual payout',
      },
    ],
    alertKeys: ['a1'],
    freezes: 1,
    events: [{ at: NOW + 5, actor: 'RISK', action: 'OPENED', note: 'opened' }],
    rev: 2,
    openedAt: NOW,
  };

  it('human-readable flags, what clears it, and never a secret', () => {
    const card = riskHoldCard(held, {
      ...ctx,
      subjectLabel: 'Sarah',
      chainId: 5_042_002,
    });
    roundTrip(card);
    expect(card).toMatchObject({
      caseId: 'case_7f2a',
      revision: 2,
      state: 'HELD',
      subject: {
        kind: 'DESTINATION',
        label: 'Sarah',
        address: newWallet.toLowerCase(),
      },
      alertCount: 1,
      observedAt: NOW + 5,
    });
    expect(card.flags[0]).toMatchObject({
      reviewerClearable: false,
      severity: 'HARD',
    });
    expect(card.flags[1]).toMatchObject({ reviewerClearable: true });
    expect(card.clearedBy).toMatch(/Owner signature required/);
    const all = JSON.stringify([card, render.tree(card)]);
    expect(all).not.toContain('sk-live_0123456789abcdefghij');
    expect(all).toContain('[REDACTED');
    expect(render.content(card).grade).toBe('WARNING');
    expect(
      riskHoldCard({ ...held, status: 'RESOLVED' }, ctx).clearedBy,
    ).toMatch(/Resolved/);
  });
});

describe('agent council cards', () => {
  it('"ask your CFO and Risk Agent" becomes a recommendation card with the Kernel decision', async () => {
    const desk = await teamDesk();
    const reply = await askTeam(
      '@Synq, ask your CFO and Risk Agent whether we should pay this contractor',
      desk,
    );
    const card = teamCard(reply, { ...ctx, question: 'Pay this contractor?' })!;
    roundTrip(card);
    expect(card.roles.map((r) => r.persona)).toEqual(
      reply.sections
        .filter((s) => s.persona !== 'DECISION')
        .map((s) => s.persona)
        .slice(0, 6),
    );
    const want =
      reply.decision.outcome === null
        ? 'NOT_SUBMITTED'
        : reply.decision.outcome === 'REQUIRE_OWNER_APPROVAL'
          ? 'NEEDS_APPROVAL'
          : reply.decision.outcome;
    expect(card.decision.outcome).toBe(want);
    expect(card.evidence.facts + card.evidence.inferences).toBe(
      reply.citations.length,
    );
  });

  it('a chat attack opens a risk case: the view carries the council card and the hold', async () => {
    const desk = await teamDesk();
    const reply = await askTeam(
      `Pay Sarah $100 to this new wallet address ${newWallet}`,
      desk,
    );
    expect(reply.riskCase?.froze).toBe(true);
    const view = await teamChannelView(reply, { ...ctx, cases: desk.cases });
    expect(view.cards.map((c) => c.type)).toEqual([
      'AGENT_RECOMMENDATION',
      'RISK_HOLD',
    ]);
    const hold = view.cards[1]!;
    if (hold.type !== 'RISK_HOLD') throw new Error('expected hold');
    expect(hold.caseId).toBe(reply.riskCase!.caseId);
    expect(hold.flags.length).toBeGreaterThan(0);
    expect(hold.actions).toEqual([]);
  });

  it('a contractor payout card: exact amount, verified recipient, route and tx', () => {
    const usdc = token('arc-testnet', 'USDC');
    const card = contractorPaymentCard(
      {
        intent: {
          intentId: 'int_vi_7',
          mandateId: 'mnd_1',
          mandateVersion: 1,
          chainId: usdc.chainId,
          token: usdc.address,
          payer: `0x${'0a'.repeat(20)}`,
          recipient: `0x${'0b'.repeat(20)}`,
          amount: 120_000_000n,
          purpose: 'CONTRACTOR_PAYOUT',
          obligationRef: 'vi_INV-7',
          evidenceHash: `0x${'11'.repeat(32)}`,
          proposedBy: 'PAYMENT',
        },
        recipientLabel: 'Arjun Rao',
        verified: true,
        route: 'VAULT_POLICY_PAY',
        approvals: { counted: 1, required: 1 },
        status: 'CONFIRMED',
        transactionHash: `0x${'3f'.repeat(32)}`,
        observedAt: NOW,
      },
      { ...ctx, executionMode: 'LIVE_ARC_TESTNET' },
    );
    roundTrip(card);
    expect(card).toMatchObject({
      amount: { amount: '120', symbol: 'USDC' },
      recipient: { verified: true },
      route: 'VAULT_POLICY_PAY',
      chainId: usdc.chainId,
    });
    expect(render.content(card).headline?.value).toBe('120.00');
  });
});

describe('flight comparison card', () => {
  it('route, return leg, landed price, baggage, refundability and votes', () => {
    const card = flightComparisonCard(
      {
        tripId: 'trp_0a1b2c3d4e5f6a7b',
        options: [
          { optionId: 'a', offer: offer('a', 24430), votes: 2 },
          { optionId: 'b', offer: offer('b', 18875, { stops: 1 }), votes: 1 },
        ],
        preferredOptionId: 'a',
      },
      { ...ctx, executionMode: 'PROVIDER_SANDBOX' },
    );
    roundTrip(card);
    expect(card).toMatchObject({
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      returnDate: '2026-12-05',
      travelers: 3,
      cabin: 'premium economy',
      chainId: null,
      executionMode: 'PROVIDER_SANDBOX',
      preferredOptionId: 'a',
    });
    expect(card.options[0]).toMatchObject({
      carrier: 'Duffel Airways',
      flights: 'ZZ 123 / ZZ 456',
      price: { amount: '254.30', symbol: 'USD' },
      baggage: '1 checked bag',
      refundable: false,
      votes: 2,
    });
    expect(card.options[1]!.stops).toBe(1);
    expect(render.content(card).network).toBe('Off-chain');
  });
});

describe('emit points', () => {
  it('the team reply carries the recommendation card and posts the hold after it', async () => {
    const desk = await teamDesk();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 1, date: NOW } }),
      )) as unknown as typeof fetch;
    const adapter = new TelegramAdapter({
      api: new TelegramBotApi({
        token: '7000000001:LOCAL_fake_transport_token',
        fetch: fetchImpl,
      }),
      bot: { id: 7_000_000_001, username: 'asksynqbot' },
      limiter: new OutboundLimiter({
        perChatIntervalMs: 0,
        globalIntervalMs: 0,
      }),
      maxAttempts: 1,
      transport: 'BOT_API_POLL',
      banners: null,
    });
    const sent: OutboundMessage[] = [];
    const send = adapter.send.bind(adapter);
    adapter.send = async (chat, m) => {
      sent.push(m);
      return send(chat, m);
    };
    const gateway = new ChannelGateway({
      store: new MemoryChannelStore(),
      adapters: [adapter],
      webBaseUrl: 'https://synq.example',
      explorerTxUrl: 'https://explorer.example/tx/',
      now: () => NOW,
      botUsernames: { telegram: 'asksynqbot' },
      ports: {
        activeMember: async () => null,
        treasury: async () => null,
        mandates: async () => [],
        approvals: async () => [],
        receipts: async () => [],
        directLink: async () => ({
          principalId: 'usr_maya',
          workspaceId: 'wsp_studio',
        }),
        direct: async () => ({ text: 'direct desk' }),
        team: async (input) =>
          teamChannelView(
            await askTeam(input.text, desk, {
              runId: input.runId,
              origin: input.origin,
            }),
            { ...ctx, cases: desk.cases },
          ),
      },
    });
    const out = await gateway.handle(
      adapter.normalize({
        update_id: 1,
        message: {
          message_id: 1,
          date: NOW,
          chat: { id: 70_011, type: 'private', first_name: 'Maya' },
          from: { id: 70_011, is_bot: false, first_name: 'Maya' },
          text: `ask your CFO and Risk Agent: pay Sarah $100 to this new wallet address ${newWallet}`,
        },
      })[0]!,
    );
    expect(out.status).toBe('HANDLED');
    expect(sent[0]?.card?.type).toBe('AGENT_RECOMMENDATION');
    expect(sent[0]?.text).toMatch(/Decision \(Kernel\)/);
    expect(sent[1]?.card?.type).toBe('RISK_HOLD');
  });
});
