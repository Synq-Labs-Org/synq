import { InteractiveCardSchema, type InteractiveCard } from '@synq/schemas';

/** Sample cards for banner tests, design review and the Telegram preview. Sample data only. */
const W = 'https://app.synq.example';
/** Public Monad testnet transaction from the MetaMask delegation evidence. */
const SAMPLE_TX_HASH =
  '0x794be83895e30c3e5bc7f27a56ad416c434e8189b2da5421b32975441a6480c0';
/** Synthetic addresses (not real accounts) so samples stay out of the chain registry. */
const sampleAddress = (head: string, tail: string) =>
  `0x${head}${'0'.repeat(32)}${tail}`;
export const SAMPLE_SAFE = sampleAddress('a8f6', '3e0c');
export const SAMPLE_RECIPIENT = sampleAddress('6bd6', '08bd');
const NOW = 1_791_792_000; // 2026-10-12T08:00:00Z
const id = (n: number) => `card_${n.toString(16).padStart(24, '0')}`;
const base = (n: number) => ({
  schema: 'synq.card/v1' as const,
  cardId: id(n),
  groupId: 'grp_friends',
  groupLabel: 'Goa Trip Crew (preview)',
  issuedAt: NOW,
});

export const SAMPLE_CARDS: Record<string, InteractiveCard> = Object.fromEntries(
  (
    [
      [
        'treasury',
        {
          ...base(1),
          type: 'GROUP_TREASURY',
          balance: { amount: '300', symbol: 'AUSD' },
          available: { amount: '272.5', symbol: 'AUSD' },
          reserved: { amount: '25', symbol: 'AUSD' },
          pending: { amount: '2.5', symbol: 'AUSD' },
          memberCount: 3,
          account: SAMPLE_SAFE,
          chainId: 10143,
          asOf: 'Envio block 70321484',
          activity: [
            { label: 'alice contributed 100 AUSD', at: 'today' },
            { label: 'Send 1 AUSD to bob confirmed', at: 'today' },
          ],
          actions: [
            {
              kind: 'VIEW',
              label: 'Open treasury',
              url: `${W}/groups/grp_friends`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'proposal',
        {
          ...base(2),
          type: 'APPROVAL_PROPOSAL',
          proposalId: `0x${'ab'.repeat(24)}`,
          proposalKind: 'SEND',
          amount: { amount: '10', symbol: 'AUSD' },
          recipient: {
            label: 'bob',
            address: SAMPLE_RECIPIENT,
          },
          reason: 'Split for Saturday dinner',
          quorum: { counted: 1, required: 2 },
          status: 'PENDING',
          statusReason: null,
          actions: [
            {
              kind: 'REVIEW_APPROVE',
              label: 'Review & approve',
              url: `${W}/approve?p=demo&g=grp_friends&n=preview`,
              style: 'PRIMARY',
            },
            {
              kind: 'REVIEW_REJECT',
              label: 'Reject',
              url: `${W}/approve?p=demo&g=grp_friends&n=preview&r=1`,
              style: 'DESTRUCTIVE',
            },
          ],
        },
      ],
      [
        'gift',
        {
          ...base(3),
          type: 'GROUP_GIFT',
          proposalId: null,
          occasion: "Priya's birthday, budget $10",
          options: [
            {
              optionId: 'a',
              product: 'Amazon gift card $10',
              price: { amount: '10', symbol: 'USD' },
              delivery: 'Instant email',
              votes: 2,
            },
            {
              optionId: 'b',
              product: 'Spotify Premium 1 month',
              price: { amount: '10.99', symbol: 'USD' },
              delivery: 'Instant code',
              votes: 1,
            },
          ],
          finalOptionId: 'a',
          provider: 'Reloadly',
          executionMode: 'PROVIDER_SANDBOX',
          actions: [
            {
              kind: 'VOTE',
              label: 'Vote',
              url: `${W}/gift/demo`,
              style: 'SECONDARY',
            },
            {
              kind: 'REVIEW_APPROVE',
              label: 'Review final proposal',
              url: `${W}/approve?p=gift&g=grp_friends&n=preview`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'hotel',
        {
          ...base(4),
          type: 'HOTEL_COMPARISON',
          proposalId: null,
          stay: 'Goa, 14–16 Nov, 3 guests',
          options: [
            {
              optionId: 'h1',
              hotel: 'Seaside Inn',
              room: 'Triple room',
              total: { amount: '180', symbol: 'USD' },
              cancellation: 'Free until 12 Nov',
              preferenceVotes: 2,
            },
            {
              optionId: 'h2',
              hotel: 'Palm Grove',
              room: '2 doubles',
              total: { amount: '210', symbol: 'USD' },
              cancellation: 'Non-refundable',
              preferenceVotes: 1,
            },
          ],
          preferredOptionId: 'h1',
          provider: 'Duffel Stays',
          executionMode: 'PROVIDER_SANDBOX',
          actions: [
            {
              kind: 'VOTE',
              label: 'Compare & vote',
              url: `${W}/stays/demo`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'dca',
        {
          ...base(5),
          type: 'DCA_MANDATE',
          mandateId: 'dca_mon_weekly',
          asset: 'MON',
          frequency: 'Weekly, Fridays',
          perExecutionLimit: { amount: '25', symbol: 'AUSD' },
          cumulativeLimit: { amount: '300', symbol: 'AUSD' },
          spent: { amount: '75', symbol: 'AUSD' },
          nextExecutionAt: NOW + 4 * 86_400,
          status: 'ACTIVE',
          actions: [
            {
              kind: 'PAUSE',
              label: 'Pause',
              url: `${W}/mandates/dca_mon_weekly?a=pause`,
              style: 'SECONDARY',
            },
            {
              kind: 'REVOKE',
              label: 'Revoke',
              url: `${W}/mandates/dca_mon_weekly?a=revoke`,
              style: 'DESTRUCTIVE',
            },
          ],
        },
      ],
      [
        'receipt-testnet',
        {
          ...base(6),
          type: 'EXECUTION_RECEIPT',
          subjectId: 'delegated_contribution',
          label: 'MetaMask delegated contribution 0.6 AUSD → group Safe',
          status: 'CONFIRMED',
          transactionHash: SAMPLE_TX_HASH,
          orderId: null,
          explorerUrl: `https://testnet.monadexplorer.com/tx/${SAMPLE_TX_HASH}`,
          settlementStatus: 'SETTLED',
          executionMode: 'REAL_TESTNET',
          actions: [
            {
              kind: 'EXPLORER',
              label: 'View on explorer',
              url: `https://testnet.monadexplorer.com/tx/${SAMPLE_TX_HASH}`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'receipt-sandbox',
        {
          ...base(7),
          type: 'EXECUTION_RECEIPT',
          subjectId: 'lithic_card_auth',
          label:
            'Synq authorized a simulated card payment using an actual card-issuing sandbox (Lithic)',
          status: 'RECONCILED',
          transactionHash: null,
          orderId: '4842c435-54d6-4681-8d37-57072353dedc',
          explorerUrl: null,
          settlementStatus: 'SETTLED',
          executionMode: 'PROVIDER_SANDBOX',
          actions: [],
        },
      ],
    ] as const
  ).map(([k, c]) => [k, InteractiveCardSchema.parse(c)]),
);

/** A sample card with some fields replaced, re-validated against the schema. */
export const editSample = (
  name: string,
  patch: Record<string, unknown>,
): InteractiveCard =>
  InteractiveCardSchema.parse({ ...SAMPLE_CARDS[name], ...patch });
const edit = editSample;
const option = (i: number) => ({
  optionId: `o${i}`,
  product: `Very long product name number ${i} with extra words that never fit on one line`,
  price: { amount: `${i}9999999999.123456789012345678`, symbol: 'USD' },
  delivery:
    'Delivered by courier within an unspecified but surely reasonable time',
  votes: i,
});
const hotelOption = (i: number) => ({
  optionId: `h${i}`,
  hotel: `The Grand Extraordinarily Long Hotel Name ${i}`,
  room: 'Deluxe ocean-view suite with two queen beds and a balcony',
  total: { amount: '1234567890123.99', symbol: 'USD' },
  cancellation:
    i % 2 ? 'Non-refundable' : 'Partially refundable before arrival minus fees',
  preferenceVotes: 0,
});

/** Layout stress cases: huge numbers, long labels, many options, every status. */
export const EDGE_CASES: [string, InteractiveCard][] = [
  [
    'treasury: huge balance, no members, no activity',
    edit('treasury', {
      groupLabel:
        'An extremely long group label that goes on and on well past any sane width',
      balance: {
        amount: '1234567890123456789012345678901.123456789012345678',
        symbol: 'AUSD',
      },
      available: { amount: '0', symbol: 'AUSD' },
      reserved: { amount: '0', symbol: 'AUSD' },
      pending: { amount: '0', symbol: 'AUSD' },
      memberCount: null,
      activity: [],
    }),
  ],
  [
    'treasury: zero balance',
    edit('treasury', {
      balance: { amount: '0', symbol: 'AUSD' },
      available: { amount: '0', symbol: 'AUSD' },
      reserved: { amount: '0', symbol: 'AUSD' },
      pending: { amount: '0', symbol: 'AUSD' },
    }),
  ],
  [
    'proposal: mandate without amount or recipient, 0 of 12',
    edit('proposal', {
      proposalKind: 'MANDATE',
      amount: null,
      recipient: null,
      reason:
        'mandate dca_weekly v3 (change) raising the cumulative budget for the next quarter of operations',
      quorum: { counted: 0, required: 12 },
    }),
  ],
  [
    'proposal: invalidated with reason',
    edit('proposal', {
      status: 'INVALIDATED',
      statusReason: 'Quote expired before quorum',
      actions: [],
    }),
  ],
  [
    'proposal: satisfied, recipient without address',
    edit('proposal', {
      status: 'SATISFIED',
      quorum: { counted: 2, required: 2 },
      recipient: { label: 'carol', address: null },
    }),
  ],
  [
    'gift: five options, no final pick',
    edit('gift', {
      options: [1, 2, 3, 4, 5].map(option),
      finalOptionId: null,
    }),
  ],
  [
    'gift: one option, simulated',
    edit('gift', {
      options: [option(1)],
      finalOptionId: 'o1',
      executionMode: 'SIMULATION',
    }),
  ],
  [
    'hotel: five options, no preference',
    edit('hotel', {
      options: [1, 2, 3, 4, 5].map(hotelOption),
      preferredOptionId: null,
    }),
  ],
  [
    'dca: revoked, nothing scheduled, overspent ratio clamp',
    edit('dca', {
      status: 'REVOKED',
      nextExecutionAt: null,
      spent: { amount: '500', symbol: 'AUSD' },
    }),
  ],
  [
    'receipt: failed with no reference',
    edit('receipt-testnet', {
      status: 'FAILED',
      transactionHash: null,
      orderId: null,
      explorerUrl: null,
      settlementStatus: 'UNKNOWN',
      executionMode: 'SIMULATION',
      actions: [],
    }),
  ],
  [
    'receipt: submitted',
    edit('receipt-testnet', {
      status: 'SUBMITTED',
      settlementStatus: 'PENDING',
    }),
  ],
  [
    'receipt: refunded sandbox order',
    edit('receipt-sandbox', {
      status: 'REFUNDED',
      settlementStatus: 'REFUNDED',
    }),
  ],
];

/* ------------------------------------------------------------------ */
/* Arc-era card types: deal, escrow, invoice, risk, agent, payout, flight */
/* ------------------------------------------------------------------ */

/** Arc testnet chain id (sample data). */
const ARC_TESTNET = 5_042_002;
const hash = (n: number) =>
  `0x${n.toString(16).padStart(4, '0').repeat(16)}` as const;
export const SAMPLE_CLIENT = sampleAddress('c11e', '0001');
export const SAMPLE_FREELANCER = sampleAddress('f4ee', '0002');
const SAMPLE_ESCROW = sampleAddress('e5c0', '0003');
const arc = (n: number) => ({
  ...base(n),
  groupId: 'ws_studio',
  groupLabel: 'Kite Studio (preview)',
  observedAt: NOW - 180,
  chainId: ARC_TESTNET,
  executionMode: 'LIVE_ARC_TESTNET' as const,
});

export const ARC_SAMPLES: Record<string, InteractiveCard> = Object.fromEntries(
  (
    [
      [
        'deal',
        {
          ...arc(101),
          type: 'DEAL_PROPOSAL',
          dealId: 'deal_7f3a91c2',
          version: 2,
          termsHash: hash(0x9f3a),
          title: 'Landing page redesign',
          status: 'NEGOTIATING',
          client: { label: 'Maya (Kite Studio)', address: SAMPLE_CLIENT },
          freelancer: { label: 'Arjun Rao', address: SAMPLE_FREELANCER },
          total: { amount: '1250', symbol: 'USDC' },
          milestoneCount: 3,
          signatures: { client: 'SIGNED', freelancer: 'PENDING' },
          escrow: SAMPLE_ESCROW,
          expiresAt: NOW + 3 * 86_400,
          actions: [
            {
              kind: 'REVIEW_APPROVE',
              label: 'Review and sign',
              url: `${W}/deal/deal_7f3a91c2?t=preview`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'escrow',
        {
          ...arc(102),
          type: 'ESCROW_MILESTONE',
          dealId: 'deal_7f3a91c2',
          termsHash: hash(0x9f3a),
          escrowDealId: '42',
          escrow: SAMPLE_ESCROW,
          milestoneIndex: 1,
          milestoneCount: 3,
          title: 'Responsive build',
          amount: { amount: '500', symbol: 'USDC' },
          state: 'DELIVERED',
          deadline: NOW + 5 * 86_400,
          evidence: {
            type: 'GITHUB_PR',
            hash: hash(0x51ab),
            label: 'kite/site PR #18 merged',
          },
          disputeDeadline: null,
          transactions: [{ label: 'Escrow funded', hash: hash(0x7c21) }],
          actions: [
            {
              kind: 'VIEW',
              label: 'Review delivery',
              url: `${W}/deal/deal_7f3a91c2?m=1`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'invoice',
        {
          ...arc(103),
          type: 'INVOICE',
          invoiceId: 'inv_3c9e10aa',
          number: 'INV-2026-014',
          version: 1,
          status: 'PARTIAL',
          issuer: { label: 'Arjun Rao', address: SAMPLE_FREELANCER },
          payer: 'Kite Studio',
          total: { amount: '840.5', symbol: 'USDC' },
          paid: { amount: '400', symbol: 'USDC' },
          due: { amount: '440.5', symbol: 'USDC' },
          overpaid: { amount: '0', symbol: 'USDC' },
          dueDate: '2026-11-01',
          paymentRef: hash(0x4e1d),
          termsHash: hash(0x2b77),
          paymentCount: 1,
          lastPaymentTx: hash(0x8d02),
          actions: [
            {
              kind: 'VIEW',
              label: 'Pay invoice',
              url: `${W}/pay/inv_3c9e10aa?t=preview`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'risk',
        {
          ...arc(104),
          type: 'RISK_HOLD',
          caseId: 'case_a91f2c7d0e',
          revision: 1,
          subject: {
            kind: 'DESTINATION',
            label: 'Sarah (contractor)',
            address: sampleAddress('bad0', '0004'),
          },
          state: 'HELD',
          flags: [
            {
              code: 'DESTINATION_CHANGED',
              severity: 'HARD',
              detail: 'Payout address differs from the verified one on file',
              reviewerClearable: false,
            },
            {
              code: 'AMOUNT_ANOMALY',
              severity: 'SOFT',
              detail: '100 USDC is 4x this vendor’s usual payout',
              reviewerClearable: true,
            },
          ],
          clearedBy:
            'Owner signature after verifying the new address from the old wallet',
          amount: { amount: '100', symbol: 'USDC' },
          alertCount: 1,
          openedAt: NOW - 600,
          actions: [
            {
              kind: 'VIEW',
              label: 'Review the case',
              url: `${W}/risk/case_a91f2c7d0e`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'agent',
        {
          ...arc(105),
          type: 'AGENT_RECOMMENDATION',
          runId: 'team_tg_5c1e9a',
          question:
            'Ask your CFO and Risk Agent whether we should pay this contractor',
          roles: [
            {
              persona: 'CFO',
              stance: 'PAY',
              summary: 'Cash covers it after reserves; pay on the due date',
              citations: 2,
            },
            {
              persona: 'RISK',
              stance: 'CLEAR',
              summary: 'Verified payout address; no fraud flags',
              citations: 2,
            },
            {
              persona: 'PAYMENT',
              stance: 'INFO',
              summary: 'Prepared a 120 USDC payout via the vault policy',
              citations: 1,
            },
          ],
          decision: {
            outcome: 'NEEDS_APPROVAL',
            reasons: ['Above the per-action cap: the owner signs'],
          },
          counterparty: 'Arjun',
          amount: { amount: '120', symbol: 'USDC' },
          evidence: { facts: 4, inferences: 1, oldestFactSeconds: 95 },
          riskCaseId: null,
          auditHash: hash(0xa0d1),
          actions: [
            {
              kind: 'REVIEW_APPROVE',
              label: 'Review and sign in your wallet',
              url: `${W}/intents/int_vi_7`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'contractor',
        {
          ...arc(106),
          type: 'CONTRACTOR_PAYMENT',
          paymentId: 'int_vi_7',
          recipient: {
            label: 'Arjun Rao',
            address: SAMPLE_FREELANCER,
            verified: true,
          },
          amount: { amount: '120', symbol: 'USDC' },
          route: 'VAULT_POLICY_PAY',
          obligationRef: 'vi_INV-2026-014',
          approvals: { counted: 1, required: 1 },
          status: 'CONFIRMED',
          transactionHash: hash(0x3f9e),
          evidenceHash: hash(0x11aa),
          actions: [
            {
              kind: 'EXPLORER',
              label: 'View on explorer',
              url: `https://testnet.arcscan.app/tx/${hash(0x3f9e)}`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
      [
        'flight',
        {
          ...arc(107),
          type: 'FLIGHT_COMPARISON',
          chainId: null,
          executionMode: 'PROVIDER_SANDBOX',
          tripId: 'trp_0a1b2c3d4e5f6a7b',
          proposalId: null,
          origin: 'DEL',
          destination: 'GOI',
          departureDate: '2026-12-01',
          returnDate: '2026-12-05',
          travelers: 3,
          cabin: 'economy',
          options: [
            {
              optionId: 'f1',
              carrier: 'Duffel Airways',
              flights: 'ZZ 123 / ZZ 456',
              legs: [
                { origin: 'DEL', destination: 'GOI', date: '2026-12-01' },
                { origin: 'GOI', destination: 'DEL', date: '2026-12-05' },
              ],
              stops: 0,
              price: { amount: '254.3', symbol: 'USD' },
              baggage: '1 checked bag',
              refundable: true,
              votes: 2,
            },
            {
              optionId: 'f2',
              carrier: 'Duffel Airways',
              flights: 'ZZ 781 / ZZ 902',
              legs: [
                { origin: 'DEL', destination: 'GOI', date: '2026-12-01' },
                { origin: 'GOI', destination: 'DEL', date: '2026-12-05' },
              ],
              stops: 1,
              price: { amount: '198.75', symbol: 'USD' },
              baggage: 'Cabin bag only',
              refundable: false,
              votes: 1,
            },
            {
              optionId: 'f3',
              carrier: 'Duffel Airways',
              flights: 'ZZ 210 / ZZ 344',
              legs: [
                { origin: 'DEL', destination: 'GOI', date: '2026-12-01' },
                { origin: 'GOI', destination: 'DEL', date: '2026-12-05' },
              ],
              stops: 0,
              price: { amount: '301', symbol: 'USD' },
              baggage: '2 checked bags',
              refundable: true,
              votes: 0,
            },
          ],
          preferredOptionId: 'f1',
          provider: 'Duffel (test mode)',
          actions: [
            {
              kind: 'VOTE',
              label: 'Compare and vote',
              url: `${W}/fund/trips/trp_0a1b2c3d4e5f6a7b`,
              style: 'PRIMARY',
            },
          ],
        },
      ],
    ] as const
  ).map(([k, c]) => [k, InteractiveCardSchema.parse(c)]),
);

const editArc = (name: string, patch: Record<string, unknown>) =>
  InteractiveCardSchema.parse({ ...ARC_SAMPLES[name], ...patch });
const LONG =
  'An extraordinarily long label that keeps going well past any width a card could show';
const HUGE = '98765432109876543210987654321.123456';

/** Two stress cases per Arc-era type: huge amounts, long names, missing optional fields, terminal states. */
export const ARC_EDGE_CASES: [string, InteractiveCard][] = [
  [
    'deal: settled, both signed, huge total, long names',
    editArc('deal', {
      status: 'SETTLED',
      title: LONG,
      client: { label: LONG, address: SAMPLE_CLIENT },
      total: { amount: HUGE, symbol: 'USDC' },
      milestoneCount: 32,
      signatures: { client: 'SIGNED', freelancer: 'SIGNED' },
      actions: [],
    }),
  ],
  [
    'deal: draft, no escrow, no expiry, declined',
    editArc('deal', {
      status: 'DRAFT',
      version: 1,
      escrow: null,
      expiresAt: null,
      signatures: { client: 'PENDING', freelancer: 'DECLINED' },
      executionMode: 'LOCAL_FIXTURE',
    }),
  ],
  [
    'escrow: disputed with deadline, no evidence, no txs',
    editArc('escrow', {
      state: 'DISPUTED',
      evidence: null,
      transactions: [],
      disputeDeadline: NOW + 2 * 86_400,
      escrowDealId: null,
      escrow: null,
      actions: [],
    }),
  ],
  [
    'escrow: released, 32 milestones, huge amount, long title',
    editArc('escrow', {
      state: 'RELEASED',
      milestoneIndex: 31,
      milestoneCount: 32,
      title: LONG,
      amount: { amount: HUGE, symbol: 'USDC' },
      escrowDealId:
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    }),
  ],
  [
    'invoice: paid in full, holo',
    editArc('invoice', {
      status: 'PAID',
      paid: { amount: '840.5', symbol: 'USDC' },
      due: { amount: '0', symbol: 'USDC' },
      paymentCount: 2,
      actions: [],
    }),
  ],
  [
    'invoice: overpaid, huge numbers, long payer, draft refs missing',
    editArc('invoice', {
      status: 'OVERPAID',
      payer: LONG,
      total: { amount: HUGE, symbol: 'USDC' },
      paid: { amount: '98765432109876543210987654321.5', symbol: 'USDC' },
      due: { amount: '0', symbol: 'USDC' },
      overpaid: { amount: '0.376544', symbol: 'USDC' },
      paymentRef: null,
      termsHash: null,
      lastPaymentTx: null,
    }),
  ],
  [
    'risk: blocked, eight flags, no amount, no address',
    editArc('risk', {
      state: 'BLOCKED',
      subject: { kind: 'VENDOR', label: LONG, address: null },
      amount: null,
      flags: Array.from({ length: 8 }, (_, i) => ({
        code: i % 2 ? 'SCREENING_HIT' : 'SPEND_VELOCITY',
        severity: i % 3 ? 'HARD' : 'SOFT',
        detail: `${LONG} (${i})`,
        reviewerClearable: false,
      })),
    }),
  ],
  [
    'risk: resolved, no flags',
    editArc('risk', { state: 'RESOLVED', flags: [], revision: 3 }),
  ],
  [
    'agent: deny, single role, no amount or evidence',
    editArc('agent', {
      roles: [
        {
          persona: 'RISK',
          stance: 'VETO',
          summary: 'Payout address changed an hour ago; hold the payment',
          citations: 0,
        },
      ],
      decision: { outcome: 'DENY', reasons: [] },
      counterparty: null,
      amount: null,
      evidence: { facts: 0, inferences: 0, oldestFactSeconds: null },
      riskCaseId: 'case_a91f2c7d0e',
    }),
  ],
  [
    'agent: allow, six roles, long summaries',
    editArc('agent', {
      roles: (
        ['CFO', 'RISK', 'PAYMENT', 'AUDIT', 'INVOICE', 'RESEARCH'] as const
      ).map((persona, i) => ({
        persona,
        stance: (
          ['PAY', 'CLEAR', 'INFO', 'CLEAR', 'INFO', 'UNAVAILABLE'] as const
        )[i],
        summary: LONG,
        citations: i,
      })),
      decision: { outcome: 'ALLOW', reasons: [LONG] },
      amount: { amount: HUGE, symbol: 'USDC' },
    }),
  ],
  [
    'contractor: unverified, denied, agent wallet, no tx',
    editArc('contractor', {
      recipient: {
        label: LONG,
        address: sampleAddress('bad0', '0004'),
        verified: false,
      },
      route: 'AGENT_WALLET',
      obligationRef: null,
      approvals: { counted: 0, required: 2 },
      status: 'DENIED',
      transactionHash: null,
      evidenceHash: null,
      actions: [],
    }),
  ],
  [
    'contractor: awaiting approval, huge amount',
    editArc('contractor', {
      amount: { amount: HUGE, symbol: 'USDC' },
      approvals: { counted: 0, required: 1 },
      status: 'AWAITING_APPROVAL',
      transactionHash: null,
      executionMode: 'LOCAL_FIXTURE',
    }),
  ],
  [
    'flight: one way, five options, no preference, long carrier',
    editArc('flight', {
      returnDate: null,
      preferredOptionId: null,
      options: [1, 2, 3, 4, 5].map((i) => ({
        optionId: `o${i}`,
        carrier: `${LONG.slice(0, 70)} ${i}`,
        flights: null,
        legs: [{ origin: 'DEL', destination: 'GOI', date: '2026-12-01' }],
        stops: i % 3,
        price: { amount: `${i}234567.89`, symbol: 'USD' },
        baggage: null,
        refundable: i % 2 === 0,
        votes: 0,
      })),
    }),
  ],
  [
    'flight: single option, nine travellers, first class',
    editArc('flight', {
      travelers: 9,
      cabin: 'first',
      options: [
        {
          ...(ARC_SAMPLES.flight as { options: object[] }).options[0],
          price: { amount: '0.01', symbol: 'USD' },
        },
      ],
      actions: [],
    }),
  ],
];
