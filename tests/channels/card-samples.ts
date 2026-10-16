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
